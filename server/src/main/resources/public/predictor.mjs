// Client-side prediction and reconciliation, in one place.
//
// The browser and tools/predict-check.mjs both use this. If the checker had its
// own copy it could pass while the game was broken, which would make it worse
// than useless.
//
// TWO RULES, both learned the hard way by measuring:
//
//   1. SIMULATE EVERY TICK, NOT EVERY INPUT. The server steps the world on every
//      tick whether or not an input arrived for it, holding the last intent when
//      none did. A client that only simulates the ticks it has inputs for runs
//      fewer steps than the server and drifts by a whole body within seconds.
//      Measured at 1.95 units of mean error before this was fixed.
//
//   2. COMPARE LIKE WITH LIKE. The client deliberately runs ahead of the server,
//      so comparing "where I am now" against "where the server says I am" is
//      comparing two different moments and reports an enormous error that is not
//      real. The predictor keeps a short history of its own past states and
//      compares against the one for the tick the snapshot describes.

import { World, Body, stepWithInput } from './sim.mjs';

/** Ticks of past states kept for measuring error. Four seconds at 60Hz. */
const HISTORY = 240;

export class Predictor {
  /**
   * @param {{w:number,h:number,dt:number,thrust:number,maxSpeed:number,restitution:number}} cfg
   * @param {number} id
   * @param {{x:number,y:number,r:number}} start
   */
  constructor(cfg, id, start) {
    this.cfg = cfg;
    this.id = id;
    this.world = new World(cfg.w, cfg.h, {
      maxSpeed: cfg.maxSpeed,
      wallRestitution: cfg.restitution,
      bodyRestitution: cfg.bodyRestitution,
    });
    this.body = this.world.add(new Body(id, start.x, start.y, start.r ?? 1.6, 1));
    this.inputs = new Map();   // tick -> {ax, ay}
    this.history = new Map();  // tick -> snapshot of our own predicted state
    this.tick = 0;             // the tick our state is the result of
    this.held = { ax: 0, ay: 0 };
    this.lastError = 0;
    this.worstError = 0;
  }

  /** Record the intent addressed to a tick. */
  setInput(tick, input) {
    this.inputs.set(tick, input);
  }

  /** Advance one tick, using the input for it or holding the last one. */
  advance(tick, frozen = false) {
    const input = this.inputs.get(tick) ?? this.held;
    this.held = input;
    // During the pause after a goal the server ignores thrust, so predicting
    // any would put us somewhere the server never goes.
    const applied = frozen ? { ax: 0, ay: 0 } : input;
    stepWithInput(this.world, this.body, applied, this.cfg.thrust, this.cfg.dt);
    this.tick = tick;
    this.history.set(tick, {
      x: this.body.x, y: this.body.y, vx: this.body.vx, vy: this.body.vy,
    });
    this.prune(tick);
  }

  /**
   * Fold in the truth as of serverTick, then replay everything after it.
   *
   * @returns the distance between what we had predicted for that tick and what
   *          actually happened. Near zero means the two simulations agree.
   */
  /**
   * Bring the local world in line with a snapshot: add bodies that appeared,
   * drop ones that left, and set every one of them to the server's numbers.
   *
   * <p>The whole world is mirrored, not just your own body, because the star
   * you are about to hit is part of your own prediction. Other players are
   * mirrored too and then simulated with no input at all, which is wrong the
   * moment they thrust, and right for the fraction of a second that matters
   * for a collision. They are drawn from interpolated snapshots regardless, so
   * the error never reaches the screen except through contact with you.
   */
  syncWorld(bodies) {
    const seen = new Set();
    for (const s of bodies) {
      seen.add(s.id);
      let b = this.world.byId(s.id);
      if (!b) {
        b = this.world.add(new Body(s.id, s.x, s.y, s.r, s.m ?? 1));
        if (s.id === this.id) this.body = b;
      }
      b.x = s.x; b.y = s.y; b.vx = s.vx; b.vy = s.vy;
      b.radius = s.r;
      if (s.m) b.mass = s.m;
    }
    // Anything the server no longer has, we no longer have.
    this.world.bodies = this.world.bodies.filter(b => seen.has(b.id));
    const mine = this.world.byId(this.id);
    if (mine) this.body = mine;
  }

  reconcile(serverTick, truth, frozenTicks = 0) {
    const mine = Array.isArray(truth)
        ? truth.find(b => b.id === this.id)
        : truth;
    if (!mine) return 0;
    const predicted = this.history.get(serverTick);
    if (predicted) {
      this.lastError = Math.hypot(predicted.x - mine.x, predicted.y - mine.y);
      if (this.lastError > this.worstError) this.worstError = this.lastError;
    }

    if (Array.isArray(truth)) {
      this.syncWorld(truth);
    } else {
      this.body.x = truth.x;
      this.body.y = truth.y;
      this.body.vx = truth.vx;
      this.body.vy = truth.vy;
      if (truth.r) this.body.radius = truth.r;
    }

    // Re-establish what the server would have been holding at this point, so a
    // replayed gap holds the same intent the server held.
    this.held = this.inputAtOrBefore(serverTick);

    const to = this.tick;
    this.history.clear();
    this.history.set(serverTick, { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy });

    let replayed = 0;
    for (let t = serverTick + 1; t <= to; t++) {
      // Ticks still inside the post-goal pause are replayed without thrust,
      // matching what the server did with them.
      this.advance(t, replayed < frozenTicks);
      replayed++;
    }
    this.tick = to;
    return replayed;
  }

  /** The intent the server would be holding at this tick. */
  inputAtOrBefore(tick) {
    for (let t = tick; t > tick - HISTORY; t--) {
      const i = this.inputs.get(t);
      if (i) return i;
    }
    return { ax: 0, ay: 0 };
  }

  prune(tick) {
    for (const t of this.inputs.keys()) if (t < tick - HISTORY) this.inputs.delete(t);
    for (const t of this.history.keys()) if (t < tick - HISTORY) this.history.delete(t);
  }
}
