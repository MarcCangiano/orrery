package dev.cangiano.orrery;

/**
 * A fixed-timestep loop. Every tick advances the simulation by exactly the same
 * amount of time, whatever the machine is doing.
 *
 * <p>This matters more here than in most games. The client re-runs the same
 * physics locally to predict its own body, and re-runs several ticks again
 * whenever the server corrects it. If a tick's duration depended on how long the
 * last frame took, the client and the server would be simulating different
 * worlds and no amount of reconciliation would hide it.
 *
 * <p><b>The catch-up limit is the important part.</b> If the process stalls, a
 * naive loop tries to run every missed tick at once, which takes longer than the
 * stall did, which produces a longer stall. That death spiral is the classic way
 * a game server falls over under load. Here the loop runs at most
 * {@code maxCatchUpTicks} in one pass, throws the rest away, and counts what it
 * dropped so the number can be alerted on rather than discovered in a bug report.
 */
public final class FixedTickLoop {

    /** One step of the simulation. {@code dt} is always the same value. */
    @FunctionalInterface
    public interface Tick {
        void run(long tickNumber, double dt);
    }

    private final long tickNanos;
    private final int maxCatchUpTicks;
    private final TimeSource time;
    private final double dt;

    private long lastNanos;
    private long accumulator;
    private long tickNumber;
    private long droppedTicks;
    private boolean started;

    public FixedTickLoop(int ticksPerSecond, int maxCatchUpTicks, TimeSource time) {
        if (ticksPerSecond <= 0) {
            throw new IllegalArgumentException("ticksPerSecond must be positive");
        }
        if (maxCatchUpTicks <= 0) {
            throw new IllegalArgumentException("maxCatchUpTicks must be positive");
        }
        this.tickNanos = 1_000_000_000L / ticksPerSecond;
        this.maxCatchUpTicks = maxCatchUpTicks;
        this.time = time;
        this.dt = 1.0 / ticksPerSecond;
    }

    /**
     * Run every tick that is due, and no more.
     *
     * <p>Time left over stays in the accumulator, so a caller that polls at an
     * unrelated rate still gets exactly the right number of ticks over any long
     * enough window. Nothing is rounded away.
     *
     * @return how many ticks ran this pass
     */
    public int advance(Tick tick) {
        long now = time.nanos();
        if (!started) {
            // First call establishes the origin. Without this the loop would
            // treat everything since JVM start as time it owed the simulation.
            started = true;
            lastNanos = now;
            return 0;
        }
        long elapsed = now - lastNanos;
        lastNanos = now;
        if (elapsed < 0) {
            // Monotonic clocks are not supposed to go backwards. If one does,
            // losing a frame beats running the simulation in reverse.
            elapsed = 0;
        }
        accumulator += elapsed;

        int ran = 0;
        while (accumulator >= tickNanos && ran < maxCatchUpTicks) {
            accumulator -= tickNanos;
            tick.run(tickNumber++, dt);
            ran++;
        }

        if (accumulator >= tickNanos) {
            // Still behind after the catch-up budget. Drop the debt rather than
            // carry it, because carrying it guarantees the next pass is late too.
            long owed = accumulator / tickNanos;
            droppedTicks += owed;
            accumulator -= owed * tickNanos;
        }
        return ran;
    }

    /** Fraction of the way into the next tick, 0..1. The renderer interpolates with this. */
    public double alpha() {
        return (double) accumulator / tickNanos;
    }

    /** How many ticks have run since the loop started. */
    public long tickNumber() {
        return tickNumber;
    }

    /** Ticks the loop gave up on to avoid a death spiral. Should be zero. Alert if it isn't. */
    public long droppedTicks() {
        return droppedTicks;
    }

    /** Seconds per tick. Constant, by design. */
    public double dt() {
        return dt;
    }
}
