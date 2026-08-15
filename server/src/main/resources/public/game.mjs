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

/*
 * Two renderers, one simulation.
 *
 * The 3D one is the default because the star being the only light in the arena
 * is the idea the whole game is built on, and in 2D that can only ever be drawn
 * as a gradient. ?flat=1 keeps the canvas version, which stays in the tree
 * because it is the one that still works on a machine whose WebGL does not.
 *
 * Neither of them can touch the simulation. Rendering reads the body list and
 * nothing else.
 */
const FLAT = new URLSearchParams(location.search).get('flat') === '1';
let renderer3d = null;

const canvas = document.getElementById('c');
const canvas3d = document.getElementById('c3d');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const scoreboard = document.getElementById('score');
const overlay = document.getElementById('overlay');
const panel = document.getElementById('panel');

// Other players used to be drawn from interpolated snapshots, roughly 80ms in
// the past. That is the standard answer and it is the wrong one here.
//
// This is a contact game: you aim at another body in order to hit it. Your own
// prediction resolves that contact against the world your predictor holds,
// which is the present, extrapolated. Drawing them in the past meant aiming at
// one thing and colliding with another, and the discrepancy grew with latency.
//
// So everyone is drawn from the predicted world instead: synced to the server on
// every snapshot, carried forward by the same physics in between. What you see
// is what your prediction will use. The cost is a small pop when someone thrusts
// in a way we could not know about, which is honest, and which the smoothing
// below softens.
const SMOOTH_PER_TICK = 0.35;

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
let myTeam = -1;
let phase = 'lobby';
let countdown = 0;
let sideCounts = [0, 0];
/** start, sides, or none: what the overlay is showing, which the server does not decide. */
let lobbyScreen = 'start';
let denied = '';
let shoveReady = 0;
const bodyTeam = new Map();
const bodyTether = new Map();
let shoveHeld = false;
let score = [0, 0];
let freeze = 0;
let winner = -1;

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
  // The lobby gets first refusal on a key, so SPACE starts a game rather than
  // firing a shove from a body that does not exist yet.
  if (lobbyKey(e)) {
    e.preventDefault();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === ' ') { shoveHeld = true; e.preventDefault(); return; }
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
  if (renderer3d) {
    renderer3d.resize(innerWidth, innerHeight);
    return;
  }
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
}
addEventListener('resize', resize);
resize();

/*
 * The socket reconnects on its own.
 *
 * <p>A dropped connection used to leave the page looking like the game had
 * frozen, with no way back except a manual reload, which is the wrong thing to
 * ask of someone whose wifi blinked. On reconnect the server issues a fresh id
 * and a fresh body, so the client throws away everything it believed: the
 * predictor, the clock, the pending inputs. Keeping any of it would mean
 * predicting a body that no longer exists.
 */
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws = null;
let reconnectDelay = 500;
let connected = false;

function connect() {
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    connected = true;
    reconnectDelay = 500;
  };

  ws.onmessage = ev => {
    if (fakeLagMs > 0) setTimeout(() => handle(ev.data), fakeLagMs);
    else handle(ev.data);
  };

  ws.onclose = () => {
    connected = false;
    myId = null;
    predictor = null;
    haveClock = false;
    trails.clear();
    lastVel.clear();
    drawOffset.clear();
    // Back off up to five seconds, so a server that is down does not get a
    // connection attempt every half second from every open tab.
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify(obj);
  if (fakeLagMs > 0) setTimeout(() => ws.send(payload), fakeLagMs);
  else ws.send(payload);
}

