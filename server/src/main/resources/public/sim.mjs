// The simulation, in JavaScript.
//
// This is a line-for-line mirror of World.java and Body.java on the server. It
// exists so the browser can predict its own movement instead of waiting a round
// trip to find out where it is.
//
// RULES FOR EDITING THIS FILE
//   1. Any change here is a change in the Java too, and the reverse.
//   2. Operation order matters. Floating point addition is not associative, so
//      `x += vx * dt` and `x = x + (vx * dt)` are the same but reordering a sum
//      is not. Keep the shape identical to the Java.
//   3. No Math.hypot. Java's and JavaScript's are specified differently. Both
//      sides use sqrt(vx*vx + vy*vy).
//   4. No wall clock, no randomness, no iteration over object keys.
//
// tools/drift-check.sh runs both simulations over the same inputs and fails if
// they disagree by a single bit.

export class Body {
  constructor(id, x, y, radius, mass, immovable = false) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.radius = radius;
    this.mass = mass;
    // Ring fragments. Infinite mass rather than a separate type, so there is
    // only ever one collision code path.
    this.immovable = immovable;
  }

  invMass() {
    return this.immovable ? 0 : 1 / this.mass;
  }

  applyForce(fx, fy, dt) {
    if (this.immovable) return;
    this.vx += (fx / this.mass) * dt;
    this.vy += (fy / this.mass) * dt;
  }

  speed() {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy);
  }

  clampSpeed(max) {
    const s = this.speed();
    if (s > max && s > 0) {
      const k = max / s;
      this.vx *= k;
      this.vy *= k;
    }
  }
}

export class World {
  // Defaults match the Java, but the server sends its own values on welcome and
  // the client overwrites these. The server is the source of truth for every
  // constant; these are only here so the file runs standalone in a test.
  constructor(width, height, opts = {}) {
    this.width = width;
    this.height = height;
    this.maxSpeed = opts.maxSpeed ?? 40.0;
    this.wallRestitution = opts.wallRestitution ?? 0.75;
    this.bodyRestitution = opts.bodyRestitution ?? 0.9;
    this.bodies = [];
  }

  add(body) {
    this.bodies.push(body);
    return body;
  }

  byId(id) {
    for (const b of this.bodies) {
      if (b.id === id) return b;
    }
    return null;
  }

  step(dt) {
    for (const b of this.bodies) {
      if (b.immovable) continue;
      b.clampSpeed(this.maxSpeed);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      this.bounceOffWalls(b);
    }
    this.resolveCollisions();
  }

  // Push everything nearby away and take the opposite push. Mirrors
  // World.shove on the server exactly.
  shove(actor, range, impulse) {
    let touched = 0;
    for (const b of this.bodies) {
      if (b === actor) continue;
      const dx = b.x - actor.x;
      const dy = b.y - actor.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const reach = actor.radius + b.radius + range;
      if (dist >= reach || dist === 0) continue;

      const nx = dx / dist;
      const ny = dy / dist;
      let falloff = 1.0 - (dist - actor.radius - b.radius) / range;
      if (falloff < 0) falloff = 0;
      const j = impulse * falloff;

      const invB = b.invMass();
      const invA = actor.invMass();
      b.vx += nx * j * invB;
      b.vy += ny * j * invB;
      actor.vx -= nx * j * invA;
      actor.vy -= ny * j * invA;
      touched++;
    }
    return touched;
  }

  // One pass, in insertion order. Not iterated to convergence on purpose: the
  // same answer every time matters more here than the most accurate answer,
  // because the server runs this too.
  resolveCollisions() {
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        this.collide(this.bodies[i], this.bodies[j]);
      }
    }
  }

  collide(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = a.radius + b.radius;
    if (dist >= minDist) return;

    let nx, ny;
    if (dist === 0) {
      nx = a.id < b.id ? 1 : -1;
      ny = 0;
      dist = minDist;
    } else {
      nx = dx / dist;
      ny = dy / dist;
    }

    const invA = a.invMass();
    const invB = b.invMass();
    if (invA + invB === 0) return;
    const overlap = minDist - dist;
    const share = overlap / (invA + invB);
    a.x -= nx * share * invA;
    a.y -= ny * share * invA;
    b.x += nx * share * invB;
    b.y += ny * share * invB;

    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const along = rvx * nx + rvy * ny;
    if (along > 0) return;

    const impulse = -(1 + this.bodyRestitution) * along / (invA + invB);
    a.vx -= impulse * nx * invA;
    a.vy -= impulse * ny * invA;
    b.vx += impulse * nx * invB;
    b.vy += impulse * ny * invB;
  }

  // A rope, not a spring: acts only when taut, removes only the outward part of
  // the velocity, leaves swing speed untouched. Mirrors World.applyTether.
  static applyTether(body, ax, ay, length) {
    const dx = body.x - ax;
    const dy = body.y - ay;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= length || dist === 0) return;

    const nx = dx / dist;
    const ny = dy / dist;
    body.x = ax + nx * length;
    body.y = ay + ny * length;

    const outward = body.vx * nx + body.vy * ny;
    if (outward > 0) {
      body.vx -= outward * nx;
      body.vy -= outward * ny;
    }
  }

  bounceOffWalls(b) {
    const min = b.radius;
    const maxX = this.width - b.radius;
    const maxY = this.height - b.radius;

    if (b.x < min) {
      b.x = min;
      if (b.vx < 0) b.vx = -b.vx * this.wallRestitution;
    } else if (b.x > maxX) {
      b.x = maxX;
      if (b.vx > 0) b.vx = -b.vx * this.wallRestitution;
    }

    if (b.y < min) {
      b.y = min;
      if (b.vy < 0) b.vy = -b.vy * this.wallRestitution;
    } else if (b.y > maxY) {
      b.y = maxY;
      if (b.vy > 0) b.vy = -b.vy * this.wallRestitution;
    }
  }
}

/**
 * One tick for one body under one input. The server does exactly this, in this
 * order: apply the intent as a force, then step the world.
 *
 * Kept in one function so the live client and the replay path cannot drift
 * apart from each other, which would be a second, subtler version of the same
 * bug this file is designed to avoid.
 */
export function stepWithInput(world, body, input, thrust, dt) {
  body.applyForce(input.ax * thrust, input.ay * thrust, dt);
  world.step(dt);
}

/** The order the server uses within a tick: shove first, then thrust, then step. */
export function tickWithInput(world, body, input, cfg, canShove) {
  let shoved = false;
  if (input.sh && canShove) {
    world.shove(body, cfg.shoveRange, cfg.shoveImpulse);
    shoved = true;
  }
  body.applyForce(input.ax * cfg.thrust, input.ay * cfg.thrust, cfg.dt);
  world.step(cfg.dt);
  return shoved;
}
