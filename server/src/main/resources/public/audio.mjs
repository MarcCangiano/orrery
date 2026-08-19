/**
 * Sound.
 *
 * Two halves that have nothing to do with each other.
 *
 * The effects are synthesised here, in Web Audio, with no files at all. Every
 * sound this game needs is a short event — a thump, a pluck, a bell — and a
 * synthesised one can be told how hard it was. A body hit at 30 units/s and a
 * body hit at 10 make the same sample play twice; here they make a different
 * sound, which is information a player can use. It also means the whole effects
 * layer costs zero bytes of download.
 *
 * The music is the opposite case. A frame drum and a lyre do not come out of an
 * oscillator, so the beds are generated ahead of time by tools/audio/music.py
 * and streamed. See docs/AUDIO.md.
 *
 * Everything is behind a gesture, because browsers refuse to start audio
 * without one. The lobby's START is that gesture and the timing works out: the
 * first thing you press is the thing that turns the sound on.
 */

const MUTE_KEY = 'orrery.muted';
const VOL_KEY = 'orrery.volume';

/** How long a track spends fading into the next one, mid-playlist. */
const CROSSFADE = 4.0;

/**
 * How long the FIRST track takes to reach full volume.
 *
 * Short on purpose. A four second fade into the first track of the session is
 * indistinguishable from the music being broken: you press START, nothing
 * happens, and by the time it is audible you have stopped waiting for it.
 * Mid-playlist a long fade is right, because there the point is not noticing.
 */
const FADE_IN = 0.35;

/**
 * Effects are mixed against the music, not against nothing. These are the
 * numbers the whole balance rests on, so they are together and named.
 */
const MIX = {
  master: 0.85,
  music: 0.6,
  sfx: 0.85,
};

export class Sound {
  /**
   * @param options.context an AudioContext to use instead of making one.
   *
   * This exists for tools/audio-check.mjs, which passes an OfflineAudioContext
   * and renders the effects to a buffer it can measure. A test that only
   * asserts these methods exist would have passed every day the game was
   * silent, which is the failure this whole class is most likely to have.
   */
  constructor(options = {}) {
    this.ctx = options.context ?? null;
    this.given = Boolean(options.context);
    this.ready = false;
    this.muted = localStorage.getItem(MUTE_KEY) === '1';
    const stored = parseFloat(localStorage.getItem(VOL_KEY));
    this.volume = Number.isFinite(stored) ? stored : 1;

    // Music runs on plain audio elements rather than through the graph.
    // Decoding a two-minute track into an AudioBuffer costs several megabytes
    // of memory and a stall on the main thread; an element streams it.
    this.tracks = { lobby: [], norse: [], greek: [] };
    this.players = [this._element(), this._element()];
    this.active = 0;
    this.playlist = [];
    this.playIndex = 0;
    this.mode = null;             // 'lobby' | 'match'
    this.fadeTimer = null;

    this._tether = null;
    this._pending = null;         // a mode asked for before the gesture arrived

    fetch('music/manifest.json')
      .then(r => (r.ok ? r.json() : null))
      .then(m => {
        if (!m) return;
        this.tracks = { ...this.tracks, ...m };
        /*
         * Buffer the lobby track now, before anyone has pressed anything.
         *
         * Setting src and letting the element preload is allowed without a
         * gesture; only play() is not. Without this the first track starts
         * downloading at the moment of the click, and a megabyte of MP3 over a
         * real connection is most of the delay between pressing START and
         * hearing anything.
         */
        const first = this.tracks.lobby[0];
        if (first) {
          const el = this.players[1 - this.active];
          el.src = `music/${first}.mp3`;
          el.load();
        }
      })
      // No music is a degraded game, not a broken one. The effects are
      // synthesised and do not depend on this having worked.
      .catch(() => {});
  }

  _element() {
    const el = new Audio();
    el.preload = 'auto';
    el.volume = 0;
    el.crossOrigin = 'anonymous';
    return el;
  }

