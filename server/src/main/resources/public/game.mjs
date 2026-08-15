// The client. Predicts your own body, interpolates everyone else's, and
// reconciles against the server every snapshot.
//
// THE CLOCK IS THE WHOLE PROBLEM.
//
// The server simulates tick 1, 2, 3... and applies the input addressed to each
// one. So the client has to answer a question it cannot know the answer to:
// which tick is the server on *right now*? Anything it sends will arrive some
// milliseconds from now, and if it arrives late the server has already moved on
// and holds the previous input instead.
//
// So the client runs its own tick counter deliberately ahead of the server's,
// by about the one-way latency plus a small safety margin, and addresses its
// inputs to that future tick. Snapshots carry the server's real tick, which lets
// the estimate be corrected continuously: nudged by one tick at a time when it
// is close, snapped outright when it is hopelessly wrong, such as after the tab
// was in the background.
//
// Everything else follows from that:
//   PREDICTION      simulate the local tick immediately with the input we just
//                   addressed to it, instead of waiting a round trip.
//   RECONCILIATION  a snapshot is the truth as of tick S. Snap to it, then
//                   replay the inputs for S+1 onward. If both simulations agree,
//                   the replay lands where we already were and you see nothing.
//   INTERPOLATION   other players are drawn slightly in the past, between the
//                   two most recent snapshots, or they stutter at 30Hz.

import { Predictor } from './predictor.mjs';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');

const INTERP_DELAY_MS = 80;

// Extra ticks of lead beyond measured latency. Costs responsiveness, buys
// tolerance for jitter. Four ticks is 67ms of margin: at two, roughly one input
// a second arrived after the server had already simulated its tick, and every
// one of those is a visible snap.
const SAFETY_TICKS = 4;

// Beyond this the estimate is not adjusted, it is replaced.
const RESYNC_THRESHOLD = 10;

const cfg = {
  w: 120, h: 70, hz: 60, thrust: 60, maxSpeed: 40, restitution: 0.75,
  bodyRestitution: 0.9, dt: 1 / 60, dtMs: 1000 / 60, jaws: 70 / 6,
  shoveRange: 6, shoveImpulse: 26, shoveCooldown: 40,
  tetherReach: 26, tetherMax: 22,
};

const STAR_ID = -1;
const TEAM_COLOR = ['#7fa8e3', '#e0b062'];   // Norse frost, Greek gold
const TEAM_NAME = ['Norse', 'Greek'];

let myId = null;
let predictor = null;

/** Tick our predicted state is the result of. Deliberately ahead of the server. */
let predTick = 0;
let targetTick = 0;
let haveClock = false;
let seq = 0;

const snapshots = [];
let serverTick = 0;
let serverMe = null;
let missedOnServer = 0;
let myTeam = 0;
let shoveReady = 0;
let shoveHeld = false;
let score = [0, 0];
let freeze = 0;

let rttMs = 0;
const sentAt = new Map();
let correctionError = 0;
let worstCorrection = 0;
let replayedLast = 0;

let predictionOn = true;
let ghostOn = true;
let fakeLagMs = 0;

const keys = new Set();
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === ' ') { shoveHeld = true; return; }
  if (k === 'p') { predictionOn = !predictionOn; return; }
  if (k === 'g') { ghostOn = !ghostOn; return; }
  if (k === 'l') { fakeLagMs = fakeLagMs === 0 ? 100 : fakeLagMs === 100 ? 300 : 0; return; }
  keys.add(k);
});
addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k === ' ') shoveHeld = false;
  keys.delete(k);
});

