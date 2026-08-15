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
const SECONDS = 6;

// A body is 1.6 units across. A tenth of a unit is invisible on screen but far
// larger than floating point noise, so this catches systematic error only.
const MAX_ALLOWED_ERROR = 0.1;

const SAFETY_TICKS = 2;
const RESYNC_THRESHOLD = 10;

const cfg = { dt: 1 / 60, dtMs: 1000 / 60, thrust: 60, w: 120, h: 70, maxSpeed: 40, restitution: 0.75 };
let myId = null;
let predictor = null;
let seq = 0;
let predTick = 0;
let haveClock = false;
let rttMs = 0;
const sentAt = new Map();

let snapshots = 0;
let measured = 0;
let sumError = 0;
let worstError = 0;
// A run that never touches the star measures prediction against nothing more
// interesting than a straight line. Count the contacts and fail without them.
let starContacts = 0;
let touchingStar = false;

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
    predictor = new Predictor(cfg, myId, { x: cfg.w / 2, y: cfg.h / 2, r: 1.6 });
    return;
  }

  if (m.t !== 'state' || !predictor) return;
  const truth = m.bodies.find(b => b.id === myId);
  if (!truth) return;

  snapshots++;

  const t0 = sentAt.get(m.ack);
  if (t0 !== undefined) {
    rttMs = Date.now() - t0;
    for (const k of sentAt.keys()) if (k <= m.ack) sentAt.delete(k);
  }

  const leadTicks = Math.max(1, Math.round((rttMs / 2) / cfg.dtMs)) + SAFETY_TICKS;
  const target = m.tick + leadTicks;
  if (!haveClock || Math.abs(target - predTick) > RESYNC_THRESHOLD) {
    predTick = target;
    predictor.tick = target;
    haveClock = true;
  } else if (target > predTick) predTick += 1;
  else if (target < predTick) predTick -= 1;

  const star = m.bodies.find(b => b.id === -1);
  if (star) {
    const gap = Math.hypot(star.x - truth.x, star.y - truth.y);
    const touching = gap <= star.r + truth.r + 0.25;
    if (touching && !touchingStar) starContacts++;
    touchingStar = touching;
  }

  predictor.reconcile(m.tick, m.bodies, m.freeze);

  // The first stretch is the clock settling in. Measuring then would report the
  // resync as a prediction failure, which it is not.
  if (snapshots > 20 && predictor.lastError > 0) {
    sumError += predictor.lastError;
    measured++;
    if (predictor.lastError > worstError) worstError = predictor.lastError;
  } else if (snapshots > 20) {
    measured++;  // an exact match still counts as a measurement
  }
});

// Drives at the star, hits it, backs off and hits it again. A body drifting in
// a straight line would predict perfectly even with the logic broken, and a
// collision is the case where the client is predicting something it does not
// fully control.
function intent(t, fromRight) {
  const toward = fromRight ? -1 : 1;
  const phase = Math.floor(t / 900) % 4;
  if (phase === 0) return { ax: toward, ay: 0 };
  if (phase === 1) return { ax: -toward, ay: -0.3 };
  if (phase === 2) return { ax: toward, ay: 0.3 };
  return { ax: 0, ay: 0 };
}

const started = Date.now();
const timer = setInterval(() => {
  if (!predictor || !haveClock || ws.readyState !== WebSocket.OPEN) return;
  const tick = ++predTick;
  const { ax, ay } = intent(Date.now() - started, myId % 2 === 1);
  seq++;
  const input = { ax, ay };
  predictor.setInput(tick, input);
  sentAt.set(seq, Date.now());
  ws.send(JSON.stringify({ t: 'input', seq, tick, ax, ay }));
  predictor.advance(tick);
}, 1000 / 60);

setTimeout(() => {
  clearInterval(timer);
  ws.close();

  const mean = measured ? sumError / measured : 0;
  console.log(`predict-check: ${measured} snapshots measured over ${SECONDS}s`);
  console.log(`  mean error  ${mean.toFixed(6)} units`);
  console.log(`  worst error ${worstError.toFixed(6)} units  (limit ${MAX_ALLOWED_ERROR})`);

  console.log(`  star contacts ${starContacts}`);

  if (measured === 0) {
    console.error('predict-check: FAILED — nothing was measured');
    process.exit(1);
  }
  if (starContacts === 0) {
    console.error('predict-check: FAILED — never touched the star, so collision');
    console.error('  prediction was not exercised. Fix the movement script.');
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
