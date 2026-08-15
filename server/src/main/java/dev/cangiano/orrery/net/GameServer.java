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
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The authoritative server. One thread owns the simulation and nothing else
 * touches it.
 *
 * <p>That single-threaded core is deliberate. Physics that several threads can
 * mutate is physics that stops being reproducible, and reproducibility is the
 * one property client prediction cannot do without. Network callbacks arrive on
 * Jetty's threads, drop their intent into a concurrent map, and leave. The tick
 * thread reads that map and is the only thing that ever writes to the world.
 *
 * <p>No prediction yet on purpose. Right now the client draws exactly what the
 * server last said, so movement lags by a round trip and feels bad. That is the
 * honest baseline: the next commit makes it feel good, and you can only tell it
 * worked if you know what it felt like before.
 */
public final class GameServer {

    /** Simulation rate. */
    public static final int TICK_HZ = 60;

    /** Snapshot rate. Every other tick, because 30 updates a second is plenty to interpolate from. */
    public static final int SNAPSHOT_EVERY = 2;

    /** Thruster force. Tuned by feel later, once there is feel to tune. */
    public static final double THRUST = 60.0;

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

    /** What the server knows about one connection. */
    private static final class Player {
        final int id;
        volatile double ax;
        volatile double ay;
        volatile long lastSeq;

        Player(int id) {
            this.id = id;
        }
    }

    public void start(int port) {
        app = Javalin.create(cfg -> cfg.staticFiles.add("/public", io.javalin.http.staticfiles.Location.CLASSPATH));

        app.ws("/ws", ws -> {
            ws.onConnect(ctx -> {
                int id = nextId.getAndIncrement();
                Player p = new Player(id);
                players.put(ctx, p);

                // Spawn somewhere that isn't the middle, so two players don't
                // start inside each other.
                double x = ARENA_W * (0.25 + 0.5 * ((id % 2)));
                double y = ARENA_H * 0.5;
                synchronized (world) {
                    world.add(new Body(id, x, y, PLAYER_RADIUS, PLAYER_MASS));
                }

                ctx.send(write(Messages.Welcome.of(id, ARENA_W, ARENA_H, TICK_HZ)));
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
                // Clamp rather than trust. A client is free to send ax=1e9.
                p.ax = clamp(node.path("ax").asDouble(0), -1, 1);
                p.ay = clamp(node.path("ay").asDouble(0), -1, 1);
                p.lastSeq = node.path("seq").asLong(0);
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
                        Body b = world.byId(p.id);
                        if (b != null) {
                            b.applyForce(p.ax * THRUST, p.ay * THRUST, dt);
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
                states.add(new Messages.BodyState(b.id, round(b.x), round(b.y),
                        round(b.vx), round(b.vy), b.radius));
            }
        }
        // Each client gets its own frame, because ack is per client.
        for (Map.Entry<WsContext, Player> e : players.entrySet()) {
            WsContext ctx = e.getKey();
            if (ctx.session.isOpen()) {
                ctx.send(write(Messages.Snapshot.of(tick, e.getValue().lastSeq, states)));
            }
        }
    }

    /** Two decimals is under a tenth of a player radius and cuts the frame size hard. */
    private static double round(double v) {
        return Math.round(v * 100.0) / 100.0;
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