connect();

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

    predictor = new Predictor(cfg, myId, { x: cfg.w / 2, y: cfg.h / 2, r: 1.6 });
    // The 3D renderer needs the arena size, which only arrives with the welcome.
    if (!FLAT && !renderer3d) {
      import('./render3d.mjs')
        .then(({ Renderer3D }) => {
          renderer3d = new Renderer3D(canvas3d, cfg);
          renderer3d.resize(innerWidth, innerHeight);
          canvas.classList.add('hidden');
          canvas3d.classList.remove('hidden');
        })
        .catch(err => {
          // A machine without working WebGL still gets a game.
          console.warn('3D renderer unavailable, staying flat:', err);
        });
    }
    if (AUTOPILOT) send({ t: 'pick', team: 1 });
    return;
  }

  if (m.t === 'denied') {
    denied = m.reason ?? 'no';
    overlayKey = '';           // force the panel to redraw with the message
    return;
  }

  if (m.t !== 'state' || !predictor) return;

  serverTick = m.tick;
  missedOnServer = m.missed;
  score = [m.scoreA, m.scoreB];
  freeze = m.freeze;
  winner = m.winner;
  phase = m.phase;
  countdown = m.countdown;
  sideCounts = [m.norse, m.greek];
  const mine = m.bodies.find(b => b.id === myId);
  if (mine) myTeam = mine.team;
  for (const b of m.bodies) {
    bodyTeam.set(b.id, b.team);
    bodyTether.set(b.id, b.tether);
  }
  captureDrawOffsets();
  spotImpacts(m.bodies);
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
  finishDrawOffsets();
  shoveReady = m.ready;
  correctionError = predictor.lastError;
  worstCorrection = predictor.worstError;
}

/**
 * Autopilot, switched on with ?auto=1.
 *
 * <p>For demos, screenshots and recordings: open the link with the flag and the
 * page plays itself. It drives the same input path as a person, so nothing about
 * the netcode is bypassed, and there is no branch in the server at all.
 */
const AUTOPILOT = new URLSearchParams(location.search).get('auto') === '1';

function autopilot() {
  const star = predictor?.world?.byId(STAR_ID);
  const me = predictor?.body;
  if (!star || !me) return { ax: 0, ay: 0, sh: false, th: false };

  const dx = star.x - me.x;
  const dy = star.y - me.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const phase = Math.floor(performance.now() / 1500) % 4;

  if (phase === 3) {
    // Back off and swing on the rope, which is the interesting thing to watch.
    return { ax: -dy / len, ay: dx / len, sh: false, th: true };
  }
  const closeEnough = len < star.radius + me.radius + cfg.shoveRange * 0.7;
  return { ax: dx / len, ay: dy / len, sh: closeEnough, th: false };
}

/**
 * The lobby, which is DOM rather than canvas on purpose: buttons that can be
 * tabbed to and clicked are worth more than anything hand-drawn, and the arena
 * keeps running behind it so the connection is visibly alive before anyone
 * commits to a side.
 */
let overlayKey = '';

function renderOverlay() {
  const wantOverlay = myTeam < 0 || phase === 'countdown';
  overlay.classList.toggle('show', wantOverlay);
  if (!wantOverlay) {
    overlayKey = '';
    return;
  }

  /*
   * Only rebuild when something actually changed.
   *
   * This used to rewrite panel.innerHTML on every frame, which destroyed and
   * recreated the START button sixty times a second. A click needs the element
   * it went down on to still exist when it comes up, so the button was
   * unclickable, and nothing in the console said why.
   */
  const seconds = Math.max(1, Math.ceil(countdown / cfg.hz));
  const key = [lobbyScreen, phase, myTeam, sideCounts[0], sideCounts[1], denied,
               phase === 'countdown' ? seconds : 0].join('|');
  if (key === overlayKey) return;
  overlayKey = key;

  if (phase === 'countdown' && myTeam >= 0) {
    panel.innerHTML =
      `<div id="countdown">${seconds}</div>` +
      `<div class="tag">${TEAM_NAME[myTeam]}</div>`;
    return;
  }

  if (lobbyScreen === 'start') {
    panel.innerHTML =
      `<img class="wordmark" src="./wordmark.png" alt="ORRERY">` +
      `<div class="tag">feed the star to the serpent</div>` +
      `<button id="startbtn">START</button>` +
      `<div class="hint">click, or press ENTER or SPACE</div>`;
    const btn = document.getElementById('startbtn');
    btn.onclick = startPressed;
    btn.focus();
    return;
  }

  // A side that is already ahead cannot be joined; the server enforces it and
  // this only saves someone the click.
  const norseFull = sideCounts[0] > sideCounts[1];
  const greekFull = sideCounts[1] > sideCounts[0];
  panel.innerHTML =
    `<h1>PICK A SIDE</h1>` +
    `<div class="tag">left jaws are Greek, right jaws are Norse</div>` +
    `<div class="sides">` +
      `<button class="norse" data-team="0"${norseFull ? ' disabled' : ''}>NORSE</button>` +
      `<button class="greek" data-team="1"${greekFull ? ' disabled' : ''}>GREEK</button>` +
    `</div>` +
    `<div class="count">${sideCounts[0]} norse · ${sideCounts[1]} greek` +
      (denied ? `   <span id="warn">${denied}</span>` : '') + `</div>` +
    `<div class="hint">click a side, or press ENTER or SPACE to take the emptier one</div>`;
  for (const b of panel.querySelectorAll('[data-team]')) {
    if (!b.disabled) b.onclick = () => pickSide(Number(b.dataset.team));
  }
}

