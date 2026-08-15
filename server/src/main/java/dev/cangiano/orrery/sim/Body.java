package dev.cangiano.orrery.sim;

/**
 * A circular body in the arena. Mutable on purpose: the simulation steps
 * thousands of these per second and allocating a replacement every tick would
 * hand the garbage collector a job it doesn't need.
 *
 * <p>Everything is in world units and seconds. One world unit is roughly a
 * player radius, which keeps the numbers small enough to read in a log.
 */
public final class Body {

    public final int id;
    public final double radius;
    public final double mass;

    public double x;
    public double y;
    public double vx;
    public double vy;

    public Body(int id, double x, double y, double radius, double mass) {
        if (mass <= 0) {
            throw new IllegalArgumentException("mass must be positive, was " + mass);
        }
        this.id = id;
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.mass = mass;
    }

    /** Apply a force for one tick. Zero-g: no drag, no friction, nothing stops you. */
    public void applyForce(double fx, double fy, double dt) {
        vx += (fx / mass) * dt;
        vy += (fy / mass) * dt;
    }

    /** Speed in world units per second. */
    public double speed() {
        return Math.hypot(vx, vy);
    }

    /**
     * Hold speed under a ceiling without changing direction.
     *
     * <p>A cap exists because zero-g plus a thruster is unbounded, and a body
     * moving faster than its own diameter per tick tunnels straight through
     * walls that a discrete collision check only samples once.
     */
    public void clampSpeed(double max) {
        double s = speed();
        if (s > max && s > 0) {
            double k = max / s;
            vx *= k;
            vy *= k;
        }
    }
}
