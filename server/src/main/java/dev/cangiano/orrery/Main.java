package dev.cangiano.orrery;

/**
 * Runs the tick loop against the real clock and reports what it actually
 * achieved, rather than what it was configured for.
 *
 * <p>Temporary. This becomes the server entry point once there is a server.
 */
public final class Main {

    private static final int TICKS_PER_SECOND = 60;
    private static final int MAX_CATCH_UP = 5;
    private static final long RUN_SECONDS = 3;

    public static void main(String[] args) throws InterruptedException {
        FixedTickLoop loop = new FixedTickLoop(TICKS_PER_SECOND, MAX_CATCH_UP, TimeSource.SYSTEM);

        long start = System.nanoTime();
        long worstGapNanos = 0;
        long lastTickNanos = start;

        System.out.printf("running %d ticks/sec for %d seconds%n", TICKS_PER_SECOND, RUN_SECONDS);

        while (System.nanoTime() - start < RUN_SECONDS * 1_000_000_000L) {
            loop.advance((tickNumber, dt) -> {
                // The simulation goes here. For now the loop is the subject.
            });

            long now = System.nanoTime();
            if (loop.tickNumber() > 0) {
                long gap = now - lastTickNanos;
                if (gap > worstGapNanos) {
                    worstGapNanos = gap;
                }
                lastTickNanos = now;
            }

            // Hand the core back rather than spinning it. A busy-wait would give
            // a prettier number here and cook a laptop in production.
            Thread.sleep(1);
        }

        double elapsedSeconds = (System.nanoTime() - start) / 1_000_000_000.0;
        double achievedRate = loop.tickNumber() / elapsedSeconds;

        System.out.printf("ticks:      %d%n", loop.tickNumber());
        System.out.printf("rate:       %.2f/sec (target %d)%n", achievedRate, TICKS_PER_SECOND);
        System.out.printf("worst gap:  %.2f ms (budget %.2f ms)%n",
                worstGapNanos / 1_000_000.0, 1000.0 / TICKS_PER_SECOND);
        System.out.printf("dropped:    %d%n", loop.droppedTicks());
    }
}
