#!/usr/bin/env node
// Unit test for the in-flight tool heartbeat and the thinking-block fix in
// rc-handler.js. No orchestrator, no CLI, no MongoDB: initRcHandler is given a
// stub store and a fake phone WS, and stream-json events are fed straight into
// processDesktopMessage.
//
// Covers:
//   1. A tool_use with no tool_result emits periodic 'running' frames whose
//      elapsedMs grows, then exactly one 'complete' when the result arrives.
//   2. The per-session heartbeat timer is cleared afterwards (no leak).
//   3. seq is monotonic per tool call, so the phone can drop a late 'running'.
//   4. An agent (Task) dispatch does NOT double-emit -- the old per-agent
//      timer was replaced by the shared one, not stacked on top of it.
//   5. An Anthropic thinking block ({type:'thinking', thinking:'...'}) produces
//      a non-empty rc_thinking. This is the bug that read block.text.
//   6. A turn that ends with a tool still in flight emits a terminal frame so
//      the phone's row cannot stay in-flight forever.

import {
  initRcHandler,
  __processDesktopMessageForTest as feed,
  __registerSessionForTest as register,
  __endThinkingForTest as endThinking
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

// --- Harness ------------------------------------------------------------

const sent = [];
const fakePhone = {
  readyState: 1,
  send(payload) { sent.push(JSON.parse(payload)); }
};
const stubStore = {
  appendTranscript: async () => {},
  appendPendingQueue: async () => {},
  updateTitle: async () => {}
};

initRcHandler(stubStore, new Map([['phone-1', fakePhone]]), {});

function newSession(sessionId) {
  const session = {
    phoneDeviceId: 'phone-1',
    desktopWs: { readyState: 1, send() {}, close() {} },
    pendingPermissions: new Map(),
    createdAt: Date.now(),
    contextPct: 0
  };
  register(sessionId, session);
  return session;
}

const toolStatuses = (sessionId) =>
  sent.filter(m => m.type === 'rc_tool_status' && m.sessionId === sessionId);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- 1/2/3: heartbeat lifecycle for a slow non-agent tool ---------------

async function testSlowToolHeartbeat() {
  console.log('\nslow non-agent tool (TaskOutput) emits running heartbeats');
  const sessionId = 'hb-slow';
  const session = newSession(sessionId);
  const before = sent.length;

  feed(sessionId, session, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'TaskOutput', input: { id: 'abc' } }] }
  });

  check('tool is tracked as in flight', session.toolInFlight?.size === 1);
  check('heartbeat timer armed', !!session.toolHeartbeatTimer);

  // 7s with no tool_result -> at least 3 beats at the 2s interval.
  await sleep(7000);

  const beats = sent.slice(before).filter(m => m.type === 'rc_tool_status' && m.status === 'running');
  check('at least 3 running frames', beats.length >= 3, `got ${beats.length}`);
  check('elapsedMs strictly grows',
    beats.every((b, i) => i === 0 || b.elapsedMs > beats[i - 1].elapsedMs),
    beats.map(b => b.elapsedMs).join(','));
  check('seq strictly grows',
    beats.every((b, i) => i === 0 || b.seq > beats[i - 1].seq),
    beats.map(b => b.seq).join(','));
  check('running frames carry the toolCallId', beats.every(b => b.toolCallId === 'tu-1'));

  feed(sessionId, session, {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }] }
  });

  const completes = sent.slice(before).filter(m => m.type === 'rc_tool_status' && m.status === 'complete');
  check('exactly one complete frame', completes.length === 1, `got ${completes.length}`);
  const lastBeat = beats[beats.length - 1];
  check('complete seq is higher than every heartbeat seq',
    completes[0].seq > lastBeat.seq,
    `complete=${completes[0].seq} lastBeat=${lastBeat.seq}`);

  check('in-flight set emptied', session.toolInFlight.size === 0);
  check('heartbeat timer cleared (no leak)', session.toolHeartbeatTimer === null);

  // No further beats after completion.
  const afterComplete = sent.length;
  await sleep(3000);
  const late = sent.slice(afterComplete).filter(m => m.type === 'rc_tool_status' && m.status === 'running');
  check('no running frames after complete', late.length === 0, `got ${late.length}`);
}

// --- 4: agent dispatch must not double-emit ------------------------------

async function testAgentNoDoubleEmit() {
  console.log('\nagent (Task) dispatch emits one heartbeat stream, not two');
  const sessionId = 'hb-agent';
  const session = newSession(sessionId);
  const before = sent.length;

  feed(sessionId, session, {
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use', id: 'tu-agent', name: 'Task',
        input: { subagent_type: 'general-purpose', description: 'find things', prompt: 'go' }
      }]
    }
  });

  await sleep(5000);
  const beats = sent.slice(before).filter(m => m.type === 'rc_tool_status' && m.status === 'running');

  // One shared timer at 2s over ~5s gives ~2 beats. The old code had a
  // per-agent timer as well; if both were live we would see roughly double.
  check('agent beats are not doubled', beats.length >= 1 && beats.length <= 3, `got ${beats.length}`);
  const perTick = new Map();
  for (const b of beats) perTick.set(b.seq, (perTick.get(b.seq) || 0) + 1);
  check('no duplicate seq values', [...perTick.values()].every(v => v === 1));
  check('agent metadata preserved on heartbeat', beats.every(b => b.isAgent === true));
  check('agentElapsedMs still populated', beats.every(b => typeof b.agentElapsedMs === 'number'));

  feed(sessionId, session, {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-agent', content: 'ok' }] }
  });
  check('agent timer cleared', session.toolHeartbeatTimer === null);
}

// --- 5: thinking block ---------------------------------------------------

function testThinkingBlock() {
  console.log('\nthinking blocks carry text in .thinking, not .text');
  const sessionId = 'think-1';
  const session = newSession(sessionId);
  const before = sent.length;

  feed(sessionId, session, {
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'weighing the options', signature: 'sig' }] }
  });

  const thinking = sent.slice(before).filter(m => m.type === 'rc_thinking');
  const withText = thinking.filter(m => m.text && m.text.length > 0);
  check('emitted a non-empty rc_thinking', withText.length >= 1,
    `frames=${thinking.length} nonEmpty=${withText.length}`);
  check('text matches the thinking field',
    withText.some(m => m.text === 'weighing the options'),
    withText.map(m => JSON.stringify(m.text)).join(','));
}

// --- 6: turn ends with a tool still in flight ---------------------------

async function testOrphanedToolTerminated() {
  console.log('\nturn ending with a tool in flight emits a terminal frame');
  const sessionId = 'orphan-1';
  const session = newSession(sessionId);

  feed(sessionId, session, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu-orphan', name: 'Bash', input: { command: 'sleep 999' } }] }
  });
  const before = sent.length;

  // Turn ends without a tool_result -- interrupt or CLI crash.
  endThinking(sessionId, session);

  const terminal = sent.slice(before).filter(
    m => m.type === 'rc_tool_status' && m.toolCallId === 'tu-orphan' &&
         (m.status === 'error' || m.status === 'complete')
  );
  check('orphaned tool got a terminal frame', terminal.length === 1, `got ${terminal.length}`);
  check('heartbeat stopped', session.toolHeartbeatTimer === null);
  check('in-flight set cleared', session.toolInFlight.size === 0);
}

// --- run -----------------------------------------------------------------

(async () => {
  await testSlowToolHeartbeat();
  await testAgentNoDoubleEmit();
  testThinkingBlock();
  await testOrphanedToolTerminated();

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
