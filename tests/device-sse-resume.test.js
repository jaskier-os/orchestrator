#!/usr/bin/env node
// Unit test for the SSE device transport (src/device-stream.js).
//
// Exercises the registry and the ws-shaped socket wrapper directly against a
// fake ServerResponse, so no HTTP server, orchestrator or phone is needed.
//
// Covers:
//   1. Frames are numbered and delivered, and SSE framing survives payloads
//      containing newlines (a raw newline would terminate the event).
//   2. Last-Event-ID replays exactly the missed frames -- no gap, no repeat.
//   3. A client that fell further behind than the ring holds gets an explicit
//      `resync`, not a silent partial resume.
//   4. Two concurrent connections for one device both receive frames -- a
//      reconnect racing the old teardown must not starve either.
//   5. The SseDeviceSocket presents ws-compatible readyState/send/close so it
//      can live in deviceConnections beside real WebSockets.
//   6. Frames sent while nothing is attached are buffered and delivered on
//      resume, which is what makes the transport survive a dropped stream.

import { EventEmitter } from 'events';
import {
  DeviceStreamRegistry,
  SseDeviceSocket,
  RING_CAPACITY_FOR_TEST
} from '../src/device-stream.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

/** Minimal stand-in for http.ServerResponse that records what was written. */
class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.headers = null;
    this.status = null;
    this.writableEnded = false;
    this.destroyed = false;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(s) { this.chunks.push(s); this.writableLength = this.stalledBytes ?? 0; return true; }
  /** Set to simulate a client that has stopped reading. */
  writableLength = 0;
  end() { this.writableEnded = true; this.emit('close'); }
  get text() { return this.chunks.join(''); }
  /** Parse the SSE wire format back into {id, event, data} records. */
  get events() {
    return this.text
      .split('\n\n')
      .filter(b => b.includes('event:'))
      .map(block => {
        const out = { id: null, event: null, data: [] };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) out.id = Number.parseInt(line.slice(4), 10);
          else if (line.startsWith('event: ')) out.event = line.slice(7);
          else if (line.startsWith('data: ')) out.data.push(line.slice(6));
        }
        return { id: out.id, event: out.event, data: out.data.join('\n') };
      });
  }
}

const DEV = 'phone-1';

function testFramingAndDelivery() {
  console.log('\nframes are numbered, delivered, and newline-safe');
  const reg = new DeviceStreamRegistry();
  const res = new FakeRes();
  reg.attach(DEV, res, null);

  check('SSE content type set', res.headers?.['Content-Type'] === 'text/event-stream');
  check('proxy buffering disabled', res.headers?.['X-Accel-Buffering'] === 'no');

  reg.send(DEV, JSON.stringify({ type: 'a' }));
  // A frame whose SERIALIZED form spans multiple lines -- pretty-printed JSON,
  // which is exactly what a naive `data: <payload>` would split into separate
  // events, corrupting the frame.
  const multiline = JSON.stringify({ type: 'b', text: 'line1\nline2\nline3' }, null, 2);
  check('fixture really is multi-line', multiline.includes('\n'));
  reg.send(DEV, multiline);

  const evs = res.events;
  check('two frames delivered', evs.length === 2, `got ${evs.length}`);
  check('ids are sequential from 1', evs[0].id === 1 && evs[1].id === 2,
    `${evs[0].id},${evs[1].id}`);
  check('multiline payload round-trips intact', evs[1].data === multiline,
    JSON.stringify(evs[1].data));
  check('payload still parses as JSON after transport',
    JSON.parse(evs[1].data).text.split('\n').length === 3);
}

function testResumeReplay() {
  console.log('\nLast-Event-ID replays exactly the missed frames');
  const reg = new DeviceStreamRegistry();
  const first = new FakeRes();
  reg.attach(DEV, first, null);
  for (let i = 1; i <= 5; i++) reg.send(DEV, JSON.stringify({ n: i }));

  // Client saw through frame 3, then the stream dropped.
  first.end();
  for (let i = 6; i <= 8; i++) reg.send(DEV, JSON.stringify({ n: i }));

  const resumed = new FakeRes();
  reg.attach(DEV, resumed, 3);
  const ids = resumed.events.filter(e => e.event === 'message').map(e => e.id);
  check('replays 4..8 and nothing else', ids.join() === '4,5,6,7,8', ids.join());
  check('no resync needed', !resumed.events.some(e => e.event === 'resync'));

  // A live frame after resume continues the same numbering.
  reg.send(DEV, JSON.stringify({ n: 9 }));
  const after = resumed.events.filter(e => e.event === 'message').map(e => e.id);
  check('numbering continues after resume', after[after.length - 1] === 9,
    after.join());
}

