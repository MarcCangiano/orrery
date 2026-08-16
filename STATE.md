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
- [x] Lobby: start screen, pick a side, five second countdown, then kick off.
      Teams are chosen rather than assigned by join order. ESC gives up your
      side and goes back, without dropping the socket
- [x] 3D renderer (Three.js, vendored). The simulation stays 2D and verified;
      only the picture is dimensional. ?flat=1 keeps the canvas renderer
- [x] Artwork: 18 textures generated and wired in. See docs/ART-BRIEF.md for
      what was asked for and docs/ART-DELIVERY.md for what arrived and what
      changed afterwards
- [x] Sound. Effects are synthesised in Web Audio with no assets and scale with
      the physics that caused them; music is five generated instrumental beds,
      one lobby drone and two per pantheon, alternating with a crossfade.
      M mutes. See docs/AUDIO.md
- [x] CI: GitHub Actions runs the tests, the drift check and the prediction
      check on every push. The browser check skips cleanly without Chrome
- [x] Dockerfile: two stages, JRE and a jar, one process serves game and client
- [x] Reconnect: the socket comes back on its own, tested by killing the server
      under a live client and watching it recover
- [ ] Deploy to a real host, so the link is playable rather than readable
      (needs a box and Boss's call on spend; there is a Dockerfile ready)
- [x] Public on GitHub: github.com/MarcCangiano/orrery, CI green

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
- Late inputs: measured over a real network and fixed. Two causes. The server
  acknowledged an input when it APPLIED it, but inputs are addressed to a future
  tick, so the wait for that tick counted as latency, which grew the lead, which
  pushed inputs further out, which grew the measurement again. Acking on arrival
  reported an honest 79ms to a server 40ms away instead of 125ms. Second, the
  safety margin is now driven by the server's own `missed` counter rather than
  fixed at four: every reported late input adds a tick of lead and three quiet
  seconds give one back. Hosted result: lead 6-8, correction 0.0000, and missed
  inputs stopped at 7 and stayed there, where they had been climbing about nine
  a second.

## How to run it

    export JAVA_HOME=~/jdks/jdk-21.0.12+8/Contents/Home
    ./gradlew :server:test     # 8 tests
    ./gradlew :server:run      # 3 seconds of loop, prints achieved rate

## Verifying

    ./verify.sh

Seven gates: the tests, the Java-versus-JavaScript drift check, a headless
client that plays for nine seconds against a real server and measures its own
prediction error, a spectator check, a leave check, a browser load of the actual
page, and an audio check that renders every effect to a buffer and measures the
samples.

The unit tests will never catch a netcode bug; the drift and prediction checks
exist for that. The browser check exists because all of the others passed while
the real client was a black screen. The audio check exists for the same reason
one step further on: a check that asserted the sound methods exist would have
passed on every version of the file that was silent.

## Fixed and deployed 2026-08-16

**The 3D canvas overflowed its window on Retina displays.** Reported as the game
being "zoomed into the corner" on a laptop. `resize()` called
`renderer.setSize(w, h, false)`, and that third argument tells three.js not to
write the canvas's CSS size. With `setPixelRatio(2)` the buffer becomes twice the
CSS size, and a canvas with no CSS size lays out at its buffer size in CSS
pixels: 2000x880 inside a 1000x440 window, so the window showed the top-left
quarter. `position: fixed; inset: 0` does not stretch a replaced element that
already has an intrinsic size. On a 1x display buffer and CSS size are equal and
nothing looks wrong, which is how it survived a round of headless screenshots
taken at devicePixelRatio 1. The 2D HUD canvas had always set its own style; the
3D one now lets three.js do it.

**The follow camera's clamp ignored aspect ratio.** A separate bug found on the
way, real but not the one reported. The margins that keep the camera inside the
cage were fixed fractions of camera height, correct only at the window shape they
were tuned on; they now come from the frustum, so the clamp holds at any shape
and the camera stops following on an axis once the view is wider than the arena.

## Known unfixed

**Camera framing on wide windows (2026-08-16).** On a laptop the arena sat in a
corner with an arena's worth of dead space beside it, while the same build framed
correctly at 1000x620. The follow clamp in `render3d.mjs` measured "inside the
cage" as fixed fractions of camera height (0.30 and 0.20), which are only true at
the window shape they were tuned on. Vertical field of view is fixed, so a wider
window does not zoom out, it widens: at 1512x760 the visible half-width is nearly
double what the clamp assumed, so the camera was still allowed to sit against a
wall. The margins now come from the camera frustum itself, which also means that
once the view is wider than the cage the focus pins to the middle and the camera
stops following on that axis. Camera height is untouched; the scale still does
not breathe. Verified with screenshots at both window sizes and a full
`./verify.sh`. **The fix is local only — fly.io still serves the old client.**


**The bot scores far more slowly through the server than it does in the sim.**
Boss reported that at the start of a match, against a player who does nothing,
the opponent "always misses". Measured rather than guessed:

- `BotIdleMatchTest` runs the real sim headless with an idle player, faithful
  down to immovable fragments and the lane the server actually spawns the bot in.
  It scores at 7.3s and then every 7-10 seconds, ten goals in two minutes.
- The same code through the local server, joined from a browser and left alone,
  scored once in eighty seconds. Twice.

Same Bot class, same physics, wildly different outcome, so the fault is in the
server loop around the bot rather than in its decisions. Not yet found.

One theory tried and thrown away: that the shove cone was too loose. It fires
when the x component of bot-to-star beats 0.3, about 72 degrees off axis, and a
shove is radial, so the edge of that cone sends the star sideways. Replacing it
with a proper two dimensional dot product against the goal direction made the bot
WORSE, 4 goals against the original's 6, and was reverted. The obvious
explanation is wrong; the test is what proved it.

Fixed while in there: every bot shared one shove cooldown, so the first to fire
put the rest on cooldown. Only one bot spawns today, so it is a trap rather than
a symptom.

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
