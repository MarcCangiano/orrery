package dev.cangiano.orrery.net;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.cangiano.orrery.FixedTickLoop;
import dev.cangiano.orrery.TimeSource;
import dev.cangiano.orrery.sim.Body;
import dev.cangiano.orrery.sim.World;
import io.javalin.Javalin;
import io.javalin.websocket.WsContext;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReferenceArray;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The authoritative server. One thread owns the simulation and nothing else
 * touches it.
 *
 * <p>That single-threaded core is deliberate. Physics that several threads can
 * mutate is physics that stops being reproducible, and reproducibility is the
 * one property client prediction cannot do without. Network callbacks arrive on
 * Jetty's threads, drop their intent into a queue, and leave. The tick thread
 * reads those queues and is the only thing that ever writes to the world.
 *
 * <p><b>Inputs are addressed to a tick, not to a queue.</b> Two earlier versions
 * got this wrong. The first kept only the latest input and applied whatever had
 * arrived by tick time. The second queued them and consumed one per tick. Both
 * fail the same way: the client predicts one step per input it sends, the server
 * runs one step per tick, and those are two independent clocks. Over a second
 * they disagree by a tick or so, which measured as a mean prediction error of
 * 0.42 world units, roughly a quarter of a body, permanently.
 *
 * <p>Now a client stamps each input with the tick it is meant for, aiming a
 * couple of ticks into the server's future. At tick T the server applies the
 * input addressed to T, or holds the last one if nothing arrived in time. Both
 * sides now agree on exactly which inputs affected which ticks, so a replay on
 * the client reproduces the server's arithmetic instead of approximating it.
 */
public final class GameServer {

    /** Simulation rate. */
    public static final int TICK_HZ = 60;

    /** Snapshot rate. Every other tick, because 30 updates a second is plenty to interpolate from. */
    public static final int SNAPSHOT_EVERY = 2;

    /** Thruster force. Tuned by feel later, once there is feel to tune. */
    public static final double THRUST = 60.0;

    /**
     * Ring buffer of pending inputs, indexed by tick. Four seconds at 60Hz.
     * A ring rather than a growable map because a client cannot make the server
     * allocate by sending inputs addressed to the year 3000.
     */
    private static final int INPUT_RING = 256;

    private static final double ARENA_W = 120;
    private static final double ARENA_H = 70;
    private static final double PLAYER_RADIUS = 1.6;
    private static final double PLAYER_MASS = 1.0;

