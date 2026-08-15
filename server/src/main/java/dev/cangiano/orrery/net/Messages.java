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
            @JsonProperty("tick") long tick,
            @JsonProperty("ax") double ax,
            @JsonProperty("ay") double ay) {}

    /**
     * Server's answer to a join: who you are, how big the world is, and every
     * constant its physics uses.
     *
     * <p>The constants are on the wire deliberately. The client re-runs the same
     * simulation to predict, and the fastest way to a bug nobody can reproduce
     * is a client built against a thrust value the server changed last week.
     * There is one source of truth and it is the server.
     */
    public record Welcome(
            @JsonProperty("t") String t,
            @JsonProperty("id") int id,
            @JsonProperty("w") double w,
            @JsonProperty("h") double h,
            @JsonProperty("hz") int hz,
            @JsonProperty("thrust") double thrust,
            @JsonProperty("maxSpeed") double maxSpeed,
            @JsonProperty("restitution") double restitution,
            @JsonProperty("bodyRestitution") double bodyRestitution) {
        public static Welcome of(int id, double w, double h, int hz,
                double thrust, double maxSpeed, double restitution, double bodyRestitution) {
            return new Welcome("welcome", id, w, h, hz, thrust, maxSpeed,
                    restitution, bodyRestitution);
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

    /**
     * The world as the server sees it, which is the only version that counts.
     *
     * <p>{@code tick} is the tick this state is the result of, and it is what
     * the client replays forward from. {@code ack} is the newest input sequence
     * the server has actually applied, used only to measure round trip.
     * {@code missed} counts inputs that arrived too late to be used, which is
     * the number that explains a client feeling snappy or not.
     */
    public record Snapshot(
            @JsonProperty("t") String t,
            @JsonProperty("tick") long tick,
            @JsonProperty("ack") long ack,
            @JsonProperty("missed") long missed,
            @JsonProperty("bodies") List<BodyState> bodies) {
        public static Snapshot of(long tick, long ack, long missed, List<BodyState> bodies) {
            return new Snapshot("state", tick, ack, missed, bodies);
        }
    }
}
