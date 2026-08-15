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
- [ ] WebSocket transport and a binary-ish protocol
- [ ] Client connects, sends input, renders server state
- [ ] Physics solver: bodies, walls, collisions, restitution
- [ ] Client prediction and reconciliation
- [ ] Debug tooling: lag simulator, predicted-vs-authoritative overlay
- [ ] Tether
- [ ] The star, the jaws, scoring, match flow
- [ ] Interest management
- [ ] Lag-compensated shove
- [ ] Deploy: server on a box, client on Pages

## Known issues

- `Main` paces the loop with `Thread.sleep(1)`, and macOS sleep granularity puts
  the worst observed gap at 25ms against a 16.67ms budget. Harmless while the
  loop does nothing, wrong once it simulates. The fix is to sleep until just
  before the deadline and spin the last fraction of a millisecond. Not now.

## How to run it

    export JAVA_HOME=~/jdks/jdk-21.0.12+8/Contents/Home
    ./gradlew :server:test     # 8 tests
    ./gradlew :server:run      # 3 seconds of loop, prints achieved rate

## Next action

Transport. A WebSocket endpoint, a client that connects, and one input message
making a body move on the server and appear on screen. Nothing predicted yet:
first prove the round trip, then make it feel good.
