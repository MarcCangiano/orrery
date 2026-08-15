package dev.cangiano.orrery.net;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * The wire format. JSON while the protocol is still changing shape every hour,
 * because being able to read a frame in a browser inspector is worth more right
 * now than the bytes it costs. This becomes binary before it matters.
 *
 * <p>Field names are short for the same reason they will eventually be binary:
 * a snapshot goes out to every client many times a second.
 */
public final class Messages {

    private Messages() {}

    /** Client says hello. */
    public record Join(@JsonProperty("t") String t, @JsonProperty("name") String name) {}

    /**
     * One tick of intent from a client.
     *
     * <p>{@code seq} is the client's own counter. The server echoes the last one
     * it consumed, which is what lets the client throw away the inputs the
     * server has already accounted for and replay only the rest. Nothing uses
     * that yet; it is here because retrofitting a sequence number into a
     * protocol after the fact is miserable.
     */
    public record Input(
            @JsonProperty("t") String t,
            @JsonProperty("seq") long seq,
            @JsonProperty("ax") double ax,
            @JsonProperty("ay") double ay) {}

    /** Server's answer to a join: who you are and how big the world is. */
    public record Welcome(
            @JsonProperty("t") String t,
            @JsonProperty("id") int id,
            @JsonProperty("w") double w,
            @JsonProperty("h") double h,
            @JsonProperty("hz") int hz) {
        public static Welcome of(int id, double w, double h, int hz) {
            return new Welcome("welcome", id, w, h, hz);
        }
    }

    /** One body in a snapshot. */
    public record BodyState(
            @JsonProperty("id") int id,
            @JsonProperty("x") double x,
            @JsonProperty("y") double y,
            @JsonProperty("vx") double vx,
            @JsonProperty("vy") double vy,
            @JsonProperty("r") double r) {}

    /** The world as the server sees it, which is the only version that counts. */
    public record Snapshot(
            @JsonProperty("t") String t,
            @JsonProperty("tick") long tick,
            @JsonProperty("ack") long ack,
            @JsonProperty("bodies") List<BodyState> bodies) {
        public static Snapshot of(long tick, long ack, List<BodyState> bodies) {
            return new Snapshot("state", tick, ack, bodies);
        }
    }
}
