# Orrery

A real-time multiplayer physics arena. Young gods fight over a captured star in
the wreckage of a dead solar system, and feed it to a serpent's jaws at either
end of the cage.

Java server, browser client, authoritative simulation with client-side
prediction. Norse against Greek.

```
./run.sh          # then open http://localhost:7070
./verify.sh       # tests, physics drift check, live prediction check
```

Controls: **WASD** thrust, **SPACE** shove, **SHIFT** tether.
Debug: **P** toggles prediction, **L** adds fake lag, **G** shows the server's
ghost.

---

## What it is

There is no floor and no friction. You accelerate, and then you keep going until
something stops you. Three verbs:

- **Thrust** — you never coast to a halt, so stopping costs as much as starting.
- **Tether** — throw a line at a ring fragment or at the star and swing. A rope
  only removes the outward part of your velocity, so speed along the arc is
  free. This is where the skill ceiling lives.
- **Shove** — push everything nearby away and take the same push in the opposite
  direction. There is nothing to brace against out here, so every defensive play
  costs you position.

The star is the only light source in the arena.

## How the netcode works

The server owns the simulation. It runs a fixed 60Hz tick and is the only thing
that ever writes to the world; network threads only drop intents into a ring
buffer and leave. Snapshots go out at 30Hz.

The client does not wait for a round trip to move. It runs the same simulation
in JavaScript, keeps its own tick counter deliberately **ahead** of the server's
by one-way latency plus a margin, addresses every input to a specific future
tick, and simulates that tick the moment the key goes down. Every snapshot, it
rewinds to the server's version of the world and replays whatever came after it.

When both simulations agree, that replay lands exactly where the client already
was and nothing visible happens. That is the whole trick, and it only works if
they really do agree, which is what two of the three checks in `verify.sh` are
for.

```
tools/drift-check.sh      Java and JavaScript physics over identical inputs,
                          compared bit for bit, 600 ticks. No tolerance: a
                          tolerance would pass on exactly the slow divergence
                          it exists to catch.

tools/predict-check.mjs   A headless client that plays for nine seconds against
                          a real server and measures its own prediction error,
                          driving the browser's own predictor rather than a copy.

tools/client-check.sh     Loads the actual page in a browser. Exists because a
                          rename once left the draw loop calling a function that
                          no longer existed: the client threw on its first frame
                          and rendered a black screen, and every other check
                          passed, since they all run the simulation in Node and
                          none of them opens the page.
```

Current numbers: **0.000000 units** of prediction error, with star collisions,
shoves, and a tethered swing inside the measured run.

## Four bugs worth reading about

Every one of these was invisible until something measured it, and each is
written up in the commit that fixed it.

**Two clocks, 0.42 units of error.** Inputs were consumed from a queue, one per
tick. The client predicted one step per input it *sent*, the server ran one step
per *tick*, and those are independent clocks that disagree by about a tick a
second. Fixed by addressing every input to a specific tick.

**Skipped simulation, 1.95 units.** The client only simulated ticks it had
inputs for, while the server simulated all of them, holding the last intent
across the gaps. Fewer steps on one side, permanent drift.

**A renumbered tick, one snap a second.** The client's clock corrected itself by
moving its tick counter directly, which skipped a tick number outright. Nothing
was ever addressed to the skipped tick, so the server held the previous intent
and corrected the client. It now closes the gap by running an extra tick and
emitting an input for it. Late inputs fell from 8.9% of snapshots to 1.6%.

**No lag compensation, and the measurement that decided it.** The usual answer
to "the client aims at stale positions" is to rewind the world when resolving a
hit. Building that made things worse, from 0.000000 units to 0.124. This client
does not hold stale positions: it mirrors the whole world and carries every body
forward with the same physics, so for anything without an input its present *is*
the server's, and rewinding put the server behind the client. What a client
genuinely cannot know is another player's intent, and the answer to that is a
correction within one snapshot, not a rewind of everything. The reasoning is
kept in `GameServer` where the shove is applied, because the next person to read
it will have the same instinct I did.

Drawing followed the same logic: other players are rendered from the predicted
world rather than interpolated ~80ms in the past. In a contact game you aim at a
body in order to hit it, and your prediction resolves that contact against the
present, so drawing the past means aiming at one thing and colliding with
another.

**Iteration order, 0.23 units on contact.** Collisions resolve in one pass over
the body list, so with three bodies touching at once the order decides the
answer. The client built its list starting with its own body; the server's
starts with the star. Two bodies alone are symmetric and agreed. A player wedged
between the star and a ring fragment did not.

The measurement itself was wrong once too, which was the most instructive of the
lot: comparing the client's current state against a snapshot compares two
different moments, because the client is deliberately ahead. It reported a huge
error that was not real. The predictor keeps a history of its own past states
and compares against the tick the snapshot actually describes.

## Layout

```
server/src/main/java/dev/cangiano/orrery/
  FixedTickLoop.java      fixed timestep with a catch-up limit
  sim/World.java          circles, walls, collisions, tether constraint
  sim/Arena.java          the game inside the physics: spawns, jaws, scoring
  net/GameServer.java     authoritative loop, tick-addressed inputs, snapshots
server/src/main/resources/public/
  sim.mjs                 the same physics, in JavaScript
  predictor.mjs           prediction and reconciliation
  game.mjs                input, rendering, the clock estimate
tools/                    the two checks that catch netcode bugs
```

`sim.mjs` is a line-for-line mirror of the Java, and the drift check fails the
build if it ever stops being one.

## Running it against a friend

The server is a single process with no dependencies beyond a JVM. Point them at
your machine on port 7070. Team is assigned by join order, alternating, so two
browsers land on opposite sides.