function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
}
addEventListener('resize', resize);
resize();

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws`);

function send(obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify(obj);
  if (fakeLagMs > 0) setTimeout(() => ws.send(payload), fakeLagMs);
  else ws.send(payload);
}

ws.onmessage = ev => {
  if (fakeLagMs > 0) setTimeout(() => handle(ev.data), fakeLagMs);
  else handle(ev.data);
};

function handle(raw) {
  const m = JSON.parse(raw);

  if (m.t === 'welcome') {
    myId = m.id;
    Object.assign(cfg, {
      w: m.w, h: m.h, hz: m.hz, thrust: m.thrust,
      maxSpeed: m.maxSpeed, restitution: m.restitution,
      bodyRestitution: m.bodyRestitution, jaws: m.jaws,
      shoveRange: m.shoveRange, shoveImpulse: m.shoveImpulse,
      shoveCooldown: m.shoveCooldown, tetherReach: m.tetherReach,
      tetherMax: m.tetherMax,
      dt: 1 / m.hz, dtMs: 1000 / m.hz,
    });
    myTeam = m.team;
    predictor = new Predictor(cfg, myId, { x: cfg.w / 2, y: cfg.h / 2, r: 1.6 });
    return;
  }

  if (m.t !== 'state' || !predictor) return;

  serverTick = m.tick;
  missedOnServer = m.missed;
  score = [m.scoreA, m.scoreB];
  freeze = m.freeze;
  snapshots.push({ at: performance.now(), tick: m.tick, bodies: m.bodies });
  while (snapshots.length > 32) snapshots.shift();

  const t0 = sentAt.get(m.ack);
  if (t0 !== undefined) {
    rttMs = performance.now() - t0;
    for (const k of sentAt.keys()) if (k <= m.ack) sentAt.delete(k);
  }

  // Where the clock should be: the server's tick, plus the ticks that will pass
  // while our next input is in flight, plus a margin for jitter.
  const leadTicks = Math.max(1, Math.round((rttMs / 2) / cfg.dtMs)) + SAFETY_TICKS;
  const target = m.tick + leadTicks;

  if (!haveClock || Math.abs(target - predTick) > RESYNC_THRESHOLD) {
    predTick = target;
    targetTick = target;
    predictor.tick = target;
    haveClock = true;
  } else {
    // Never move predTick directly. Skipping a tick number here was costing
    // roughly one input a second: nothing was ever addressed to the skipped
    // tick, so the server held the previous intent and the client had to be
    // corrected. The local loop closes the gap instead, one whole tick at a
    // time, and every tick gets an input.
    targetTick = target;
  }

  const truth = m.bodies.find(b => b.id === myId);
  if (!truth) return;
  serverMe = truth;

  // The predictor compares the truth against what IT had predicted for that same
  // tick, not against where we are now. We are deliberately ahead of the server,
  // so comparing now-against-then would report the lead as an error.
  replayedLast = predictor.reconcile(m.tick, m.bodies, m.freeze, m.ready);
  shoveReady = m.ready;
  correctionError = predictor.lastError;
  worstCorrection = predictor.worstError;
}

function readKeys() {
  let ax = 0, ay = 0;
  if (keys.has('a') || keys.has('arrowleft')) ax -= 1;
  if (keys.has('d') || keys.has('arrowright')) ax += 1;
  if (keys.has('w') || keys.has('arrowup')) ay -= 1;
  if (keys.has('s') || keys.has('arrowdown')) ay += 1;
  const len = Math.sqrt(ax * ax + ay * ay);
  if (len > 0) { ax /= len; ay /= len; }
  return { ax, ay };
}

/**
 * One local tick: address an input to the next tick, send it, and simulate it
 * immediately so the screen answers the key press now rather than in 40ms.
 */
function localTick() {
  if (myId === null || !haveClock || !predictor) return;
  const tick = ++predTick;
  const { ax, ay } = readKeys();
  // One shove per press, not one per tick the bar is held down.
  const sh = shoveHeld && tick >= predictor.shoveReadyTick;
  if (sh) shoveHeld = false;
  const th = keys.has('shift');
  seq++;
  const input = { ax, ay, sh, th };
  predictor.setInput(tick, input);
  sentAt.set(seq, performance.now());
  send({ t: 'input', seq, tick, ax, ay, sh, th });

  // Always advance, even with prediction switched off, so the predictor's tick
  // and history stay aligned with the server and P can be toggled at any moment.
  predictor.advance(tick);
}

// Fixed-step accumulator rather than setInterval, for the same reason the server
// has one: setInterval drifts, and a drifting client tick is exactly the bug
// this whole redesign was written to remove.
let lastFrame = performance.now();
let accumulator = 0;

function interpolatedBodies(now) {
  const target = now - INTERP_DELAY_MS;
  let older = null, newer = null;
  for (const s of snapshots) {
    if (s.at <= target) older = s;
    else { newer = s; break; }
  }
  if (!older) return snapshots.length ? snapshots[snapshots.length - 1].bodies : [];
  if (!newer) return older.bodies;

  const span = newer.at - older.at;
  const alpha = span > 0 ? (target - older.at) / span : 0;
  const out = [];
  for (const a of older.bodies) {
    const b = newer.bodies.find(x => x.id === a.id);
    if (!b) continue;
    out.push({
      id: a.id,
      x: a.x + (b.x - a.x) * alpha,
      y: a.y + (b.y - a.y) * alpha,
      r: a.r,
      team: a.team,
      fixed: a.fixed,
      tether: b.tether,
    });
  }
  return out;
}

function frame() {
  const now = performance.now();
  let elapsed = now - lastFrame;
  lastFrame = now;
  if (elapsed > 250) elapsed = 250;  // came back from a background tab
  accumulator += elapsed;
  let guard = 0;
  while (accumulator >= cfg.dtMs && guard++ < 10) {
    accumulator -= cfg.dtMs;
    localTick();
    // Behind the server's clock: run an extra tick to catch up rather than
    // renumbering, so no tick is ever left without an input.
    if (haveClock && predTick < targetTick && guard++ < 10) {
      localTick();
    }
  }
  // Ahead of it: let the accumulator drain without emitting, which slows the
  // client's clock by a tick instead of jumping it backwards.
  if (haveClock && predTick > targetTick + 1) {
    accumulator = 0;
  }

  draw(now);
  requestAnimationFrame(frame);
}

/**
 * The star is the only light in here, so it is drawn as a light rather than as
 * a circle: a hot core inside a falloff that reaches most of the arena.
 */
function drawStar(b) {
  const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r * 9);
  glow.addColorStop(0, 'rgba(255,236,190,0.55)');
  glow.addColorStop(0.25, 'rgba(255,196,90,0.18)');
  glow.addColorStop(1, 'rgba(255,170,40,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r * 9, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe9b0';
  ctx.fill();
}

function draw(now) {
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, W, H);

  const scale = Math.min(W / (cfg.w + 8), H / (cfg.h + 8));
  const ox = (W - cfg.w * scale) / 2;
  const oy = (H - cfg.h * scale) / 2;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  ctx.lineWidth = 2 / scale;

  ctx.strokeStyle = '#1c2740';
  ctx.strokeRect(0, 0, cfg.w, cfg.h);

  // The jaws: the stretch of each end wall a star can be fed through.
  const midY = cfg.h / 2;
  ctx.lineWidth = 5 / scale;
  for (const [x, team] of [[0, 1], [cfg.w, 0]]) {
    ctx.beginPath();
    ctx.moveTo(x, midY - cfg.jaws);
    ctx.lineTo(x, midY + cfg.jaws);
    ctx.strokeStyle = TEAM_COLOR[team];
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.lineWidth = 2 / scale;

  for (const b of interpolatedBodies(now)) {
    if (b.id === myId) continue;
    if (b.id === STAR_ID) { drawStar(b); continue; }
    if (b.fixed) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = '#161d2c';
      ctx.fill();
      ctx.strokeStyle = '#2a3752';
      ctx.stroke();
      continue;
    }
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = b.team === myTeam ? '#4a6fa5' : '#8a5a3c';
    ctx.fill();
    ctx.strokeStyle = TEAM_COLOR[b.team] ?? '#666';
    ctx.stroke();
  }

  // The server's opinion of where you are. With prediction working it sits under
  // you and you never notice it. Press L for 300ms of lag and watch it trail:
  // that gap is exactly what prediction is hiding.
  if (ghostOn && serverMe) {
    ctx.beginPath();
    ctx.arc(serverMe.x, serverMe.y, serverMe.r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(232,176,75,.55)';
    ctx.stroke();
  }

  // The rope, drawn from the predicted position so it tracks the hand rather
  // than lagging a snapshot behind it.
  if (predictor?.anchor && predictor.body) {
    ctx.beginPath();
    ctx.moveTo(predictor.body.x, predictor.body.y);
    ctx.lineTo(predictor.anchor.x, predictor.anchor.y);
    ctx.strokeStyle = 'rgba(190,215,255,.75)';
    ctx.stroke();
  }
  // Everyone else's ropes come from the snapshot.
  for (const b of interpolatedBodies(now)) {
    if (b.id === myId || !b.tether) continue;
    const anchor = interpolatedBodies(now).find(x => x.id === b.tether);
    if (!anchor) continue;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(anchor.x, anchor.y);
    ctx.strokeStyle = 'rgba(150,170,210,.4)';
    ctx.stroke();
  }

  const me = predictionOn ? predictor?.body : serverMe;
  if (me) {
    const r = me.radius ?? me.r;
    ctx.beginPath();
    ctx.arc(me.x, me.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#7fe3c0';
    ctx.fill();
    ctx.strokeStyle = TEAM_COLOR[myTeam];
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(me.x, me.y);
    ctx.lineTo(me.x + me.vx * 0.12, me.y + me.vy * 0.12);
    ctx.strokeStyle = 'rgba(127,227,192,.55)';
    ctx.stroke();
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  hud.innerHTML =
    `<b>${score[0]}</b> Norse   Greek <b>${score[1]}</b>` +
    (freeze > 0 ? '   <span id="warn">goal</span>' : '') + `\n` +
    `orrery  <b>you are ${myId ?? '...'}</b> (${TEAM_NAME[myTeam]})\n` +
    `server tick ${serverTick}   client tick ${predTick}   lead ${predTick - serverTick}\n` +
    `rtt ${rttMs.toFixed(0)}ms   fake lag ${fakeLagMs}ms   missed on server ${missedOnServer}\n` +
    `prediction ${predictionOn ? '<b>on</b>' : '<span id="warn">off</span>'}` +
    `   replayed ${replayedLast}\n` +
    `correction ${correctionError.toFixed(4)}  worst ${worstCorrection.toFixed(4)}\n` +
    `shove ${predTick >= shoveReady ? '<b>ready</b>' : 'in ' +
        Math.max(0, Math.ceil((shoveReady - predTick) / 60 * 10) / 10) + 's'}\n` +
    `WASD thrust   SPACE shove   SHIFT tether   P prediction   L lag   G ghost`;
}

requestAnimationFrame(frame);
