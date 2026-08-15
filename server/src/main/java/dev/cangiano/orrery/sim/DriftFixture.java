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
        if (tick < 120) return 1;
        if (tick < 200) return -1;
        if (tick < 260) return 0;
        if (tick < 400) return 0.5;
        return -0.25;
    }

    public static double ay(int tick) {
        if (tick < 60) return 0;
        if (tick < 180) return -1;
        if (tick < 300) return 1;
        if (tick < 420) return -0.75;
        return 0;
    }

    public static void main(String[] args) {
        World world = new World(W, H);
        Body body = world.add(new Body(1, 12.5, 7.25, RADIUS, MASS));
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
        out.append("  \"start\": { \"x\": 12.5, \"y\": 7.25 },\n");
        out.append("  \"ticks\": [\n");

        for (int tick = 0; tick < TICKS; tick++) {
            body.applyForce(ax(tick) * THRUST, ay(tick) * THRUST, dt);
            world.step(dt);
            out.append("    {\"x\": ").append(Double.toString(body.x))
                    .append(", \"y\": ").append(Double.toString(body.y))
                    .append(", \"vx\": ").append(Double.toString(body.vx))
                    .append(", \"vy\": ").append(Double.toString(body.vy))
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