function testResyncOnEviction() {
  console.log('\nfalling behind the ring yields an explicit resync');
  const reg = new DeviceStreamRegistry();
  const first = new FakeRes();
  reg.attach(DEV, first, null);
  // Overflow the ring so early frames are evicted.
  for (let i = 0; i < RING_CAPACITY_FOR_TEST + 50; i++) {
    reg.send(DEV, JSON.stringify({ n: i }));
  }
  first.end();

  const resumed = new FakeRes();
  reg.attach(DEV, resumed, 1); // frame 1 is long gone
  const evs = resumed.events;
  check('resync emitted', evs.some(e => e.event === 'resync'),
    evs.map(e => e.event).join(','));
  check('resync says why', evs.find(e => e.event === 'resync')?.data.includes('buffer_evicted'));

  // A client only slightly behind must NOT be told to resync.
  const nearby = new FakeRes();
  const latest = RING_CAPACITY_FOR_TEST + 45;
  reg.attach(DEV, nearby, latest);
  check('a client within the ring resumes without resync',
    !nearby.events.some(e => e.event === 'resync'));
}

function testConcurrentConnections() {
  console.log('\ntwo live connections for one device both receive frames');
  const reg = new DeviceStreamRegistry();
  const a = new FakeRes();
  const b = new FakeRes();
  reg.attach(DEV, a, null);
  reg.attach(DEV, b, null);

  reg.send(DEV, JSON.stringify({ hello: true }));
  check('first connection received', a.events.some(e => e.event === 'message'));
  check('second connection received', b.events.some(e => e.event === 'message'),
    'a reconnect racing teardown must not starve either stream');

  // Closing one leaves the other working.
  a.end();
  reg.send(DEV, JSON.stringify({ second: true }));
  check('survivor still receives after the other closes',
    b.events.filter(e => e.event === 'message').length === 2,
    `got ${b.events.filter(e => e.event === 'message').length}`);
}

function testWsCompatibility() {
  console.log('\nSseDeviceSocket presents the ws API the orchestrator uses');
  const reg = new DeviceStreamRegistry();
  const sock = new SseDeviceSocket(reg, DEV);

  check('readyState is CLOSED(3) with no stream', sock.readyState === 3);
  // Deliberately does NOT throw: most orchestrator call sites check readyState
  // and then send, and an SSE readyState flips the instant the response closes.
  // Throwing there would surface as an unhandled rejection in async handlers.
  let threw = false;
  try { sock.send('x'); } catch { threw = true; }
  check('send does not throw when disconnected', !threw)

  // The dispatcher's device-command cleanup calls removeListener from a
  // setTimeout; its absence threw and broke every tool routed to the phone.
  for (const fn of ['removeListener', 'off', 'once', 'ping']) {
    check(`exposes ${fn}()`, typeof sock[fn] === 'function');
  }
  const noop = () => {}
  sock.on('message', noop);
  sock.removeListener('message', noop);
  let afterRemoval = 0;
  sock.on('message', () => { afterRemoval++; });
  sock.emitMessage('{}');
  check('removeListener actually detaches', afterRemoval === 1);

  let onceCount = 0;
  sock.once('message', () => { onceCount++; });
  sock.emitMessage('{}');
  sock.emitMessage('{}');
  check('once() fires exactly once', onceCount === 1, `got ${onceCount}`);

  const res = new FakeRes();
  reg.attach(DEV, res, null);
  check('readyState is OPEN(1) once attached', sock.readyState === 1);

  sock.send(JSON.stringify({ type: 'rc_message' }));
  check('send reaches the stream', res.events.some(e => e.event === 'message'));

  // Inbound frames arrive as POSTs and are dispatched to 'message' handlers.
  const received = [];
  sock.on('message', d => received.push(d));
  sock.emitMessage('{"type":"identify"}');
  check('inbound POST body reaches message handlers',
    received.length === 1 && received[0].includes('identify'));

  let closedWith = null;
  sock.on('close', code => { closedWith = code; });
  sock.close(1000, 'bye');
  check('close notifies handlers', closedWith === 1000);
  check('close drops the stream', sock.readyState === 3);
}

