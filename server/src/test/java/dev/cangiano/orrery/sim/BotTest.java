package dev.cangiano.orrery.sim;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class BotTest {

    private static Body player(int id, double x, double y) {
        return new Body(id, x, y, Arena.PLAYER_RADIUS, Arena.PLAYER_MASS);
    }

    private static Body star(double x, double y) {
        return new Body(Arena.STAR_ID, x, y, Arena.STAR_RADIUS, Arena.STAR_MASS);
    }

    @Test
    void itMovesTowardsTheStarWhenItIsFarAway() {
        Bot bot = new Bot(2); // team 0, attacking the right-hand jaws
        Body me = player(2, 20, 35);
        bot.think(me, star(60, 35));

        assertTrue(bot.ax > 0.5, "should be heading toward the star, ax was " + bot.ax);
    }

    @Test
    void itPositionsItselfBehindTheStarRatherThanOnIt() {
        // Team 0 attacks the right, so it should approach from the left of the
        // star. Standing on top of the star would push it nowhere useful.
        Bot bot = new Bot(2);
        Body me = player(2, 60, 10);      // directly below the star
        Body theStar = star(60, 35);
        bot.think(me, theStar);

        // Its target is left of the star, so with the star directly above it,
        // the bot should be steering up and to the left.
        assertTrue(bot.ax < 0, "should swing around to the goal side, ax was " + bot.ax);
    }

    @Test
    void itShovesWhenTheStarIsCloseAndInFrontOfTheJawsItAttacks() {
        Bot bot = new Bot(2);            // attacks the right
        Body me = player(2, 55, 35);     // just left of the star
        bot.think(me, star(59, 35));

        assertTrue(bot.shove, "the star is between it and the jaws it wants: shove");
    }

    @Test
    void itDoesNotShoveTheStarBackTowardsItsOwnJaws() {
        Bot bot = new Bot(2);            // attacks the right
        Body me = player(2, 64, 35);     // on the WRONG side of the star
        bot.think(me, star(60, 35));

        assertTrue(!bot.shove, "shoving here would score an own goal");
    }

    @Test
    void itBrakesInsteadOfOrbitingWhenItIsClosingFast() {
        Bot bot = new Bot(2);
        Body me = player(2, 54, 35);
        me.vx = 30;                       // barrelling at the star
        bot.think(me, star(60, 35));

        assertTrue(bot.ax < 0, "should be braking, not adding more speed, ax was " + bot.ax);
    }

    @Test
    void itSurvivesAWorldWithNoStar() {
        Bot bot = new Bot(2);
        bot.think(player(2, 10, 10), null);
        assertTrue(bot.ax == 0 && bot.ay == 0 && !bot.shove);
    }
}
