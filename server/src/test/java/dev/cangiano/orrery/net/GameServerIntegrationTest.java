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

        // Thrust right for about half a second of wall clock.
        for (int i = 1; i <= 30; i++) {
            ws.sendText("{\"t\":\"input\",\"seq\":" + i + ",\"ax\":1,\"ay\":0}", true).get();
            Thread.sleep(16);
        }
        Thread.sleep(300); // let the snapshots catch up

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
        assertEquals(2, snapshot.get("bodies").size(), "both players should be in the world");
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
