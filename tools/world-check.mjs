#!/usr/bin/env node
// How wrong the REST of the world is, as opposed to your own body.
//
// predict-check measures the one body whose intent the client knows: its own.
// That number has been zero for a while, and it is the wrong number to reassure
// anyone with, because it says nothing about the thing a player actually
// watches. You chase the star. The star is pushed by an opponent whose intent
// the client cannot know, so the client extrapolates it, is corrected every
// snapshot, and slides the drawing toward the correction over a few frames.
//
// That sliding is what "a bit of lag" feels like when your own ship is exact,
// and until it is measured there is nothing to tell whether a change helped.
//
// It reports, for every body that is not this client's:
//   * how far the prediction had drifted by the time the truth arrived
//   * how much of that is the star specifically, since the star is the game
//
// Usage: node tools/world-check.mjs [ws://localhost:7070/ws] [seconds]

import { Predictor } from '../server/src/main/resources/public/predictor.mjs';

const url = process.argv[2] ?? 'ws://localhost:7070/ws';
const SECONDS = Number(process.argv[3] ?? 20);
/*
 * --no-intent turns OFF carrying other bodies' thrust forward, so the two
 * behaviours can be compared on the same server in the same conditions. Without
 * an A/B there is no way to tell whether a change to extrapolation helped, and
 * the numbers here move enough between runs that eyeballing two runs is not
 * evidence.
 */
const NO_INTENT = process.argv.includes('--no-intent');
const STAR_ID = -1;

const cfg = { dt: 1 / 60, dtMs: 1000 / 60, thrust: 60, w: 120, h: 70, maxSpeed: 40, restitution: 0.75 };
let myId = null;
let predictor = null;
let seq = 0;
let predTick = 0;
let haveClock = false;

const errors = new Map();          // id -> [drift, ...]
/*
 * What the whole world looked like at each tick we predicted.
 *
 * The first version of this compared the predictor's CURRENT world against the
 * snapshot that had just arrived, which is the exact mistake predict-check was
 * built to avoid and that is written up in the README. The client runs about
 * six ticks ahead on purpose, so that comparison reports the lead as error: it
 * showed a median of 0.9 units of "drift" that was simply six ticks of honest
 * motion, and it did not shrink when the snapshot rate was doubled, which is
 * what gave it away.
 */
const worldHistory = new Map();    // tick -> Map(id -> {x, y})
let snapshots = 0;
let sinceFreeze = 0;

const ws = new WebSocket(url);
ws.addEventListener('error', () => {
  console.error('world-check: could not connect to', url);
  process.exit(2);
});

ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);

  if (m.t === 'welcome') {
    myId = m.id;
    Object.assign(cfg, {
      w: m.w, h: m.h, thrust: m.thrust, maxSpeed: m.maxSpeed,
      restitution: m.restitution, dt: 1 / m.hz, dtMs: 1000 / m.hz,
      bodyRestitution: m.bodyRestitution, shoveRange: m.shoveRange,
      shoveImpulse: m.shoveImpulse, shoveCooldown: m.shoveCooldown,
      tetherReach: m.tetherReach, tetherMax: m.tetherMax,
    });
    predictor = new Predictor(cfg, myId, { x: cfg.w / 2, y: cfg.h / 2, r: 1.6 });
    ws.send(JSON.stringify({ t: 'pick', team: 1 }));
    return;
  }

  if (m.t !== 'state' || !predictor) return;
  if (m.phase !== 'playing' || m.freeze > 0) { sinceFreeze = 0; return; }
  /*
   * Skip the snapshots just after a pause ends.
   *
   * A goal and the end of a match both teleport every body back to its spawn.
   * The end-of-match reset happens on the tick freeze reaches zero, so that
   * snapshot arrives with freeze already clear and a whole arena of movement
   * no client could have predicted. Left in, it showed up as a worst case of
   * 46 units and buried the number this exists to measure.
   */
  if (++sinceFreeze < 10) return;

  if (!haveClock) {
    predTick = m.tick + 6;
    predictor.tick = predTick;
    haveClock = true;
  }

  /*
   * Compare BEFORE syncing, which is the whole point.
   *
   * The predictor mirrors the world on every snapshot, so after reconcile
   * everything agrees by construction and measuring then would report zero
   * forever. What matters is how far the extrapolation had drifted in the
   * 33ms since the last snapshot, because that gap is what gets smoothed
   * across the screen.
   */
  const predicted = worldHistory.get(m.tick);
  if (snapshots > 20 && predicted) {
    for (const truth of m.bodies) {
      if (truth.id === myId || truth.immovable) continue;
      const guess = predicted.get(truth.id);
      if (!guess) continue;
      const drift = Math.hypot(guess.x - truth.x, guess.y - truth.y);
      if (!errors.has(truth.id)) errors.set(truth.id, []);
      errors.get(truth.id).push(drift);
    }
  }
  snapshots++;

  predictor.reconcile(m.tick, m.bodies, m.freeze, m.ready);
  if (NO_INTENT) {
    for (const b of predictor.world.bodies) { b.intentX = 0; b.intentY = 0; }
  }
});

// Drift straight ahead. This client is not trying to play well, it is trying to
// be present while the bot moves the star around.
setInterval(() => {
  if (!haveClock || !predictor) return;
  const tick = ++predTick;
  seq++;
  predictor.setInput(tick, { ax: 0, ay: 0, sh: false, th: false });
  ws.send(JSON.stringify({ t: 'input', seq, tick, ax: 0, ay: 0, sh: false, th: false, rt: 0 }));
  predictor.advance(tick);

  // Keep what every body looked like at this tick, so a snapshot for tick T is
  // compared against what we predicted FOR TICK T rather than against now.
  const frame = new Map();
  for (const b of predictor.world.bodies) frame.set(b.id, { x: b.x, y: b.y });
  worldHistory.set(tick, frame);
  for (const t of worldHistory.keys()) {
    if (t < tick - 240) worldHistory.delete(t);
  }
}, 1000 / 60);

setTimeout(() => {
  const stats = arr => {
    const s = [...arr].sort((a, b) => a - b);
    return {
      n: s.length,
      mean: s.reduce((a, b) => a + b, 0) / s.length,
      p50: s[Math.floor(s.length * 0.5)],
      p95: s[Math.floor(s.length * 0.95)],
      max: s[s.length - 1],
    };
  };

  if (!errors.size) {
    console.log('world-check: nothing to measure. Was anything else moving?');
    process.exit(1);
  }

  console.log(`world-check: ${snapshots} snapshots`);
  const all = [...errors.values()].flat();
  const a = stats(all);
  console.log(`  every other body: mean ${a.mean.toFixed(3)}  p50 ${a.p50.toFixed(3)}` +
              `  p95 ${a.p95.toFixed(3)}  worst ${a.max.toFixed(3)} units`);

  const star = errors.get(STAR_ID);
  if (star) {
    const s = stats(star);
    console.log(`  the star:         mean ${s.mean.toFixed(3)}  p50 ${s.p50.toFixed(3)}` +
                `  p95 ${s.p95.toFixed(3)}  worst ${s.max.toFixed(3)} units`);
  }
  // A body is 1.6 units across, so drift is quoted against that: a tenth of a
  // body is invisible, half a body is the thing you are chasing jumping.
  console.log(`  (a body is 1.6 units wide; p95 ${(a.p95 / 1.6 * 100).toFixed(0)}% of a body)`);
  process.exit(0);
}, SECONDS * 1000);
