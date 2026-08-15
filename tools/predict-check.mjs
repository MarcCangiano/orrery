#!/usr/bin/env node
// A headless client that plays for a few seconds and measures how wrong its own
// prediction was.
//
// The drift check proves the two simulations agree when handed identical inputs.
// This proves the running system hands them identical inputs in the first place,
// which is where the real bugs live: a tick simulated on one side and not the
// other, an input applied twice, a clock estimate that races.
//
// It drives the browser's own Predictor, so it cannot pass while the thing
// players run is broken.
//
// Usage: node tools/predict-check.mjs [ws://localhost:7070/ws]

import { Predictor } from '../server/src/main/resources/public/predictor.mjs';

const url = process.argv[2] ?? 'ws://localhost:7070/ws';
const SECONDS = 9;

// A body is 1.6 units across. A tenth of a unit is invisible on screen but far
// larger than floating point noise, so this catches systematic error only.
const MAX_ALLOWED_ERROR = 0.1;

const SAFETY_TICKS = 4;
const RESYNC_THRESHOLD = 10;

const cfg = { dt: 1 / 60, dtMs: 1000 / 60, thrust: 60, w: 120, h: 70, maxSpeed: 40, restitution: 0.75 };
let myId = null;
let predictor = null;
let seq = 0;
let predTick = 0;
let targetTick = 0;
let haveClock = false;
let rttMs = 0;
const sentAt = new Map();

let snapshots = 0;
let measured = 0;
let sumError = 0;
let worstError = 0;
// A run that never touches the star measures prediction against nothing more
// interesting than a straight line. Count the contacts and fail without them.
let goals = 0;
let lastFreeze = 0;
let lastMissed = 0;
let lateSnapshots = 0;
let skippedForGoals = 0;
let starContacts = 0;
let touchingStar = false;
let shoves = 0;
let tetheredTicks = 0;
let starPos = null;
let myPos = null;

const ws = new WebSocket(url);
ws.addEventListener('error', () => {
  console.error('predict-check: could not connect to', url);
  console.error('  start the server first: ./run.sh');
  process.exit(2);
});

ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);

  if (m.t === 'welcome') {
    myId = m.id;
    Object.assign(cfg, {
      w: m.w, h: m.h, thrust: m.thrust, maxSpeed: m.maxSpeed,
      restitution: m.restitution, dt: 1 / m.hz, dtMs: 1000 / m.hz,
    });
    cfg.bodyRestitution = m.bodyRestitution;
    cfg.shoveRange = m.shoveRange;
    cfg.shoveImpulse = m.shoveImpulse;
    cfg.shoveCooldown = m.shoveCooldown;
    cfg.tetherReach = m.tetherReach;
    cfg.tetherMax = m.tetherMax;
    predictor = new Predictor(cfg, myId, { x: cfg.w / 2, y: cfg.h / 2, r: 1.6 });
    return;
  }

  if (m.t !== 'state' || !predictor) return;
  const truth = m.bodies.find(b => b.id === myId);
  if (!truth) return;

  snapshots++;
  const wasFreeze = lastFreeze;
  lastFreeze = m.freeze;

  const t0 = sentAt.get(m.ack);
  if (t0 !== undefined) {
    rttMs = Date.now() - t0;
    for (const k of sentAt.keys()) if (k <= m.ack) sentAt.delete(k);
  }

  const leadTicks = Math.max(1, Math.round((rttMs / 2) / cfg.dtMs)) + SAFETY_TICKS;
  const target = m.tick + leadTicks;
  if (!haveClock || Math.abs(target - predTick) > RESYNC_THRESHOLD) {
    predTick = target;
    targetTick = target;
    predictor.tick = target;
    haveClock = true;
  } else {
    // Never renumber. See the note in game.mjs: a skipped tick is an input the
    // server never receives.
    targetTick = target;
  }

  const star = m.bodies.find(b => b.id === -1);
  myPos = { x: truth.x, y: truth.y };
  if (star) {
    starPos = { x: star.x, y: star.y };
    const gap = Math.hypot(star.x - truth.x, star.y - truth.y);
    const touching = gap <= star.r + truth.r + 0.25;
    if (touching && !touchingStar) starContacts++;
    touchingStar = touching;
  }

  predictor.reconcile(m.tick, m.bodies, m.freeze, m.ready);

  // The first stretch is the clock settling in. Measuring then would report the
  // resync as a prediction failure, which it is not.
  // A goal teleports every body back to its spawn. That is an authoritative
  // event, not something a client could have predicted, so the correction it
  // causes is correct behaviour rather than drift. Counting it would bury a
  // real regression under a number that is supposed to be there.
  if (m.freeze > 0) {
    if (wasFreeze === 0) goals++;   // snapshots are every other tick, so watch the edge
    skippedForGoals++;
    predictor.lastError = 0;
  } else if (m.missed > lastMissed) {
    // An input arrived after the server had already run that tick, so it held
    // the previous intent and we predicted the new one. The correction is
    // right; what matters is how often it happens, counted below.
    lastMissed = m.missed;
    lateSnapshots++;
    measured++;
  } else if (snapshots > 20) {
    lastMissed = m.missed;
    sumError += predictor.lastError;
    measured++;
    if (predictor.lastError > worstError) worstError = predictor.lastError;
    if (predictor.lastError > 0.1) {
      const recent = [];
      for (let tk = m.tick - 6; tk <= m.tick + 6; tk++) {
        const i = predictor.inputs.get(tk);
        if (i && i.sh) recent.push(tk);
      }
      console.error(`  spike ${predictor.lastError.toFixed(3)} at server tick ${m.tick}` +
        `  freeze=${m.freeze}  ready=${m.ready}  missed=${m.missed}` +
        `  shoveTicks=[${recent.join(',')}]  lead=${predTick - m.tick}`);
    }
  }
});

