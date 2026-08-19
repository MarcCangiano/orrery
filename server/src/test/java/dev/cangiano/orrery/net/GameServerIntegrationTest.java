package dev.cangiano.orrery.net;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * End to end: a real socket, a real server, a real tick loop.
 *
 * <p>Uses the JDK's own WebSocket client rather than pulling in a test-only
 * dependency. Slower than a unit test and worth it, because everything
 * interesting here lives in the seam between the network thread and the one
 * thread allowed to touch the simulation.
 */
class GameServerIntegrationTest {

    private final ObjectMapper json = new ObjectMapper();
    private GameServer server;

    @AfterEach
    void tearDown() {
        if (server != null) {
            server.stop();
        }
    }

    private static int freePort() throws Exception {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    /** Collects text frames and hands out the ones a test is waiting for. */
    private static final class Collector implements WebSocket.Listener {
        final List<String> messages = new ArrayList<>();
        final CountDownLatch welcomed = new CountDownLatch(1);
        private final StringBuilder partial = new StringBuilder();

        @Override
        public void onOpen(WebSocket ws) {
            ws.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            partial.append(data);
            if (last) {
                String msg = partial.toString();
                partial.setLength(0);
                synchronized (messages) {
                    messages.add(msg);
                }
                if (msg.contains("\"welcome\"")) {
                    welcomed.countDown();
                }
            }
            ws.request(1);
            return CompletableFuture.completedFuture(null);
        }
    }

    /**
     * The health check has to be able to go red, and this is the only test that
     * proves it.
     *
     * <p>It exists because of a real outage: the sim thread died, / kept
     * returning the page, the platform's check kept passing, and the game was
     * unplayable for a day and a half with nothing anywhere saying so. A check
     * that cannot fail is not a check, so this one is watched failing.
     */
    @Test
    void healthGoesRedWhenTheSimulationStops() throws Exception {
        int port = freePort();
        server = new GameServer();
        server.start(port);

        HttpClient http = HttpClient.newHttpClient();
        HttpRequest health = HttpRequest.newBuilder(
                URI.create("http://localhost:" + port + "/health")).build();

        // Give the loop a moment to take its first tick.
        Thread.sleep(200);
        HttpResponse<String> live = http.send(health, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, live.statusCode(), "a ticking server should be healthy");
        assertTrue(live.body().startsWith("ok"), live.body());

        // The exact shape of the outage: web server up, simulation gone.
        server.stopSimulationForTest();
        Thread.sleep(2_100);        // longer than STALE_NANOS

        HttpResponse<String> dead = http.send(health, HttpResponse.BodyHandlers.ofString());
        assertEquals(503, dead.statusCode(), "a stopped simulation should fail the check");
        assertTrue(dead.body().contains("SIMULATION STOPPED"), dead.body());
    }

    @Test
    void aClientJoinsThrustsAndSeesItsOwnBodyMove() throws Exception {
        int port = freePort();
        server = new GameServer();
        server.start(port);

        Collector collector = new Collector();
        WebSocket ws = HttpClient.newHttpClient()
                .newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), collector)
                .get(5, TimeUnit.SECONDS);

        assertTrue(collector.welcomed.await(5, TimeUnit.SECONDS), "server never said welcome");

        JsonNode welcome = firstMatching(collector, "welcome");
        assertNotNull(welcome);
        int myId = welcome.get("id").asInt();
        assertTrue(myId > 0);
        assertTrue(welcome.get("w").asDouble() > 0, "welcome must describe the arena");

        // Players arrive in the lobby without a body and have to take a side.
        ws.sendText("{\"t\":\"pick\",\"team\":0}", true).get();
        Thread.sleep(200);

        // Inputs are addressed to a server tick, so the test has to aim ahead of
        // the server the same way a real client does. It learns the current tick
        // from a snapshot and fills the next stretch of ticks with the same
        // intent, which covers whatever the server reaches while these are in
        // flight.
        assertNotNull(awaitSnapshot(collector), "no snapshot arrived to take a tick from");
        awaitPlaying(collector);

        long seq = 0;
        for (int round = 0; round < 6; round++) {
            JsonNode latest = lastMatching(collector, "state");
            assertNotNull(latest, "no snapshot to take the tick from");
            long from = latest.get("tick").asLong() + 2;
            for (long tick = from; tick < from + 12; tick++) {
                seq++;
                ws.sendText("{\"t\":\"input\",\"seq\":" + seq + ",\"tick\":" + tick
                        + ",\"ax\":1,\"ay\":0}", true).get();
            }
            Thread.sleep(120);
        }
        Thread.sleep(200); // let the snapshots catch up

