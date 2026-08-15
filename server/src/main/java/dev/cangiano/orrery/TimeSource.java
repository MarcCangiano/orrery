package dev.cangiano.orrery;

/**
 * Monotonic time in nanoseconds.
 *
 * <p>This exists so the tick loop can be driven by a test instead of by a
 * wall clock. A loop you can only test by sleeping is a loop nobody tests.
 */
@FunctionalInterface
public interface TimeSource {

    /** Nanoseconds from an arbitrary origin. Only differences are meaningful. */
    long nanos();

    /** Real time. {@code System.nanoTime} is monotonic; {@code currentTimeMillis} is not. */
    TimeSource SYSTEM = System::nanoTime;
}
