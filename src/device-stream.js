/**
 * Server-Sent-Events transport for device connections.
 *
 * The phone normally talks to the orchestrator over a WebSocket. Some networks
 * (notably under Russian DPI) interfere with the WebSocket `Upgrade` handshake
 * specifically, while ordinary streaming HTTPS responses pass. This module
 * offers the same message channel with no Upgrade: the server pushes frames on
 * a long-lived `text/event-stream` GET, and the phone sends frames back with
 * ordinary POSTs.
 *
 * The design goal is that NOTHING else in the orchestrator needs to know which
 * transport a device is on. A connection here exposes the small slice of the
 * `ws` API the rest of the codebase uses -- `send()`, `readyState`, `close()`,
 * and the `on('message'|'close')` registration -- so it can be stored in the
 * same `deviceConnections` map and written to by the same code.
 *
 * Every frame is numbered. A reconnecting client sends `Last-Event-ID` and gets
 * the frames it missed replayed from a bounded ring buffer; if it has fallen
 * further behind than the buffer holds, it gets a `resync` event and refetches
 * state instead of silently losing messages.
 */

/** Frames retained per device for replay after a dropped stream. */
const RING_CAPACITY = 500;

/** Keepalive cadence. Comfortably under typical proxy idle timeouts. */
const PING_INTERVAL_MS = 15000;

/**
 * How long after a stream drops we keep reporting the device as reachable, so
 * frames generated during a reconnect are buffered for replay instead of being
 * skipped by callers that check readyState first.
 */
const RESUME_WINDOW_MS = 30000;

/**
 * Unflushed bytes tolerated on one stream before it is dropped as stalled.
 * Roughly one large TTS payload's worth of slack.
 */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * One device's stream state: the frame ring plus every live response for that
 * device.
 *
 * `conns` is a Set, not a single response: a reconnect can race the old
 * connection's teardown, and a single slot would let the new stream clobber the
 * old one (or vice versa) and leave a client attached to nothing.
 */
class DeviceStream {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.seq = 0;
    this.buf = [];
    this.conns = new Set();
    /** When the last stream detached, or null while one is attached. */
    this.detachedAt = null;
  }

  /**
   * Whether a client resuming at `lastId` can be brought up to date.
   *
   * `lastId > seq` means the client is ahead of us, which only happens when the
   * orchestrator restarted and the counter reset. Everything the client saw
   * belongs to a previous run, so resuming would silently skip frames.
   */
  canResume(lastId) {
    if (lastId > this.seq) return false;
    if (this.buf.length === 0) return lastId === this.seq;
    return lastId + 1 >= this.buf[0].id;
  }

  /**
   * Number a frame, retain it for replay, and write it to every live stream.
   * @param {string} payload already-serialized frame
   * @returns {boolean} whether at least one stream received it
   */
  push(payload) {
    this.seq += 1;
    const id = this.seq;
    this.buf.push({ id, payload });
    if (this.buf.length > RING_CAPACITY) this.buf.splice(0, this.buf.length - RING_CAPACITY);
    let delivered = false;
    for (const res of this.conns) {
      if (writeEvent(res, id, 'message', payload)) delivered = true;
    }
    return delivered;
  }

  /**
   * Replay everything after `lastId`.
   * @returns {boolean} false when the client cannot be brought up to date --
   *   either the frames were evicted, or the counter restarted underneath it.
   *   The caller must then tell the client to resync rather than let it assume
   *   it is current.
   */
  replay(res, lastId) {
    if (!this.canResume(lastId)) return false;
    for (const frame of this.buf) {
      if (frame.id > lastId) writeEvent(res, frame.id, 'message', frame.payload);
    }
    return true;
  }

  get open() {
    return this.conns.size > 0;
  }

  /**
   * Whether a frame sent now can still reach the client.
   *
   * True while a stream is attached, and for a short window after the last one
   * dropped -- a dropped SSE stream is usually a reconnect in progress, and the
   * frame will be replayed from the ring. Callers gate on this (via
   * readyState) BEFORE handing a frame over, so reporting closed the instant
   * the socket goes means the frame is never buffered and the resume path has
   * nothing to replay.
   *
   * Past the window we report closed so the durable Mongo queue takes over --
   * the ring is bounded and must not be mistaken for long-term storage.
   */
  get deliverable() {
    if (this.conns.size > 0) return true;
    if (!this.detachedAt) return false;
    return Date.now() - this.detachedAt < RESUME_WINDOW_MS;
  }
}

/**
 * Write one SSE event. Returns false if the socket is already gone.
 * `data` is split across lines because a raw newline would terminate the event.
 */
