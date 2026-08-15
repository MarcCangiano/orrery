#!/usr/bin/env node
// ESC goes back to the lobby, and the room recovers.
//
// This is a protocol check rather than a browser one, because what ESC has to
// do is server-side: take the body away, put the room back in the lobby if it
// was the last player, and leave a socket that is still perfectly good alone.
//
// The interesting case is not one player leaving. It is that leaving is NOT a
// disconnect. removePlayer deliberately keeps a match running when a socket
// drops, so that a reconnect a moment later rejoins a game in progress rather
// than a wiped one; if leaving shared that path it would be impossible to end a
// match at all. So the second half of this asserts the difference: one of two
// players leaving must not stop the other's game, and the last one leaving must.
//
// Usage: node tools/leave-check.mjs [ws://localhost:7070/ws]

const url = process.argv[2] ?? 'ws://localhost:7070/ws';

function fail(why) {
  console.log(`leave-check: FAILED — ${why}`);
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A client that remembers the last snapshot it saw. */
function connect() {
  const ws = new WebSocket(url);
  const c = { ws, id: null, last: null, ready: null };
  c.ready = new Promise(resolve => {
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') { c.id = m.id; resolve(c); }
      if (m.t === 'state') c.last = m;
    });
  });
  return c;
}

const send = (c, obj) => c.ws.send(JSON.stringify(obj));
const hasBody = c => Boolean(c.last?.bodies?.some(b => b.id === c.id));

const a = connect();
const b = connect();
await Promise.all([a.ready, b.ready]);
await sleep(500);

// --- a spectator has no body -----------------------------------------------

if (hasBody(a)) fail('a client that has not picked a side already has a body');

// --- joining, then leaving --------------------------------------------------

send(a, { t: 'pick', team: 0 });
send(b, { t: 'pick', team: 1 });
// Past the five second countdown, so the match is genuinely under way.
await sleep(7000);

if (!hasBody(a) || !hasBody(b)) fail('picking a side did not produce a body');
if (a.last.phase !== 'playing') fail(`two players picked sides and the phase is "${a.last.phase}"`);

const bodiesPlaying = a.last.bodies.length;

send(a, { t: 'leave' });
await sleep(1200);

if (hasBody(a)) fail('ESC did not take the body away');

// Deliberately NOT asserted: that the arena has fewer bodies. The first version
// of this check did, and failed, because dropping to one human brings a bot in
// to fill the empty side — the count is identical and only the ids differ. The
// assertion that means something is that this player's own id is gone.
if (a.last.bodies.some(x => x.id === a.id)) fail('the leaver is still in the world');

// The other player must still be playing. This is the assertion that separates
// leaving from the empty-room reset, and it is the one that would break if
// leaveTeam were ever folded into removePlayer.
if (b.last.phase !== 'playing') {
  fail(`one player left and the other's match stopped (phase "${b.last.phase}")`);
}
if (!hasBody(b)) fail('one player leaving took the other player\'s body with it');

const scoreBefore = [b.last.scoreA, b.last.scoreB];

// --- the last player leaving ends the match --------------------------------

send(b, { t: 'leave' });
await sleep(1200);

if (b.last.phase !== 'lobby') {
  fail(`the last player left and the room is in "${b.last.phase}" rather than the lobby`);
}
if (hasBody(b)) fail('the last player left and still has a body');

// --- and the socket still works --------------------------------------------
//
// The whole point of ESC over closing the tab: the connection survives, so
// picking a side again has to work without reconnecting.

send(a, { t: 'pick', team: 0 });
await sleep(1200);
if (!hasBody(a)) fail('rejoining after ESC did not work, so the socket did not survive leaving');

console.log(`leave-check: OK — ESC removes the body and returns to the lobby`);
// Reported rather than asserted, and without claiming why. With bots on the
// count usually does not move, because one arrives to fill the empty side; with
// ORRERY_BOTS=0, as verify.sh runs it, it drops by one. Saying which happened
// would be a guess, and a check that narrates a guess is worse than one that
// says nothing.
console.log(`  one of two leaving left the other playing `
  + `(${bodiesPlaying} bodies before, ${a.last.bodies.length} after)`);
console.log(`  the last one leaving reset the room (score was ${scoreBefore.join('-')})`);
console.log(`  the socket survived, and rejoining worked without reconnecting`);
process.exit(0);
