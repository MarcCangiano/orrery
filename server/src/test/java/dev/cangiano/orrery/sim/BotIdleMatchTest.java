package dev.cangiano.orrery.sim;

import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.cangiano.orrery.net.GameServer;
import org.junit.jupiter.api.Test;

/**
 * How long does the bot take to score against somebody who never touches the
 * keyboard?
 *
 * <p>Boss reported that at the start of a match, doing nothing, the other side
 * "always misses". Watching the score through a browser said the same thing but
 * with enormous variance: one run had four goals in forty seconds, the next had
 * one in eighty. Variance that wide is not something you can tune against by
 * eye, so this runs the real sim headless and counts.
 *
 * <p>It deliberately mirrors the server loop rather than calling into it: the
 * server owns sockets and phases, and none of that is what is being measured.
 * What is measured is the bot's own decisions against the same physics.
 */
final class BotIdleMatchTest {

    private static final double DT = 1.0 / 60.0;
    private static final int SECONDS = 120;

    /** Goals the bot scores in two minutes, plus how often it fires. */
    private static int[] run() {
        World world = new World(Arena.WIDTH, Arena.HEIGHT);
        Body star = world.add(new Body(Arena.STAR_ID, Arena.WIDTH / 2, Arena.HEIGHT / 2,
                Arena.STAR_RADIUS, Arena.STAR_MASS));
        // Seat 0 is team 0 and seat 1 is team 1, matching Arena.teamOf.
        Body idle = world.add(new Body(0, Arena.spawnX(0), Arena.spawnY(0),
                Arena.PLAYER_RADIUS, Arena.PLAYER_MASS));
        Bot bot = new Bot(3);
        Body botBody = world.add(new Body(3, Arena.spawnX(bot.team), Arena.spawnY(3 / 2),
                Arena.PLAYER_RADIUS, Arena.PLAYER_MASS));
        for (int i = 0; i < Arena.FRAGMENTS.length; i++) {
            double[] f = Arena.FRAGMENTS[i];
            Body frag = new Body(Arena.FIRST_FRAGMENT_ID - i, f[0], f[1],
                    Arena.FRAGMENT_RADIUS, 1);
            // The server pins these. A movable fragment is a different game.
            frag.immovable = true;
            world.add(frag);
        }

        int goals = 0;
        int shoves = 0;
        long shoveReady = 0;
        for (long tick = 0; tick < SECONDS * 60L; tick++) {
            bot.think(botBody, star);
            if (bot.shove && tick >= shoveReady) {
                world.shove(botBody, Arena.SHOVE_RANGE, Arena.SHOVE_IMPULSE);
                shoveReady = tick + Arena.SHOVE_COOLDOWN;
                shoves++;
            }
            botBody.applyForce(bot.ax * GameServer.THRUST * Bot.thrustScale(),
                    bot.ay * GameServer.THRUST * Bot.thrustScale(), DT);
            // The idle player does nothing at all, which is the whole point.
            world.step(DT);

            if (Arena.scoringTeam(star) >= 0) {
                goals++;
                System.out.printf("  goal %d at %.1fs%n", goals, tick / 60.0);
                star.x = Arena.WIDTH / 2;
                star.y = Arena.HEIGHT / 2;
                star.vx = 0;
                star.vy = 0;
                botBody.x = Arena.spawnX(bot.team);
                botBody.y = Arena.spawnY(3 / 2);
                botBody.vx = 0;
                botBody.vy = 0;
                idle.x = Arena.spawnX(0);
                idle.y = Arena.spawnY(0);
                idle.vx = 0;
                idle.vy = 0;
            }
        }
        return new int[] { goals, shoves };
    }

    @Test
    void itScoresAgainstSomebodyStandingStill() {
        int[] r = run();
        System.out.printf("bot vs idle: %d goals, %d shoves in %ds%n", r[0], r[1], SECONDS);
        // Two minutes against a stationary opponent. One goal is the broken
        // behaviour that was reported; the bot is throttled on purpose, so this
        // asserts "it plays", not "it dominates".
        assertTrue(r[0] >= 4, "bot only scored " + r[0] + " in " + SECONDS + "s against an idle player");
        assertTrue(r[1] > 0, "bot never shoved at all");
    }
}
