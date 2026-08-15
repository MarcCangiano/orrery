#!/usr/bin/env node
// Screenshots the running client after it has actually been playing for a
// while.
//
// Chrome's --screenshot flag fires on load, and --virtual-time-budget fast
// forwards timers past real network I/O, so both of them reliably capture a
// client that has connected to nothing. This drives Chrome over the DevTools
// Protocol in real time instead: open the page, wait genuine seconds, then
// capture. No dependencies; Node has fetch and WebSocket built in.
//
// Usage: node tools/shot.mjs <url> <out.png> [seconds]

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:7070/?auto=1';
const out = process.argv[3] ?? 'shot.png';
const seconds = Number(process.argv[4] ?? 8);

const CHROME = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9222 + Math.floor(process.pid % 500);
const profile = mkdtempSync(join(tmpdir(), 'orrery-shot-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  // NOT --disable-gpu: that switches off WebGL, and this tool exists to
  // photograph a WebGL renderer. SwiftShader draws it in software instead.
  '--enable-unsafe-swiftshader',
  // Local test pages import modules over file://, which Chrome blocks by
  // default and reports as an empty canvas rather than as an error.
  '--allow-file-access-from-files',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1000,620',
  'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The PAGE target's socket, not the browser's.
 *
 * <p>/json/version hands back a browser-level endpoint, and the Page domain does
 * not exist there: navigation appears to work and the screenshot comes back
 * empty, with no error to explain it. The tab lives in /json/list.
 */
async function endpoint() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
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
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg.result ?? {});
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Page.navigate', { url });

// Real seconds, on the real clock, so the socket connects and the world moves.
await sleep(seconds * 1000);

const { data } = await send('Page.captureScreenshot', { format: 'png' });
if (!data) {
  console.error('shot: chrome returned no image');
  process.exit(1);
}
writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`shot: wrote ${out} after ${seconds}s of real play`);
process.exit(0);
