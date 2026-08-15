package dev.cangiano.orrery;

import dev.cangiano.orrery.net.GameServer;

/** Starts the server. Port from ORRERY_PORT, default 7070. */
public final class Main {

    public static void main(String[] args) {
        int port = 7070;
        String env = System.getenv("ORRERY_PORT");
        if (env != null && !env.isBlank()) {
            port = Integer.parseInt(env.trim());
        }

        GameServer server = new GameServer();
        server.start(port);
        Runtime.getRuntime().addShutdownHook(new Thread(server::stop));
    }
}
