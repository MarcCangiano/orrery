#!/usr/bin/env node
// Replays the Java fixture's input script through the JavaScript simulation and
// compares every tick, bit for bit.
//
// Exact equality, not a tolerance. A tolerance would pass on exactly the slow
// divergence this is built to catch: two simulations that agree to six decimals
// today and are half a body apart after a minute of play.
//
// Usage: node tools/drift-check.mjs <fixture.json>

import { readFileSync } from 'node:fs';
import { World, Body, stepWithInput } from '../server/src/main/resources/public/sim.mjs';

const path = process.argv[2];
if (!path) {
  console.error('usage: drift-check.mjs <fixture.json>');
  process.exit(2);
}

const fx = JSON.parse(readFileSync(path, 'utf8'));

// The same pure function of tick number as DriftFixture.java. Duplicated on
// purpose rather than shipped in the fixture: if the script itself came from the
// Java side, a bug in how the Java reads its own inputs would be invisible.
function ax(tick) {
  if (tick < 120) return 1;
  if (tick < 200) return -1;
  if (tick < 260) return 0;
  if (tick < 400) return 0.5;
  return -0.25;
}

function ay(tick) {
  if (tick < 60) return 0;
  if (tick < 180) return -1;
  if (tick < 300) return 1;
  if (tick < 420) return -0.75;
  return 0;
}

const world = new World(fx.width, fx.height, {
  maxSpeed: fx.maxSpeed,
  wallRestitution: fx.restitution,
});
const body = world.add(new Body(1, fx.start.x, fx.start.y, fx.radius, fx.mass));
const dt = 1 / fx.hz;

let firstDivergence = null;
let maxDelta = 0;

for (let tick = 0; tick < fx.ticks.length; tick++) {
  stepWithInput(world, body, { ax: ax(tick), ay: ay(tick) }, fx.thrust, dt);

  const want = fx.ticks[tick];
  const deltas = [
    Math.abs(body.x - want.x),
    Math.abs(body.y - want.y),
    Math.abs(body.vx - want.vx),
    Math.abs(body.vy - want.vy),
  ];
  const worst = Math.max(...deltas);
  if (worst > maxDelta) maxDelta = worst;

  const same =
    body.x === want.x && body.y === want.y &&
    body.vx === want.vx && body.vy === want.vy;

  if (!same && firstDivergence === null) {
    firstDivergence = { tick, got: { x: body.x, y: body.y, vx: body.vx, vy: body.vy }, want };
  }
}

if (firstDivergence === null) {
  console.log(`drift-check: OK — ${fx.ticks.length} ticks, identical to the last bit`);
  process.exit(0);
}

console.error('drift-check: FAILED');
console.error(`  first divergence at tick ${firstDivergence.tick}`);
console.error(`  java says ${JSON.stringify(firstDivergence.want)}`);
console.error(`  js   says ${JSON.stringify(firstDivergence.got)}`);
console.error(`  worst delta across the run: ${maxDelta}`);
console.error('');
console.error('  The two simulations have drifted. Client prediction is not');
console.error('  trustworthy until this is zero. Check operation order first.');
process.exit(1);
