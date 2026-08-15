# Orrery — state

Read this first. It says what exists, what is next, and which decisions are
already made so they don't get relitigated.

**Last updated:** 2026-08-14

---

## What this is

A real-time multiplayer physics arena. Young gods in a shattered orrery fight
over a captured star and feed it to a serpent's jaws at either end of the cage.
Norse against Greek.

Java server, browser client. The server owns the simulation; nothing a client
says is trusted.

## Why it exists

Two reasons, in order:

1. Java on the resume as something shipped rather than degree coursework. The
   credential lands the moment prediction, reconciliation, lag compensation and
   interest management work, which is roughly four weeks in, not at launch.
2. Because building it is the point. Boss said so plainly.

## Decisions already made

- **Netcode model:** authoritative fixed-tick server, client-side prediction of
  your own body, server reconciliation, entity interpolation for everyone else.
  Not lockstep, not trust-the-client.
- **Physics:** our own fixed-step rigid-body solver, circles and walls only.
  Written rather than imported, because determinism and re-simulation on
  correction are the whole point and a black box would fight us.
- **Team size:** build for 2v2, test at 1v1, keep team size and arena scale as
  config so 3v3 is a setting rather than a rewrite.
- **Characters:** ONE body, identical stats, until the feel is locked. Mass and
  thrust are not stats sitting on top of a physics game, they are the game.
  Roster comes after.
- **Client:** browser, canvas, vanilla JS. Deploys on GitHub Pages, same as the
  other two games, so anyone can click a link and play.
- **The star is the only light source.** Possession controls visibility. This is
  gameplay, not decoration.
- **Toolchain:** isolated JDK under `~/jdks`, never brew. A brew install is what
  breaks ffmpeg and kills every video pipeline on this machine.

## The three verbs

- **Thrust** — accelerate, never stop. Fuel is a budget that recharges slowly.
- **Tether** — throw a line at a ring fragment, swing, release. The skill
  ceiling lives here.
- **Shove** — push the star or an opponent, and take the equal and opposite
  push yourself. Every defensive play costs position.

## Status

- [x] Project skeleton
- [x] JDK installed and verified (Temurin 21.0.12, isolated under ~/jdks, never brew)
- [x] Gradle build, JUnit, 8 passing tests
- [x] Fixed-tick server loop with a measured, stable tick (59.65/sec vs 60 target, 0 dropped)
- [x] WebSocket transport, JSON protocol (binary later, when the shape stops changing)
- [x] Client connects, sends input, renders server state
- [x] Physics: bodies, thrust, walls, restitution, speed cap. Collisions between
      bodies NOT done yet
- [x] Client prediction and reconciliation (measured at 0.000000 units of error)
- [x] Debug tooling: lag simulator (L), server ghost (G), prediction toggle (P)
- [x] Interpolation for other players, 80ms behind
- [x] Body-to-body collisions, immovable ring fragments
- [x] The star, the jaws, teams, scoring, post-goal reset
- [x] Shove with equal-and-opposite recoil, on a cooldown
- [x] Tether: rope constraint, anchors are fragments and the star
- [x] Lag compensation: TRIED AND REMOVED, see the note in GameServer. Rewinding
      made prediction worse because this client extrapolates rather than lagging
- [x] Others drawn from the predicted world, not interpolated in the past
- [ ] Interest management
- [ ] Lag compensation for the shove
- [x] Match flow: first to 5, a longer pause, then a fresh match
- [x] A bot opponent, so one person opening the link gets a game
- [x] Look: trails, thruster plume, impact flashes, star pulse, split scoreboard
- [x] ?auto=1 autopilot, for demos and for taking screenshots of live play
- [ ] Sound
- [ ] Deploy: server on a box, client on Pages

## How the clock works, because it is the non-obvious part

The server applies the input addressed to each tick. The client therefore runs
its own tick counter AHEAD of the server's by about one-way latency plus two
ticks of margin, and addresses inputs to that future tick. Snapshots carry the
server's tick, so the estimate is nudged one tick at a time when close and
snapped when hopeless, such as after a background tab.

Two rules fell out of measuring, both in `predictor.mjs`:

1. **Simulate every tick, not every input.** The server steps on every tick,
   holding the last intent when nothing arrived. A client that only steps the
   ticks it has inputs for runs fewer steps and drifts. Measured at 1.95 units
   of mean error before the fix.
2. **Compare like with like.** The client is deliberately ahead, so comparing
   "where I am now" against "where the server says I am" reports the lead as
   error. The predictor keeps its own history and compares against the state it
   predicted for that same tick.

## Known issues

- Nothing measured and outstanding. The sleep-granularity problem from the first
  commit is fixed: the loop now sleeps to just before the deadline and spins the
  last fraction, and the server holds **60.00 ticks/s with zero dropped**.
- Other players are mirrored into the client's prediction with no input at all,
  which is wrong the moment they thrust. It only reaches the screen through
  contact with you, and the correction arrives within a snapshot. Revisit if
  player-to-player collisions start feeling loose in real play.
- Late inputs sit at ~1.6% of snapshots on localhost. Each one is a small snap.
  Worth re-measuring over a real network before deciding whether SAFETY_TICKS
  needs to be adaptive.

## How to run it

    export JAVA_HOME=~/jdks/jdk-21.0.12+8/Contents/Home
    ./gradlew :server:test     # 8 tests
    ./gradlew :server:run      # 3 seconds of loop, prints achieved rate

## Verifying

    ./verify.sh

Four gates: the tests, the Java-versus-JavaScript drift check, a headless client
that plays for nine seconds against a real server and measures its own
prediction error, and a browser load of the actual page. The unit tests will
never catch a netcode bug; the middle two exist for that. The last one exists
because all three of the others passed while the real client was a black screen.

## Next action

**Play it with two humans.** Everything above is verified by machines and none
of it says whether the game is any good. The specific questions: does the star
feel heavy enough to need a teammate, is the tether readable when someone else
is swinging, and is the shove cooldown too long to defend with.

Tuning that follows from that session, not before it: THRUST, STAR_MASS,
SHOVE_IMPULSE, SHOVE_COOLDOWN, TETHER_MAX_LENGTH. They are all constants in
Arena.java and World.java and they are all sent to the client on welcome, so
changing one is a server restart and nothing else.

Then, in rough order: a score limit and a match end, sound, and interest
management once there are enough bodies for it to matter.
