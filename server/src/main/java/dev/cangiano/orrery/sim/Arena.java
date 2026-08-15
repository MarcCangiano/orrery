package dev.cangiano.orrery.sim;

/**
 * The shape of the match: where things start, how big the jaws are, and what
 * counts as a goal.
 *
 * <p>Separated from {@link World}, which knows only about circles and walls and
 * should stay that way. World is the physics; Arena is the game played inside
 * it. Keeping them apart is what lets the browser run the physics without also
 * needing to agree about scoring.
 */
public final class Arena {

    public static final double WIDTH = 120;
    public static final double HEIGHT = 70;

    public static final double PLAYER_RADIUS = 1.6;
    public static final double PLAYER_MASS = 1.0;

    /** The star: heavy enough that one player cannot simply carry it. */
    public static final double STAR_RADIUS = 2.4;
    public static final double STAR_MASS = 4.0;
    public static final int STAR_ID = -1;

    /**
     * Half-height of the jaws, centered vertically on each end wall. A third of
     * the arena: wide enough that a good shot goes in, narrow enough that a
     * lucky bounce usually does not.
     */
    public static final double JAWS_HALF_HEIGHT = HEIGHT / 6;

    /** Ticks the world holds still after a goal, so a score is legible. */
    public static final int RESET_TICKS = 90;

    /** Ticks between the last player readying up and the first kick. */
    public static final int COUNTDOWN_TICKS = 300;

    /** Goals that win a match. */
    public static final int GOALS_TO_WIN = 5;

    /** A longer pause at the end of a match than after an ordinary goal. */
    public static final int MATCH_END_TICKS = 240;

    /** Shove: reach beyond the two radii, impulse at point blank, and the wait. */
    public static final double SHOVE_RANGE = 6.0;
    public static final double SHOVE_IMPULSE = 26.0;
    public static final int SHOVE_COOLDOWN = 40;

    /**
     * Tether: how far a line will reach when thrown, and the longest rope it
     * will pay out. Reach is generous because aiming a grapple with a thruster
     * is hard enough already; the skill is in when you release, not in catching
     * the anchor.
     */
    public static final double TETHER_REACH = 26.0;
    public static final double TETHER_MAX_LENGTH = 22.0;

    /** Ring fragments: immovable lumps of the dead orrery to bounce off and tether to. */
    public static final double FRAGMENT_RADIUS = 3.2;
    public static final int FIRST_FRAGMENT_ID = -100;

    /**
     * Fragment centres, as {x, y} pairs. Four of them, symmetric, off the centre
     * line so the direct shot at the jaws is never simply open.
     */
    public static final double[][] FRAGMENTS = {
        { WIDTH * 0.34, HEIGHT * 0.24 },
        { WIDTH * 0.34, HEIGHT * 0.76 },
        { WIDTH * 0.66, HEIGHT * 0.24 },
        { WIDTH * 0.66, HEIGHT * 0.76 },
    };

    private Arena() {}

    /**
     * Fallback team for an id, used only for bots and for anything that has not
     * chosen. Players pick their own side in the lobby now, so this is no longer
     * the source of truth it used to be.
     */
    public static int teamOf(int playerId) {
        return Math.floorMod(playerId, 2);
    }

    /** Where a player of this team starts, spread out by index within the team. */
    public static double spawnX(int team) {
        return team == 0 ? WIDTH * 0.25 : WIDTH * 0.75;
    }

    public static double spawnY(int indexInTeam) {
        // Alternate above and below the middle so two teammates never overlap.
        double offset = (indexInTeam % 2 == 0 ? 1 : -1) * (6 + 4 * (indexInTeam / 2));
        return HEIGHT / 2 + offset;
    }

    /**
     * Which team just scored, or -1.
     *
     * <p>The check is on the star's centre passing the wall plane rather than on
     * the whole body being through, because the wall bounce in {@link World}
     * will have already stopped it. A goal is therefore "the star reached the
     * end wall inside the jaws", which is the same thing to a player and much
     * simpler to reason about.
     */
    public static int scoringTeam(Body star) {
        boolean insideJaws = Math.abs(star.y - HEIGHT / 2) <= JAWS_HALF_HEIGHT;
        if (!insideJaws) {
            return -1;
        }
        if (star.x <= star.radius + 0.001) {
            return 1;   // reached the left wall, so the right-hand team scored
        }
        if (star.x >= WIDTH - star.radius - 0.001) {
            return 0;
        }
        return -1;
    }
}