        JsonNode last = lastMatching(collector, "state");
        assertNotNull(last, "no snapshots arrived");

        JsonNode me = null;
        for (JsonNode b : last.get("bodies")) {
            if (b.get("id").asInt() == myId) {
                me = b;
            }
        }
        assertNotNull(me, "my own body was missing from the snapshot");
        assertTrue(me.get("vx").asDouble() > 1.0,
                "thrusting right should build real velocity, was " + me.get("vx"));
        assertEquals(0.0, me.get("vy").asDouble(), 1e-9, "and should not drift on the other axis");
        assertTrue(last.get("ack").asLong() > 0, "server must echo the input sequence it consumed");
        assertTrue(last.has("missed"), "snapshots must report inputs that arrived too late");

        ws.sendClose(WebSocket.NORMAL_CLOSURE, "done").get(2, TimeUnit.SECONDS);
    }

    @Test
    void aSecondClientSeesTheFirstOne() throws Exception {
        int port = freePort();
        server = new GameServer();
        server.start(port);

        Collector one = new Collector();
        WebSocket wsOne = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), one)
                .get(5, TimeUnit.SECONDS);
        assertTrue(one.welcomed.await(5, TimeUnit.SECONDS));

        Collector two = new Collector();
        WebSocket wsTwo = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), two)
                .get(5, TimeUnit.SECONDS);
        assertTrue(two.welcomed.await(5, TimeUnit.SECONDS));

        wsOne.sendText("{\"t\":\"pick\",\"team\":0}", true).get();
        wsTwo.sendText("{\"t\":\"pick\",\"team\":1}", true).get();
        Thread.sleep(400);

        JsonNode snapshot = lastMatching(two, "state");
        assertNotNull(snapshot);

        int players = 0;
        int stars = 0;
        int fragments = 0;
        for (JsonNode b : snapshot.get("bodies")) {
            int id = b.get("id").asInt();
            if (id == dev.cangiano.orrery.sim.Arena.STAR_ID) {
                stars++;
            } else if (id <= dev.cangiano.orrery.sim.Arena.FIRST_FRAGMENT_ID) {
                fragments++;
                assertTrue(b.get("fixed").asBoolean(), "fragments must be marked immovable");
            } else {
                players++;
            }
        }
        assertEquals(2, players, "both players should be in the world");
        assertEquals(1, stars, "and so should the star");
        assertEquals(dev.cangiano.orrery.sim.Arena.FRAGMENTS.length, fragments,
                "and every ring fragment");
        assertTrue(snapshot.has("scoreA") && snapshot.has("scoreB"),
                "snapshots carry the score");
    }

    @Test
    void twoPlayersCannotPileOntoTheSameSide() throws Exception {
        int port = freePort();
        server = new GameServer();
        server.start(port);

        Collector one = new Collector();
        WebSocket wsOne = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), one)
                .get(5, TimeUnit.SECONDS);
        assertTrue(one.welcomed.await(5, TimeUnit.SECONDS));

        Collector two = new Collector();
        WebSocket wsTwo = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), two)
                .get(5, TimeUnit.SECONDS);
        assertTrue(two.welcomed.await(5, TimeUnit.SECONDS));

        // Both ask for Norse. Nothing used to stop them, so both spawned on the
        // same half of the arena with nobody opposing them.
        wsOne.sendText("{\"t\":\"pick\",\"team\":0}", true).get();
        Thread.sleep(250);
        wsTwo.sendText("{\"t\":\"pick\",\"team\":0}", true).get();
        Thread.sleep(400);

        JsonNode snap = lastMatching(two, "state");
        assertNotNull(snap);
        assertEquals(1, snap.get("norse").asInt(), "the second pick must be refused");
        assertEquals(0, snap.get("greek").asInt(), "and must not silently move them either");

        boolean refused = false;
        synchronized (two.messages) {
            for (String m : two.messages) {
                if (m.contains("\"denied\"")) {
                    refused = true;
                }
            }
        }
        assertTrue(refused, "the player must be told why nothing happened");

        // The other side is still open.
        wsTwo.sendText("{\"t\":\"pick\",\"team\":1}", true).get();
        Thread.sleep(400);
        snap = lastMatching(two, "state");
        assertEquals(1, snap.get("greek").asInt(), "and joining the emptier side works");
    }

    @Test
    void aDisconnectDoesNotWipeAMatchInProgress() throws Exception {
        int port = freePort();
        server = new GameServer();
        server.start(port);

        Collector staying = new Collector();
        WebSocket wsStaying = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), staying)
                .get(5, TimeUnit.SECONDS);
        assertTrue(staying.welcomed.await(5, TimeUnit.SECONDS));

        Collector leaving = new Collector();
        WebSocket wsLeaving = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), leaving)
                .get(5, TimeUnit.SECONDS);
        assertTrue(leaving.welcomed.await(5, TimeUnit.SECONDS));

        wsStaying.sendText("{\"t\":\"pick\",\"team\":0}", true).get();
        wsLeaving.sendText("{\"t\":\"pick\",\"team\":1}", true).get();
        awaitPlaying(staying);

        // One of them drops, which is what a browser does for a moment whenever
        // a network hiccups and its client reconnects.
        wsLeaving.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(2, TimeUnit.SECONDS);
        Thread.sleep(600);

        JsonNode snap = lastMatching(staying, "state");
        assertNotNull(snap);
        assertEquals("playing", snap.get("phase").asText(),
                "the round must keep running for whoever is still here");
    }

    @Test
    void aBodyIsNotLeftBehindWhenTheSocketClosesWithoutWarning() throws Exception {
        int port = freePort();
        server = new GameServer();
        server.start(port);

        Collector watcher = new Collector();
        WebSocket wsWatcher = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), watcher)
                .get(5, TimeUnit.SECONDS);
        assertTrue(watcher.welcomed.await(5, TimeUnit.SECONDS));
        wsWatcher.sendText("{\"t\":\"pick\",\"team\":0}", true).get();

        Collector ghost = new Collector();
        WebSocket wsGhost = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), ghost)
                .get(5, TimeUnit.SECONDS);
        assertTrue(ghost.welcomed.await(5, TimeUnit.SECONDS));
        wsGhost.sendText("{\"t\":\"pick\",\"team\":1}", true).get();
        Thread.sleep(500);

        int ghostId = firstMatching(ghost, "welcome").get("id").asInt();
        JsonNode before = lastMatching(watcher, "state");
        assertTrue(hasBody(before, ghostId), "the second player should be on the pitch");

        // Abandon the second connection without closing it: no close frame, no
        // goodbye, exactly what a killed tab or a sleeping laptop does.
        wsGhost.abort();

        // The server gives a quiet player ten seconds before dropping them.
        // Watch for THAT id leaving, not for the player count dropping: a bot
        // takes the empty side the moment it opens up, so the count goes
        // straight back to two and says nothing about the abandoned body.
        boolean gone = false;
        long deadline = System.nanoTime() + 20_000_000_000L;
        while (System.nanoTime() < deadline) {
            JsonNode snap = lastMatching(watcher, "state");
            if (snap != null && !hasBody(snap, ghostId)) {
                gone = true;
                break;
            }
            Thread.sleep(250);
        }
        assertTrue(gone, "an abandoned body must not stand in the arena forever");
    }

    private boolean hasBody(JsonNode snapshot, int id) {
        for (JsonNode b : snapshot.get("bodies")) {
            if (b.get("id").asInt() == id) {
                return true;
            }
        }
        return false;
    }

    /** Waits out the five second countdown, during which nothing moves by design. */
    private void awaitPlaying(Collector c) throws Exception {
        long deadline = System.nanoTime() + 12_000_000_000L;
        while (System.nanoTime() < deadline) {
            JsonNode n = lastMatching(c, "state");
            if (n != null && "playing".equals(n.path("phase").asText())) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("the match never started");
    }

    /** Snapshots start 16ms after connect, so a test that reads one immediately loses the race. */
    private JsonNode awaitSnapshot(Collector c) throws Exception {
        long deadline = System.nanoTime() + 3_000_000_000L;
        while (System.nanoTime() < deadline) {
            JsonNode n = lastMatching(c, "state");
            if (n != null) {
                return n;
            }
            Thread.sleep(20);
        }
        return null;
    }

    private JsonNode firstMatching(Collector c, String type) throws Exception {
        synchronized (c.messages) {
            for (String m : c.messages) {
                JsonNode n = json.readTree(m);
                if (type.equals(n.path("t").asText())) {
                    return n;
                }
            }
        }
        return null;
    }

    private JsonNode lastMatching(Collector c, String type) throws Exception {
        JsonNode found = null;
        synchronized (c.messages) {
            for (String m : c.messages) {
                JsonNode n = json.readTree(m);
                if (type.equals(n.path("t").asText())) {
                    found = n;
                }
            }
        }
        return found;
    }
}
