package dev.cangiano.orrery.sim;

import java.util.ArrayList;
import java.util.List;

/**
 * The arena and everything in it.
 *
 * <p><b>This class must stay deterministic.</b> Same bodies plus same inputs
 * plus same tick count has to produce the same result on the server and in the
 * browser, or client prediction can't work. That means no wall-clock reads, no
 * randomness without a seeded generator, and iteration order that never depends
 * on a hash. The JavaScript client re-implements exactly this, so any change
 * here is a change in two places.
 *
 * <p>The cage is a rectangle for now. Bodies bounce off it rather than wrapping,
 * because a wall you can slingshot off is a feature and a wrap-around edge is a
 * way to lose the star.
 */
public final class World {

    /** Speed ceiling in units per second. See {@link Body#clampSpeed}. */
    public static final double MAX_SPEED = 40.0;

    /** How much speed survives a wall bounce. Below 1 so a wall is a mistake, not a trampoline. */
    public static final double WALL_RESTITUTION = 0.75;

    public final double width;
    public final double height;

    private final List<Body> bodies = new ArrayList<>();

    public World(double width, double height) {
        this.width = width;
        this.height = height;
    }

    public Body add(Body body) {
        bodies.add(body);
        return body;
    }

    public void remove(int id) {
        bodies.removeIf(b -> b.id == id);
    }

    /** Insertion-ordered, never hash-ordered. Determinism depends on this. */
    public List<Body> bodies() {
        return bodies;
    }

    public Body byId(int id) {
        for (Body b : bodies) {
            if (b.id == id) {
                return b;
            }
        }
        return null;
    }

    /**
     * Advance the world by exactly one tick.
     *
     * <p>Semi-implicit Euler: velocity first, then position from the new
     * velocity. It is one line different from the explicit version and it stops
     * orbits and bounces from gaining energy out of nowhere.
     */
    public void step(double dt) {
        for (Body b : bodies) {
            b.clampSpeed(MAX_SPEED);
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            bounceOffWalls(b);
        }
    }

    private void bounceOffWalls(Body b) {
        double min = b.radius;
        double maxX = width - b.radius;
        double maxY = height - b.radius;

        if (b.x < min) {
            b.x = min;
            // Only reverse if it is still heading into the wall. Without that
            // check a body resting on a wall flips its velocity every tick and
            // buzzes in place.
            if (b.vx < 0) {
                b.vx = -b.vx * WALL_RESTITUTION;
            }
        } else if (b.x > maxX) {
            b.x = maxX;
            if (b.vx > 0) {
                b.vx = -b.vx * WALL_RESTITUTION;
            }
        }

        if (b.y < min) {
            b.y = min;
            if (b.vy < 0) {
                b.vy = -b.vy * WALL_RESTITUTION;
            }
        } else if (b.y > maxY) {
            b.y = maxY;
            if (b.vy > 0) {
                b.vy = -b.vy * WALL_RESTITUTION;
            }
        }
    }
}
