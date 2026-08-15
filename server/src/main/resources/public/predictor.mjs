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
    /** Tick our own shove is available again. Re-synced from every snapshot. */
    this.shoveReadyTick = 0;
    /** Anchor body we are roped to, or null, plus the rope's length. */
    this.anchor = null;
    this.tetherLength = 0;
  }

  /** Record the intent addressed to a tick. */
  setInput(tick, input) {
    this.inputs.set(tick, input);
  }

  /** Advance one tick, using the input for it or holding the last one. */
  advance(tick, frozen = false) {
    const own = this.inputs.get(tick);
    const input = own ?? this.held;
    this.held = input;
    // During the pause after a goal the server ignores thrust, so predicting
    // any would put us somewhere the server never goes.
    const applied = frozen ? { ax: 0, ay: 0 } : input;

    // Tether is a hold, so the held intent is right here. Same rule and same
    // anchor choice as the server, or a swing would predict as a straight line.
    if (!frozen) {
      if (input.th) {
        if (!this.anchor) {
          this.anchor = this.nearestAnchor();
          if (this.anchor) {
            const dx = this.body.x - this.anchor.x;
            const dy = this.body.y - this.anchor.y;
            this.tetherLength = Math.min(
              Math.sqrt(dx * dx + dy * dy), this.cfg.tetherMax);
          }
        }
      } else {
        this.anchor = null;
      }
      if (this.anchor) {
        World.applyTether(this.body, this.anchor.x, this.anchor.y, this.tetherLength);
      }
    }

    // The shove fires only on a tick we actually addressed an input to, never
    // from a held intent, matching the server exactly. See GameServer.
    if (!frozen && own && own.sh && tick >= this.shoveReadyTick) {
      this.world.shove(this.body, this.cfg.shoveRange, this.cfg.shoveImpulse);
      this.shoveReadyTick = tick + this.cfg.shoveCooldown;
    }

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
    // Rebuilt in the SERVER'S order, every time, rather than updated in place.
    //
    // Collisions resolve as a single pass over the list, so when three bodies
    // touch at once the order decides the answer. The client used to start its
    // list with its own body and append everyone else as they appeared, while
    // the server's list begins with the star. Two bodies alone are symmetric
    // and agreed; a player wedged between the star and a ring fragment did not,
    // and it showed up as a 0.23 unit spike exactly on the ticks with contact.
    const rebuilt = [];
    for (const s of bodies) {
      let b = this.world.byId(s.id);
      if (!b) b = new Body(s.id, s.x, s.y, s.r, s.m ?? 1);
      b.x = s.x; b.y = s.y; b.vx = s.vx; b.vy = s.vy;
      b.radius = s.r;
      if (s.m) b.mass = s.m;
      b.immovable = !!s.fixed;
      rebuilt.push(b);
    }
    this.world.bodies = rebuilt;
    const mine = this.world.byId(this.id);
    if (mine) this.body = mine;
  }

  reconcile(serverTick, truth, frozenTicks = 0, serverShoveReady = null) {
    const mine = Array.isArray(truth)
        ? truth.find(b => b.id === this.id)
        : truth;
    if (!mine) return 0;
    const predicted = this.history.get(serverTick);
    /*
     * A goal teleports every body back to its spawn, which is an authoritative
     * event rather than a failure of prediction. Counting it made the HUD report
     * a worst correction of 85 units, most of the arena, on a client whose
     * prediction was in fact exact. The number is only worth showing if it means
     * one thing.
     */
    if (predicted && frozenTicks === 0) {
      this.lastError = Math.hypot(predicted.x - mine.x, predicted.y - mine.y);
      if (this.lastError > this.worstError) this.worstError = this.lastError;
    } else if (frozenTicks > 0) {
      this.lastError = 0;
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

    // The server's cooldown wins. Ours can be ahead of it when a shove input
    // was lost, and replaying with the wrong one would fire a shove the server
    // never fired.
    if (serverShoveReady !== null) this.shoveReadyTick = serverShoveReady;

    // The server owns the rope. Adopting its anchor and length rather than
    // trusting our own means a catch that happened a tick apart is corrected
    // here instead of leaving a permanent offset.
    if (mine.tether) {
      this.anchor = this.world.byId(mine.tether) ?? null;
      if (this.anchor && mine.tlen) this.tetherLength = mine.tlen;
    } else {
      this.anchor = null;
    }

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

  /** Nearest fragment or star within reach. Players are not anchors. */
  nearestAnchor() {
    let best = null;
    let bestDist = this.cfg.tetherReach;
    for (const b of this.world.bodies) {
      if (b.id >= 0) continue;
      const dx = b.x - this.body.x;
      const dy = b.y - this.body.y;
      const dist = Math.sqrt(dx * dx + dy * dy) - b.radius;
      if (dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    return best;
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