    private final ObjectMapper json = new ObjectMapper();
    private final World world = new World(ARENA_W, ARENA_H);
    private final Map<WsContext, Player> players = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);

    private Javalin app;
    private Thread simThread;
    private volatile boolean running;

    /** One intent from a client, addressed to a specific server tick. */
    private record Command(long seq, long tick, double ax, double ay) {}

    /** What the server knows about one connection. */
    private static final class Player {
        final int id;
        /** Written by network threads, read by the sim thread. Slot is tick % INPUT_RING. */
        final AtomicReferenceArray<Command> ring = new AtomicReferenceArray<>(INPUT_RING);
        // Only the sim thread touches these.
        Command lastApplied = new Command(0, 0, 0, 0);
        volatile long ack;
        volatile long missed;

        Player(int id) {
            this.id = id;
        }
    }

    public void start(int port) {
        app = Javalin.create(cfg -> cfg.staticFiles.add("/public",
                io.javalin.http.staticfiles.Location.CLASSPATH));

        app.ws("/ws", ws -> {
            ws.onConnect(ctx -> {
                int id = nextId.getAndIncrement();
                Player p = new Player(id);
                players.put(ctx, p);

                double x = ARENA_W * (0.25 + 0.5 * (id % 2));
                double y = ARENA_H * 0.5;
                synchronized (world) {
                    world.add(new Body(id, x, y, PLAYER_RADIUS, PLAYER_MASS));
                }

                ctx.send(write(Messages.Welcome.of(id, ARENA_W, ARENA_H, TICK_HZ,
                        THRUST, World.MAX_SPEED, World.WALL_RESTITUTION)));
                System.out.printf("player %d connected (%d online)%n", id, players.size());
            });

            ws.onMessage(ctx -> {
                Player p = players.get(ctx);
                if (p == null) {
                    return;
                }
                JsonNode node = json.readTree(ctx.message());
                if (!"input".equals(node.path("t").asText())) {
                    return;
                }
                long forTick = node.path("tick").asLong(0);
                // Clamp rather than trust. A client is free to send ax=1e9.
                Command c = new Command(
                        node.path("seq").asLong(0),
                        forTick,
                        clamp(node.path("ax").asDouble(0), -1, 1),
                        clamp(node.path("ay").asDouble(0), -1, 1));
                p.ring.set((int) Math.floorMod(forTick, INPUT_RING), c);
            });

            ws.onClose(ctx -> removePlayer(ctx));
            ws.onError(ctx -> removePlayer(ctx));
        });

        app.start(port);
        startSimulation();
        System.out.printf("orrery listening on http://localhost:%d%n", port);
    }

    private void removePlayer(WsContext ctx) {
        Player p = players.remove(ctx);
        if (p != null) {
            synchronized (world) {
                world.remove(p.id);
            }
            System.out.printf("player %d left (%d online)%n", p.id, players.size());
        }
    }

    private void startSimulation() {
        running = true;
        simThread = new Thread(this::simulationLoop, "sim");
        simThread.setDaemon(true);
        simThread.start();
    }

    private void simulationLoop() {
        FixedTickLoop loop = new FixedTickLoop(TICK_HZ, 5, TimeSource.SYSTEM);
        long lastReport = System.nanoTime();

        while (running) {
            loop.advance((tick, dt) -> {
                synchronized (world) {
                    for (Player p : players.values()) {
                        int slot = (int) Math.floorMod(tick, INPUT_RING);
                        Command c = p.ring.get(slot);
                        if (c != null && c.tick() == tick) {
                            p.lastApplied = c;
                            p.ack = c.seq();
                            p.ring.set(slot, null);
                        } else if (c == null) {
                            // Nothing addressed to this tick arrived in time.
                            // Hold the last intent: a dropped packet should read
                            // as a stutter, not as the thruster cutting out.
                            p.missed++;
                        }
                        Body b = world.byId(p.id);
                        if (b != null) {
                            b.applyForce(p.lastApplied.ax() * THRUST,
                                    p.lastApplied.ay() * THRUST, dt);
                        }
                    }
                    world.step(dt);
                }
                if (tick % SNAPSHOT_EVERY == 0) {
                    broadcast(tick);
                }
            });

            if (System.nanoTime() - lastReport > 10_000_000_000L) {
                lastReport = System.nanoTime();
                if (loop.droppedTicks() > 0) {
                    System.out.printf("WARNING dropped %d ticks%n", loop.droppedTicks());
                }
            }

            try {
                Thread.sleep(1);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void broadcast(long tick) {
        List<Messages.BodyState> states;
        synchronized (world) {
            states = new ArrayList<>(world.bodies().size());
            for (Body b : world.bodies()) {
                states.add(new Messages.BodyState(b.id, b.x, b.y, b.vx, b.vy, b.radius));
            }
        }
        // Each client gets its own frame, because ack is per client.
        for (Map.Entry<WsContext, Player> e : players.entrySet()) {
            WsContext ctx = e.getKey();
            if (ctx.session.isOpen()) {
                Player p = e.getValue();
                ctx.send(write(Messages.Snapshot.of(tick, p.ack, p.missed, states)));
            }
        }
    }

    private static double clamp(double v, double lo, double hi) {
        return v < lo ? lo : Math.min(v, hi);
    }

    private String write(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (Exception e) {
            throw new IllegalStateException("could not serialize " + o.getClass(), e);
        }
    }

    public void stop() {
        running = false;
        if (app != null) {
            app.stop();
        }
    }
}
