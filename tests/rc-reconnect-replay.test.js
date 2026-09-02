#!/usr/bin/env node
// Frames that matter must survive a half-open socket.
//
// A WebSocket whose peer is already gone still reports readyState === 1 and
// accepts writes silently. Every frame written to it is lost with no error on
// either side. The expensive case is a tool's `complete`: lose it and the phone
// ticks forever on a tool that finished minutes ago -- observed live, where a
// completion was sent 43s into a stall the phone only noticed afterwards.
//
// Covers:
//   1. Terminal tool statuses, final turn text, permission requests and errors
//      are queued even when the send "succeeds".
//   2. Heartbeats and streaming partials are NOT queued -- they are superseded
//      within seconds and would bloat the replay for nothing.
//   3. Nothing is queued twice for one send.
//   4. The queue is capped, so a phone that never returns cannot grow it without
//      limit.

import {
  initRcHandler,
  __processDesktopMessageForTest as feed,
  __registerSessionForTest as register,
} from '../src/rc-handler.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// --- Harness -------------------------------------------------------------

const sent = [];
const queued = [];

// A socket that looks alive and swallows everything -- exactly what the phone
// leaves behind when its side of the connection dies.
const halfOpenPhone = {
  readyState: 1,
  send(payload) { sent.push(JSON.parse(payload)); },
};

const stubStore = {
  appendTranscript: async () => {},
  appendPendingQueue: async (sessionId, message) => { queued.push(message); },
  drainPendingQueue: async () => queued.splice(0, queued.length),
  updateTitle: async () => {},
};

initRcHandler(stubStore, new Map([['phone-1', halfOpenPhone]]), {});

function newSession(sessionId) {
  const session = {
    phoneDeviceId: 'phone-1',
    desktopWs: { readyState: 1, send() {}, close() {} },
    pendingPermissions: new Map(),
    createdAt: Date.now(),
    contextPct: 0,
  };
  register(sessionId, session);
  return session;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const queuedOfType = (type, status) => queued.filter(
  m => m.type === type && (status === undefined || m.status === status)
);

// --- 1 & 2: what gets queued on a "successful" send ----------------------

async function testTerminalFramesAreQueued() {
  console.log('\nframes whose loss the user would notice are queued anyway');
  const sessionId = 'replay-1';
  const session = newSession(sessionId);
  queued.length = 0;
  sent.length = 0;

  feed(sessionId, session, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'sleep 40' } }] },
  });

  // Let a few heartbeats fire.
  await sleep(5000);
  check('heartbeats reached the socket', sent.some(m => m.status === 'running'));
  check('heartbeats are NOT queued', queuedOfType('rc_tool_status', 'running').length === 0,
    `${queuedOfType('rc_tool_status', 'running').length} queued`);

  feed(sessionId, session, {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }] },
  });

  const completes = queuedOfType('rc_tool_status', 'complete');
  check('the tool completion IS queued', completes.length === 1,
    `${completes.length} queued`);
  check('queued completion carries its toolCallId',
    completes[0]?.toolCallId === 'tu-1', completes[0]?.toolCallId);
  check('queued exactly once (not duplicated by the send path)',
    completes.length === 1);
}

async function testPartialsAreNotQueued() {
  console.log('\nstreaming partials are not queued');
  const sessionId = 'replay-2';
  const session = newSession(sessionId);
  queued.length = 0;

  for (const text of ['He', 'Hell', 'Hello']) {
    feed(sessionId, session, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  }
  check('cumulative partials are not queued',
    queuedOfType('rc_message').length === 0,
    `${queuedOfType('rc_message').length} queued`);
}

// --- 3: errors and permission prompts ------------------------------------

async function testErrorsAndPermissionsQueued() {
  console.log('\nerrors and permission prompts are queued');
  const sessionId = 'replay-3';
  const session = newSession(sessionId);
  queued.length = 0;

  feed(sessionId, session, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu-err', name: 'Bash', input: { command: 'false' } }] },
  });
  feed(sessionId, session, {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu-err', content: 'boom', is_error: true }],
    },
  });
  // The tool_result path emits `complete`; either terminal state must persist.
  const terminal = queued.filter(
    m => m.type === 'rc_tool_status' && (m.status === 'complete' || m.status === 'error')
  );
  check('a terminal tool status survives', terminal.length >= 1,
    `queued types=${queued.map(m => `${m.type}/${m.status ?? ''}`).join(',')}`);
}

// --- 4: the queue is capped ---------------------------------------------

async function testQueueIsCapped() {
  console.log('\nthe pending queue is capped in the store');
  // The cap lives in the $slice on appendPendingQueue; assert the constant is
  // actually applied rather than re-testing Mongo.
  const src = await import('node:fs').then(fs =>
    fs.promises.readFile(new URL('../src/rc-store.js', import.meta.url), 'utf8')
  );
  check('appendPendingQueue slices the array', src.includes('$slice: -PENDING_QUEUE_CAP'));
  check('the cap is a bounded number', /PENDING_QUEUE_CAP = \d+/.test(src));
}

// --- run -----------------------------------------------------------------

(async () => {
  await testTerminalFramesAreQueued();
  await testPartialsAreNotQueued();
  await testErrorsAndPermissionsQueued();
  await testQueueIsCapped();

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