function writeEvent(res, id, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  // Backpressure: a client that has stopped reading would otherwise grow
  // Node's socket buffer without bound. Past the cap, drop the stream -- the
  // client reconnects and replays from the ring, which is exactly the recovery
  // path this transport already has.
  if (res.writableLength > MAX_PENDING_BYTES) {
    console.warn(`[device-stream] dropping stalled stream (${res.writableLength} bytes queued)`);
    try { res.end(); } catch { /* already gone */ }
    return false;
  }
  try {
    const lines = String(data).split('\n').map(l => `data: ${l}`).join('\n');
    res.write(`id: ${id}\nevent: ${event}\n${lines}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export class DeviceStreamRegistry {
  constructor() {
    /** @type {Map<string, DeviceStream>} */
    this.streams = new Map();
  }

  get(deviceId) {
    let s = this.streams.get(deviceId);
    if (!s) {
      s = new DeviceStream(deviceId);
      this.streams.set(deviceId, s);
    }
    return s;
  }

  /**
   * Attach an SSE response to a device.
   * @param {string} deviceId
   * @param {import('http').ServerResponse} res
   * @param {number|null} lastEventId from the Last-Event-ID header
   * @returns {DeviceStream}
   */
  attach(deviceId, res, lastEventId) {
    const stream = this.get(deviceId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tell any nginx in the path not to buffer; without it the client sees
      // nothing until the response closes, which for a live stream is never.
      'X-Accel-Buffering': 'no'
    });
    // Flush the headers immediately so the client's connect completes rather
    // than waiting for the first real frame.
    res.write(': connected\n\n');

    if (lastEventId != null) {
      const ok = stream.replay(res, lastEventId);
      if (!ok) {
        // The client missed more than we retained. Say so explicitly instead of
        // resuming as though nothing was lost.
        writeEvent(res, stream.seq, 'resync', JSON.stringify({ reason: 'buffer_evicted' }));
      }
    }

    stream.conns.add(res);
    stream.detachedAt = null;
    const ping = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try { res.write(': ping\n\n'); } catch { /* closed under us */ }
    }, PING_INTERVAL_MS);
    if (ping.unref) ping.unref();

    const detach = () => {
      clearInterval(ping);
      stream.conns.delete(res);
      if (stream.conns.size === 0) stream.detachedAt = Date.now();
    };
    res.on('close', detach);
    res.on('error', detach);
    return stream;
  }

  /**
   * Send a frame to a device over SSE.
   * @returns {boolean} whether it reached a live stream
   */
  send(deviceId, payload) {
    // get(), not streams.get(): buffer even when the device has never attached
    // or is momentarily away. A client reconnecting within the ring's depth
    // still receives these, which is the whole point of the resume path.
    return this.get(deviceId).push(payload);
  }

  /** A stream is currently attached. Used to decide when to reap state. */
  isConnected(deviceId) {
    return this.streams.get(deviceId)?.open === true;
  }

  /**
   * A frame sent now can still reach the client, counting a brief reconnect
   * window. This is what readyState reports, so callers that check before
   * sending still hand frames over during a reconnect.
   */
  isDeliverable(deviceId) {
    return this.streams.get(deviceId)?.deliverable === true;
  }

  /** Drop a device's state entirely (device removed, not merely disconnected). */
  forget(deviceId) {
    const stream = this.streams.get(deviceId);
    if (!stream) return;
    for (const res of stream.conns) {
      try { res.end(); } catch { /* already gone */ }
    }
    this.streams.delete(deviceId);
  }
}

/**
 * Wrap an SSE stream in the slice of the `ws` API the rest of the orchestrator
 * uses, so a device on SSE can live in `deviceConnections` alongside real
 * WebSockets and every existing `ws.send(...)` call site works untouched.
 *
 * Inbound frames do not arrive on this object -- they come in as POSTs, which
 * the HTTP layer feeds to the registered 'message' handlers.
 */
export class SseDeviceSocket {
  constructor(registry, deviceId) {
    this.registry = registry;
    this.deviceId = deviceId;
    this.isSse = true;
    this._handlers = { message: [], close: [], error: [] };
  }

  /**
   * Mirrors WebSocket.OPEN(1) / CLOSED(3) so readyState checks work as-is.
   *
   * Reports open through a brief reconnect window, not just while a stream is
   * literally attached: callers check this and then send, so a momentary gap
   * would make them skip the frame entirely and the resume buffer would have
   * nothing to replay.
   */
  get readyState() {
    return this.registry.isDeliverable(this.deviceId) ? 1 : 3;
  }

  /**
   * Deliberately does NOT throw when the stream is down, unlike `ws.send`.
   * Most call sites here check `readyState` and then send, and an SSE stream's
   * readyState flips the instant the HTTP response closes -- far more volatile
   * than a WebSocket. Throwing into those async paths would turn a dropped
   * frame into an unhandled rejection. The frame is still buffered for replay.
   */
  send(payload) {
    this.registry.send(this.deviceId, payload);
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  }

  /** ws-compatible: register a handler that fires at most once. */
  once(event, handler) {
    const wrapper = (...args) => {
      this.removeListener(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  /**
   * ws-compatible listener removal. The dispatcher's device-command paths call
   * this in their cleanup, so its absence threw from a setTimeout callback and
   * broke every tool routed to the phone.
   */
  removeListener(event, handler) {
    const list = this._handlers[event];
    if (!list) return this;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
    return this;
  }

  off(event, handler) {
    return this.removeListener(event, handler);
  }

  /** ws-compatible no-op: SSE keepalive is the server-sent ping comment. */
  ping() {}

  /** Bytes queued but unflushed. SSE writes go straight to the socket. */
  get bufferedAmount() {
    return 0;
  }

  /** Deliver an inbound POST body to the registered message handlers. */
  emitMessage(data) {
    for (const h of this._handlers.message) {
      try { h(data); } catch (err) {
        console.error(`[device-stream] message handler failed: ${err.message}`);
      }
    }
  }

  close(code, reason) {
    this.registry.forget(this.deviceId);
    for (const h of this._handlers.close) {
      try { h(code ?? 1000, reason ?? ''); } catch { /* handler owns its errors */ }
    }
  }

  /** ws-compatible alias used on the abrupt-teardown paths. */
  terminate() {
    this.close(1006, 'terminated');
  }
}

export const RING_CAPACITY_FOR_TEST = RING_CAPACITY;
export const PING_INTERVAL_MS_FOR_TEST = PING_INTERVAL_MS;