/** START, by mouse or by key. */
function startPressed() {
  lobbyScreen = 'sides';
  renderOverlay();
}

function pickSide(team) {
  send({ t: 'pick', team });
}

/**
 * Enter and Space work anywhere in the lobby.
 *
 * A game that opens with a single button should not require finding it with a
 * mouse, and the two keys everyone tries first are the two that were doing
 * nothing at all.
 */
function lobbyKey(e) {
  if (myTeam >= 0) return false;                 // already in the match
  const k = e.key;
  const confirm = k === 'Enter' || k === ' ' || k === 'Spacebar';

  if (lobbyScreen === 'start') {
    if (confirm) { startPressed(); return true; }
    return false;
  }

  if (k === 'ArrowLeft' || k === '1') { pickSide(0); return true; }
  if (k === 'ArrowRight' || k === '2') { pickSide(1); return true; }
  if (confirm) {
    // The emptier side, so pressing one key twice does not stack a team.
    pickSide(sideCounts[0] <= sideCounts[1] ? 0 : 1);
    return true;
  }
  return false;
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
  // No body, no inputs. A player in the lobby is a spectator.
  if (myTeam < 0) return;
  const tick = ++predTick;
  let { ax, ay } = readKeys();
  // One shove per press, not one per tick the bar is held down.
  let sh = shoveHeld && tick >= predictor.shoveReadyTick;
  if (sh) shoveHeld = false;
  let th = keys.has('shift');

  if (AUTOPILOT) {
    const a = autopilot();
    ax = a.ax;
    ay = a.ay;
    sh = a.sh && tick >= predictor.shoveReadyTick;
    th = a.th;
  }
  seq++;
  const input = { ax, ay, sh, th };
  predictor.setInput(tick, input);
  sentAt.set(seq, performance.now());
  // rt is the snapshot our predicted world is built from. The server resolves a
  // shove against that moment, which is the one we could actually see, and it
  // is also the state our own prediction of the shove used.
  send({ t: 'input', seq, tick, ax, ay, sh, th, rt: serverTick });

  // Always advance, even with prediction switched off, so the predictor's tick
  // and history stay aligned with the server and P can be toggled at any moment.
  predictor.advance(tick);
}

/*
 * The tick loop runs on its own timer, NOT inside the render loop.
 *
 * It used to be driven by requestAnimationFrame, which is fine until a frame
 * gets expensive. Under software WebGL a frame can take hundreds of
 * milliseconds, the ticks stopped being emitted, no input reached the server,
 * and the connection eventually dropped: a rendering cost turning into a
 * network failure. Input is not allowed to depend on how fast the picture is.
 *
 * It is still a fixed-step accumulator rather than one tick per timer fire,
 * because setInterval drifts, and a drifting client clock is the bug this whole
 * design exists to avoid.
 */
let lastTickAt = performance.now();
let accumulator = 0;

