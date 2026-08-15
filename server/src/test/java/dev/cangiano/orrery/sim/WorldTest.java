package dev.cangiano.orrery.sim;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class WorldTest {

    private static final double DT = 1.0 / 60;

    private static World arena() {
        return new World(100, 60);
    }

    @Test
    void aBodyWithNoForceOnItKeepsGoingForever() {
        World w = arena();
        Body b = w.add(new Body(1, 50, 30, 1, 1));
        b.vx = 10;

        for (int i = 0; i < 60; i++) {
            w.step(DT);
        }

        // One second at 10 units/sec. Zero-g means no drag stealing it back.
        assertEquals(60.0, b.x, 1e-9);
        assertEquals(10.0, b.vx, 1e-9, "nothing slows a body down out here");
    }

    @Test
    void thrustAccelerates() {
        World w = arena();
        Body b = w.add(new Body(1, 50, 30, 1, 2));

        b.applyForce(4, 0, DT); // F = ma, so 2 units/sec^2 for one tick
        assertEquals(4.0 / 2 * DT, b.vx, 1e-12);
    }

    @Test
    void aWallTakesSomeSpeedAndSendsYouBack() {
        World w = arena();
        Body b = w.add(new Body(1, 5, 30, 1, 1));
        b.vx = -20;

        for (int i = 0; i < 60; i++) {
            w.step(DT);
        }

        assertTrue(b.vx > 0, "should be heading away from the wall it hit");
        assertEquals(20 * World.WALL_RESTITUTION, b.vx, 1e-9, "a wall is a cost, not a trampoline");
        assertTrue(b.x >= b.radius, "and it must never end up inside the wall");
    }

    @Test
    void aBodyThatNudgesAWallBouncesOnceRatherThanEveryTick() {
        World w = arena();
        Body b = w.add(new Body(1, 1, 30, 1, 1)); // exactly touching the left wall
        b.vx = -0.0001; // barely drifting into it

        int signFlips = 0;
        double previousVx = b.vx;
        for (int i = 0; i < 240; i++) {
            w.step(DT);
            if (Math.signum(b.vx) != Math.signum(previousVx)) {
                signFlips++;
            }
            previousVx = b.vx;
            assertTrue(b.x >= b.radius - 1e-12, "must never end up inside the wall");
        }

        // Without the "is it still heading into the wall" check, a body sitting
        // on a wall would flip its velocity on all 240 ticks and buzz.
        assertEquals(1, signFlips, "one bounce, not one per tick");
        assertTrue(b.vx > 0, "and afterwards it drifts away, because nothing out here holds it");
    }

    @Test
    void speedIsCappedSoNothingTunnelsThroughAWall() {
        World w = arena();
        Body b = w.add(new Body(1, 50, 30, 1, 1));
        b.vx = 10_000;

        w.step(DT);

        assertTrue(b.speed() <= World.MAX_SPEED + 1e-9, "speed cap must hold, was " + b.speed());
        assertTrue(b.x < w.width, "and the body must still be inside the arena");
    }

    @Test
    void steppingIsDeterministic() {
        // Two identical worlds must not drift apart. The browser runs this same
        // simulation to predict, so this is the property prediction rests on.
        World a = arena();
        World b = arena();
        Body ba = a.add(new Body(1, 12.5, 7.25, 1, 1));
        Body bb = b.add(new Body(1, 12.5, 7.25, 1, 1));
        ba.vx = 13.37;
        ba.vy = -7.91;
        bb.vx = 13.37;
        bb.vy = -7.91;

        for (int i = 0; i < 1000; i++) {
            a.step(DT);
            b.step(DT);
        }

        assertEquals(ba.x, bb.x, 0.0, "bit-identical, not merely close");
        assertEquals(ba.y, bb.y, 0.0);
        assertEquals(ba.vx, bb.vx, 0.0);
        assertEquals(ba.vy, bb.vy, 0.0);
    }
}
