package dev.cangiano.orrery.sim;

/**
 * A server-side player that is not a person.
 *
 * <p>Exists because the demo has to work for one person. A physics arena with
 * nobody in it is a screensaver, and asking someone to find a second human
 * before they can tell whether the game is any good is asking too much.
 *
 * <p>Deliberately simple, and deliberately not hidden behind the word "AI". It
 * steers toward a point, it shoves when the star is in front of it, and it goes
 * home when the star is behind it. That produces something that looks like it is
 * playing, which is the whole requirement. It does not use the tether, because a
 * bot that swings better than a new player would be discouraging rather than
 * useful.
 */
public final class Bot {

    /**
     * How hard the bot may push, against a player's full thrust.
     *
     * <p>It was 1.0, which measured badly: against a player who never moved, the
     * bot scored every six seconds and won a five-goal match in half a minute.
     * Each goal stops the world for a second and a half to reset, so a quarter
     * of the wall clock was spent frozen and the game read as constantly
     * stopping. That was reported three times, each time as something else
     * breaking.
     *
     * <p>The bot is not made stupid, only slower. It still plays the same way,
     * which is what stops it from looking broken.
     */
    private static final double THRUST_SCALE = 0.32;

    /**
     * Ticks between decisions. A person does not re-aim sixty times a second
     * and neither should this: reacting instantly to every frame of the star's
     * motion is most of what made it unbeatable.
     */
    private static final int THINK_EVERY = 16;

    public final int id;
    public final int team;

    /** Ticks since construction, for spacing decisions out. */
    private int sinceThink;

    /** What the world should multiply this bot's thrust by. */
    public static double thrustScale() {
        return THRUST_SCALE;
    }

    /** Where it wants to push, this tick. Read by the server after {@link #think}. */
    public double ax;
    public double ay;
    public boolean shove;

    public Bot(int id) {
        this.id = id;
        this.team = Arena.teamOf(id);
    }

    /**
     * Decide what to do this tick.
     *
     * @param me   the bot's own body
     * @param star the star
     */
    public void think(Body me, Body star) {
        shove = false;
        if (me == null || star == null) {
            ax = 0;
            ay = 0;
            return;
        }

        /*
         * Between decisions, keep pushing the way it last chose.
         *
         * ax and ay are deliberately left alone rather than zeroed: zeroing
         * would make the bot thrust one tick in nine, which is not a slower
         * opponent, it is a broken one. The shove stays false, because a shove
         * is a decision and holding it would fire again the instant the
         * cooldown lapsed, on a tick the bot never chose.
         */
        if (sinceThink++ % THINK_EVERY != 0) {
            return;
        }

        // The jaws this bot is trying to feed, and the ones it defends.
        double attackX = team == 0 ? Arena.WIDTH : 0;
        double defendX = team == 0 ? 0 : Arena.WIDTH;
        double midY = Arena.HEIGHT / 2;

        // Stand off from the star on the side away from the target, so pushing
        // forward sends the star toward the jaws rather than sideways.
        double toGoalX = attackX - star.x;
        double toGoalY = midY - star.y;
        double toGoalLen = Math.sqrt(toGoalX * toGoalX + toGoalY * toGoalY);
        if (toGoalLen == 0) {
            toGoalLen = 1;
        }
        double standoff = star.radius + Arena.PLAYER_RADIUS + 1.5;
        double targetX = star.x - (toGoalX / toGoalLen) * standoff;
        double targetY = star.y - (toGoalY / toGoalLen) * standoff;

        // If the star is already past this bot on the way to its own jaws, stop
        // attacking and get between the star and home.
        boolean starIsBehind = team == 0 ? star.x < me.x - 6 : star.x > me.x + 6;
        boolean starThreatens = Math.abs(star.x - defendX) < Arena.WIDTH * 0.4;
        if (starIsBehind && starThreatens) {
            targetX = star.x + (defendX > star.x ? -1 : 1) * standoff;
            targetY = star.y;
        }

        double dx = targetX - me.x;
        double dy = targetY - me.y;
        double dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 0.4) {
            ax = dx / dist;
            ay = dy / dist;
        } else {
            ax = 0;
            ay = 0;
        }

        /*
         * Zero-g means a bot that only ever thrusts toward its target orbits it
         * forever. Braking when it is closing fast and nearly there is the
         * difference between something that looks like it is playing and
         * something that looks broken.
         */
        double closing = (me.vx * dx + me.vy * dy) / (dist == 0 ? 1 : dist);
        if (dist < 8 && closing > 12) {
            ax = -me.vx;
            ay = -me.vy;
            double len = Math.sqrt(ax * ax + ay * ay);
            if (len > 0) {
                ax /= len;
                ay /= len;
            }
        }

        // Shove when the star is close and roughly between this bot and the
        // jaws it is attacking, which is when a shove actually sends it there.
        double toStarX = star.x - me.x;
        double toStarY = star.y - me.y;
        double toStarLen = Math.sqrt(toStarX * toStarX + toStarY * toStarY);
        if (toStarLen < star.radius + Arena.PLAYER_RADIUS + Arena.SHOVE_RANGE * 0.8) {
            double alignment = (toStarX / (toStarLen == 0 ? 1 : toStarLen))
                    * ((attackX - star.x) / Math.abs(attackX - star.x == 0 ? 1 : attackX - star.x));
            shove = alignment > 0.3;
        }
    }
}