function tickLoop() {
  const now = performance.now();
  let elapsed = now - lastTickAt;
  lastTickAt = now;
  if (elapsed > 250) elapsed = 250;   // came back from a background tab
  accumulator += elapsed;

  let guard = 0;
  while (accumulator >= cfg.dtMs && guard++ < 12) {
    accumulator -= cfg.dtMs;
    localTick();
    if (haveClock && predTick < targetTick && guard++ < 12) localTick();
  }
  if (haveClock && predTick > targetTick + 1) accumulator = 0;
}

setInterval(tickLoop, 1000 / 120);   // twice the tick rate, so the step is never late

/**
 * Everything, as the predictor believes it is right now.
 *
 * <p>Each body carries a small drawing offset that decays toward zero, so a
 * correction slides the drawn position over a few frames instead of teleporting
 * it. The simulation is never smoothed, only the picture of it.
 */
const drawOffset = new Map();   // id -> {dx, dy}

/* ---- Look ----------------------------------------------------------------
 * All of this is drawing only. None of it touches the simulation, and none of
 * it is allowed to: the physics has to stay identical to the server's, and a
 * trail that nudged a position would be the least funny bug in the project.
 */
const trails = new Map();       // id -> [{x, y}], newest last
const lastVel = new Map();      // id -> {vx, vy}, for spotting impacts
const flashes = [];             // {x, y, born, strength}
const TRAIL_LENGTH = 16;

function recordTrails() {
  if (!predictor) return;
  for (const b of predictor.world.bodies) {
    if (b.immovable) continue;
    let trail = trails.get(b.id);
    if (!trail) { trail = []; trails.set(b.id, trail); }
    trail.push({ x: b.x, y: b.y });
    if (trail.length > TRAIL_LENGTH) trail.shift();
  }
  for (const id of trails.keys()) {
    if (!predictor.world.byId(id)) trails.delete(id);
  }
}

/** A hit is a velocity that changed faster than a thruster could change it. */
function spotImpacts(bodies) {
  for (const b of bodies) {
    const was = lastVel.get(b.id);
    lastVel.set(b.id, { vx: b.vx, vy: b.vy });
    if (!was) continue;
    const delta = Math.hypot(b.vx - was.vx, b.vy - was.vy);
    /*
     * Thrust across one snapshot is about 2 units/s, so 4 looked like a safe
     * floor for "that was a hit". It was not: a body sliding along a fragment
     * clears it on almost every snapshot, and the screen filled with a chain of
     * rings following each player around. 9 only fires on a real collision or a
     * shove, and a flash that appears rarely is worth more than one that is
     * always on.
     */
    if (delta > 9) {
      const now = performance.now();
      // One flash per body at a time, so a long contact does not stack.
      const recent = flashes.some(f => f.id === b.id && now - f.born < 200);
      if (!recent) {
        const strength = Math.min(delta / 24, 1);
        flashes.push({ id: b.id, x: b.x, y: b.y, born: now, strength });
        if (flashes.length > 24) flashes.shift();
        if (renderer3d) renderer3d.addFlash(b.x, b.y, strength);
      }
    }
  }
}

