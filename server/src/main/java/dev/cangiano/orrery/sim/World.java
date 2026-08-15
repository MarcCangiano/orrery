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

    /**
     * How much speed survives a body-to-body hit. Higher than the wall, because
     * bouncing off another god should feel like an event and bouncing off the
     * cage should feel like a mistake.
     */
    public static final double BODY_RESTITUTION = 0.9;

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
        resolveCollisions();
    }

    /**
     * One pass of pair collisions, in insertion order.
     *
     * <p>Deliberately a single pass rather than iterating to convergence. One
     * pass is not the most physically accurate answer when three bodies pile
     * up, and it is the same answer every time, which matters more: the browser
     * runs this too, and "mostly converged" is not a reproducible state.
     *
     * <p>O(n^2) over the whole arena. With a dozen bodies that is nothing. If
     * this ever holds hundreds, it wants a spatial grid, not a cleverer loop.
     */
    private void resolveCollisions() {
        int n = bodies.size();
        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                collide(bodies.get(i), bodies.get(j));
            }
        }
    }

    private void collide(Body a, Body b) {
        double dx = b.x - a.x;
        double dy = b.y - a.y;
        double dist = Math.sqrt(dx * dx + dy * dy);
        double minDist = a.radius + b.radius;
        if (dist >= minDist) {
            return;
        }

        double nx;
        double ny;
        if (dist == 0) {
            // Exactly concentric. Pick a direction from the ids so both
            // runtimes pick the same one instead of dividing by zero.
            nx = a.id < b.id ? 1 : -1;
            ny = 0;
            dist = minDist;
        } else {
            nx = dx / dist;
            ny = dy / dist;
        }

        // Push them apart by inverse mass, so a light body does most of the
        // moving. Without this they sink into each other and the impulse below
        // fires every tick.
        double invA = 1.0 / a.mass;
        double invB = 1.0 / b.mass;
        double overlap = minDist - dist;
        double share = overlap / (invA + invB);
        a.x -= nx * share * invA;
        a.y -= ny * share * invA;
        b.x += nx * share * invB;
        b.y += ny * share * invB;

        double rvx = b.vx - a.vx;
        double rvy = b.vy - a.vy;
        double along = rvx * nx + rvy * ny;
        if (along > 0) {
            // Already separating. Applying an impulse now would suck them back
            // together, which reads as a magnet rather than a collision.
            return;
        }

        double impulse = -(1 + BODY_RESTITUTION) * along / (invA + invB);
        a.vx -= impulse * nx * invA;
        a.vy -= impulse * ny * invA;
        b.vx += impulse * nx * invB;
        b.vy += impulse * ny * invB;
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
