package dev.cangiano.orrery.sim;

import java.util.Locale;

/**
 * Runs a scripted input sequence through the real simulation and prints every
 * tick as JSON.
 *
 * <p>The JavaScript in {@code tools/drift-check.mjs} replays the identical
 * script through {@code sim.mjs} and compares. If the two ever disagree, client
 * prediction is quietly broken and the symptom players report is "it feels weird
 * sometimes", which is close to impossible to chase down after the fact.
 *
 * <p>Doubles are printed with {@link Double#toString}, which is the shortest
 * representation that round-trips exactly, so the comparison can be for equality
 * rather than for a tolerance. A tolerance would hide precisely the slow
 * divergence this is meant to catch.
 */
public final class DriftFixture {

    public static final int TICKS = 600;
    public static final double THRUST = 60.0;
    public static final int HZ = 60;
    private static final double W = 120;
    private static final double H = 70;
    private static final double RADIUS = 1.6;
    private static final double MASS = 1.0;

    private DriftFixture() {}

    /**
     * The input script. A pure function of tick number so both languages can
     * generate it without sharing data: it thrusts diagonally, reverses, holds
     * long enough to hit the speed cap, and drives into walls on both axes.
     */
    public static double ax(int tick) {
        // Aimed at the star for the opening stretch, because a fixture where the
        // bodies never touch tests the collision code not at all. drift-check
        // fails outright if this stops producing contact.
        // Lined up with the star and driving straight at it. It bounces off,
        // gets pushed back in, and does it again: several separate contacts
        // rather than one glancing pass.
        if (tick < 300) return 1;
        if (tick < 380) return -1;
        return 1;
    }

    public static double ay(int tick) {
        // Small vertical wander so contacts are off-centre and the impulse has
        // to resolve on both axes, plus a wall visit.
        if (tick < 150) return 0;
        if (tick < 240) return -0.4;
        if (tick < 330) return 0.6;
        return 0;
    }

    /** A heavy second body, so the run exercises collisions and not only walls. */
    public static final double STAR_RADIUS = 2.4;
    public static final double STAR_MASS = 4.0;

    public static void main(String[] args) {
        World world = new World(W, H);
        Body body = world.add(new Body(1, 12.5, H / 2, RADIUS, MASS));
        Body star = world.add(new Body(2, W / 2, H / 2, STAR_RADIUS, STAR_MASS));
        double dt = 1.0 / HZ;

        StringBuilder out = new StringBuilder(1 << 16);
        out.append("{\n");
        out.append("  \"hz\": ").append(HZ).append(",\n");
        out.append("  \"thrust\": ").append(Double.toString(THRUST)).append(",\n");
        out.append("  \"maxSpeed\": ").append(Double.toString(World.MAX_SPEED)).append(",\n");
        out.append("  \"restitution\": ").append(Double.toString(World.WALL_RESTITUTION)).append(",\n");
        out.append("  \"width\": ").append(Double.toString(W)).append(",\n");
        out.append("  \"height\": ").append(Double.toString(H)).append(",\n");
        out.append("  \"radius\": ").append(Double.toString(RADIUS)).append(",\n");
        out.append("  \"mass\": ").append(Double.toString(MASS)).append(",\n");
        out.append("  \"start\": { \"x\": 12.5, \"y\": ")
                .append(Double.toString(H / 2)).append(" },\n");
        out.append("  \"star\": { \"x\": ").append(Double.toString(W / 2))
                .append(", \"y\": ").append(Double.toString(H / 2))
                .append(", \"r\": ").append(Double.toString(STAR_RADIUS))
                .append(", \"m\": ").append(Double.toString(STAR_MASS)).append(" },\n");
        out.append("  \"bodyRestitution\": ")
                .append(Double.toString(World.BODY_RESTITUTION)).append(",\n");
        out.append("  \"ticks\": [\n");

        for (int tick = 0; tick < TICKS; tick++) {
            body.applyForce(ax(tick) * THRUST, ay(tick) * THRUST, dt);
            world.step(dt);
            out.append("    {\"x\": ").append(Double.toString(body.x))
                    .append(", \"y\": ").append(Double.toString(body.y))
                    .append(", \"vx\": ").append(Double.toString(body.vx))
                    .append(", \"vy\": ").append(Double.toString(body.vy))
                    .append(", \"sx\": ").append(Double.toString(star.x))
                    .append(", \"sy\": ").append(Double.toString(star.y))
                    .append(", \"svx\": ").append(Double.toString(star.vx))
                    .append(", \"svy\": ").append(Double.toString(star.vy))
                    .append("}");
            out.append(tick == TICKS - 1 ? "\n" : ",\n");
        }

        out.append("  ]\n}\n");
        System.out.print(out);
        System.out.flush();
        // Locale is irrelevant here because Double.toString never localizes,
        // which is exactly why it is used instead of String.format.
        assert Locale.getDefault() != null;
    }
}