function drawFlashes(now) {
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    const age = (now - f.born) / 420;
    if (age >= 1) { flashes.splice(i, 1); continue; }
    ctx.beginPath();
    ctx.arc(f.x, f.y, 1 + age * 7 * f.strength, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 232, 190, ${(1 - age) * 0.5 * f.strength})`;
    ctx.stroke();
  }
}

function drawTrail(b, color) {
  const trail = trails.get(b.id);
  if (!trail || trail.length < 2) return;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], c = trail[i];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(c.x, c.y);
    ctx.strokeStyle = color.replace('ALPHA', String((i / trail.length) * 0.28));
    ctx.stroke();
  }
}

/** The plume, drawn opposite the thrust, for the one body whose input we know. */
function drawPlume(me) {
  const input = predictor?.inputs.get(predTick) ?? predictor?.held;
  if (!input || (input.ax === 0 && input.ay === 0)) return;
  const len = Math.sqrt(input.ax * input.ax + input.ay * input.ay);
  if (len === 0) return;
  const nx = -input.ax / len, ny = -input.ay / len;
  const base = me.radius * 0.85;
  const tip = me.radius * (2.4 + Math.sin(performance.now() / 40) * 0.35);
  ctx.beginPath();
  ctx.moveTo(me.x + nx * base - ny * base * 0.5, me.y + ny * base + nx * base * 0.5);
  ctx.lineTo(me.x + nx * tip, me.y + ny * tip);
  ctx.lineTo(me.x + nx * base + ny * base * 0.5, me.y + ny * base - nx * base * 0.5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(127, 227, 192, .38)';
  ctx.fill();
}

function smoothedBodies() {
  if (!predictor) return [];
  const out = [];
  for (const b of predictor.world.bodies) {
    const off = drawOffset.get(b.id);
    if (off) {
      off.dx *= 1 - SMOOTH_PER_TICK;
      off.dy *= 1 - SMOOTH_PER_TICK;
      if (Math.abs(off.dx) < 0.01 && Math.abs(off.dy) < 0.01) drawOffset.delete(b.id);
    }
    out.push({
      id: b.id,
      x: b.x + (off ? off.dx : 0),
      y: b.y + (off ? off.dy : 0),
      r: b.radius,
      team: bodyTeam.get(b.id) ?? -1,
      fixed: b.immovable,
      tether: bodyTether.get(b.id) ?? 0,
    });
  }
  return out;
}

/** Note where a body is drawn now, so the coming correction can be eased in. */
function captureDrawOffsets() {
  if (!predictor) return;
  for (const b of predictor.world.bodies) {
    if (b.id === myId) continue;
    drawOffset.set(b.id, {
      dx: (drawOffset.get(b.id)?.dx ?? 0) + b.x,
      dy: (drawOffset.get(b.id)?.dy ?? 0) + b.y,
    });
  }
}

function finishDrawOffsets() {
  if (!predictor) return;
  for (const b of predictor.world.bodies) {
    if (b.id === myId) continue;
    const off = drawOffset.get(b.id);
    if (!off) continue;
    off.dx -= b.x;
    off.dy -= b.y;
    // A correction bigger than a body is a teleport, not a nudge: a goal reset
    // or somebody joining. Snap those rather than sliding across the arena.
    if (Math.hypot(off.dx, off.dy) > b.radius * 3) drawOffset.delete(b.id);
  }
}

function frame() {
  draw(performance.now());
  /*
 * A read-only handle for tests. tools and the input tests use it to ask the
 * renderer where a body actually lands on screen, rather than reimplementing
 * the projection and then testing their own arithmetic.
 */
window.__orrery = {
  get renderer3d() { return renderer3d; },
  get THREE() { return renderer3d?.THREE; },
  me: () => (myTeam < 0 ? null : (predictionOn ? predictor?.body : serverMe)),
};

requestAnimationFrame(frame);
}

/**
 * The star is the only light in here, so it is drawn as a light rather than as
 * a circle: a hot core inside a falloff that reaches most of the arena.
 */
function drawStar(b) {
  // Reach and strength both pulled back from the first attempt, which lit the
  // whole top of the screen and made the HUD hard to read. The star should say
  // "here I am" from across the arena without being the brightest thing on it.
  // A slow pulse, so a star sitting still still reads as something burning.
  const pulse = 1 + Math.sin(performance.now() / 620) * 0.06;
  const reach = b.r * 6 * pulse;
  const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, reach);
  glow.addColorStop(0, 'rgba(255,236,190,0.38)');
  glow.addColorStop(0.3, 'rgba(255,196,90,0.10)');
  glow.addColorStop(1, 'rgba(255,170,40,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(b.x, b.y, reach, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe9b0';
  ctx.fill();
}

function draw(now) {
  recordTrails();

  if (renderer3d) {
    const me = myTeam < 0 ? null : (predictionOn ? predictor?.body : serverMe);
    const drawn = smoothedBodies();
    // Replace the local player's entry with the predicted body, so the thing
    // you steer is the thing that answers instantly.
    if (me) {
      const i = drawn.findIndex(b => b.id === myId);
      const mine = {
        id: myId, x: me.x, y: me.y, r: me.radius ?? me.r,
        team: myTeam, fixed: false, tether: predictor?.anchor?.id ?? 0,
      };
      if (i >= 0) drawn[i] = mine;
      else drawn.push(mine);
    } else {
      const i = drawn.findIndex(b => b.id === myId);
      if (i >= 0) drawn.splice(i, 1);
    }
    renderer3d.draw(drawn, myId, ghostOn && serverMe && myTeam >= 0 ? serverMe : null);
    drawHud();
    return;
  }

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

  drawFlashes(now);

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

  for (const b of smoothedBodies()) {
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
    drawTrail(b, b.team === myTeam ? 'rgba(74,111,165,ALPHA)' : 'rgba(138,90,60,ALPHA)');
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
  const drawn = smoothedBodies();
  for (const b of drawn) {
    if (b.id === myId || !b.tether) continue;
    const anchor = drawn.find(x => x.id === b.tether);
    if (!anchor) continue;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(anchor.x, anchor.y);
    ctx.strokeStyle = 'rgba(150,170,210,.4)';
    ctx.stroke();
  }

  // The predictor always owns a body so it has something to simulate, but a
  // player in the lobby has no body on the server. Drawing the local one put a
  // ghost player in the middle of the arena before anyone had picked a side.
  const me = myTeam < 0 ? null : (predictionOn ? predictor?.body : serverMe);
  if (me) {
    const r = me.radius ?? me.r;
    drawTrail(me, 'rgba(127,227,192,ALPHA)');
    drawPlume(me);
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

  if (freeze > 0) {
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = winner >= 0 ? `${TEAM_NAME[winner].toUpperCase()} WIN` : 'GOAL';
    ctx.font = `600 ${winner >= 0 ? 9 : 11}px ui-monospace, Menlo, monospace`;
    // Fades as the pause runs out, so the world coming back to life is visible
    // rather than sudden.
    const span = winner >= 0 ? 240 : 90;
    ctx.globalAlpha = Math.min(1, freeze / (span * 0.5));
    ctx.fillStyle = winner >= 0 ? TEAM_COLOR[winner] : '#ffe9b0';
    ctx.fillText(big, cfg.w / 2, cfg.h / 2);
    ctx.globalAlpha = 1;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawHud();
}

/**
 * The DOM parts of the screen: lobby overlay, scoreboard, diagnostics.
 *
 * Shared by both renderers rather than duplicated in each, which is how it was
 * briefly written and how it broke: the flat path called a drawHud() that had
 * never been defined, and the only symptom was an exception every frame that
 * nobody was reading.
 */
function drawHud() {
  renderOverlay();

  hud.innerHTML =
    `orrery  <b>you are ${myId ?? '...'}</b> ` +
    `(${myTeam >= 0 ? TEAM_NAME[myTeam] : 'lobby'})   phase ${phase}\n` +
    `server tick ${serverTick}   client tick ${predTick}   lead ${predTick - serverTick}\n` +
    `rtt ${rttMs.toFixed(0)}ms   fake lag ${fakeLagMs}ms   missed on server ${missedOnServer}\n` +
    `prediction ${predictionOn ? '<b>on</b>' : '<span id="warn">off</span>'}` +
    `   replayed ${replayedLast}\n` +
    `correction ${correctionError.toFixed(4)}  worst ${worstCorrection.toFixed(4)}\n` +
    `shove ${predTick >= shoveReady ? '<b>ready</b>' : 'in ' +
        Math.max(0, Math.ceil((shoveReady - predTick) / 60 * 10) / 10) + 's'}\n` +
    `WASD thrust   SPACE shove   SHIFT tether   P prediction   L lag   G ghost` +
    (AUTOPILOT ? '   <b>autopilot</b>' : '') +
    (connected ? '' : '\n<span id="warn">disconnected, reconnecting</span>');

  scoreboard.innerHTML =
    `<span class="norse">NORSE <b>${score[0]}</b></span>` +
    `<span style="opacity:.4">   ·   </span>` +
    `<span class="greek"><b>${score[1]}</b> GREEK</span>`;
}


// Start drawing. The tick loop above runs on its own timer, so input keeps
// flowing even when a frame is slow; this is only the picture.
requestAnimationFrame(frame);
