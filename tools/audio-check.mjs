#!/usr/bin/env node
// Renders every sound effect to a buffer and measures it.
//
// The point is that this can fail for the right reason. A check that asserted
// the methods exist, or that the module imports, would have passed on every
// version of this file that made no sound at all — a filter left at zero, a
// gain never ramped, a context created suspended. So each effect is rendered
// through an OfflineAudioContext and the samples are looked at:
//
//   * silence must be silent, which is what makes the other numbers mean
//     anything. Without it, a measurement picking up noise from somewhere else
//     would report every sound as present.
//   * every effect must actually produce signal.
//   * a hard impact must measure louder than a soft one, because the reason
//     these are synthesised rather than sampled is that strength carries
//     information, and a fixed sound would pass every other assertion here.
//
// It also checks the music, which cannot be rendered offline because it streams
// through media elements: the manifest is fetched and every track it lists must
// come back over HTTP as real audio of a plausible size.
//
// Usage: node tools/audio-check.mjs [url]

import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'http://localhost:7070/';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'server/src/main/resources/public');

const CHROME = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function fail(why) {
  console.log(`audio-check: FAILED — ${why}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Static half: the calls the game makes must exist on the class.
//
// This is the cheap half and it catches the rename. game.mjs calling a method
// audio.mjs no longer has throws inside a snapshot handler, where nothing shows
// it, and the game simply goes quiet.

const game = readFileSync(join(PUBLIC, 'game.mjs'), 'utf8');
const audio = readFileSync(join(PUBLIC, 'audio.mjs'), 'utf8');

const called = new Set([...game.matchAll(/\bsound\.(\w+)\s*\(/g)].map(m => m[1]));
const defined = new Set([...audio.matchAll(/^\s{2}(\w+)\s*\(/gm)].map(m => m[1]));
const missing = [...called].filter(n => !defined.has(n));
if (missing.length) fail(`game.mjs calls sound.${missing.join(', sound.')} which audio.mjs does not define`);

if (!called.size) fail('game.mjs does not call the sound layer at all');

// ---------------------------------------------------------------------------
// Live half.

const PORT = 9222 + Math.floor(process.pid % 500);
const profile = mkdtempSync(join(tmpdir(), 'orrery-audio-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  '--enable-unsafe-swiftshader',
  // Headless Chrome has no output device. OfflineAudioContext does not need
  // one, but the page also constructs media elements, and this keeps their
  // failure from being an unhandled rejection that stops the script.
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await res.json()).find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome never opened a page target');
}

const ws = new WebSocket(await endpoint());
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  const resolve = pending.get(msg.id);
  if (resolve) { pending.delete(msg.id); resolve(msg); }
});
function send(method, params = {}) {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await sleep(2500);

// Rendered inside the page, because Node has no Web Audio.
const probe = `(async () => {
  const { Sound } = await import('/audio.mjs');
  const SR = 44100;
  const out = {};

  async function measure(name, fire, seconds) {
    const off = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
    const s = new Sound({ context: off });
    s.unlock();
    fire(s);
    const buf = await off.startRendering();
    let peak = 0, sum = 0, n = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const a = d[i] < 0 ? -d[i] : d[i];
        if (a > peak) peak = a;
        sum += d[i] * d[i];
        n++;
      }
    }
    out[name] = { peak, rms: Math.sqrt(sum / n) };
  }

  await measure('silence',      () => {},                    0.5);
  await measure('impact_hard',  s => s.impact(1),            0.6);
  await measure('impact_soft',  s => s.impact(0.08),         0.6);
  await measure('shove',        s => s.shove(),              0.6);
  await measure('goal',         s => s.goal(true),           2.0);
  await measure('win',          s => s.win(true),            2.6);
  await measure('countdown',    s => s.countdown(1),         0.6);
  await measure('tether_on',    s => s.tetherAttach(),       0.4);
  await measure('tether_off',   s => s.tetherRelease(),      0.4);
  await measure('star_touch',   s => s.starTouch(1),         0.4);
  await measure('thrust',       s => s.thrust(1),            0.8);
  await measure('ui_select',    s => s.uiSelect(),           0.4);
  await measure('muted',        s => { s.setMuted(true); s.shove(); }, 0.6);

  const man = await (await fetch('/music/manifest.json')).json();
  const tracks = [];
  for (const group of ['lobby', 'norse', 'greek']) {
    for (const name of (man[group] ?? [])) {
      const r = await fetch('/music/' + name + '.mp3');
      const b = r.ok ? await r.arrayBuffer() : new ArrayBuffer(0);
      tracks.push({ group, name, status: r.status, bytes: b.byteLength });
    }
  }
  return JSON.stringify({ out, man, tracks });
})()`;

const res = await send('Runtime.evaluate', {
  expression: probe, awaitPromise: true, returnByValue: true,
});

if (res.result?.exceptionDetails || res.result?.result?.subtype === 'error') {
  const d = res.result.exceptionDetails;
  fail(`the page threw: ${d?.exception?.description ?? d?.text ?? 'unknown'}`);
}
const raw = res.result?.result?.value;
if (!raw) fail('the probe returned nothing, so audio.mjs did not import');

const { out, man, tracks } = JSON.parse(raw);

// --- effects ---------------------------------------------------------------

const FLOOR = 0.001;
if (out.silence.peak > FLOOR) {
  fail(`silence measured ${out.silence.peak.toFixed(5)}, so these numbers do not mean what they claim`);
}

const effects = Object.keys(out).filter(k => k !== 'silence' && k !== 'muted');
const quiet = effects.filter(k => out[k].peak < 0.01);
if (quiet.length) fail(`no audible signal from: ${quiet.join(', ')}`);

if (out.impact_hard.peak <= out.impact_soft.peak * 1.5) {
  fail(`a hard impact (${out.impact_hard.peak.toFixed(3)}) is not meaningfully louder than a soft one `
     + `(${out.impact_soft.peak.toFixed(3)}), so strength carries no information`);
}

if (out.muted.peak > FLOOR) {
  fail(`muting left ${out.muted.peak.toFixed(5)} of signal, so M does not silence the game`);
}

// --- music -----------------------------------------------------------------

const groups = ['lobby', 'norse', 'greek'].filter(g => (man[g] ?? []).length === 0);
if (groups.length) fail(`the manifest lists no tracks for: ${groups.join(', ')}`);

const broken = tracks.filter(t => t.status !== 200 || t.bytes < 100_000);
if (broken.length) {
  fail(`unplayable track(s): ${broken.map(t => `${t.name} (${t.status}, ${t.bytes}B)`).join(', ')}`);
}

const total = tracks.reduce((a, t) => a + t.bytes, 0);

console.log(`audio-check: ${effects.length} effects rendered, all audible, silence clean`);
console.log(`  loudest ${effects.sort((a, b) => out[b].peak - out[a].peak)[0]}`
  + `   impact scales ${(out.impact_hard.peak / out.impact_soft.peak).toFixed(1)}x soft to hard`);
console.log(`  music ${tracks.length} tracks, ${(total / 1048576).toFixed(1)} MB`
  + `   (${man.norse.length} norse, ${man.greek.length} greek, ${man.lobby.length} lobby)`);
console.log(`  ${called.size} of the class's methods are called by game.mjs`);
console.log('audio-check: OK');
process.exit(0);