// Drives at the star, hits it, backs off and hits it again. A body drifting in
// a straight line would predict perfectly even with the logic broken, and a
// collision is the case where the client is predicting something it does not
// fully control.
/**
 * Chase the star, ram it, then back off and shove.
 *
 * <p>A fixed direction was not good enough: shoving moves the star, so by the
 * time the bot came back around it was thrusting at where the star used to be
 * and the run covered no collisions at all. Steering at the live position makes
 * contact reliable, which is the whole point of the check.
 */
function intent(t) {
  // Four short phases rather than three long ones: a six second run with a
  // slow cycle sometimes finished without ever reaching the star, which made
  // the coverage check flaky rather than informative.
  const phase = Math.floor(t / 800) % 4;
  if (!starPos || !myPos) return { ax: 1, ay: 0, mayShove: false };

  const dx = starPos.x - myPos.x;
  const dy = starPos.y - myPos.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const toStar = { ax: dx / len, ay: dy / len };

  // Two phases closing on the star with the hands down, one backing off and
  // shoving. Both the collision path and the shove path get exercised.
  if (phase === 2) {
    // Thrust across the anchor rather than at it, which is what actually makes
    // a rope go taut.
    return { ax: -toStar.ay, ay: toStar.ax, mayShove: false, tether: true };
  }
  if (phase === 3) {
    // Back off and shove: the action, its recoil, and the rope together.
    return { ax: -toStar.ax, ay: -toStar.ay, mayShove: true, tether: true };
  }
  // Phases 0 and 1 close on the star with the hands down, so a collision
  // actually happens.
  return { ...toStar, mayShove: false, tether: false };
}

const started = Date.now();
function emitTick() {
  const tick = ++predTick;
  const { ax, ay, mayShove, tether } = intent(Date.now() - started);
  const sh = mayShove && tick >= predictor.shoveReadyTick;
  const th = !!tether;
  if (predictor.anchor) tetheredTicks++;
  if (sh) shoves++;
  seq++;
  const input = { ax, ay, sh, th };
  predictor.setInput(tick, input);
  sentAt.set(seq, Date.now());
  ws.send(JSON.stringify({ t: 'input', seq, tick, ax, ay, sh, th }));
  predictor.advance(tick);
}

const timer = setInterval(() => {
  if (!predictor || !haveClock || ws.readyState !== WebSocket.OPEN) return;
  emitTick();
  // Catch up by running an extra tick, never by renumbering.
  if (predTick < targetTick) emitTick();
}, 1000 / 60);

setTimeout(() => {
  clearInterval(timer);
  ws.close();

  const mean = measured ? sumError / measured : 0;
  console.log(`predict-check: ${measured} snapshots measured over ${SECONDS}s`);
  console.log(`  mean error  ${mean.toFixed(6)} units`);
  console.log(`  worst error ${worstError.toFixed(6)} units  (limit ${MAX_ALLOWED_ERROR})`);

  const lateRate = measured ? lateSnapshots / measured : 0;
  console.log(`  star contacts ${starContacts}   shoves ${shoves}   goals ${goals}` +
              `   tethered ticks ${tetheredTicks}`);
  console.log(`  late inputs ${lateSnapshots}/${measured} snapshots ` +
              `(${(lateRate * 100).toFixed(1)}%, limit 3.0%)`);
  if (skippedForGoals) {
    console.log(`  ${skippedForGoals} snapshots excluded: the world was resetting after a goal`);
  }

  if (measured === 0) {
    console.error('predict-check: FAILED — nothing was measured');
    process.exit(1);
  }
  if (shoves === 0) {
    console.error('predict-check: FAILED — never shoved, so the action and its');
    console.error('  recoil were not exercised.');
    process.exit(1);
  }
  if (tetheredTicks === 0) {
    console.error('predict-check: FAILED — the rope was never taut, so the');
    console.error('  tether constraint was not exercised.');
    process.exit(1);
  }
  if (starContacts === 0) {
    console.error('predict-check: FAILED — never touched the star, so collision');
    console.error('  prediction was not exercised. Fix the movement script.');
    process.exit(1);
  }
  if (lateRate > 0.03) {
    console.error('predict-check: FAILED — too many inputs arrived after the server');
    console.error('  had already simulated their tick. Each one is a visible snap.');
    console.error('  Raise SAFETY_TICKS, or find out why the client clock is drifting.');
    process.exit(1);
  }
  if (worstError > MAX_ALLOWED_ERROR) {
    console.error('predict-check: FAILED — prediction and server disagree');
    console.error('  Check that the client simulates every tick, not every input,');
    console.error('  and that both sides hold the same intent across a gap.');
    process.exit(1);
  }
  console.log('predict-check: OK — the client predicts what the server does');
  process.exit(0);
}, SECONDS * 1000);