  /**
   * Called from the first real gesture. Safe to call repeatedly.
   *
   * Doing this on load instead looks like it works, right up until Chrome
   * creates the context in a suspended state and every sound for the rest of
   * the session is silently dropped with no error anywhere.
   */
  unlock() {
    if (!this.master) {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
      }

      this.master = this.ctx.createGain();
      // A compressor across everything, because the loud moments here stack:
      // a goal bell can land on the same frame as two impacts and a shove, and
      // without this that sums past full scale and clips.
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.18;

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = MIX.sfx;

      this.sfxBus.connect(this.comp);
      this.comp.connect(this.master);
      this.master.connect(this.ctx.destination);

      this._buildTether();
    }
    // An OfflineAudioContext is driven by startRendering, not by resume, and
    // it reports itself suspended until then. Only a real one gets resumed.
    if (!this.given && this.ctx.state === 'suspended') this.ctx.resume();
    this.ready = true;
    this._applyVolume();
    if (this._pending) { const m = this._pending; this._pending = null; this.play(m); }
  }

  _applyVolume() {
    const v = this.muted ? 0 : this.volume;
    if (this.master) this.master.gain.value = v * MIX.master;
    const el = this.players[this.active];
    if (el && !el.paused) el.volume = v * MIX.music;
  }

  setMuted(on) {
    this.muted = on;
    localStorage.setItem(MUTE_KEY, on ? '1' : '0');
    this._applyVolume();
    if (on) this.tether(false);
  }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    localStorage.setItem(VOL_KEY, String(this.volume));
    this._applyVolume();
  }

  // ---------------------------------------------------------------- music

  /**
   * Switch beds. 'lobby' is one quiet drone; 'match' cycles the two pantheons.
   *
   * Asking for the mode already playing does nothing, which matters because the
   * caller is a snapshot handler running sixty times a second.
   */
  play(mode) {
    if (this.mode === mode) return;
    if (!this.ready) { this._pending = mode; return; }
    this.mode = mode;

    if (mode === 'lobby') {
      this.playlist = this.tracks.lobby.slice();
    } else {
      // Alternating rather than shuffled. Two Norse tracks in a row would read
      // as one long track, and the point of having two pantheons in the
      // rotation is that you notice the change.
      const n = this.tracks.norse, g = this.tracks.greek;
      this.playlist = [];
      for (let i = 0; i < Math.max(n.length, g.length); i++) {
        if (n[i]) this.playlist.push(n[i]);
        if (g[i]) this.playlist.push(g[i]);
      }
    }
    this.playIndex = 0;
    if (!this.playlist.length) return;
    this._startTrack(this.playlist[0], true);
  }

  /**
   * Buffer the first match track before the match needs it.
   *
   * <p>The lobby track is preloaded in the constructor for the same reason: a
   * source assigned now downloads quietly, and one assigned at the transition
   * downloads while the transition is trying to happen. Called on every
   * countdown snapshot, so it has to be free after the first.
   */
  preloadMatch() {
    if (this._matchPreloaded) return;
    const first = this.tracks.norse?.[0] ?? this.tracks.greek?.[0];
    if (!first) return;
    this._matchPreloaded = true;
    const el = this.players[1 - this.active];
    const want = `music/${first}.mp3`;
    if (!el.src.endsWith(want)) {
      el.src = want;
      el.load();
    }
  }

  stop() {
    this.mode = null;
    clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    for (const el of this.players) { el.pause(); el.volume = 0; }
  }

  _startTrack(name, immediate) {
    const next = 1 - this.active;
    const el = this.players[next];
    const want = `music/${name}.mp3`;
    // Reassigning src throws away whatever was already buffered, which undoes
    // the preload in the constructor and puts the download back in front of the
    // first note. Only touch it when it is genuinely a different track.
    if (!el.src.endsWith(want)) {
      el.src = want;
      el.load();
    }
    try { el.currentTime = 0; } catch {}
    el.volume = 0;
    const target = (this.muted ? 0 : this.volume) * MIX.music;

    const started = el.play();
    if (started && started.catch) {
      // Rejected play means the gesture has not landed yet. Not an error worth
      // showing anyone; the next unlock() will come back through here.
      started.catch(() => {});
    }

    const old = this.players[this.active];
    this.active = next;
    this._crossfade(old, el, target, immediate ? FADE_IN : CROSSFADE);
    this._watchForEnd(el);
  }

  _crossfade(from, to, target, seconds) {
    clearInterval(this.fadeTimer);
    const steps = Math.max(1, Math.round(seconds * 20));
    let step = 0;
    const fromStart = from ? from.volume : 0;
    this.fadeTimer = setInterval(() => {
      step++;
      const t = Math.min(1, step / steps);
      to.volume = target * t;
      if (from) from.volume = fromStart * (1 - t);
      if (t >= 1) {
        clearInterval(this.fadeTimer);
        this.fadeTimer = null;
        if (from) { from.pause(); from.volume = 0; }
      }
    }, 50);
  }

  /**
   * Start the next track before this one ends, so the fade overlaps.
   *
   * 'ended' is deliberately not used. By the time it fires there has already
   * been a gap, and a gap in a bed is the one thing a player actually notices
   * about background music.
   */
  _watchForEnd(el) {
    const check = () => {
      if (el !== this.players[this.active] || !this.mode) return;
      const left = (el.duration || 0) - el.currentTime;
      if (el.duration && left <= CROSSFADE) {
        this.playIndex = (this.playIndex + 1) % this.playlist.length;
        this._startTrack(this.playlist[this.playIndex], false);
        return;
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 500);
  }

  // ------------------------------------------------------------- effects

  /** White noise, made once and shared. Rebuilding it per sound is wasteful. */
  _noise() {
    if (!this._noiseBuf) {
      const n = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this._noiseBuf = buf;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    return src;
  }

  /*
   * There is no thrust sound.
   *
   * There was: filtered noise under a low sine, gated by how hard you were
   * pushing. It was removed rather than turned down. In a game where you are
   * thrusting almost continuously it is running almost continuously, so it
   * stops being a cue and becomes a floor that everything else has to be heard
   * over — and the things that matter here are the shove, the impact and the
   * bell. Do not add it back without solving that.
   */

  /** A quiet tone while a tether is attached, so the rope is audible as well as visible. */
  _buildTether() {
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 196;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 400;
    filter.Q.value = 3;
    osc.connect(filter); filter.connect(gain); gain.connect(this.sfxBus);
    osc.start();
    this._tether = { gain, osc };
  }

  tether(on, tension = 0) {
    if (!this.ready || !this._tether) return;
    this._tether.gain.gain.setTargetAtTime(
      on ? 0.045 : 0, this.ctx.currentTime, 0.08);
    if (on) {
      // Pitch tracks how hard the rope is pulling, which turns the tether from
      // a thing you can see into a thing you can feel.
      this._tether.osc.frequency.setTargetAtTime(
        170 + tension * 130, this.ctx.currentTime, 0.15);
    }
  }

  /** A pitched blip. The building block for most of the one-shots below. */
  _blip({ type = 'sine', from, to = from, dur = 0.2, gain = 0.2, delay = 0, curve = 'exp' }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) {
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
      else osc.frequency.linearRampToValueAtTime(to, t + dur);
    }
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.sfxBus);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  /** A filtered noise burst. Everything percussive here is one of these. */
  _burst({ freq = 900, q = 1, dur = 0.15, gain = 0.2, delay = 0, sweepTo = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const src = this._noise();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + dur);
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter); filter.connect(g); g.connect(this.sfxBus);
    src.start(t); src.stop(t + dur + 0.02);
  }

  /**
   * A collision. Strength is 0 to 1 and drives everything about the sound.
   *
   * A hard hit is not a loud version of a soft hit: it is brighter and it
   * rings lower, the way a real one is. Scaling only the gain sounds like a
   * volume knob rather than an impact.
   */
  impact(strength) {
    const s = Math.max(0.05, Math.min(1, strength));
    this._burst({ freq: 380 + s * 1600, q: 1.2, dur: 0.06 + s * 0.1, gain: 0.09 + s * 0.24 });
    this._blip({ type: 'sine', from: 150 - s * 40, to: 48, dur: 0.13 + s * 0.13, gain: 0.1 + s * 0.2 });
  }

  /** Your own shove. Deliberately the most physical sound in the game. */
  shove() {
    this._burst({ freq: 1500, sweepTo: 180, q: 0.8, dur: 0.22, gain: 0.3 });
    this._blip({ type: 'sine', from: 190, to: 42, dur: 0.26, gain: 0.34 });
  }

  tetherAttach() {
    this._blip({ type: 'triangle', from: 300, to: 620, dur: 0.1, gain: 0.16 });
    this._burst({ freq: 2400, q: 2, dur: 0.05, gain: 0.08 });
  }

  tetherRelease() {
    this._blip({ type: 'triangle', from: 480, to: 220, dur: 0.11, gain: 0.11 });
  }

  /** Touching the star: bright, and it should feel like picking up something hot. */
  starTouch(strength) {
    const s = Math.max(0.1, Math.min(1, strength));
    this._blip({ type: 'sine', from: 660, to: 990, dur: 0.16, gain: 0.06 + s * 0.1 });
    this._burst({ freq: 3200, q: 1.5, dur: 0.09, gain: 0.05 + s * 0.07 });
  }

  /**
   * A goal. A bell rather than a fanfare, and it tells you whose it was:
   * a rising major third when it is yours, a falling minor one when it is not.
   */
  goal(mine) {
    const root = mine ? 392 : 294;                     // G4 or D4
    const partials = mine ? [1, 1.5, 2, 3] : [1, 1.2, 1.5, 2];
    partials.forEach((p, i) => {
      this._blip({
        type: 'sine', from: root * p, dur: 1.5 - i * 0.22,
        gain: (mine ? 0.2 : 0.14) / (i + 1.3), delay: i * 0.035,
      });
    });
    if (!mine) this._blip({ type: 'sine', from: root * 0.5, to: root * 0.47, dur: 1.1, gain: 0.1, curve: 'lin' });
  }

  /** The end of a match. The goal bell, extended into an arpeggio. */
  win(mine) {
    const root = mine ? 392 : 261;
    const steps = mine ? [1, 1.26, 1.5, 2, 2.52] : [1, 0.94, 0.84, 0.75];
    steps.forEach((p, i) => {
      this._blip({ type: 'sine', from: root * p, dur: 1.8, gain: 0.16, delay: i * 0.16 });
      this._blip({ type: 'triangle', from: root * p * 2, dur: 0.9, gain: 0.05, delay: i * 0.16 });
    });
  }

  /** One per second of the countdown, with the last one an octave up. */
  countdown(secondsLeft) {
    const last = secondsLeft <= 1;
    this._blip({
      type: 'square', from: last ? 880 : 440, dur: last ? 0.3 : 0.09,
      gain: last ? 0.14 : 0.09,
    });
  }

  uiMove() { this._blip({ type: 'square', from: 520, dur: 0.04, gain: 0.05 }); }

  uiSelect() {
    this._blip({ type: 'square', from: 440, to: 660, dur: 0.09, gain: 0.09 });
    this._blip({ type: 'square', from: 880, dur: 0.06, gain: 0.04, delay: 0.05 });
  }
}
