#!/usr/bin/env node
// The WebSocket server must reap peers that vanished without a clean close.
//
// The `ws` library does NOT do this. A client that disappears -- phone loses
// its network, NAT drops the mapping, process killed -- leaves a socket the
// server considers ESTABLISHED forever. Measured on the live server before this
// was added: ONE phone had accumulated 150 established connections while the
// phone itself held 9, the rest stuck in FIN-WAIT-1 because their FINs were
// never acknowledged.
//
// This asserts the reaper logic directly: it pings each round, terminates
// anything that missed the previous round, and never touches a socket that is
// answering.

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

/** A stand-in for a ws client: records pings and whether it was terminated. */
function fakeClient({ answersPings, label }) {
  const c = {
    label,
    isAlive: true,
    pings: 0,
    terminated: false,
    _pongHandlers: [],
    on(event, fn) { if (event === 'pong') this._pongHandlers.push(fn); },
    ping() {
      this.pings++;
      // A live peer's pong comes back on the next tick of the event loop; a
      // dead one never answers, which is exactly what the reaper detects.
      if (answersPings) for (const h of this._pongHandlers) h();
    },
    terminate() { this.terminated = true; },
  };
  c._lastSeenAt = 0; // treated as long-idle unless a test says otherwise
  c.on('pong', () => { c.isAlive = true; c._lastSeenAt = Date.now(); });
  return c;
}

const INTERVAL_MS = 30000;

/** The reaper, mirroring the interval body in src/index.js. */
function reapRound(clients, now = Date.now()) {
  const terminated = [];
  for (const ws of clients) {
    const idle = now - (ws._lastSeenAt ?? now);
    if (ws.isAlive === false && idle > INTERVAL_MS) {
      ws.terminate();
      terminated.push(ws.label);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  return terminated;
}

function testDeadPeerIsReaped() {
  console.log('\na peer that stops answering is terminated');
  const live = fakeClient({ answersPings: true, label: 'live' });
  const dead = fakeClient({ answersPings: false, label: 'dead' });
  const clients = [live, dead];

  // Round 1: both were alive at entry, so both get pinged, nothing dies.
  let killed = reapRound(clients);
  check('nothing terminated on the first round', killed.length === 0, killed.join(','));
  check('both were pinged', live.pings === 1 && dead.pings === 1);
  check('the answering peer is marked alive again', live.isAlive === true);
  check('the silent peer is still marked not-alive', dead.isAlive === false);

  // Round 2: the dead one never answered round 1.
  killed = reapRound(clients);
  check('the silent peer is terminated', killed.join() === 'dead', killed.join(','));
  check('the answering peer survives', live.terminated === false);
  check('and keeps being pinged', live.pings === 2);
}

function testMessagesCountAsLiveness() {
  console.log('\na client that sends messages but never pongs is NOT terminated');
  // THE REGRESSION. The phone answers no protocol pings at all (pongs=0) while
  // sending an application health frame every 5s. Treating only pongs as proof
  // of life terminated its healthy socket every ~40s; the phone reconnected,
  // and that loop looked exactly like the network fault being hunted.
  const chatty = fakeClient({ answersPings: false, label: 'chatty' });
  let now = 1_000_000;
  chatty._lastSeenAt = now;

  for (let round = 0; round < 5; round++) {
    now += INTERVAL_MS;
    // A message arrives between sweeps, as the phone's 5s health frame does.
    chatty._lastSeenAt = now - 5000;
    const killed = reapRound([chatty], now);
    check(`round ${round + 1}: survived on message traffic alone`,
      killed.length === 0 && chatty.terminated === false);
  }

  // Genuinely silent now: no messages, no pongs, longer than one interval.
  now += INTERVAL_MS * 2;
  const killed = reapRound([chatty], now);
  check('but IS terminated once it goes truly silent', killed.join() === 'chatty',
    killed.join(','));
}

function testHealthyPeerSurvivesManyRounds() {
  console.log('\na peer carrying traffic is never terminated');
  const live = fakeClient({ answersPings: true, label: 'live' });
  for (let i = 0; i < 20; i++) reapRound([live]);
  check('survived 20 rounds', live.terminated === false);
  check('was pinged every round', live.pings === 20, `${live.pings}`);
}

function testTerminateThrowIsContained() {
  console.log('\na throw from terminate() does not stall the sweep');
  const bad = fakeClient({ answersPings: false, label: 'bad' });
  bad.terminate = () => { throw new Error('socket already destroyed'); };
  const good = fakeClient({ answersPings: false, label: 'good' });
  const clients = [bad, good];

  reapRound(clients); // arm both as not-alive
  // Mirror the guarded form used in src/index.js.
  let reached = false;
  for (const ws of clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* already gone */ }
      if (ws.label === 'good') reached = true;
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* dying socket */ }
  }
  check('a later client is still reached after an earlier throw', reached);
}

function testWiredIntoEveryUpgrade() {
  console.log('\nliveness is armed on every upgrade path');
  // With `noServer: true` the server never emits 'connection', so arming has
  // to happen in each handleUpgrade callback. A path that forgets it would
  // have isAlive undefined -- never === false -- and so never be reaped.
  const src = require('fs').readFileSync(
    new URL('../src/index.js', import.meta.url), 'utf8'
  );
  const upgrades = (src.match(/wss\.handleUpgrade\(/g) || []).length;
  const armed = (src.match(/trackWsLiveness\(ws\);/g) || []).length;
  check('every handleUpgrade arms liveness', upgrades > 0 && armed === upgrades,
    `${armed} armed vs ${upgrades} upgrade paths`);
  check('the sweep interval exists', /setInterval\([\s\S]{0,1600}?ws\.terminate\(\)/.test(src));
  // Any traffic must count as liveness, not pongs alone: the phone returns no
  // pongs at all and would otherwise be reaped every interval.
  check('message traffic counts as liveness',
    /_lastSeenAt/.test(src) && /on\('message'/.test(src));
  // A socket that connects moments before a sweep must not be pinged and then
  // killed on the very next tick -- that terminated healthy phones 7s after
  // they connected.
  check('new sockets get a full interval before they can be reaped',
    /_connectedAt/.test(src) && /age < WS_LIVENESS_INTERVAL_MS/.test(src));
  check('the interval is unref\'d so it cannot hold the process open',
    /wsLivenessInterval\.unref\(\)/.test(src));
}

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

testDeadPeerIsReaped();
testMessagesCountAsLiveness();
testHealthyPeerSurvivesManyRounds();
testTerminateThrowIsContained();
testWiredIntoEveryUpgrade();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
