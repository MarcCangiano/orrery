#!/usr/bin/env node
// Connects, does NOT take a side, and asserts the arena is visible anyway.
//
// The client used to skip mirroring the world whenever a snapshot contained no
// body of its own, which is the normal state of everyone in the lobby. The star
// and the ring fragments were simply absent from the screen until you joined a
// team. Watching is a thing people do.
//
// Usage: node tools/spectator-check.mjs [ws://localhost:7070/ws]

import { Predictor } from '../server/src/main/resources/public/predictor.mjs';

const url = process.argv[2] ?? 'ws://localhost:7070/ws';
const cfg = { dt: 1 / 60, dtMs: 1000 / 60, thrust: 60, w: 120, h: 70, maxSpeed: 40, restitution: 0.75 };
let predictor = null;
let snapshots = 0;

const ws = new WebSocket(url);
ws.addEventListener('error', () => {
  console.error('spectator-check: could not connect. Start the server first.');
  process.exit(2);
});

ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.t === 'welcome') {
    Object.assign(cfg, { w: m.w, h: m.h, thrust: m.thrust, maxSpeed: m.maxSpeed,
      restitution: m.restitution, bodyRestitution: m.bodyRestitution,
      dt: 1 / m.hz, dtMs: 1000 / m.hz });
    predictor = new Predictor(cfg, m.id, { x: cfg.w / 2, y: cfg.h / 2, r: 1.6 });
    return;   // deliberately never picks a side
  }
  if (m.t !== 'state' || !predictor) return;
  snapshots++;
  predictor.reconcile(m.tick, m.bodies, m.freeze, m.ready);
});

setTimeout(() => {
  ws.close();
  const bodies = predictor?.world?.bodies ?? [];
  const star = bodies.filter(b => b.id === -1).length;
  const fragments = bodies.filter(b => b.id <= -100).length;
  console.log(`spectator-check: ${snapshots} snapshots, ${bodies.length} bodies visible ` +
              `(${star} star, ${fragments} fragments)`);
  if (snapshots === 0) {
    console.error('spectator-check: FAILED — no snapshots arrived');
    process.exit(1);
  }
  if (star !== 1 || fragments < 4) {
    console.error('spectator-check: FAILED — a spectator cannot see the arena');
    console.error('  The client is skipping the world sync when it has no body.');
    process.exit(1);
  }
  console.log('spectator-check: OK — the arena is visible without joining');
  process.exit(0);
}, 4000);
