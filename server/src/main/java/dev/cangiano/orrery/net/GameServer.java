package dev.cangiano.orrery.net;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.cangiano.orrery.FixedTickLoop;
import dev.cangiano.orrery.TimeSource;
import dev.cangiano.orrery.sim.Arena;
import dev.cangiano.orrery.sim.Body;
import dev.cangiano.orrery.sim.Bot;
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

    private final ObjectMapper json = new ObjectMapper();
    private final World world = new World(Arena.WIDTH, Arena.HEIGHT);
    private final Map<WsContext, Player> players = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    private final Body star = world.add(new Body(Arena.STAR_ID,
            Arena.WIDTH / 2, Arena.HEIGHT / 2, Arena.STAR_RADIUS, Arena.STAR_MASS));

    private final int[] score = new int[2];
    private final List<Body> fragments = new ArrayList<>();
    private final List<Bot> bots = new ArrayList<>();
    private long botShoveReady;

    /**
     * Bots off with ORRERY_BOTS=0.
     *
     * <p>Used by the prediction check, which measures how closely a client's own
     * prediction tracks the server. A bot is another player, and another
     * player's INTENT is the one thing a client cannot predict, so leaving bots
     * on would mix an unavoidable and well-understood error into the number that
     * is supposed to isolate prediction fidelity.
     */
    private final boolean botsEnabled =
            !"0".equals(System.getenv("ORRERY_BOTS"));
    /** Ticks left of the pause after a goal. Inputs are ignored while it runs. */
    private int freeze;
    /** Team that won the match in progress, or -1 while it is still being played. */
    private int winner = -1;

    /**
     * What the room is doing.
     *
     * <p>LOBBY means nobody has taken a side yet and there is nothing to
     * simulate that anyone can affect. COUNTDOWN is the five seconds after
     * somebody readies up, which exists so a match does not begin while you are
     * still finding the keyboard. PLAYING is everything else, including the
     * pauses after a goal, which are their own thing and were here first.
     */
    private enum Phase { LOBBY, COUNTDOWN, PLAYING }

    private Phase phase = Phase.LOBBY;
    private int countdown;

    private Javalin app;
    private Thread simThread;
    private volatile boolean running;

    /** One intent from a client, addressed to a specific server tick. */
    private record Command(long seq, long tick, double ax, double ay,
            boolean shove, boolean tether, long renderTick) {}

    /** What the server knows about one connection. */
    private static final class Player {
        final int id;
        /** The side this player chose, or -1 while they are still in the lobby. */
        volatile int team = -1;
        /**
         * Which spawn slot on that side. Fixed when the side is chosen and kept,
         * because working it out again from the player id at reset time put two
         * team mates on the same spot and marched later joiners off the middle.
         */
        volatile int seat;
        /** Written by network threads, read by the sim thread. Slot is tick % INPUT_RING. */
        final AtomicReferenceArray<Command> ring = new AtomicReferenceArray<>(INPUT_RING);
        // Only the sim thread touches these.
        Command lastApplied = new Command(0, 0, 0, 0, false, false, 0);
        volatile long ack;
        volatile long missed;
        /** The tick this player may shove again. Only the sim thread writes it. */
        volatile long shoveReadyTick;
        /** When anything was last heard from this socket. */
        volatile long lastSeenNanos = System.nanoTime();
        /** Anchor this player is roped to, or null. Sim thread only. */
        Body anchor;
        double tetherLength;

        Player(int id) {
            this.id = id;
        }
    }

    public void start(int port) {
        for (int i = 0; i < Arena.FRAGMENTS.length; i++) {
            Body f = new Body(Arena.FIRST_FRAGMENT_ID - i,
                    Arena.FRAGMENTS[i][0], Arena.FRAGMENTS[i][1],
                    Arena.FRAGMENT_RADIUS, 1);
            f.immovable = true;
            fragments.add(world.add(f));
        }

        app = Javalin.create(cfg -> cfg.staticFiles.add("/public",
                io.javalin.http.staticfiles.Location.CLASSPATH));

        app.ws("/ws", ws -> {
            ws.onConnect(ctx -> {
                int id = nextId.getAndIncrement();
                Player p = new Player(id);
                players.put(ctx, p);

                // No body yet. A player watches from the lobby until they pick
                // a side, which is also what makes spectating free: a connection
                // with no team is simply a connection with no body.
                ctx.send(write(Messages.Welcome.of(id, Arena.WIDTH, Arena.HEIGHT, TICK_HZ,
                        THRUST, World.MAX_SPEED, World.WALL_RESTITUTION,
                        World.BODY_RESTITUTION, Arena.JAWS_HALF_HEIGHT,
                        Arena.SHOVE_RANGE, Arena.SHOVE_IMPULSE, Arena.SHOVE_COOLDOWN,
                        Arena.TETHER_REACH, Arena.TETHER_MAX_LENGTH)));
                System.out.printf("player %d connected, in the lobby (%d online)%n",
                        id, players.size());
            });

            ws.onMessage(ctx -> {
                Player p = players.get(ctx);
                if (p == null) {
                    return;
                }
                p.lastSeenNanos = System.nanoTime();
                JsonNode node = json.readTree(ctx.message());
                String type = node.path("t").asText();

                if ("pick".equals(type)) {
                    pickTeam(p, node.path("team").asInt(0));
                    return;
                }
                if ("leave".equals(type)) {
                    leaveTeam(p);
                    return;
                }
                if (!"input".equals(type)) {
                    return;
                }
                long forTick = node.path("tick").asLong(0);
                // Clamp rather than trust. A client is free to send ax=1e9.
                Command c = new Command(
                        node.path("seq").asLong(0),
                        forTick,
                        clamp(node.path("ax").asDouble(0), -1, 1),
                        clamp(node.path("ay").asDouble(0), -1, 1),
                        node.path("sh").asBoolean(false),
                        node.path("th").asBoolean(false),
                        node.path("rt").asLong(0));
                p.ring.set((int) Math.floorMod(forTick, INPUT_RING), c);
            });

            ws.onClose(ctx -> removePlayer(ctx));
            ws.onError(ctx -> removePlayer(ctx));
        });

        app.start(port);
        startSimulation();
        System.out.printf("orrery listening on http://localhost:%d%n", port);
    }

    /**
     * Take a side and get a body.
     *
     * <p>Readying up is what starts the countdown, and only from the lobby: a
     * player joining a match already in progress drops straight into it rather
     * than resetting everyone else's game.
     */
    private void pickTeam(Player p, int team) {
        if (team != 0 && team != 1) {
            return;
        }
        /*
         * Sides may never differ by more than one.
         *
         * Nothing stopped two people both choosing Norse, so both spawned on the
         * same half against nobody, which is the "both teams start on the same
         * side" that was reported. The client offers the emptier side on ENTER
         * and greys out a full one, and this is the rule underneath that: the
         * server decides, because the client can be wrong or old.
         */
        if (p.team != team && countTeam(team) > countTeam(1 - team)) {
            ctxOf(p).ifPresent(ctx -> ctx.send(write(new java.util.HashMap<>(java.util.Map.of(
                    "t", "denied", "reason", "that side is full")))));
            return;
        }
        synchronized (world) {
            p.team = team;
            p.seat = Math.max(countTeam(team) - 1, 0);
            if (world.byId(p.id) == null) {
                world.add(new Body(p.id, Arena.spawnX(team), Arena.spawnY(p.seat),
                        Arena.PLAYER_RADIUS, Arena.PLAYER_MASS));
            }
            if (phase == Phase.LOBBY) {
                phase = Phase.COUNTDOWN;
                countdown = Arena.COUNTDOWN_TICKS;
                score[0] = 0;
                score[1] = 0;
                winner = -1;
                resetPositions();
            }
        }
        System.out.printf("player %d took team %d%n", p.id, team);
        balanceBots();
    }

    /**
     * Give up your side and go back to watching, without dropping the socket.
     *
     * <p>This is deliberately not the same code path as a disconnect. A
     * disconnect must be treated as temporary, because a client that reconnects
     * a moment later has to find the match still running; that is why
     * {@link #removePlayer} only resets an empty room. Leaving is a decision,
     * so when the last person with a side leaves the match really is over and
     * the room goes back to the lobby with the score cleared.
     */
    private void leaveTeam(Player p) {
        if (p.team < 0) {
            return;
        }
        synchronized (world) {
            p.team = -1;
            // The body goes with the side. A player in the lobby is a
            // connection with no body, which is the same state they arrived in.
            world.remove(p.id);
            if (readyHumans() == 0) {
                phase = Phase.LOBBY;
                countdown = 0;
                winner = -1;
                score[0] = 0;
                score[1] = 0;
                resetPositions();
            }
        }
        System.out.printf("player %d went back to the lobby%n", p.id);
        balanceBots();
    }

    /** The socket belonging to a player, for the rare message aimed at one person. */
    private java.util.Optional<WsContext> ctxOf(Player target) {
        for (Map.Entry<WsContext, Player> e : players.entrySet()) {
            if (e.getValue() == target) {
                return java.util.Optional.of(e.getKey());
            }
        }
        return java.util.Optional.empty();
    }

    private int countTeam(int team) {
        int n = 0;
        for (Player p : players.values()) {
            if (p.team == team) {
                n++;
            }
        }
        return n;
    }

    /** Everyone who has taken a side. Bots do not count as reasons to keep playing. */
    private int readyHumans() {
        int n = 0;
        for (Player p : players.values()) {
            if (p.team >= 0) {
                n++;
            }
        }
        return n;
    }

    private void removePlayer(WsContext ctx) {
        Player p = players.remove(ctx);
        if (p != null) {
            synchronized (world) {
                world.remove(p.id);
            }
            System.out.printf("player %d left (%d online)%n", p.id, players.size());
            balanceBots();
            /*
             * Only an empty room goes back to the lobby.
             *
             * This used to trigger whenever nobody had a team, which included
             * the instant between a client's socket dropping and its automatic
             * reconnect. The match was wiped, the score was reset, and from the
             * player's side the round simply stopped half way through, which is
             * exactly what was reported. A brief disconnect must cost you your
             * body and nothing else.
             */
            if (players.isEmpty()) {
                synchronized (world) {
                    phase = Phase.LOBBY;
                    countdown = 0;
                    winner = -1;
                    score[0] = 0;
                    score[1] = 0;
                    resetPositions();
                }
                System.out.println("room empty, back to the lobby");
            }
        }
    }

    /**
     * Keep exactly one opponent on the far side while a single person is
     * playing, and get out of the way the moment a second person arrives.
     *
     * <p>A bot is a body in the world like any other, so a client predicts and
     * draws it without knowing the difference. That is the point: if the bot
     * needed special handling on the client, it would also be a second code
     * path through everything that matters.
     */
    private void balanceBots() {
        if (!botsEnabled) {
            return;
        }
        synchronized (world) {
            int humans = readyHumans();
            int wanted = humans == 1 ? 1 : 0;
            while (bots.size() > wanted) {
                Bot gone = bots.remove(bots.size() - 1);
                world.remove(gone.id);
                System.out.printf("bot %d left%n", gone.id);
            }
            while (bots.size() < wanted) {
                // Take an id on the opposite team to the lone human.
                int humanTeam = 0;
                for (Player pl : players.values()) {
                    if (pl.team >= 0) {
                        humanTeam = pl.team;
                    }
                }
                int id = nextId.getAndIncrement();
                // Take an id whose fallback team is the opposite side, since a
                // bot has no lobby to choose in.
                if (Arena.teamOf(id) == humanTeam) {
                    id = nextId.getAndIncrement();
                }
                Bot bot = new Bot(id);
                bots.add(bot);
                world.add(new Body(id, Arena.spawnX(bot.team), Arena.spawnY(id / 2),
                        Arena.PLAYER_RADIUS, Arena.PLAYER_MASS));
                System.out.printf("bot %d joined team %d%n", id, bot.team);
            }
        }
    }

    private void startSimulation() {
        running = true;
        simThread = new Thread(this::simulationLoop, "sim");
        simThread.setDaemon(true);
        simThread.start();
    }

    /**
     * Drop players who have gone quiet.
     *
     * <p>A socket does not always close politely. A tab that is killed, a
     * machine that sleeps, a network that vanishes: the server keeps the
     * connection, keeps the body, and an abandoned god stands in the middle of
     * the arena forever. That is the third player nobody could account for.
     *
     * <p>Only applied to players who have taken a side, because they are the
     * ones sending sixty inputs a second. Somebody sitting in the lobby is
     * silent by design and costs nothing but a socket.
     */
    private void dropSilentPlayers() {
        long now = System.nanoTime();
        for (Map.Entry<WsContext, Player> e : players.entrySet()) {
            Player p = e.getValue();
            if (p.team < 0) {
                continue;
            }
            if (now - p.lastSeenNanos > 10_000_000_000L) {
                System.out.printf("player %d silent for 10s, dropping%n", p.id);
                removePlayer(e.getKey());
                try {
                    e.getKey().closeSession();
                } catch (Exception ignored) {
                    // Already gone, which is the usual reason we are here.
                }
            }
        }
    }

    private void simulationLoop() {
        FixedTickLoop loop = new FixedTickLoop(TICK_HZ, 5, TimeSource.SYSTEM);
        long lastReport = System.nanoTime();
        long ticksAtLastReport = 0;

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
                        } else if (c == null && p.team >= 0) {
                            // Nothing addressed to this tick arrived in time.
                            // Hold the last intent: a dropped packet should read
                            // as a stutter, not as the thruster cutting out.
                            //
                            // Only counted for players who are actually in the
                            // match. Someone sitting in the lobby sends nothing
                            // by design, and counting that as a lost input made
                            // the diagnostic read 240 misses before the game had
                            // even started.
                            p.missed++;
                        }
                        Body b = world.byId(p.id);
                        // Nobody thrusts during the pause after a goal, or while
                        // the countdown is running. The reset is only legible if
                        // the world holds still for it.
                        if (b != null && freeze == 0 && phase == Phase.PLAYING) {
                            // A shove fires only on the tick its own input was
                            // applied, never from a held intent. Holding an
                            // intent across a dropped packet is right for a
                            // thruster and wrong for a one-shot action: it would
                            // fire again the moment the cooldown lapsed, on a
                            // tick the player never asked for.
                            // Tether is a hold: the line is out while the key is
                            // down and drops the moment it is released, so the
                            // held intent is exactly right here, unlike the shove.
                            if (p.lastApplied.tether()) {
                                if (p.anchor == null) {
                                    p.anchor = nearestAnchor(b);
                                    if (p.anchor != null) {
                                        double dx = b.x - p.anchor.x;
                                        double dy = b.y - p.anchor.y;
                                        // Rope is exactly as long as the throw,
                                        // capped, so a distant catch does not
                                        // hand out a huge orbit for free.
                                        p.tetherLength = Math.min(
                                                Math.sqrt(dx * dx + dy * dy),
                                                Arena.TETHER_MAX_LENGTH);
                                    }
                                }
                            } else {
                                p.anchor = null;
                            }
                            if (p.anchor != null) {
                                World.applyTether(b, p.anchor.x, p.anchor.y, p.tetherLength);
                            }

                            boolean asked = c != null && c.tick() == tick && c.shove();
                            if (asked && tick >= p.shoveReadyTick) {
                                /*
                                 * No rewind here, deliberately, and it was
                                 * measured rather than assumed.
                                 *
                                 * The usual reason to rewind is that a client
                                 * aims at stale positions. This client does not
                                 * hold stale positions: it mirrors the whole
                                 * world and carries every body forward by
                                 * inertia, so for anything without an input, the
                                 * star and the fragments, its idea of the present
                                 * IS the server's. Rewinding those to the tick of
                                 * the last snapshot put the server BEHIND the
                                 * client and prediction error went from 0.000000
                                 * to 0.124 units.
                                 *
                                 * What a client genuinely cannot know is another
                                 * player's intent. That is a real gap, and the
                                 * answer to it is not to rewind everything; it
                                 * is that the correction arrives within one
                                 * snapshot. Revisit if player-to-player shoving
                                 * ever feels wrong in real play with real
                                 * latency, which is a question two humans answer
                                 * and this file cannot.
                                 */
                                world.shove(b, Arena.SHOVE_RANGE, Arena.SHOVE_IMPULSE);
                                p.shoveReadyTick = tick + Arena.SHOVE_COOLDOWN;
                            }
                            b.applyForce(p.lastApplied.ax() * THRUST,
                                    p.lastApplied.ay() * THRUST, dt);
                        }
                    }
                    for (Bot bot : bots) {
                        Body b = world.byId(bot.id);
                        if (b == null || freeze > 0 || phase != Phase.PLAYING) {
                            continue;
                        }
                        bot.think(b, star);
                        if (bot.shove && tick >= botShoveReady) {
                            world.shove(b, Arena.SHOVE_RANGE, Arena.SHOVE_IMPULSE);
                            botShoveReady = tick + Arena.SHOVE_COOLDOWN;
                        }
                        double botThrust = THRUST * Bot.thrustScale();
                        b.applyForce(bot.ax * botThrust, bot.ay * botThrust, dt);
                    }

                    world.step(dt);

                    if (phase == Phase.COUNTDOWN) {
                        countdown--;
                        if (countdown <= 0) {
                            phase = Phase.PLAYING;
                            System.out.println("kick off");
                        }
                    }

                    if (freeze > 0) {
                        freeze--;
                        if (freeze == 0 && winner >= 0) {
                            // The end-of-match pause is over: wipe the score and
                            // start again, rather than leaving a finished match
                            // on screen with nothing to do.
                            score[0] = 0;
                            score[1] = 0;
                            winner = -1;
                            resetPositions();
                            System.out.println("new match");
                        }
                    } else if (phase == Phase.PLAYING) {
                        int scorer = Arena.scoringTeam(star);
                        if (scorer >= 0) {
                            score[scorer]++;
                            resetPositions();
                            if (score[scorer] >= Arena.GOALS_TO_WIN) {
                                winner = scorer;
                                freeze = Arena.MATCH_END_TICKS;
                                System.out.printf("team %d wins  (%d - %d)%n",
                                        scorer, score[0], score[1]);
                            } else {
                                freeze = Arena.RESET_TICKS;
                                System.out.printf("goal for team %d  (%d - %d)%n",
                                        scorer, score[0], score[1]);
                            }
                        }
                    }
                }
                if (tick % SNAPSHOT_EVERY == 0) {
                    broadcast(tick);
                }
                if (tick % TICK_HZ == 0) {
                    dropSilentPlayers();
                }
            });

            long now = System.nanoTime();
            if (now - lastReport > 30_000_000_000L) {
                long ticks = loop.tickNumber();
                double seconds = (now - lastReport) / 1e9;
                System.out.printf("tick rate %.2f/s  dropped %d  players %d%n",
                        (ticks - ticksAtLastReport) / seconds, loop.droppedTicks(),
                        players.size());
                ticksAtLastReport = ticks;
                lastReport = now;
            }

            // Sleep most of the way to the deadline, then spin the rest.
            // Sleeping the whole way overshoots by up to 15ms on macOS; spinning
            // the whole way burns a core for nothing.
            long until = loop.nanosUntilNextTick();
            if (until > 2_000_000L) {
                try {
                    Thread.sleep((until - 1_000_000L) / 1_000_000L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            } else if (until > 0) {
                Thread.onSpinWait();
            }
        }
    }

    /**
     * The nearest thing worth roping to: a ring fragment or the star.
     *
     * <p>Players are deliberately not anchors. Roping to another player is a
     * good idea for a later version and a bad one to add at the same time as
     * the tether itself, because it makes prediction depend on someone else's
     * input rather than only on their position.
     */
    private Body nearestAnchor(Body from) {
        Body best = null;
        double bestDist = Arena.TETHER_REACH;
        for (Body b : world.bodies()) {
            if (b.id >= 0) {
                continue;   // players are not anchors
            }
            double dx = b.x - from.x;
            double dy = b.y - from.y;
            double dist = Math.sqrt(dx * dx + dy * dy) - b.radius;
            if (dist < bestDist) {
                bestDist = dist;
                best = b;
            }
        }
        return best;
    }

    /** Everything back where it started, at rest. Called after a goal. */
    private void resetPositions() {
        star.x = Arena.WIDTH / 2;
        star.y = Arena.HEIGHT / 2;
        star.vx = 0;
        star.vy = 0;
        for (Player p : players.values()) {
            Body b = world.byId(p.id);
            if (b != null) {
                b.x = Arena.spawnX(p.team >= 0 ? p.team : Arena.teamOf(p.id));
                b.y = Arena.spawnY(p.seat);
                b.vx = 0;
                b.vy = 0;
            }
            p.anchor = null;
        }
        for (Bot bot : bots) {
            Body b = world.byId(bot.id);
            if (b != null) {
                b.x = Arena.spawnX(bot.team);
                b.y = Arena.spawnY(bot.id / 2);
                b.vx = 0;
                b.vy = 0;
            }
        }
    }

    private void broadcast(long tick) {
        List<Messages.BodyState> states;
        synchronized (world) {
            states = new ArrayList<>(world.bodies().size());
            for (Body b : world.bodies()) {
                int team = -1;
                if (b.id >= 0) {
                    Player owner = null;
                    for (Player pl : players.values()) {
                        if (pl.id == b.id) {
                            owner = pl;
                        }
                    }
                    team = owner != null ? owner.team : Arena.teamOf(b.id);
                }
                int anchorId = 0;
                double ropeLength = 0;
                for (Player p : players.values()) {
                    if (p.id == b.id && p.anchor != null) {
                        anchorId = p.anchor.id;
                        ropeLength = p.tetherLength;
                    }
                }
                states.add(new Messages.BodyState(b.id, b.x, b.y, b.vx, b.vy,
                        b.radius, b.mass, team, b.immovable, anchorId, ropeLength));
            }
        }
        // Each client gets its own frame, because ack is per client.
        for (Map.Entry<WsContext, Player> e : players.entrySet()) {
            WsContext ctx = e.getKey();
            if (ctx.session.isOpen()) {
                Player p = e.getValue();
                ctx.send(write(Messages.Snapshot.of(tick, p.ack, p.missed,
                        score[0], score[1], freeze, p.shoveReadyTick,
                        phase.name().toLowerCase(), countdown,
                        countTeam(0), countTeam(1), winner, states)));
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
