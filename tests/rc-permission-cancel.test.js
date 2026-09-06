#!/usr/bin/env node
// A question/permission answered ON THE PC must be retired on the phone.
//
// When the user answers an AskUserQuestion (or approves a tool) in the PC TUI,
// the attached CLI sends `control_cancel_request` for that request_id over the
// remote-control WebSocket. The orchestrator handled only `control_request`,
// so the entry stayed in session.pendingPermissions and in the store, and was
// re-sent as a LIVE prompt on every rc_transcript_request. The phone then kept
// showing an answerable question for a tool that had already run.
//
// No orchestrator, no CLI, no MongoDB: the frame is fed straight into
// processDesktopMessage against a stub store and a fake phone WS.

import {
  initRcHandler,
  __processDesktopMessageForTest as feed,
  __registerSessionForTest as register
} from '../src/rc-handler.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

const sent = [];
const removed = [];
const fakePhone = { readyState: 1, send(p) { sent.push(JSON.parse(p)); } };
const stubStore = {
  appendTranscript: async () => {},
  appendPendingQueue: async () => {},
  updateTitle: async () => {},
  removePermission: async (sid, rid) => { removed.push(rid); },
  persistPermission: async () => {}
};
initRcHandler(stubStore, new Map([['phone-1', fakePhone]]), {});

const sessionId = 'cancel-1';
const session = {
  phoneDeviceId: 'phone-1',
  desktopWs: { readyState: 1, send() {}, close() {} },
  pendingPermissions: new Map(),
  createdAt: Date.now(),
  contextPct: 0
};
register(sessionId, session);

// 1. The CLI asks a question: the orchestrator records it as pending and
//    forwards a live prompt to the phone.
feed(sessionId, session, {
  type: 'control_request',
  request_id: 'req-q1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'tu-q1',
    input: { questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] }
  }
});
const pendingKey = [...session.pendingPermissions.keys()][0];
check('question is pending after the CLI asks it', session.pendingPermissions.size === 1);
check('phone was shown a live prompt', sent.some(m => m.type === 'rc_permission_request'));

// 2. The user answers it in the PC TUI. The CLI cancels the remote prompt.
const before = sent.length;
feed(sessionId, session, { type: 'control_cancel_request', request_id: 'req-q1' });

check('pending entry is retired', session.pendingPermissions.size === 0,
  `still pending: ${[...session.pendingPermissions.keys()]}`);
check('store entry is removed', removed.includes(pendingKey),
  `removed=${JSON.stringify(removed)} expected=${pendingKey}`);
const resolvedFrame = sent.slice(before).find(m => m.type === 'rc_permission_resolved');
check('phone is told the prompt is resolved', !!resolvedFrame);
check('resolved frame names the right request', resolvedFrame?.requestId === pendingKey,
  `got ${resolvedFrame?.requestId}`);

// 3. A cancel for something never pending is harmless.
feed(sessionId, session, { type: 'control_cancel_request', request_id: 'req-unknown' });
check('unknown cancel does not throw or emit', sent.length === before + 1);

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
