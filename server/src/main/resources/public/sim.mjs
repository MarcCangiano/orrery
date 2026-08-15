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
  constructor(id, x, y, radius, mass) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.radius = radius;
    this.mass = mass;
  }

  applyForce(fx, fy, dt) {
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
      b.clampSpeed(this.maxSpeed);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      this.bounceOffWalls(b);
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
