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

    /**
     * A body nothing can move: the ring fragments the arena is built from.
     * Modelled as infinite mass rather than as a separate type, so collision
     * code stays one code path. Inverse mass is zero, so every impulse divides
     * into nothing and the fragment does not budge.
     */
    public boolean immovable;

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

    /** 1/mass, or zero for something that cannot be moved. */
    public double invMass() {
        return immovable ? 0.0 : 1.0 / mass;
    }

    /** Apply a force for one tick. Zero-g: no drag, no friction, nothing stops you. */
    public void applyForce(double fx, double fy, double dt) {
        if (immovable) {
            return;
        }
        vx += (fx / mass) * dt;
        vy += (fy / mass) * dt;
    }

    /**
     * Speed in world units per second.
     *
     * <p>Deliberately {@code sqrt(vx*vx + vy*vy)} rather than {@code Math.hypot}.
     * Hypot is the better function: it avoids overflow and is correctly rounded
     * here. It is also specified differently in Java and in JavaScript, and the
     * browser runs this same simulation to predict. Two implementations that
     * disagree in the last bit diverge slowly, which is the worst kind of bug to
     * find. Speeds here are small enough that overflow is not a real concern.
     */
    public double speed() {
        return Math.sqrt(vx * vx + vy * vy);
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
