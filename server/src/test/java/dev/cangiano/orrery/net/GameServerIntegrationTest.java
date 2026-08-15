package dev.cangiano.orrery.net;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
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

        // Inputs are addressed to a server tick, so the test has to aim ahead of
        // the server the same way a real client does. It learns the current tick
        // from a snapshot and fills the next stretch of ticks with the same
        // intent, which covers whatever the server reaches while these are in
        // flight.
        assertNotNull(awaitSnapshot(collector), "no snapshot arrived to take a tick from");

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
        HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), one)
                .get(5, TimeUnit.SECONDS);
        assertTrue(one.welcomed.await(5, TimeUnit.SECONDS));

        Collector two = new Collector();
        HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create("ws://localhost:" + port + "/ws"), two)
                .get(5, TimeUnit.SECONDS);
        assertTrue(two.welcomed.await(5, TimeUnit.SECONDS));

        Thread.sleep(300);

        JsonNode snapshot = lastMatching(two, "state");
        assertNotNull(snapshot);

        int players = 0;
        int stars = 0;
        for (JsonNode b : snapshot.get("bodies")) {
            if (b.get("id").asInt() == dev.cangiano.orrery.sim.Arena.STAR_ID) {
                stars++;
            } else {
                players++;
            }
        }
        assertEquals(2, players, "both players should be in the world");
        assertEquals(1, stars, "and so should the star");
        assertTrue(snapshot.has("scoreA") && snapshot.has("scoreB"),
                "snapshots carry the score");
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
