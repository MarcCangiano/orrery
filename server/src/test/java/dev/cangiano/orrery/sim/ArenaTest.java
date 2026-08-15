package dev.cangiano.orrery.sim;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class ArenaTest {

    private static Body starAt(double x, double y) {
        return new Body(Arena.STAR_ID, x, y, Arena.STAR_RADIUS, Arena.STAR_MASS);
    }

    @Test
    void aStarAgainstTheLeftWallInsideTheJawsIsAGoalForTheRightHandTeam() {
        assertEquals(1, Arena.scoringTeam(starAt(Arena.STAR_RADIUS, Arena.HEIGHT / 2)));
    }

    @Test
    void aStarAgainstTheRightWallInsideTheJawsIsAGoalForTheLeftHandTeam() {
        assertEquals(0, Arena.scoringTeam(
                starAt(Arena.WIDTH - Arena.STAR_RADIUS, Arena.HEIGHT / 2)));
    }

    @Test
    void aStarAgainstTheWallOutsideTheJawsIsNothing() {
        double aboveTheJaws = Arena.HEIGHT / 2 - Arena.JAWS_HALF_HEIGHT - 0.5;
        assertEquals(-1, Arena.scoringTeam(starAt(Arena.STAR_RADIUS, aboveTheJaws)));
    }

    @Test
    void aStarInOpenSpaceIsNothingHoweverCentredItLooks() {
        assertEquals(-1, Arena.scoringTeam(starAt(Arena.WIDTH / 2, Arena.HEIGHT / 2)));
    }

    @Test
    void teamsAlternateSoTheSidesStayEven() {
        assertEquals(0, Arena.teamOf(2));
        assertEquals(1, Arena.teamOf(3));
        assertEquals(0, Arena.teamOf(4));
    }

    @Test
    void teammatesDoNotSpawnOnTopOfEachOther() {
        double first = Arena.spawnY(0);
        double second = Arena.spawnY(1);
        assertEquals(true, Math.abs(first - second) > Arena.PLAYER_RADIUS * 2,
                "spawn points must be at least a body apart, were " + first + " and " + second);
    }
}
