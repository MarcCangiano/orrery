package dev.cangiano.orrery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class FixedTickLoopTest {

    /** A clock a test can drive by hand, so none of this needs sleeping. */
    private static final class FakeClock implements TimeSource {
        private long nanos;

        @Override
        public long nanos() {
            return nanos;
        }

        void advanceMillis(long millis) {
            nanos += millis * 1_000_000L;
        }
    }

    private static final int HZ = 60;
    private static final long TICK_MILLIS = 1000 / HZ; // 16ms, deliberately not exact

    @Test
    void firstCallEstablishesTheOriginAndRunsNothing() {
        FakeClock clock = new FakeClock();
        clock.advanceMillis(90_000); // pretend the JVM has been up a while
        FixedTickLoop loop = new FixedTickLoop(HZ, 5, clock);

        assertEquals(0, loop.advance((n, dt) -> {}),
                "the first pass must not try to repay every tick since the clock's origin");
    }

    @Test
    void runsOneTickPerElapsedPeriod() {
        FakeClock clock = new FakeClock();
        FixedTickLoop loop = new FixedTickLoop(HZ, 5, clock);
        loop.advance((n, dt) -> {});

        clock.advanceMillis(17); // one 16.66ms period, with change to spare
        assertEquals(1, loop.advance((n, dt) -> {}));

        clock.advanceMillis(17);
        assertEquals(1, loop.advance((n, dt) -> {}));
    }

    @Test
    void subTickAdvancesAccumulateInsteadOfBeingLost() {
        FakeClock clock = new FakeClock();
        FixedTickLoop loop = new FixedTickLoop(HZ, 5, clock);
        loop.advance((n, dt) -> {});

        int ran = 0;
        for (int i = 0; i < 10; i++) {
            clock.advanceMillis(4); // well under one 16.67ms period each time
            ran += loop.advance((n, dt) -> {});
        }
        // A loop that discarded the remainder on each pass would run zero ticks
        // here, because no single pass ever crosses a tick boundary. 40ms of
        // time at 60Hz is two whole periods with 6.67ms left over.
        assertEquals(2, ran, "leftover time must carry, not round away");
    }

    @Test
    void tickNumbersAreContiguousAndDtIsConstant() {
        FakeClock clock = new FakeClock();
        FixedTickLoop loop = new FixedTickLoop(HZ, 16, clock);
        loop.advance((n, dt) -> {});

        List<Long> seen = new ArrayList<>();
        List<Double> deltas = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            clock.advanceMillis(TICK_MILLIS + 1);
            loop.advance((n, dt) -> {
                seen.add(n);
                deltas.add(dt);
            });
        }

        for (int i = 0; i < seen.size(); i++) {
            assertEquals((long) i, seen.get(i), "tick numbers must not skip or repeat");
        }
        for (double d : deltas) {
            assertEquals(1.0 / HZ, d, 1e-12, "every tick advances the world by the same amount");
        }
    }

    @Test
    void aLongStallIsCappedAndTheDebtIsDroppedNotCarried() {
        FakeClock clock = new FakeClock();
        FixedTickLoop loop = new FixedTickLoop(HZ, 5, clock);
        loop.advance((n, dt) -> {});

        clock.advanceMillis(2_000); // a two second stall: 120 ticks owed at 60Hz
        int ran = loop.advance((n, dt) -> {});

        assertEquals(5, ran, "catch-up must be capped or a stall becomes a death spiral");
        assertTrue(loop.droppedTicks() > 100,
                "the ticks we refused to run must be counted, not silently swallowed");

        // The next pass must be back to normal rather than still repaying the debt.
        clock.advanceMillis(17);
        assertEquals(1, loop.advance((n, dt) -> {}));
    }

    @Test
    void aClockThatGoesBackwardsCostsAFrameRatherThanRunningTimeInReverse() {
        FakeClock clock = new FakeClock();
        FixedTickLoop loop = new FixedTickLoop(HZ, 5, clock);
        loop.advance((n, dt) -> {});

        clock.nanos -= 500_000_000L; // half a second backwards
        assertEquals(0, loop.advance((n, dt) -> {}));

        clock.advanceMillis(17);
        assertEquals(1, loop.advance((n, dt) -> {}), "the loop must recover on the next pass");
    }

    @Test
    void alphaReportsHowFarIntoTheNextTickWeAre() {
        FakeClock clock = new FakeClock();
        FixedTickLoop loop = new FixedTickLoop(HZ, 5, clock);
        loop.advance((n, dt) -> {});

        clock.advanceMillis(8); // just under half a period
        loop.advance((n, dt) -> {});

        double alpha = loop.alpha();
        assertTrue(alpha > 0.4 && alpha < 0.6, "alpha should sit near half a tick, was " + alpha);
    }

    @Test
    void rejectsNonsenseConfiguration() {
        assertThrows(IllegalArgumentException.class,
                () -> new FixedTickLoop(0, 5, new FakeClock()));
        assertThrows(IllegalArgumentException.class,
                () -> new FixedTickLoop(HZ, 0, new FakeClock()));
    }
}