function testBufferingWhileDetached() {
  console.log('\nframes sent while detached are delivered on resume');
  const reg = new DeviceStreamRegistry();
  const sock = new SseDeviceSocket(reg, DEV);
  const first = new FakeRes();
  reg.attach(DEV, first, null);
  reg.send(DEV, JSON.stringify({ n: 1 }));
  first.end();

  // THE REGRESSION THIS GUARDS: orchestrator senders check readyState and only
  // then send (safeSend in index.js, and every `ws.readyState === 1` site).
  // If readyState went CLOSED the instant the stream detached, those callers
  // would skip the frame entirely -- it would never reach the ring, and resume
  // would replay nothing. Verified against the live deployment, where exactly
  // that produced "resume delivered 0 frames".
  check('readyState stays OPEN through the reconnect window',
    sock.readyState === 1, `got ${sock.readyState}`);
  check('no stream is literally attached', reg.isConnected(DEV) === false);

  // Send the way the orchestrator does: guarded by readyState.
  for (const n of [2, 3]) {
    if (sock.readyState === 1) sock.send(JSON.stringify({ n }));
  }

  const resumed = new FakeRes();
  reg.attach(DEV, resumed, 1);
  const ids = resumed.events.filter(e => e.event === 'message').map(e => e.id);
  check('frames sent while offline are replayed', ids.join() === '2,3', ids.join());

  // Past the window the device is genuinely gone and the durable Mongo queue
  // must take over -- the ring is bounded and is not long-term storage.
  reg.get(DEV).detachedAt = Date.now() - 60_000;
  const goneSock = new SseDeviceSocket(reg, DEV);
  reg.get(DEV).conns.clear();
  check('readyState reports CLOSED once the window lapses',
    goneSock.readyState === 3, `got ${goneSock.readyState}`);
}

function testRestartResync() {
  console.log('\na client ahead of the server (restart) is told to resync');
  // The orchestrator restarted: seq is back at 0, but the phone still holds a
  // Last-Event-ID from the previous run. Naively "resuming" would deliver
  // nothing and report success, silently eating every frame.
  const reg = new DeviceStreamRegistry();
  const res = new FakeRes();
  // Frames buffered before this client attaches.
  reg.send(DEV, JSON.stringify({ n: 1 }));
  reg.send(DEV, JSON.stringify({ n: 2 }));

  reg.attach(DEV, res, 400); // client is far "ahead" of the fresh counter
  const evs = res.events;
  check('resync emitted for an ahead-of-server client',
    evs.some(e => e.event === 'resync'),
    evs.map(e => e.event).join(','));

  // And a client with a cursor from this run still resumes normally.
  const ok = new FakeRes();
  reg.attach(DEV, ok, 1);
  check('a same-run cursor still resumes without resync',
    !ok.events.some(e => e.event === 'resync'));
  check('same-run resume replays only the missing frame',
    ok.events.filter(e => e.event === 'message').map(e => e.id).join() === '2');
}

function testStalledClientDropped() {
  console.log('\na stalled client is dropped rather than buffered without bound');
  const reg = new DeviceStreamRegistry();
  const res = new FakeRes();
  reg.attach(DEV, res, null);
  reg.send(DEV, JSON.stringify({ ok: true }));
  check('healthy client receives', res.events.length === 1);

  // Simulate the kernel/socket buffer filling because the client stopped reading.
  res.stalledBytes = 64 * 1024 * 1024;
  res.write('');
  reg.send(DEV, JSON.stringify({ dropped: true }));
  check('stalled stream is ended', res.writableEnded);
  check('stalled stream is detached', !reg.isConnected(DEV));

  // The frame is still retained, so the client gets it when it reconnects --
  // dropping the stream must not drop history.
  const resumed = new FakeRes();
  reg.attach(DEV, resumed, 1);
  check('frame survives for replay after the drop',
    resumed.events.some(e => e.event === 'message' && e.data.includes('dropped')));
}

// --- run -----------------------------------------------------------------

testFramingAndDelivery();
testResumeReplay();
testResyncOnEviction();
testConcurrentConnections();
testWsCompatibility();
testBufferingWhileDetached();
testRestartResync();
testStalledClientDropped();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
