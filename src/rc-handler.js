import crypto from 'crypto';
import config from './config.js';
import { DEFAULT_ORCHESTRATOR_MODE, validateOrchestratorMode, normalizeMode, toCliMode, toPhoneMode } from './permission-mode.js';
import {
  MSG_TYPE,
  serializeMessage,
  createRcSessionStartMessage,
  createRcSessionEndMessage,
  createRcMessage,
  createRcPermissionRequestMessage,
  createRcToolStatusMessage,
  createRcThinkingMessage,
  createRcThinkingEndMessage,
  createRcModeChangeMessage,
  createRcTranscriptMessage,
  createRcErrorMessage,
  createRcUserInputMessage,
  createRcUserMessageAckMessage
} from '@orchestrator/sdk/protocol';

// --- Helpers ---

const USER_TEXT_HASH_LRU_SIZE = 32;

function userTextHash(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').substring(0, 16);
}

/**
 * Returns true and records the hash if this user text is new for the session;
 * false if it's a recent duplicate (e.g. a Claude-Code replay of an already-
 * persisted message). Bounded LRU of the last N hashes per session.
 */
function shouldPersistUserText(session, text) {
  if (!session) return true;
  const h = userTextHash(text);
  if (!Array.isArray(session.recentUserTextHashes)) session.recentUserTextHashes = [];
  if (session.recentUserTextHashes.includes(h)) return false;
  session.recentUserTextHashes.push(h);
  if (session.recentUserTextHashes.length > USER_TEXT_HASH_LRU_SIZE) {
    session.recentUserTextHashes.shift();
  }
  return true;
}

// --- Module-level dependencies (set by initRcHandler) ---
/** @type {import('./rc-store.js').RcStore} */
let rcStore = null;
/** @type {Map<string, import('ws').WebSocket>} */
let deviceConnections = null;

// --- Internal state ---
/** @type {Map<string, { desktopWs: import('ws').WebSocket, phoneDeviceId: string|null, permissionMode: string, pendingPermissions: Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout, toolName: string, toolArgs: Object, description: string|null }>, createdAt: Date, activityTimer: NodeJS.Timeout|null, lineBuffer: string, contextPct: number }>} */
const rcSessions = new Map();
/** @type {Map<import('ws').WebSocket, string>} */
const desktopToSession = new Map();

// Orchestrator-side permission mode pre-registered by gateway before the
// desktop WS attaches. Drained on handleRemoteControlConnection.
/** @type {Map<string, string>} */
const pendingSessionModes = new Map();

// Phone messages that arrive for a sessionId whose desktop WS has not yet
// connected. Drained on handleRemoteControlConnection; expired with an
// rc_error echo to the phone so the UI can stop showing "thinking".
/** @type {Map<string, { items: Array<{ deviceId: string, envelope: Object, ws: import('ws').WebSocket }>, expiryTimer: NodeJS.Timeout }>} */
const pendingPhoneMessages = new Map();
// 60s TTL gives the pc-agent enough time to respawn a CLI for a session whose
// previous CLI exited (auto-respawn path triggered from handleRcPhoneMessage).
// CLI cold-start is ~10-30s; previous 15s caused spurious "failed to attach"
// errors when the user resumed an existing session.
const PENDING_PHONE_MSG_TTL_MS = 60_000;

// Ceiling timer for the respawn dedup guard. Separate from PENDING_PHONE_MSG_TTL_MS
// because CLI cold-start (10-30s) + session resume (loads full context) can exceed
// 60s, causing the guard to expire and a second respawn to fire.
const RESPAWN_CEILING_MS = 120_000;

const PERMISSION_TIMEOUT_MS = 120_000;
let SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h -- closes session if no user interaction

// Turn-level timeout: if a CLI turn (thinking -> result) exceeds this, the
// orchestrator sends rc_error + rc_thinking_end to the phone so the UI
// escapes the "Thinking..." state. The desktop WS is closed to kill the CLI.
const TURN_TIMEOUT_MS = parseInt(process.env.RC_TURN_TIMEOUT_MS, 10) || 10 * 60 * 1000; // 10 minutes

// Desktop RC WebSocket ping interval. Unlike agent registry pings, this
// detects half-open connections where the CLI is alive but the TCP state
// doesn't reflect it (e.g. network partition, OS socket leak).
const RC_DESKTOP_PING_INTERVAL_MS = 30_000;

// Auto-respawn callback (set by initRcHandler). Returns a Promise that
// resolves once pc-agent has spawned a new CLI and the desktop WS is
// (or will shortly be) attached for the given sessionId. If unset or the
// callback rejects, the queued phone messages will time out as before.
/** @type {((sessionId: string, workDir: string, permissionMode: string) => Promise<void>)|null} */
let respawnCliFn = null;

// Adopt CLI callback (set by initRcHandler). Attaches to an interactive CLI the
// user already has open for a session WITHOUT spawning one. Unlike respawnCliFn
// it never starts a process, so it is safe to fire merely on chat-open. Resolves
// true when an attach actually happened.
/** @type {((sessionId: string, workDir: string, permissionMode: string) => Promise<boolean>)|null} */
let adoptCliFn = null;

// Kill CLI callback (set by initRcHandler). Called by endSession() to
// SIGTERM/SIGKILL the actual CLI process on the PC so it doesn't reconnect.
/** @type {((sessionId: string) => Promise<void>)|null} */
let killCliFn = null;

// Export-JSONL callback (set by initRcHandler). Reconstructs a session's full
// transcript from Claude Code's on-disk JSONL via pc-agent. JSONL is the
// authoritative conversation record: PC-only legs (session resumed directly at
// the terminal, outside the live RC relay) land only there, never in Mongo. The
// merged transcript uses it as the spine so the phone stops showing stale
// history. Returns [] on any failure so the caller falls back to Mongo.
/** @type {((workDir: string, sessionId: string) => Promise<Array>)|null} */
let exportJsonlFn = null;

// Coalesce concurrent JSONL exports per session. The phone's resume storm (HTTP
// retry + WS request + reconnect can all fire within ~1s) would otherwise shell
// out to the CLI repeatedly. A Map of in-flight promises (cleared on settle)
// collapses them into one. Unlike a TTL cache this never serves stale content --
// every settled call reflects disk at call time.
/** @type {Map<string, Promise<Array>>} */
const inFlightTranscriptExports = new Map();

/**
 * Page a full transcript the exporter returned unsliced.
 *
 * The CLI does the slicing when it supports it; this is the fallback for a
 * pc-agent that predates the flags, so the phone still gets a page instead of
 * the whole conversation. Mirrors exportTranscriptPageImpl's semantics,
 * including serving the OLDEST page for a cursor that no longer resolves --
 * repeating the newest page would loop the phone on the same rows.
 * @param {Array} all
 * @param {{ limit: number, before?: string|null }} opts
 */
function sliceUnpagedExport(all, opts) {
  const limit = Math.max(1, opts.limit);
  let end = all.length;
  if (opts.before) {
    const uid = decodeCursor(opts.before)?.uid;
    const idx = uid ? all.findIndex(e => entryUid(e) === uid) : -1;
    end = idx >= 0 ? idx : Math.min(limit, all.length);
  }
  const start = Math.max(0, end - limit);
  const entries = all.slice(start, end);
  return {
    entries,
    nextCursor: entries.length > 0 ? encodeEntryCursor(entries[0]) : null,
    hasMore: start > 0,
    ok: true
  };
}

function exportJsonlCoalesced(sessionId, workDir, opts = {}) {
  const paged = opts.limit != null;
  // ok=false means the spine could not be READ at all, which is a different
  // thing from a spine that simply has no more entries. Only the former may
  // fall back to paging Mongo.
  const empty = paged ? { entries: [], nextCursor: null, hasMore: false, ok: false } : [];
  if (!exportJsonlFn || !workDir) return Promise.resolve(empty);
  // The cache key carries the cursor and limit: two different pages of the same
  // session are different requests, and keying on sessionId alone would serve
  // one page's rows for another's cursor.
  const key = paged ? `${sessionId}|${opts.limit}|${opts.before || ''}` : sessionId;
  const existing = inFlightTranscriptExports.get(key);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(() => exportJsonlFn(workDir, sessionId, paged ? { limit: opts.limit, before: opts.before } : {}))
    .then(res => {
      if (!paged) return Array.isArray(res) ? res : [];
      // A pc-agent that predates paging ignores the flags and returns the whole
      // transcript as a bare array. Slice it here rather than serving thousands
      // of entries to a phone that asked for a page -- the point of the feature
      // is that a long conversation never ships whole.
      if (Array.isArray(res)) {
        return sliceUnpagedExport(res, opts);
      }
      if (!res || !Array.isArray(res.entries)) return empty;
      // Same guard for an envelope whose entries were not actually limited.
      if (res.entries.length > opts.limit) {
        return sliceUnpagedExport(res.entries, opts);
      }
      return {
        entries: res.entries,
        nextCursor: res.nextCursor ?? null,
        hasMore: res.hasMore === true,
        ok: res.ok !== false
      };
    })
    .catch(err => {
      console.error(`[rc-handler] JSONL export failed for ${sessionId}: ${err.message}`);
      return empty;
    })
    .finally(() => { inFlightTranscriptExports.delete(key); });
  inFlightTranscriptExports.set(key, p);
  return p;
}

// Phone-only renderable entry types that the JSONL cannot contain (permission
// prompts are answered on the phone, not recorded by Claude Code). These are
// spliced back into the JSONL spine so approval cards survive a resume.
const PHONE_ONLY_TRANSCRIPT_TYPES = new Set(['rc_permission_request', 'rc_permission_resolved']);

// Mirrors the $slice: -1000 cap in rc-store.appendTranscript. Reaching the
// start of the Mongo array therefore does NOT mean reaching the start of the
// conversation, which is why the paged path reports `truncated` separately from
// `hasMore`.
const MONGO_TRANSCRIPT_CAP = 1000;

/**
 * Build the transcript payload sent to the phone. JSONL (authoritative, always
 * current) is the spine; Mongo's phone-only permission entries are merged in by
 * timestamp. Falls back to the raw Mongo transcript whenever the JSONL export is
 * unavailable (pc-agent offline, session on another machine, empty, or error) --
 * strict no-regression.
 * @param {string} sessionId
 * @param {string|null} workDir
 * @returns {Promise<Array>}
 */
export async function buildMergedTranscript(sessionId, workDir) {
  const [mongoRes, jsonlRes] = await Promise.allSettled([
    rcStore.getTranscript(sessionId),
    exportJsonlCoalesced(sessionId, workDir)
  ]);
  const mongoArr = mongoRes.status === 'fulfilled' && Array.isArray(mongoRes.value) ? mongoRes.value : [];
  const jsonlArr = jsonlRes.status === 'fulfilled' && Array.isArray(jsonlRes.value) ? jsonlRes.value : [];
  if (jsonlArr.length === 0) return mongoArr;
  const perms = mongoArr.filter(e => PHONE_ONLY_TRANSCRIPT_TYPES.has(e?.type));
  if (perms.length === 0) return jsonlArr;
  // Stable sort (V8): equal-ts keeps spine-before-perms insertion order.
  const merged = jsonlArr.concat(perms);
  merged.sort((a, b) => {
    const ta = a?.ts || '';
    const tb = b?.ts || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return merged;
}

// Rows sent on a WS catch-up. These paths push unsolicited, so they must not
// ship an entire long conversation -- the phone pages the rest upward over
// HTTP with the cursor from the same endpoint.
const WS_CATCHUP_LIMIT = 100;

/**
 * Newest slice of a session's transcript, for the unsolicited WS catch-up
 * pushes. Returns a plain array (the rc_transcript envelope's shape) rather
 * than a page envelope.
 * @param {string} sessionId
 * @param {string|null} workDir
 */
async function buildCatchUpTranscript(sessionId, workDir) {
  const page = await buildMergedTranscriptPage(sessionId, workDir, { limit: WS_CATCHUP_LIMIT });
  return page.transcript;
}

/**
 * Stable identity for a transcript entry, used as the cursor tiebreaker. JSONL
 * entries arrive with a `uid` from the CLI; Mongo permission entries have none,
 * so one is derived from their content. Sorting on (ts, uid) rather than ts
 * alone makes the order total, which is what makes it cursorable at all.
 * @param {Object} entry
 */
function entryUid(entry) {
  if (entry?.uid) return entry.uid;
  const basis = `${entry?.ts || ''}|${entry?.type || ''}|${JSON.stringify(entry?.data ?? null)}`;
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

/**
 * Return the entry with its `uid` stamped on, so the derived identity travels
 * to the phone instead of being recomputed (or lost) there.
 * @param {Object} entry
 */
function withUid(entry) {
  if (!entry || entry.uid) return entry;
  return { ...entry, uid: entryUid(entry) };
}

function compareEntries(a, b) {
  const ta = a?.ts || '';
  const tb = b?.ts || '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ua = entryUid(a);
  const ub = entryUid(b);
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

function encodeEntryCursor(entry) {
  return Buffer.from(`${entry?.ts || ''}|${entryUid(entry)}`, 'utf8').toString('base64');
}

/** Split a cursor back into its (ts, uid) parts. */
function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep === -1) return null;
    return { ts: decoded.slice(0, sep), uid: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

/**
 * One page of a session's transcript, newest-first.
 *
 * Two sources have to agree on a single ordering: the JSONL spine (paged by the
 * CLI, which owns the parentUuid chain) and Mongo's phone-only permission
 * entries. The JSONL page defines the window; permission entries whose (ts, uid)
 * falls inside it are spliced in.
 *
 * When JSONL is unavailable the whole thing degrades to paging Mongo alone --
 * but Mongo's transcript is capped at 1000 entries, so that page is flagged
 * `truncated` rather than pretending it reached the start of the conversation.
 *
 * @param {string} sessionId
 * @param {string|null} workDir
 * @param {{ limit: number, before?: string }} opts
 * @returns {Promise<{ transcript: Array, nextCursor: string|null, hasMore: boolean, truncated: boolean }>}
 */
export async function buildMergedTranscriptPage(sessionId, workDir, opts) {
  const limit = Math.max(1, Math.min(500, opts?.limit || 100));
  const before = opts?.before || null;

  const [mongoRes, jsonlRes] = await Promise.allSettled([
    rcStore.getTranscript(sessionId),
    exportJsonlCoalesced(sessionId, workDir, { limit, before })
  ]);
  const mongoArr = mongoRes.status === 'fulfilled' && Array.isArray(mongoRes.value) ? mongoRes.value : [];
  const jsonlPage = jsonlRes.status === 'fulfilled' && jsonlRes.value && Array.isArray(jsonlRes.value.entries)
    ? jsonlRes.value
    : { entries: [], nextCursor: null, hasMore: false, ok: false };

  // --- Mongo-only fallback -------------------------------------------------
  // buildMergedTranscript's early-returns bypass the merge entirely when one
  // side is empty; the paged path has to handle that case explicitly or a
  // session whose JSONL is missing (pc-agent offline, unresolvable project
  // slug) cannot be paged at all.
  //
  // Gated on ok===false, NOT on entries.length: the spine legitimately returns
  // zero entries once the caller has paged past its first record, and treating
  // that as "unavailable" would re-serve old permission entries as if they were
  // more history.
  if (jsonlPage.ok === false) {
    const sorted = mongoArr.map(withUid).sort(compareEntries);
    let end = sorted.length;
    if (before) {
      const idx = sorted.findIndex(e => encodeEntryCursor(e) === before);
      end = idx >= 0 ? idx : Math.min(limit, sorted.length);
    }
    const start = Math.max(0, end - limit);
    const slice = sorted.slice(start, end);
    return {
      transcript: slice,
      nextCursor: slice.length > 0 ? encodeEntryCursor(slice[0]) : null,
      hasMore: start > 0,
      // Mongo keeps only the last 1000 entries ($slice: -1000). Reaching its
      // start is NOT reaching the start of the conversation, and the phone must
      // be able to say so rather than implying the history is complete.
      truncated: start === 0 && sorted.length >= MONGO_TRANSCRIPT_CAP
    };
  }

  // Spine exhausted: the caller has paged past the oldest JSONL record.
  if (jsonlPage.entries.length === 0) {
    return { transcript: [], nextCursor: null, hasMore: false, truncated: false };
  }

  // --- JSONL spine + Mongo permission entries ------------------------------
  // withUid stamps the derived identity onto the entry so it survives to the
  // phone: without it a Mongo entry arrives with no uid, the phone assigns a
  // random row id, and the same permission card can render twice if two pages
  // ever overlap.
  const perms = mongoArr.filter(e => PHONE_ONLY_TRANSCRIPT_TYPES.has(e?.type)).map(withUid);
  const pageEntries = [...jsonlPage.entries].sort(compareEntries);
  const oldest = pageEntries[0];
  const newest = pageEntries[pageEntries.length - 1];
  // Window is [page-oldest-key, requested-cursor). Anchoring the upper bound on
  // the cursor the caller passed -- rather than on this page's newest entry --
  // makes consecutive pages tile exactly: the next request's cursor IS this
  // page's oldest key, so every permission entry lands on exactly one page,
  // with no gap between windows and no overlap. The newest page has no cursor
  // and so has no upper bound; the last page takes everything older, since a
  // permission entry older than the whole spine has no page of its own.
  const isLastPage = jsonlPage.hasMore !== true;
  const upperBound = before ? decodeCursor(before) : null;
  const inWindow = perms.filter(p => {
    // The newest page (no cursor) has no upper bound -- it is the tail, and a
    // permission entry newer than the last spine record still belongs on it.
    if (upperBound && compareEntries(p, upperBound) >= 0) return false;
    if (isLastPage) return true;
    return compareEntries(p, oldest) >= 0;
  });

  const merged = pageEntries.concat(inWindow).sort(compareEntries);
  return {
    transcript: merged,
    // The cursor always comes from the JSONL spine so paging stays anchored to
    // the authoritative record even when permission entries share a timestamp.
    nextCursor: jsonlPage.nextCursor,
    // Never from Mongo: it is capped and would claim the conversation ends at
    // 1000 entries. Older permission entries are flushed into the last page
    // above rather than extending hasMore, which would spin forever since the
    // cursor cannot advance past the spine.
    hasMore: jsonlPage.hasMore === true,
    truncated: false
  };
}

// Dedup in-flight respawns. Unlike the previous implementation which cleared
// on spawn-ack, this guard stays until the desktop WS actually connects (the
// session appears in rcSessions) or a 60s ceiling expires. This prevents the
// phone retry loop from spawning extra CLIs during the cold-start window.
/** @type {Map<string, { promise: Promise<void>, timer: NodeJS.Timeout }>} */
const inFlightRespawns = new Map();

// Dedup in-flight adopt attempts. A phone reopening the same chat repeatedly
// (onResume re-fires the transcript request) must not stack attach calls at
// pc-agent. Cleared when the desktop WS connects (session enters rcSessions via
// clearRespawnGuard, which also clears this) or after a short ceiling.
/** @type {Set<string>} */
const inFlightAdopts = new Set();
const ADOPT_CEILING_MS = 30_000;

/**
 * Initialize RC handler with dependencies.
 * @param {import('./rc-store.js').RcStore} store
 * @param {Map<string, import('ws').WebSocket>} connections
 * @param {{ sessionTimeoutMs?: number, respawnCli?: (sessionId: string, workDir: string, permissionMode: string) => Promise<void>, killCli?: (sessionId: string) => Promise<void>, exportJsonl?: (workDir: string, sessionId: string) => Promise<Array> }} [options]
 */
export function initRcHandler(store, connections, options) {
  rcStore = store;
  deviceConnections = connections;
  if (options?.sessionTimeoutMs) {
    SESSION_TIMEOUT_MS = options.sessionTimeoutMs;
  }
  if (options?.respawnCli) {
    respawnCliFn = options.respawnCli;
  }
  if (options?.adoptCli) {
    adoptCliFn = options.adoptCli;
  }
  if (options?.killCli) {
    killCliFn = options.killCli;
  }
  if (options?.exportJsonl) {
    exportJsonlFn = options.exportJsonl;
  }
  console.log(`[rc-handler] Initialized (sessionTimeout=${SESSION_TIMEOUT_MS}ms, respawnCli=${!!respawnCliFn}, adoptCli=${!!adoptCliFn}, killCli=${!!killCliFn}, exportJsonl=${!!exportJsonlFn})`);
}

/**
 * Find the first connected phone device WS.
 * @returns {{ deviceId: string, ws: import('ws').WebSocket }|null}
 */
function findPhoneWs() {
  for (const [deviceId, ws] of deviceConnections) {
    if (ws._deviceType === 'phone' && ws.readyState === 1) {
      return { deviceId, ws };
    }
  }
  return null;
}

/**
 * Send a message to the phone. If phone is disconnected, queue it in the store.
 * @param {string} sessionId
 * @param {Object} message
 */
/**
 * Whether losing this frame would leave the phone visibly wrong, and so it
 * must survive a reconnect.
 *
 * The expensive failure is a terminal tool status: lose the `complete` and the
 * row ticks forever on a tool that finished minutes ago. Losing one `running`
 * heartbeat costs nothing -- another follows in 2s -- and queueing every one
 * would make the replay huge for no benefit. Streaming text partials are
 * likewise self-superseding.
 * @param {Object} message
 */
function isReplayableOnReconnect(message) {
  if (!message || typeof message !== 'object') return false;
  switch (message.type) {
    case MSG_TYPE.RC_TOOL_STATUS:
      // Only the terminal states; heartbeats are replaced within seconds.
      return message.status === 'complete' || message.status === 'error';
    case MSG_TYPE.RC_PERMISSION_REQUEST:
    case MSG_TYPE.RC_ERROR:
    case MSG_TYPE.RC_SESSION_END:
      return true;
    case MSG_TYPE.RC_MESSAGE:
      // Only the settled turn text; partials are cumulative snapshots.
      return message.isFinal === true;
    default:
      return false;
  }
}

async function sendToPhone(sessionId, message, persist = true) {
  const session = rcSessions.get(sessionId);
  const targetDeviceId = session?.phoneDeviceId;

  // Use session's bound phone, or fall back to any phone
  let phone = null;
  if (targetDeviceId && deviceConnections.has(targetDeviceId)) {
    const ws = deviceConnections.get(targetDeviceId);
    if (ws.readyState === 1) phone = { deviceId: targetDeviceId, ws };
  }
  if (!phone) phone = findPhoneWs();

  if (phone && phone.ws.readyState === 1) {
    try {
      const payload = serializeMessage(message).replace(/\0/g, '');
      phone.ws.send(payload);
      // readyState === 1 does NOT mean the peer received this. A half-open
      // socket -- open to us, already gone from the phone's side -- accepts
      // writes silently, and every frame written to it is lost with no error
      // anywhere. Frames whose loss the user would actually notice are
      // therefore ALSO queued, and cleared only when the phone acknowledges
      // them on reconnect. Streaming partials are excluded: they are
      // superseded by the next one anyway, so queueing them would just make
      // the reconnect replay enormous.
      if (isReplayableOnReconnect(message)) {
        await rcStore.appendPendingQueue(sessionId, message).catch(() => {});
      }
    } catch (err) {
      console.error(`[rc-handler] Failed to send to phone: ${err.message}`);
      await rcStore.appendPendingQueue(sessionId, message).catch(() => {});
    }
  } else {
    console.log(`[rc-handler] Phone not connected, queuing message for session ${sessionId}`);
    await rcStore.appendPendingQueue(sessionId, message).catch(() => {});
  }

  if (persist) {
    // Also persist to transcript
    await rcStore.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      type: message.type,
      data: message
    }).catch(() => {});
  }
}

/**
 * Send NDJSON line back to desktop WS.
 * @param {import('ws').WebSocket} desktopWs
 * @param {Object} obj
 */
function sendToDesktop(desktopWs, obj) {
  if (desktopWs.readyState !== 1) return;
  try {
    desktopWs.send(JSON.stringify(obj) + '\n');
  } catch (err) {
    console.error(`[rc-handler] Failed to send to desktop: ${err.message}`);
  }
}

/**
 * Wrapper around sendToPhone that also marks thinkingStartedAt the first time
 * an rc_thinking is emitted in a turn. The corresponding rc_thinking_end is
 * emitted by emitThinkingEnd on result/interrupt/close.
 * @param {string} sessionId
 * @param {Object} session
 * @param {string} text
 */
/**
 * Reset (or arm) the turn-level timeout. Called on turn start and whenever
 * a sub-agent shows real progress (new tokens or tool calls) so that active
 * work doesn't get killed by a stale timer.
 */
function resetTurnTimer(sessionId, session) {
  if (!session.turnTimer) return;
  clearTimeout(session.turnTimer);
  const turnWs = session.desktopWs;
  session.turnTimer = setTimeout(() => {
    if (session.desktopWs !== turnWs) {
      console.log(`[rc-handler] Turn timeout for session ${sessionId} -- WS changed (reconnected), ignoring stale timer`);
      return;
    }
    console.log(`[rc-handler] Turn timeout (${TURN_TIMEOUT_MS / 1000}s) for session ${sessionId} -- killing stuck turn`);
    sendToPhone(sessionId, createRcErrorMessage(sessionId, 'Turn timed out -- the session will be restarted on next message.', 'orchestrator'));
    emitThinkingEnd(sessionId, session);
    try { turnWs.close(1000, 'turn_timeout'); } catch {}
  }, TURN_TIMEOUT_MS);
}

/**
 * Interval between `running` heartbeats for an in-flight tool.
 */
const TOOL_HEARTBEAT_MS = 2000;

/**
 * Stamp a monotonically increasing per-tool sequence number on an
 * rc_tool_status envelope. sendToPhone is async, so a heartbeat scheduled just
 * before a tool_result can land AFTER the 'complete' frame; the phone upserts
 * tool rows by toolCallId, so without an ordering stamp a late 'running' would
 * overwrite 'complete' and strand the row as permanently in-flight. The phone
 * drops any status whose seq is lower than the one it already applied.
 * @param {Object} session
 * @param {Object} msg rc_tool_status envelope
 */
function stampToolSeq(session, msg) {
  if (!session.toolSeq) session.toolSeq = new Map();
  const key = msg.toolCallId || msg.toolName || 'unknown';
  const next = (session.toolSeq.get(key) || 0) + 1;
  session.toolSeq.set(key, next);
  msg.seq = next;
  // Every tool status the phone could receive is logged here, at the single
  // point they all pass through, so the wire can be compared against what the
  // phone rendered.
  console.log(
    `[rc-handler] rc_tool_status ${msg.toolName} status=${msg.status} ` +
    `seq=${next} toolCallId=${msg.toolCallId || '-'}` +
    (msg.elapsedMs != null ? ` elapsedMs=${msg.elapsedMs}` : ''),
  );
  return msg;
}

/**
 * Emit one `running` heartbeat per in-flight tool. Runs on a single
 * per-session interval (not one timer per tool) so a turn with many concurrent
 * tools cannot flood the phone.
 * @param {string} sessionId
 * @param {Object} session
 */
function emitToolHeartbeats(sessionId, session) {
  if (!session.toolInFlight || session.toolInFlight.size === 0) return;
  const now = Date.now();
  for (const [toolCallId, entry] of session.toolInFlight) {
    const elapsedMs = now - entry.startedAt;
    // Skip fast tools: a Read that returns in 300ms should never produce a
    // heartbeat row. The margin keeps the first beat on the 2s tick rather than
    // slipping to the next one on timer jitter.
    if (elapsedMs < TOOL_HEARTBEAT_MS - 250) continue;
    const hb = stampToolSeq(session, createRcToolStatusMessage(
      sessionId, entry.toolName, 'running', entry.input || null, null, toolCallId
    ));
    hb.elapsedMs = elapsedMs;
    const meta = session.agentMeta ? session.agentMeta.get(toolCallId) : null;
    if (meta) {
      // Reset the turn timer if the sub-agent made real progress (new tokens
      // spent or tools called) since the last heartbeat, so active work isn't
      // killed by a stale timer.
      const curTokens = meta.liveTokens || 0;
      const curTools = meta.liveToolCount || 0;
      if (curTokens > (meta._prevTokens || 0) || curTools > (meta._prevToolCount || 0)) {
        resetTurnTimer(sessionId, session);
        meta._prevTokens = curTokens;
        meta._prevToolCount = curTools;
      }
      hb.isAgent = true;
      if (meta.agentName) hb.agentName = meta.agentName;
      if (meta.agentTask) hb.agentTask = meta.agentTask;
      hb.agentElapsedMs = elapsedMs;
      // Forward live-accumulated counts so the row keeps showing tools/tokens
      // between sub-agent message arrivals. Claude Code's stream-json does not
      // forward subagent tool_use/usage events to the parent in real time --
      // the final counts only arrive with the tool_result.
      if (meta.liveTokens != null) hb.agentTokens = meta.liveTokens;
      if (meta.liveToolCount != null) hb.agentToolCount = meta.liveToolCount;
    }
    if (session.contextPct > 0) hb.contextPct = session.contextPct;
    // Never persisted: the transcript is capped at 1000 entries, and
    // heartbeats would evict real history.
    sendToPhone(sessionId, hb, false);
  }
}

/**
 * Replay the current in-flight tools to ONE freshly-(re)connected phone ws, so
 * a phone that opens a chat mid-turn sees the running-tool rows immediately
 * instead of waiting for the next 2s heartbeat (or, for a fast turn, never).
 * Unlike emitToolHeartbeats this targets a single socket rather than the whole
 * device set, and it does NOT gate on elapsed time -- a just-started tool must
 * still show as running the moment the phone attaches.
 * @param {string} sessionId
 * @param {Object} session
 * @param {import('ws').WebSocket} ws
 */
function replayInFlightTools(sessionId, session, ws) {
  if (!session.toolInFlight || session.toolInFlight.size === 0) return;
  if (!ws || ws.readyState !== 1) return;
  const now = Date.now();
  for (const [toolCallId, entry] of session.toolInFlight) {
    const hb = stampToolSeq(session, createRcToolStatusMessage(
      sessionId, entry.toolName, 'running', entry.input || null, null, toolCallId
    ));
    hb.elapsedMs = now - entry.startedAt;
    const meta = session.agentMeta ? session.agentMeta.get(toolCallId) : null;
    if (meta) {
      hb.isAgent = true;
      if (meta.agentName) hb.agentName = meta.agentName;
      if (meta.agentTask) hb.agentTask = meta.agentTask;
      hb.agentElapsedMs = now - entry.startedAt;
      if (meta.liveTokens != null) hb.agentTokens = meta.liveTokens;
      if (meta.liveToolCount != null) hb.agentToolCount = meta.liveToolCount;
    }
    if (session.contextPct > 0) hb.contextPct = session.contextPct;
    try { ws.send(serializeMessage(hb).replace(/\0/g, '')); } catch {}
  }
}

/**
 * Record a tool as in-flight and arm the session heartbeat if it isn't running.
 * @param {string} sessionId
 * @param {Object} session
 * @param {string} toolCallId
 * @param {string} toolName
 * @param {Object|null} input
 */
function trackToolStart(sessionId, session, toolCallId, toolName, input) {
  if (!toolCallId) return;
  if (!session.toolInFlight) session.toolInFlight = new Map();
  session.toolInFlight.set(toolCallId, { toolName, input: input || null, startedAt: Date.now() });
  if (!session.toolHeartbeatTimer) {
    session.toolHeartbeatTimer = setInterval(
      () => emitToolHeartbeats(sessionId, session), TOOL_HEARTBEAT_MS
    );
  }
}

/**
 * Drop a tool from the in-flight set and disarm the heartbeat once empty.
 * @param {Object} session
 * @param {string} toolCallId
 */
function trackToolEnd(session, toolCallId) {
  if (!session.toolInFlight) return;
  if (toolCallId) session.toolInFlight.delete(toolCallId);
  if (session.toolInFlight.size === 0) stopToolHeartbeat(session);
}

/**
 * Clear the session heartbeat interval and forget all in-flight tools.
 * @param {Object} session
 */
function stopToolHeartbeat(session) {
  if (session.toolHeartbeatTimer) {
    clearInterval(session.toolHeartbeatTimer);
    session.toolHeartbeatTimer = null;
  }
  if (session.toolInFlight) session.toolInFlight.clear();
  // toolSeq is per-invocation and grows for the life of the session, so drop it
  // once nothing is in flight.
  if (session.toolSeq) session.toolSeq.clear();
}

function emitThinking(sessionId, session, text) {
  if (!session.thinkingStartedAt) {
    session.thinkingStartedAt = Date.now();
    // Arm turn-level timeout so a stuck CLI doesn't leave the phone in
    // "Thinking..." forever. Cleared by emitThinkingEnd on normal completion.
    if (session.turnTimer) clearTimeout(session.turnTimer);
    // Set a sentinel so resetTurnTimer sees a truthy turnTimer to clear+re-arm.
    session.turnTimer = true;
    resetTurnTimer(sessionId, session);
  }
  sendToPhone(sessionId, createRcThinkingMessage(sessionId, text, session.thinkingStartedAt));
}

/**
 * Emit rc_thinking_end if a thinking turn is in progress. No-op otherwise.
 * @param {string} sessionId
 * @param {Object} session
 */
function emitThinkingEnd(sessionId, session) {
  if (!session) return;
  // Safety net for a tool_use whose tool_result never arrived (interrupt, CLI
  // crash) -- without it the heartbeat interval would outlive the turn. A tool
  // that IS still legitimately running keeps its heartbeat: on a real turn end
  // the tool_result always precedes this, so a non-empty set here means the
  // result was lost, and we emit a terminal frame so the phone's row does not
  // stay in-flight forever.
  if (session.toolInFlight && session.toolInFlight.size > 0) {
    for (const [toolCallId, entry] of session.toolInFlight) {
      sendToPhone(sessionId, stampToolSeq(session, createRcToolStatusMessage(
        sessionId, entry.toolName, 'error', entry.input || null,
        'Tool did not report a result before the turn ended.', toolCallId
      )), false);
    }
  }
  stopToolHeartbeat(session);
  if (!session.thinkingStartedAt) return;
  const elapsedMs = Date.now() - session.thinkingStartedAt;
  session.thinkingStartedAt = null;
  // Clear turn-level timeout
  if (session.turnTimer) {
    clearTimeout(session.turnTimer);
    session.turnTimer = null;
  }
  sendToPhone(sessionId, createRcThinkingEndMessage(sessionId, elapsedMs));
}

/**
 * Detect whether a tool_use block is a custom-agent dispatch (Claude Code's
 * Task tool) and return { isAgent, agentName } metadata to attach to the
 * rc_tool_status envelope. Returns nulls/false for normal tools.
 * @param {{ name?: string, input?: Object }} block
 */
function describeAgentDispatch(block) {
  if (!block || (block.name !== 'Task' && block.name !== 'Agent')) {
    return { isAgent: false, agentName: null, agentTask: null };
  }
  const input = block.input || {};
  const agentName = input.subagent_type || input.agent || input.agentName || null;
  // The Task tool's `description` is a 3-5 word purpose summary; forward it
  // so the phone can render the agent's actual job, not just "Agent:".
  let agentTask = input.description || null;
  if (!agentTask && typeof input.prompt === 'string') {
    agentTask = input.prompt.split('\n')[0].slice(0, 80);
  }
  return { isAgent: true, agentName, agentTask };
}

/**
 * Parse the trailing <usage>...</usage> block emitted by Claude Code's
 * AgentTool tool_result. Returns null if no block found.
 *   <usage>total_tokens: 81134
 *   tool_uses: 7
 *   duration_ms: 143000</usage>
 * @param {string|null} text
 * @returns {{ tokens: number|null, toolUses: number|null, durationMs: number|null }|null}
 */
/**
 * Tier A: handle a sub-agent message (assistant/user) whose parent_tool_use_id
 * matches an in-flight AgentTool dispatch. Accumulate live tool_uses and
 * token counts onto the parent's agentMeta entry, and emit a debounced
 * rc_tool_status (status='running') so the phone shows live counts.
 *
 * Sub-agent messages flow through the SDK as nested user/assistant events
 * (see Claude Code's utils/queryHelpers.ts agent_progress branch).
 *
 * @param {string} sessionId
 * @param {Object} session
 * @param {string} parentToolUseId
 * @param {Object} msg
 */
const SUBAGENT_EMIT_THROTTLE_MS = 1000;
function handleSubagentProgress(sessionId, session, parentToolUseId, msg) {
  const meta = session.agentMeta.get(parentToolUseId);
  if (!meta) return;
  if (meta.liveTokens == null) meta.liveTokens = 0;
  if (meta.liveToolCount == null) meta.liveToolCount = 0;
  if (meta.lastEmitTs == null) meta.lastEmitTs = 0;

  // Count tool_use blocks on assistant messages
  const content = msg.message?.content || msg.content || null;
  if (msg.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'tool_use') {
        meta.liveToolCount += 1;
      }
    }
    // Accumulate tokens from usage if present.
    const usage = msg.message?.usage || msg.usage || null;
    if (usage) {
      const out = usage.output_tokens || 0;
      const inp = usage.input_tokens || 0;
      const cc = usage.cache_creation_input_tokens || 0;
      const cr = usage.cache_read_input_tokens || 0;
      const turnTotal = out + inp + cc + cr;
      if (turnTotal > meta.liveTokens) {
        meta.liveTokens = turnTotal;
      }
    }
  }

  // Debounce emission to ~1Hz max.
  const now = Date.now();
  if (now - meta.lastEmitTs < SUBAGENT_EMIT_THROTTLE_MS) return;
  meta.lastEmitTs = now;

  // Use the SAME toolName the parent dispatch used so the phone's
  // upsertToolStatus matches the existing row instead of creating a new one.
  const statusMsg = createRcToolStatusMessage(
    sessionId,
    meta.toolName || 'Task',
    'running',
    null,
    null,
    parentToolUseId
  );
  statusMsg.isAgent = true;
  if (meta.agentName) statusMsg.agentName = meta.agentName;
  if (meta.agentTask) statusMsg.agentTask = meta.agentTask;
  statusMsg.agentTokens = meta.liveTokens;
  statusMsg.agentToolCount = meta.liveToolCount;
  statusMsg.agentElapsedMs = Date.now() - meta.startedAt;
  if (session.contextPct > 0) statusMsg.contextPct = session.contextPct;
  sendToPhone(sessionId, statusMsg, false);
}

function parseAgentUsage(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/<usage>([\s\S]*?)<\/usage>/);
  if (!m) return null;
  const body = m[1];
  const num = (label) => {
    const r = new RegExp(`${label}\\s*:\\s*(\\d+)`).exec(body);
    return r ? parseInt(r[1], 10) : null;
  };
  return {
    tokens: num('total_tokens'),
    toolUses: num('tool_uses'),
    durationMs: num('duration_ms'),
  };
}

// Safety timeout for replay buffer: if the CLI never sends a 'result' event
// (e.g. it crashed during replay or has no history), flush after 90s.
const REPLAY_FLUSH_TIMEOUT_MS = 90_000;

/**
 * End replay mode for a session: flush any buffered phone messages to the
 * desktop CLI now that it's ready to accept new user input.
 * @param {string} sessionId
 * @param {Object} session
 */
function endReplayMode(sessionId, session) {
  if (!session.replayInProgress) return;
  session.replayInProgress = false;
  if (session.replayFlushTimer) {
    clearTimeout(session.replayFlushTimer);
    session.replayFlushTimer = null;
  }
  const buffer = session.replayPhoneBuffer;
  session.replayPhoneBuffer = null;
  if (buffer && buffer.length > 0) {
    console.log(`[rc-handler] Replay ended for ${sessionId}, flushing ${buffer.length} buffered phone message(s)`);
    for (const envelope of buffer) {
      sendToDesktop(session.desktopWs, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: envelope.text }] }
      });
    }
  } else {
    console.log(`[rc-handler] Replay ended for ${sessionId}, no buffered messages`);
  }

  // Restore persisted pending permissions from MongoDB. After an orchestrator
  // restart the CLI reconnects and replays, but does NOT re-send control_request
  // for permissions it's still blocking on. Restore them so the phone can
  // approve/reject and unblock the CLI.
  restorePersistedPermissions(sessionId, session).catch(err => {
    console.error(`[rc-handler] Failed to restore persisted permissions for ${sessionId}: ${err.message}`);
  });
}

/**
 * Restore persisted pending permissions from MongoDB into the in-memory
 * session. For each restored permission, re-create the blocking promise
 * and re-send the permission request to the phone.
 */
async function restorePersistedPermissions(sessionId, session) {
  const persisted = await rcStore.getPermissions(sessionId);
  const entries = Object.entries(persisted);
  if (entries.length === 0) return;

  for (const [toolUseId, data] of entries) {
    // Skip if already in memory (set during this session, not from a restart)
    if (session.pendingPermissions.has(toolUseId)) continue;

    const { toolName, toolArgs, description, requestId } = data;
    console.log(`[rc-handler] Restoring persisted permission: session=${sessionId} tool=${toolName} toolUseId=${toolUseId}`);

    // Re-send to phone
    sendToPhone(sessionId, createRcPermissionRequestMessage(
      sessionId, toolName || 'unknown', toolArgs || {}, toolUseId, description || null
    ));

    // Re-create blocking promise so phone approval resolves it
    const permissionPromise = new Promise((resolve, reject) => {
      session.pendingPermissions.set(toolUseId, { resolve, reject, timer: null, toolName, toolArgs, description, requestId });
    });
    permissionPromise.then(result => {
      rcStore.removePermission(sessionId, toolUseId).catch(() => {});
      const response = result.approved
        ? { behavior: 'allow', updatedInput: toolArgs || {}, toolUseID: toolUseId }
        : { behavior: 'deny', message: result.reason || 'User rejected', toolUseID: toolUseId };
      sendToDesktop(session.desktopWs, {
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response }
      });
      console.log(`[rc-handler] Restored permission resolved: ${response.behavior} requestId=${requestId} toolUseId=${toolUseId}`);
    }).catch(err => {
      rcStore.removePermission(sessionId, toolUseId).catch(() => {});
      sendToDesktop(session.desktopWs, {
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: err.message, toolUseID: toolUseId } }
      });
    });
  }
  console.log(`[rc-handler] Restored ${entries.length} persisted permission(s) for ${sessionId}`);
}

/**
 * Reset the session activity timer.
 * @param {string} sessionId
 */
function resetActivityTimer(sessionId) {
  const session = rcSessions.get(sessionId);
  if (!session) return;
  if (session.activityTimer) {
    clearTimeout(session.activityTimer);
  }
  session.activityTimer = setTimeout(() => {
    console.log(`[rc-handler] Session ${sessionId} timed out due to inactivity`);
    timeoutSession(sessionId);
  }, SESSION_TIMEOUT_MS);
}

/**
 * Mark a session as timed out. Keeps it in the store for revival but cleans up in-memory state.
 * Sends a user-visible rc_error AND rc_session_end so the phone tears down its
 * RC session state (buffers/threads). Without rc_session_end the phone keeps
 * the session alive indefinitely after the 12h timeout.
 * @param {string} sessionId
 */
async function timeoutSession(sessionId) {
  const session = rcSessions.get(sessionId);
  if (!session) return;

  console.log(`[rc-handler] Session ${sessionId} timed out -- marking inactive`);

  // Notify phone with a user-visible error message
  sendToPhone(sessionId, createRcErrorMessage(sessionId, 'Session timed out. Send a message to resume.', 'orchestrator')).catch(() => {});
  // Force phone-side cleanup of RC session state (buffers, threads). The phone's
  // rc_error handler only shows a banner; rc_session_end triggers full teardown.
  sendToPhone(sessionId, createRcSessionEndMessage(sessionId)).catch(() => {});

  // Close desktop WS (Claude Code process will exit)
  try { session.desktopWs.close(1000, 'timeout'); } catch {}

  // Mark as ended in store (keeps transcript for revival)
  await rcStore.end(sessionId).catch(() => {});

  // Clean up in-memory state
  cleanupSession(sessionId, session);
}

/**
 * Clean up a session fully (maps, timers, pending permissions).
 * @param {string} sessionId
 * @param {Object} session
 */
function cleanupSession(sessionId, session) {
  if (!rcSessions.has(sessionId)) return;
  // Clear activity timer
  if (session.activityTimer) {
    clearTimeout(session.activityTimer);
    session.activityTimer = null;
  }
  // Clear turn timer
  if (session.turnTimer) {
    clearTimeout(session.turnTimer);
    session.turnTimer = null;
  }

  // Drain any pending phone messages and cancel their TTL timer.
  // These reference the (possibly-closed) phone WS via closure -- leaving
  // them parked here would keep dead sockets reachable from the GC root.
  const pending = pendingPhoneMessages.get(sessionId);
  if (pending) {
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    pendingPhoneMessages.delete(sessionId);
    if (pending.items.length > 0) {
      console.log(`[rc-handler] Dropped ${pending.items.length} pending phone message(s) on cleanup of session ${sessionId}`);
    }
  }

  // Reject all pending permissions
  for (const [requestId, pending] of session.pendingPermissions) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Session ended'));
  }
  session.pendingPermissions.clear();

  // Clear replay state
  if (session.replayFlushTimer) {
    clearTimeout(session.replayFlushTimer);
    session.replayFlushTimer = null;
  }
  session.replayInProgress = false;
  session.replayPhoneBuffer = null;

  // Stop the in-flight tool heartbeat to prevent a timer leak.
  stopToolHeartbeat(session);
  if (session.agentMeta) {
    session.agentMeta.clear();
  }

  // Remove from maps
  desktopToSession.delete(session.desktopWs);
  rcSessions.delete(sessionId);
}

/**
 * Handle a new remote control WebSocket connection from desktop Claude Code.
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} request
 */
export async function handleRemoteControlConnection(ws, request) {
  // Validate auth
  const apiKey = request.headers['x-api-key']
    || (request.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
    || '';
  if (!apiKey || apiKey !== config.apiKey) {
    console.log('[rc-handler] Rejected desktop connection: invalid API key');
    ws.close(4401, 'unauthorized');
    return;
  }

  // Extract or generate session ID
  const url = new URL(request.url, `http://${request.headers.host}`);
  const sessionId = url.searchParams.get('session') || crypto.randomUUID();
  let workDir = url.searchParams.get('workDir') || null;

  // The bundled `claude` CLI does not append a workDir query param to its
  // --sdk-url -- it just connects to whatever URL the gateway gave it. The
  // gateway's POST /api/v1/remote-sessions/start, however, has already
  // persisted (sessionId, workDir) into rcStore before spawning the CLI.
  // If we don't recover workDir here, the rc_session_start message we send
  // to the phone has workDir=null -> ChatsListFragment.activeFolders() drops
  // the session and no folder chip ever appears.
  if (!workDir && rcStore) {
    try {
      const stored = await rcStore.get(sessionId);
      if (stored && stored.workDir) {
        workDir = stored.workDir;
      }
    } catch (err) {
      console.error(`[rc-handler] Failed to look up workDir for ${sessionId}: ${err.message}`);
    }
  }

  // Preload existing session data so we can restore title + permissionMode on reattach.
  let preloadedTitleSet = false;
  let storedPermissionMode = null;
  try {
    const stored = await rcStore.get(sessionId);
    if (stored) {
      if (stored.title && String(stored.title).trim().length > 0) {
        preloadedTitleSet = true;
      }
      if (stored.permissionMode) {
        storedPermissionMode = stored.permissionMode;
      }
    }
  } catch (_) {}

  console.log(`[rc-handler] Desktop connected, sessionId=${sessionId}, workDir=${workDir}`);

  // Desktop WS has connected -- clear the respawn dedup guard so a future
  // respawn (if this CLI dies again) isn't blocked by a stale guard.
  clearRespawnGuard(sessionId);

  // Check for existing session (reconnect case)
  const existing = rcSessions.get(sessionId);
  if (existing) {
    console.log(`[rc-handler] Desktop reconnecting to existing session ${sessionId}`);
    // Close the old WS to kill the stale CLI process. Without this, multiple
    // CLIs accumulate for the same session after rapid respawns.
    try { existing.desktopWs.close(1000, 'replaced'); } catch {}
    desktopToSession.delete(existing.desktopWs);
    // Clear stale turn timer from the old WS before replacing it. The WS
    // identity check in the timer callback is the primary guard, but clearing
    // here avoids a spurious log when the timer fires and sees a different WS.
    if (existing.turnTimer) {
      clearTimeout(existing.turnTimer);
      existing.turnTimer = null;
    }
    existing.thinkingStartedAt = null;
    existing.desktopWs = ws;
    existing.lastAssistantText = '';
    if (preloadedTitleSet) existing.titleSet = true;
    // Reconnect to existing in-memory session: the CLI will replay, so
    // enable the replay buffer to protect phone messages from being dropped.
    // IMPORTANT: preserve any already-buffered messages from prior reconnects
    // (multiple rapid reconnections can happen when respawn races).
    if (preloadedTitleSet) {
      existing.replayInProgress = true;
      if (!existing.replayPhoneBuffer) existing.replayPhoneBuffer = [];
      if (existing.replayFlushTimer) clearTimeout(existing.replayFlushTimer);
      existing.replayFlushTimer = setTimeout(() => {
        endReplayMode(sessionId, existing);
      }, REPLAY_FLUSH_TIMEOUT_MS);
    }
    desktopToSession.set(ws, sessionId);
    resetActivityTimer(sessionId);
  } else {
    // Create new session
    const preregisteredMode = pendingSessionModes.get(sessionId);
    if (preregisteredMode) pendingSessionModes.delete(sessionId);
    const sessionMode = preregisteredMode || storedPermissionMode || DEFAULT_ORCHESTRATOR_MODE;
    const session = {
      desktopWs: ws,
      phoneDeviceId: null,
      workDir: workDir || null,
      permissionMode: sessionMode,
      pendingPermissions: new Map(),
      createdAt: new Date(),
      activityTimer: null,
      lineBuffer: '',
      titleSet: preloadedTitleSet,
      // Bounded LRU of recently-persisted user-text hashes so we can
      // deduplicate the Claude-Code `--replay-user-messages` echoes (which
      // also fire after `--resume` and replay the entire prior history).
      recentUserTextHashes: [],
      contextPct: 0,
      thinkingStartedAt: null,
      turnTimer: null,
      // Replay-awareness: when a CLI (re)connects for a session that already
      // has transcript data, it replays its conversation history before
      // accepting new input. Phone messages arriving during replay are
      // silently dropped by the CLI. Buffer them and flush after the first
      // 'result' event (marks end of replay) or a safety timeout.
      replayInProgress: preloadedTitleSet, // has history -> will replay
      replayPhoneBuffer: preloadedTitleSet ? [] : null,
      replayFlushTimer: null,
      // Accumulated assistant text for the current turn. Persisted as a
      // single transcript entry on 'result' instead of once per streaming
      // partial, so $slice:-1000 stops silently dropping older conversation
      // history in long / multi-device sessions.
      lastAssistantText: ''
    };
    rcSessions.set(sessionId, session);
    desktopToSession.set(ws, sessionId);

    // Arm safety timeout for replay buffer flush
    if (session.replayInProgress) {
      session.replayFlushTimer = setTimeout(() => {
        endReplayMode(sessionId, session);
      }, REPLAY_FLUSH_TIMEOUT_MS);
    }

    // Persist to store (fire and forget)
    rcStore.create(sessionId, workDir, sessionMode).catch(err => {
      console.error(`[rc-handler] Failed to persist session: ${err.message}`);
    });

    // Seed the user-text dedup LRU from existing transcript so CLI replay
    // of already-persisted messages doesn't create duplicates.
    if (preloadedTitleSet) {
      rcStore.getTranscript(sessionId).then(transcript => {
        const s = rcSessions.get(sessionId);
        if (!s) return;
        for (const entry of transcript) {
          if (entry.type === 'user_message' && entry.data?.text) {
            const h = userTextHash(entry.data.text);
            if (!s.recentUserTextHashes.includes(h)) {
              s.recentUserTextHashes.push(h);
              if (s.recentUserTextHashes.length > USER_TEXT_HASH_LRU_SIZE) {
                s.recentUserTextHashes.shift();
              }
            }
          }
        }
        if (s.recentUserTextHashes.length > 0) {
          console.log(`[rc-handler] Seeded user-text dedup LRU with ${s.recentUserTextHashes.length} hashes for session ${sessionId}`);
        }
      }).catch(() => {});
    }

    resetActivityTimer(sessionId);
  }

  // Replay any phone messages that arrived before the desktop attached.
  drainPendingPhoneMessages(sessionId);

  // Notify all connected phone devices about the new session
  const startMsg = createRcSessionStartMessage(sessionId, workDir);
  const phone = findPhoneWs();
  if (phone) {
    const session = rcSessions.get(sessionId);
    if (session) session.phoneDeviceId = phone.deviceId;
    try {
      const payload = serializeMessage(startMsg).replace(/\0/g, '');
      phone.ws.send(payload);
    } catch (err) {
      console.error(`[rc-handler] Failed to send session_start to phone: ${err.message}`);
    }
  }
  console.log(`[rc-handler] Sent rc_session_start to phone, phoneConnected=${!!phone}`);

  // Desktop WS ping/pong heartbeat -- detects half-open connections where
  // the CLI process is gone but TCP hasn't torn down (network partition,
  // OS socket leak). Similar to the agent registry ping in registry.js.
  ws._rcAlive = true;
  ws.on('pong', () => { ws._rcAlive = true; });
  const pingInterval = setInterval(() => {
    if (!ws._rcAlive) {
      console.log(`[rc-handler] Desktop WS pong timeout for session ${sessionId} -- closing dead connection`);
      clearInterval(pingInterval);
      ws.terminate();
      return;
    }
    ws._rcAlive = false;
    try { ws.ping(); } catch { clearInterval(pingInterval); }
  }, RC_DESKTOP_PING_INTERVAL_MS);

  // Set up message handler for desktop NDJSON
  ws.on('message', (raw) => {
    const session = rcSessions.get(sessionId);
    if (!session) return;

    // Don't reset activity timer on desktop messages -- only user interaction counts
    const rawStr = raw.toString();
    // Handle NDJSON: buffer partial lines across frames
    const buffer = session.lineBuffer + rawStr;
    const lines = buffer.split('\n');
    // Last element may be incomplete line
    session.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        console.error(`[rc-handler] Failed to parse NDJSON line: ${err.message} line=${trimmed.substring(0, 100)}`);
        continue;
      }

      processDesktopMessage(sessionId, session, parsed);
    }
  });

  // Desktop disconnect.
  //
  // CRITICAL: A desktop WS close does NOT mean the user wants the session
  // terminated. The pc-agent's bun CLI process is long-lived (--print
  // --sdk-url stays alive across many turns); the WS may drop transiently
  // if the orchestrator restarts (auto-deploy on git push), the network
  // hiccups, or pc-agent reconnects. In all of those cases the CLI process
  // is still alive and ready to resume on reattach.
  //
  // Previously we called rcStore.end() and sent rc_session_end to the phone
  // here, which permanently marked the session "ended" in the store -- so
  // every reload by the phone saw status="ended", chips disappeared, and
  // the user perceived "session exited immediately after one prompt".
  //
  // The correct lifetime contract is:
  //   - Active session ends ONLY via 12h idle timeout (timeoutSession) or
  //     explicit user termination (endSession via DELETE).
  //   - Desktop WS close = drop in-memory state but keep store status
  //     "active" so the phone keeps showing the session and a fresh
  //     attach picks up where we left off.
  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log(`[rc-handler] Desktop disconnected, sessionId=${sessionId} -- keeping session active in store for reattach`);
    const session = rcSessions.get(sessionId);
    if (!session) return;
    // If the session has already reconnected with a new WS, this close event
    // is from the old orphaned connection -- ignore it so we don't destroy
    // the live session.
    if (session.desktopWs !== ws) return;
    // CLI process exited unexpectedly mid-turn: tell the phone to drop the
    // thinking indicator so the UI doesn't get stuck.
    emitThinkingEnd(sessionId, session);
    cleanupSession(sessionId, session);
  });

  ws.on('error', (err) => {
    clearInterval(pingInterval);
    console.error(`[rc-handler] Desktop WS error for session ${sessionId}: ${err.message} -- keeping session active for reattach`);
    const session = rcSessions.get(sessionId);
    if (!session) return;
    if (session.desktopWs !== ws) return;
    emitThinkingEnd(sessionId, session);
    cleanupSession(sessionId, session);
  });
}

/**
 * Process a single parsed NDJSON message from desktop Claude Code.
 * @param {string} sessionId
 * @param {Object} session
 * @param {Object} parsed
 */
function processDesktopMessage(sessionId, session, parsed) {
  const type = parsed.type;
  // During replay, the CLI re-emits its full conversation history. The
  // transcript already has these entries from the original processing.
  // Skip persistence to avoid N-fold duplication per restart.
  const shouldPersist = !session.replayInProgress;
  if (type !== 'keep_alive') {
    console.log(`[rc-handler] Desktop msg type=${type} keys=${Object.keys(parsed).join(',')}`);
  }

  // Tier A: real-time sub-agent progress.
  // Claude Code's queryHelpers yields nested sub-agent assistant/user messages
  // with parent_tool_use_id set to the parent AgentTool's tool_use_id. We
  // accumulate tool_uses and tokens against that parent and debounce-emit
  // rc_tool_status updates so the phone shows live counts during Calling.
  // Intercept BEFORE parent-level handlers so sub-agent activity doesn't get
  // rendered as parent tool calls in the chat.
  const parentToolUseId = parsed.parent_tool_use_id || null;
  if (parentToolUseId && session.agentMeta && session.agentMeta.has(parentToolUseId)) {
    handleSubagentProgress(sessionId, session, parentToolUseId, parsed);
    return;
  }

  // keep_alive -- ignore or respond
  if (type === 'keep_alive') {
    sendToDesktop(session.desktopWs, { type: 'keep_alive' });
    return;
  }

  // Control requests from Claude Code: { type: "control_request", request_id: "...", request: { subtype: "can_use_tool", ... } }
  // Subtype may be at parsed.subtype (flat) or parsed.request.subtype (nested)
  if (type === 'control_request') {
    const request = parsed.request || parsed;
    const subtype = request.subtype || parsed.subtype;

    if (subtype === 'can_use_tool') {
      handlePermissionRequest(sessionId, session, { ...request, request_id: parsed.request_id || request.request_id });
      return;
    }

    if (subtype === 'set_permission_mode') {
      const newMode = request.mode || parsed.mode || DEFAULT_ORCHESTRATOR_MODE;
      session.permissionMode = newMode;
      rcStore.updatePermissionMode(sessionId, newMode).catch(() => {});
      sendToPhone(sessionId, createRcModeChangeMessage(sessionId, newMode));
      return;
    }

    console.log(`[rc-handler] Unhandled control_request subtype: ${subtype}`);
    return;
  }

  // System messages (hooks, init) -- silently ignore
  if (type === 'system') {
    return;
  }

  // User messages from Claude Code stream-json. With --replay-user-messages
  // (set by orchestratorRcMain), the user's PC-terminal prompt is echoed
  // back as {type:'user', message:{role:'user', content: <string | blocks>}}.
  // Without that flag, only tool_result blocks come through. Handle both:
  // capture user text for titling/transcript AND walk tool_result blocks.
  if (type === 'user') {
    const userContent = parsed.message?.content || parsed.content;
    let userText = '';
    if (typeof userContent === 'string') {
      userText = userContent.trim();
    } else if (Array.isArray(userContent)) {
      const parts = [];
      for (const block of userContent) {
        if (typeof block === 'string') {
          parts.push(block);
        } else if (block && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      userText = parts.join('\n').trim();
    }
    if (userText.length > 0) {
      if (!session.titleSet) {
        session.titleSet = true;
        rcStore.updateTitle(sessionId, userText.substring(0, 80)).catch(() => {});
        console.log(`[rc-handler] Title set from user message replay: session=${sessionId}`);
      }
      // During replay, skip persistence entirely -- transcript already has
      // these entries. Also dedup by hash as a safety net for non-replay
      // --replay-user-messages echoes.
      if (shouldPersist && shouldPersistUserText(session, userText)) {
        rcStore.appendTranscript(sessionId, {
          ts: new Date().toISOString(),
          type: 'user_message',
          data: { text: userText, source: 'desktop' }
        }).catch(() => {});
      }
    }
    if (Array.isArray(userContent)) {
      for (const block of userContent) {
        if (block.type === 'tool_result') {
          const toolUseId = block.tool_use_id;
          const toolName = session.toolUseIdToName?.get(toolUseId) || 'unknown';
          if (toolUseId) session.toolUseIdToName?.delete(toolUseId);
          const storedArgs = session.lastToolArgs?.get(toolUseId) || null;
          if (storedArgs) session.lastToolArgs.delete(toolUseId);
          const resultContent = typeof block.content === 'string'
            ? block.content.substring(0, 2000)
            : Array.isArray(block.content)
              ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n').substring(0, 2000)
              : null;
          // Stamp BEFORE clearing in-flight state: trackToolEnd may reset the
          // seq counters, and a 'complete' stamped with a lower seq than the
          // heartbeats that preceded it would be dropped by the phone's
          // out-of-order guard.
          const completeMsg = stampToolSeq(session, createRcToolStatusMessage(
            sessionId, toolName, 'complete', storedArgs, resultContent, toolUseId
          ));
          trackToolEnd(session, toolUseId);
          // Re-attach agent metadata so the phone preserves the Agent label
          // on the completion event (toolName="Task" alone isn't enough).
          const agentMeta = toolUseId && session.agentMeta ? session.agentMeta.get(toolUseId) : null;
          if (agentMeta) {
            completeMsg.isAgent = true;
            if (agentMeta.agentName) completeMsg.agentName = agentMeta.agentName;
            if (agentMeta.agentTask) completeMsg.agentTask = agentMeta.agentTask;
            // Tier B agent stats: AgentTool emits a trailing
            //   <usage>total_tokens: N\ntool_uses: N\nduration_ms: N</usage>
            // block in the tool_result text. Parse it for the phone UI.
            const stats = parseAgentUsage(resultContent);
            if (stats) {
              if (stats.tokens != null) completeMsg.agentTokens = stats.tokens;
              if (stats.toolUses != null) completeMsg.agentToolCount = stats.toolUses;
              completeMsg.agentElapsedMs = stats.durationMs != null
                ? stats.durationMs
                : (agentMeta.startedAt ? (Date.now() - agentMeta.startedAt) : null);
            } else if (agentMeta.startedAt) {
              completeMsg.agentElapsedMs = Date.now() - agentMeta.startedAt;
            }
            // Tier A fallback: if <usage> was absent (or partial), prefer
            // the live-accumulated counts so the Complete row never shows
            // 0 tools / 0 tokens just because the trailer wasn't emitted.
            if (completeMsg.agentTokens == null && agentMeta.liveTokens != null && agentMeta.liveTokens > 0) {
              completeMsg.agentTokens = agentMeta.liveTokens;
            }
            if (completeMsg.agentToolCount == null && agentMeta.liveToolCount != null && agentMeta.liveToolCount > 0) {
              completeMsg.agentToolCount = agentMeta.liveToolCount;
            }
            session.agentMeta.delete(toolUseId);
          }
          sendToPhone(sessionId, completeMsg, shouldPersist);
        }
      }
    }
    return;
  }

  // Rate limit events -- silently ignore
  if (type === 'rate_limit_event') {
    return;
  }

  // Assistant text content
  // stream-json wraps content in message.content, legacy uses top-level content
  const contentBlocks = parsed.content
    || parsed.message?.content
    || null;
  if (type === 'assistant' && contentBlocks) {
    // Emit a thinking marker as soon as ANY assistant event arrives for the
    // turn -- including tool_use-only events that precede text streaming.
    // emitThinking is idempotent (guarded by session.thinkingStartedAt) so
    // calling it here only stamps the start-time the first time per turn.
    // Without this, a tool-using turn (e.g. Agent dispatch) leaves the phone
    // stuck on "Sending..." for the full tool-execution duration.
    emitThinking(sessionId, session, '');
    // Update contextPct from any intermediate usage info so subsequent
    // partial messages carry a fresh value.
    const interimUsage = parsed.message?.usage || parsed.usage || null;
    if (interimUsage) {
      // Per-API-call usage on assistant events reflects the prefix sent to the
      // model on that single call (cache_read + cache_creation + new input)
      // -- this IS the current context-window occupancy, so use it directly.
      const inputTokens = interimUsage.input_tokens || 0;
      const cacheCreation = interimUsage.cache_creation_input_tokens || 0;
      const cacheRead = interimUsage.cache_read_input_tokens || 0;
      const contextTokens = inputTokens + cacheCreation + cacheRead;
      const modelUsage = parsed.modelUsage || parsed.model_usage || {};
      const firstModelKey = Object.keys(modelUsage)[0];
      const contextWindow = firstModelKey
        ? (modelUsage[firstModelKey].contextWindow || modelUsage[firstModelKey].context_window || 1000000)
        : 1000000;
      if (contextTokens > 0) {
        session.contextPct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
      }
    }
    const blocks = Array.isArray(contentBlocks) ? contentBlocks : [contentBlocks];
    // Only tool-bearing frames are logged. A tool_use that never produces an
    // rc_tool_status is otherwise indistinguishable from one that never
    // arrived -- the two look identical from the phone -- but logging every
    // text frame too buried that signal in streaming chatter.
    if (blocks.some(b => b && typeof b === 'object' && b.type === 'tool_use')) {
      console.log(`[rc-handler] assistant blocks: ${blocks
        .map(b => (typeof b === 'string' ? 'string' : b?.type || 'unknown'))
        .join(',')}`);
    }
    const textParts = [];
    for (const block of blocks) {
      if (typeof block === 'string') {
        textParts.push(block);
      } else if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'thinking' && (block.thinking || block.text)) {
        // Anthropic thinking blocks carry the text in `thinking`, not `text`.
        emitThinking(sessionId, session, block.thinking || block.text);
      } else if (block.type === 'tool_use') {
        if (!session.lastToolArgs) session.lastToolArgs = new Map();
        if (!session.toolUseIdToName) session.toolUseIdToName = new Map();
        if (!session.agentMeta) session.agentMeta = new Map();
        session.lastToolArgs.set(block.id || block.name || 'unknown', block.input || null);
        if (block.id) session.toolUseIdToName.set(block.id, block.name || 'unknown');
        const statusMsg = stampToolSeq(session, createRcToolStatusMessage(
          sessionId,
          block.name || 'unknown',
          'calling',
          block.input || null,
          null,
          block.id || null
        ));
        const { isAgent, agentName, agentTask } = describeAgentDispatch(block);
        if (isAgent) {
          statusMsg.isAgent = true;
          if (agentName) statusMsg.agentName = agentName;
          if (agentTask) statusMsg.agentTask = agentTask;
          if (block.id) {
            session.agentMeta.set(block.id, {
              toolName: block.name || 'Task',
              agentName,
              agentTask,
              startedAt: Date.now(),
              _prevTokens: 0,
              _prevToolCount: 0
            });
          }
        }
        // Every tool -- agent or not -- goes into the in-flight set so the
        // phone gets 'running' heartbeats for anything slow (TaskOutput can
        // block for minutes with no intermediate CLI event of its own).
        trackToolStart(sessionId, session, block.id, block.name || 'unknown', block.input || null);
        if (session.contextPct > 0) statusMsg.contextPct = session.contextPct;
        sendToPhone(sessionId, statusMsg, false);
      }
    }
    if (textParts.length > 0) {
      const text = textParts.join('');
      // Claude Code's stream-json text events are cumulative snapshots (each
      // carries the full response so far), so track the latest as the turn's
      // final text. Persisted once on 'result' rather than per-partial.
      session.lastAssistantText = text;
      // Fallback titling: Claude Code's stream-json does NOT echo back the
      // user's PC-terminal input as a `type:'user'` text block, so the
      // RC_USER_MESSAGE / desktop-user-text paths above never fire for
      // sessions started by typing at the PC. Use the first assistant text
      // as a last-resort title so the phone stops showing the workDir
      // basename (e.g. "user" for /home/user).
      if (!session.titleSet && text.trim().length > 0) {
        session.titleSet = true;
        rcStore.updateTitle(sessionId, text.trim().substring(0, 80)).catch(() => {});
        console.log(`[rc-handler] Title set from first assistant text: session=${sessionId}`);
      }
      const partialMsg = createRcMessage(sessionId, text, false);
      if (session.contextPct > 0) partialMsg.contextPct = session.contextPct;
      // Streaming partials are live-only (never persisted): one entry per
      // stream token would blow past the transcript $slice cap and drop
      // earlier turns. The consolidated final text is persisted on 'result'.
      sendToPhone(sessionId, partialMsg, false);
    }
    return;
  }

  // Thinking content (top-level)
  if (type === 'thinking' || (parsed.thinking && typeof parsed.thinking === 'string')) {
    const thinkingText = parsed.text || parsed.thinking || '';
    if (thinkingText) {
      emitThinking(sessionId, session, thinkingText);
    }
    return;
  }

  // Tool use (top-level)
  if (type === 'tool_use') {
    if (!session.lastToolArgs) session.lastToolArgs = new Map();
    session.lastToolArgs.set(parsed.id || parsed.name || 'unknown', parsed.input || null);
    trackToolStart(sessionId, session, parsed.id, parsed.name || 'unknown', parsed.input || null);
    sendToPhone(sessionId, stampToolSeq(session, createRcToolStatusMessage(
      sessionId,
      parsed.name || 'unknown',
      'calling',
      parsed.input || null,
      null,
      parsed.id || null
    )), false);
    return;
  }

  // Tool result (top-level)
  if (type === 'tool_result') {
    const toolName = parsed.tool_name || parsed.name || 'unknown';
    const topLevelToolUseId = parsed.tool_use_id || null;
    const storedArgs = session.lastToolArgs?.get(topLevelToolUseId || toolName) || null;
    console.log(`[rc-handler] tool_result: tool=${toolName} toolUseId=${topLevelToolUseId} hasStoredArgs=${!!storedArgs} lastToolArgsKeys=${session.lastToolArgs ? [...session.lastToolArgs.keys()].join(',') : 'none'}`);
    if (storedArgs) session.lastToolArgs.delete(topLevelToolUseId || toolName);
    // Stamp before clearing in-flight state (see the tool_result branch above).
    const topLevelComplete = stampToolSeq(session, createRcToolStatusMessage(
      sessionId,
      toolName,
      'complete',
      storedArgs,
      typeof parsed.content === 'string' ? parsed.content.substring(0, 2000) : null,
      topLevelToolUseId
    ));
    trackToolEnd(session, topLevelToolUseId);
    sendToPhone(sessionId, topLevelComplete);
    return;
  }

  // Final result -- extract context usage and mark the last message as final
  if (type === 'result') {
    // A 'result' event means the CLI finished processing a turn. If the
    // session was in replay mode (CLI reconnected and was replaying its
    // conversation history), this marks the end of replay -- flush any
    // buffered phone messages so the CLI picks them up as new input.
    if (session.replayInProgress) {
      endReplayMode(sessionId, session);
    }
    const usage = parsed.usage || null;
    if (usage) {
      // result.usage is the cumulative accumulator across every API call in the
      // session (totalUsage in QueryEngine). Adding cache_read across calls
      // double-counts the cached prefix, so it cannot be used as "context fill".
      // Use the LAST iteration -- it carries the prefix size of the final call,
      // which IS the current context-window occupancy. Fall back to the
      // accumulator only if iterations are missing.
      const iterations = Array.isArray(usage.iterations) ? usage.iterations : null;
      const last = iterations && iterations.length > 0 ? iterations[iterations.length - 1] : usage;
      const inputTokens = last.input_tokens || 0;
      const cacheCreation = last.cache_creation_input_tokens || 0;
      const cacheRead = last.cache_read_input_tokens || 0;
      const contextTokens = inputTokens + cacheCreation + cacheRead;
      // Extract actual context window from modelUsage (sent by Claude Code SDK)
      const modelUsage = parsed.modelUsage || parsed.model_usage || {};
      const firstModelKey = Object.keys(modelUsage)[0];
      const contextWindow = firstModelKey
        ? (modelUsage[firstModelKey].contextWindow || modelUsage[firstModelKey].context_window || 1000000)
        : 1000000;
      session.contextPct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
    }
    const totalCost = parsed.total_cost_usd || null;
    // End the thinking turn before sending the final message so the phone
    // can clear the indicator and stamp "Thought for Xs" on the bubble.
    emitThinkingEnd(sessionId, session);
    // Persist the turn's full assistant text as a SINGLE transcript entry.
    // Streaming partials were sent live but not persisted, so this is the
    // only place the assistant text enters the transcript -- keeping the
    // transcript compact enough that $slice:-1000 won't drop older turns.
    // Persist directly (not via sendToPhone) so the phone isn't sent a
    // duplicate of text it already rendered live.
    if (shouldPersist && session.lastAssistantText) {
      const finalTextMsg = createRcMessage(sessionId, session.lastAssistantText, true);
      if (session.contextPct > 0) finalTextMsg.contextPct = session.contextPct;
      if (totalCost !== null) finalTextMsg.costUsd = Math.round(totalCost * 10000) / 10000;
      rcStore.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        type: finalTextMsg.type,
        data: finalTextMsg
      }).catch(() => {});
    }
    session.lastAssistantText = '';
    // Live final marker for the phone UI (clears the thinking indicator,
    // stamps cost/context). Not persisted -- the text entry above covers it.
    const msg = createRcMessage(sessionId, '', true);
    if (session.contextPct > 0) msg.contextPct = session.contextPct;
    if (totalCost !== null) msg.costUsd = Math.round(totalCost * 10000) / 10000;
    sendToPhone(sessionId, msg, false);
    return;
  }

  // User input request from Claude Code
  if (type === 'user_input_request') {
    const requestId = parsed.request_id || crypto.randomUUID();
    sendToPhone(sessionId, {
      type: MSG_TYPE.RC_USER_INPUT,
      sessionId,
      prompt: parsed.prompt || 'Claude Code is asking for input',
      requestId
    }, shouldPersist);
    return;
  }

  // Error from Claude Code
  if (type === 'error' || type === 'system_error') {
    const errorText = parsed.error || parsed.message || parsed.text || 'Unknown error';
    const source = parsed.source || 'claude';
    sendToPhone(sessionId, createRcErrorMessage(sessionId, errorText, source), shouldPersist);
    return;
  }

  // control_response -- CLI ack for control_request (mode change, etc.)
  // Benign; no action needed beyond logging.
  if (type === 'control_response') {
    return;
  }

  // Unhandled -- log for debugging
  if (type) {
    console.log(`[rc-handler] Unhandled desktop message type: ${type}`);
  }
}

/**
 * Handle a permission request from desktop Claude Code.
 * Creates a promise that blocks until phone responds or timeout.
 * @param {string} sessionId
 * @param {Object} session
 * @param {Object} parsed
 */
function handlePermissionRequest(sessionId, session, parsed) {
  const toolName = parsed.tool_name || parsed.tool?.name || 'unknown';
  const toolArgs = parsed.input || parsed.tool?.input || {};
  const toolUseId = parsed.tool_use_id || crypto.randomUUID();
  // Store toolArgs so tool_result can forward them to the phone
  if (!session.lastToolArgs) session.lastToolArgs = new Map();
  session.lastToolArgs.set(toolUseId, toolArgs);
  // The outer request_id is what Claude's pendingRequests map uses to resolve
  const requestId = parsed.request_id || toolUseId;
  const description = parsed.description || null;

  console.log(`[rc-handler] Permission request: tool=${toolName} toolUseId=${toolUseId} requestId=${requestId}`);

  // Auto-approve EnterPlanMode -- no user permission needed
  if (toolName === 'EnterPlanMode') {
    console.log(`[rc-handler] Auto-approving EnterPlanMode for session ${sessionId}`);
    sendToDesktop(session.desktopWs, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput: toolArgs || {}, toolUseID: toolUseId }
      }
    });
    return;
  }

  // AskUserQuestion -- send as permission request with structured options in toolArgs
  // Phone detects toolName="AskUserQuestion" and renders option buttons
  if (toolName === 'AskUserQuestion') {
    // Format description with question text for display
    const questions = toolArgs?.questions || [];
    const questionDesc = questions.map(q => q.question || '').filter(Boolean).join('\n') || description || '';

    sendToPhone(sessionId, createRcPermissionRequestMessage(
      sessionId, toolName, toolArgs, toolUseId, questionDesc
    ));

    rcStore.persistPermission(sessionId, toolUseId, { toolName, toolArgs, description: questionDesc, requestId }).catch(err => {
      console.error(`[rc-handler] Failed to persist AskUserQuestion permission: ${err.message}`);
    });

    const permissionPromise = new Promise((resolve, reject) => {
      session.pendingPermissions.set(toolUseId, { resolve, reject, timer: null, toolName, toolArgs, description: questionDesc, requestId });
    });
    permissionPromise.then(result => {
      rcStore.removePermission(sessionId, toolUseId).catch(() => {});
      if (result.approved) {
        // Build answers map: "question text" -> "selected option"
        const answerParts = (result.reason || '').split(', ');
        const answers = {};
        for (let i = 0; i < questions.length; i++) {
          const qText = questions[i]?.question || `q${i}`;
          answers[qText] = answerParts[i] || answerParts[0] || '';
        }
        // If only one answer and multiple questions, apply it to all
        if (answerParts.length === 1 && questions.length > 1) {
          for (const q of questions) {
            answers[q.question] = answerParts[0];
          }
        }
        const updatedInput = { ...toolArgs, answers };
        console.log(`[rc-handler] AskUserQuestion answered: ${JSON.stringify(answers)}`);
        sendToDesktop(session.desktopWs, {
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput, toolUseID: toolUseId } }
        });
      } else {
        sendToDesktop(session.desktopWs, {
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: result.reason || 'User dismissed', toolUseID: toolUseId } }
        });
      }
    }).catch(() => {});
    return;
  }

  // Auto-approve based on session permission mode
  const mode = session.permissionMode;
  if (mode === 'bypassAll') {
    console.log(`[rc-handler] Auto-approving (bypassAll): tool=${toolName} requestId=${requestId}`);
    sendToPhone(sessionId, createRcToolStatusMessage(sessionId, toolName, 'auto-approved', toolArgs, null, toolUseId));
    sendToDesktop(session.desktopWs, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput: toolArgs || {}, toolUseID: toolUseId }
      }
    });
    return;
  }
  if (mode === 'acceptEdits' && (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit')) {
    console.log(`[rc-handler] Auto-approving (acceptEdits): tool=${toolName} requestId=${requestId}`);
    sendToPhone(sessionId, createRcToolStatusMessage(sessionId, toolName, 'auto-approved', toolArgs, null, toolUseId));
    sendToDesktop(session.desktopWs, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput: toolArgs || {}, toolUseID: toolUseId }
      }
    });
    return;
  }

  // Send permission request to phone
  sendToPhone(sessionId, createRcPermissionRequestMessage(
    sessionId, toolName, toolArgs, toolUseId, description
  ));

  // Persist to MongoDB so it survives orchestrator restarts
  rcStore.persistPermission(sessionId, toolUseId, { toolName, toolArgs, description, requestId }).catch(err => {
    console.error(`[rc-handler] Failed to persist permission: ${err.message}`);
  });

  // Create blocking promise -- no timeout, user can approve/reject at any time
  const permissionPromise = new Promise((resolve, reject) => {
    session.pendingPermissions.set(toolUseId, { resolve, reject, timer: null, toolName, toolArgs, description, requestId });
  });

  // When resolved, send response back to desktop using the outer request_id
  // Claude SDK expects: { behavior: "allow", updatedInput: {}, toolUseID } or { behavior: "deny", message: "..." }
  permissionPromise.then(result => {
    // Remove from MongoDB now that it's resolved
    rcStore.removePermission(sessionId, toolUseId).catch(() => {});
    const response = result.approved
      ? { behavior: 'allow', updatedInput: toolArgs || {}, toolUseID: toolUseId }
      : { behavior: 'deny', message: result.reason || 'User rejected', toolUseID: toolUseId };
    sendToDesktop(session.desktopWs, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response
      }
    });
    console.log(`[rc-handler] Permission response sent to desktop: ${response.behavior} requestId=${requestId} toolUseId=${toolUseId}`);
  }).catch(err => {
    console.error(`[rc-handler] Permission promise error: ${err.message}`);
    rcStore.removePermission(sessionId, toolUseId).catch(() => {});
    sendToDesktop(session.desktopWs, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'deny', message: err.message, toolUseID: toolUseId }
      }
    });
  });
}

/**
 * Handle an RC-related message from the phone device.
 * Called from the device message handler in index.js.
 * @param {string} deviceId
 * @param {Object} envelope
 * @param {import('ws').WebSocket} ws
 */
export function handleRcPhoneMessage(deviceId, envelope, ws) {
  // Handle transcript requests for ended sessions (not in memory but in store)
  if (envelope.type === 'rc_transcript_request' && envelope.sessionId && !rcSessions.has(envelope.sessionId)) {
    const endedSessionId = envelope.sessionId;
    console.log(`[rc-handler] Transcript request for ended session ${endedSessionId}, fetching from store`);
    (async () => {
      try {
        // Session not in memory -> recover workDir from the store so the JSONL
        // spine (authoritative history for the last PC leg) can be merged in.
        const stored = await rcStore.get(endedSessionId).catch(() => null);
        const transcript = await buildCatchUpTranscript(endedSessionId, stored?.workDir || null);
        if (transcript.length > 0) {
          const catchUpMsg = createRcTranscriptMessage(endedSessionId, transcript);
          if (ws.readyState === 1) {
            const payload = serializeMessage(catchUpMsg).replace(/\0/g, '');
            ws.send(payload);
          }
        }
      } catch (err) {
        console.error(`[rc-handler] Failed to send transcript for ended session: ${err.message}`);
      }
    })();
    // Adopt-only: if the user has this conversation open in an interactive CLI
    // on the PC, attach to it so the phone shows it live. Never spawns; a no-op
    // when nothing is running. Independent of the transcript send above. The ws
    // is passed so that, once adopt resolves a workDir the store never had, the
    // catch-up transcript can be pushed to this same phone.
    maybeAdoptCli(endedSessionId, ws);
    return;
  }

  // Resolve target session. Rules:
  //  - If the envelope names a sessionId that exists, use it.
  //  - If the envelope names a sessionId that does NOT exist yet, queue the
  //    message: the desktop WS is still attaching and will drain the queue
  //    on connect. This beats the findSessionForDevice fallback -- we must
  //    NEVER route a message to a different session just because it was
  //    the only one active.
  //  - Only when the envelope has no sessionId at all do we fall back to
  //    per-device lookup (legacy callers).
  let sessionId = null;
  if (envelope.sessionId) {
    if (rcSessions.has(envelope.sessionId)) {
      sessionId = envelope.sessionId;
    } else {
      enqueuePhoneMessage(envelope.sessionId, deviceId, envelope, ws);
      console.log(`[rc-handler] Queued ${envelope.type} for pending session ${envelope.sessionId} from ${deviceId}`);

      // Persist user messages immediately so they survive even if the CLI
      // never attaches. The CLI replay path deduplicates via shouldPersistUserText.
      if (envelope.type === MSG_TYPE.RC_USER_MESSAGE && envelope.text) {
        rcStore.appendTranscript(envelope.sessionId, {
          ts: new Date().toISOString(),
          type: 'user_message',
          data: { text: envelope.text, source: 'phone' }
        }).catch(() => {});
      }

      // Ack the phone so it stops retrying and transitions from Sending to Thinking
      if (envelope.type === MSG_TYPE.RC_USER_MESSAGE && envelope.requestId && ws.readyState === 1) {
        try {
          ws.send(serializeMessage(createRcUserMessageAckMessage(envelope.sessionId, envelope.requestId)).replace(/\0/g, ''));
        } catch {}
      }

      // Auto-respawn path: if the session row is still active in the store
      // (CLI exited but session not user-terminated), ask pc-agent to spawn
      // a new CLI for it. The new desktop WS will hit
      // handleRemoteControlConnection, which calls drainPendingPhoneMessages
      // and replays the queued envelopes. No phone-side change needed.
      maybeRespawnCli(envelope.sessionId);
      return;
    }
  } else {
    sessionId = findSessionForDevice(deviceId);
  }
  if (!sessionId) {
    console.log(`[rc-handler] No active RC session for device ${deviceId}, ignoring ${envelope.type}`);
    return;
  }

  const session = rcSessions.get(sessionId);
  if (!session) return;

  resetActivityTimer(sessionId);

  if (envelope.type === MSG_TYPE.RC_PERMISSION_RESPONSE) {
    const requestId = envelope.requestId;
    const pending = session.pendingPermissions.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      session.pendingPermissions.delete(requestId);
      pending.resolve({
        approved: envelope.approved === true,
        modeChange: envelope.modeChange || null,
        reason: envelope.reason || null
      });
      console.log(`[rc-handler] Permission response from phone: ${envelope.approved ? 'approved' : 'denied'} for ${requestId}`);

      // Persist approval/rejection to transcript so phone can restore correct state on reopen
      rcStore.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        type: 'rc_permission_resolved',
        data: { requestId, toolName: pending.toolName, approved: envelope.approved === true }
      }).catch(() => {});

      // Handle mode change if included
      if (envelope.modeChange) {
        session.permissionMode = envelope.modeChange;
        rcStore.updatePermissionMode(sessionId, envelope.modeChange).catch(() => {});
      }
    } else {
      console.log(`[rc-handler] No pending permission for requestId=${requestId}`);
    }
    return;
  }

  if (envelope.type === MSG_TYPE.RC_USER_RESPONSE) {
    // Check if this is a response to AskUserQuestion (stored in pendingPermissions)
    const pending = session.pendingPermissions.get(envelope.requestId);
    if (pending && pending.toolName === 'AskUserQuestion') {
      console.log(`[rc-handler] AskUserQuestion response: requestId=${envelope.requestId} text=${(envelope.text || '').substring(0, 40)}`);
      pending.resolve({ approved: true, reason: envelope.text || '' });
      session.pendingPermissions.delete(envelope.requestId);
    } else {
      // Forward user text response to desktop as NDJSON
      sendToDesktop(session.desktopWs, {
        type: 'user_input_response',
        request_id: envelope.requestId,
        text: envelope.text || ''
      });
    }
    console.log(`[rc-handler] User response forwarded to desktop: requestId=${envelope.requestId}`);

    // Also persist to transcript
    rcStore.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      type: 'user_response',
      data: { requestId: envelope.requestId, text: envelope.text }
    }).catch(() => {});
    return;
  }

  if (envelope.type === MSG_TYPE.RC_USER_MESSAGE) {
    const text = envelope.text || '';
    const requestId = envelope.requestId || null;
    console.log(`[rc-handler] Proactive user message from phone: session=${sessionId} reqId=${requestId} text=${text.substring(0, 40)} replayInProgress=${!!session.replayInProgress}`);

    // Set title from first user message (more descriptive than assistant tool-calling preambles)
    if (!session.titleSet && text.length > 0) {
      session.titleSet = true;
      rcStore.updateTitle(sessionId, text.substring(0, 80)).catch(() => {});
    }

    // If the CLI is still replaying its conversation history after a
    // reconnect, buffer this message -- the CLI silently drops user input
    // during replay. The buffer is flushed when the first 'result' event
    // arrives (endReplayMode) or after REPLAY_FLUSH_TIMEOUT_MS.
    if (session.replayInProgress && session.replayPhoneBuffer) {
      // Dedup by requestId -- phone retries produce duplicates.
      if (!requestId || !session.replayPhoneBuffer.some(m => m.requestId === requestId)) {
        session.replayPhoneBuffer.push({ text, requestId });
      }
      console.log(`[rc-handler] Buffered phone message during replay: session=${sessionId} buffer=${session.replayPhoneBuffer.length}`);
      // Persist immediately so the message survives even if replay never completes
      if (text.length > 0 && shouldPersistUserText(session, text)) {
        rcStore.appendTranscript(sessionId, {
          ts: new Date().toISOString(),
          type: 'user_message',
          data: { text, source: 'phone' }
        }).catch(() => {});
      }
      // Still ack the phone so it stops retrying
      if (requestId) {
        sendToPhone(sessionId, createRcUserMessageAckMessage(sessionId, requestId), false).catch(() => {});
      }
      resetActivityTimer(sessionId);
      return;
    }

    // Persist user message immediately so it survives even if the CLI
    // never processes it (dead, hung, respawn failed). Phone messages are
    // always persisted -- the dedup LRU only applies to CLI replay echoes
    // (desktop-sourced) to prevent N-fold duplication on CLI restart.
    if (text.length > 0) {
      // Still record the hash so that when the CLI replays this message
      // back (desktop echo), the replay path skips persistence.
      shouldPersistUserText(session, text);
      rcStore.appendTranscript(sessionId, {
        ts: new Date().toISOString(),
        type: 'user_message',
        data: { text, source: 'phone' }
      }).catch(() => {});
    }

    // If there are pending permission requests, re-send them to the phone
    // so the user sees the approval dialog. This handles the case where
    // the permission arrived while the chat UI was closed -- the user
    // opens the chat, types a message, and needs to see the pending dialog.
    if (session.pendingPermissions.size > 0) {
      for (const [permReqId, pending] of session.pendingPermissions) {
        const rePromptMsg = createRcPermissionRequestMessage(
          sessionId,
          pending.toolName || 'unknown',
          pending.toolArgs || {},
          permReqId,
          pending.description || null
        );
        sendToPhone(sessionId, rePromptMsg, false).catch(() => {});
      }
      console.log(`[rc-handler] Re-sent ${session.pendingPermissions.size} pending permission(s) to phone on user message`);
    }

    // Send as NDJSON user message to desktop Claude Code.
    sendToDesktop(session.desktopWs, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    });

    // Ack the phone so its OrchestratorClient can stop the retry timer for
    // this requestId. Phone sends requestId on every rc_user_message; legacy
    // clients without one just don't get an ack and rely on transcript-echo
    // detection (the desktop replay path persists the message into the
    // transcript that phone reloads on resume).
    if (requestId) {
      sendToPhone(sessionId, createRcUserMessageAckMessage(sessionId, requestId), false).catch(() => {});
    }

    resetActivityTimer(sessionId);
    return;
  }

  if (envelope.type === MSG_TYPE.RC_MODE_CHANGE || envelope.type === 'rc_mode_change') {
    // Phone sends short names ("default", "acceptEdits"); normalize to
    // orchestrator canonical names ("ask_on_potentially_safe", "acceptAll").
    const mode = normalizeMode(envelope.mode);
    if (!mode) {
      console.log(`[rc-handler] Rejected rc_mode_change with unknown mode: ${envelope.mode}`);
      sendToPhone(sessionId, createRcErrorMessage(
        sessionId,
        'invalid_permission_mode',
        'orchestrator'
      )).catch(() => {});
      return;
    }
    session.permissionMode = mode;
    rcStore.updatePermissionMode(sessionId, mode).catch(() => {});
    // Forward to desktop/pc-agent boundary using CLI-name
    sendToDesktop(session.desktopWs, {
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'set_permission_mode', mode: toCliMode(mode) }
    });
    console.log(`[rc-handler] Mode change from phone: session=${sessionId} mode=${mode}`);
    return;
  }

  if (envelope.type === 'rc_transcript_request') {
    // Phone activity opened and needs catch-up (transcript + pending permissions)
    console.log(`[rc-handler] Transcript request from phone: session=${sessionId}`);
    (async () => {
      try {
        const transcript = await buildCatchUpTranscript(sessionId, session.workDir || null);
        if (transcript.length > 0) {
          const catchUpMsg = createRcTranscriptMessage(sessionId, transcript);
          if (ws.readyState === 1) {
            const payload = serializeMessage(catchUpMsg).replace(/\0/g, '');
            ws.send(payload);
          }
        }
      } catch (err) {
        console.error(`[rc-handler] Failed to send transcript on request: ${err.message}`);
      }
      // Re-send pending permission requests (in-memory + MongoDB fallback)
      const sentIds = new Set();
      for (const [requestId, pending] of session.pendingPermissions) {
        sentIds.add(requestId);
        const rePromptMsg = createRcPermissionRequestMessage(
          sessionId,
          pending.toolName || 'unknown',
          pending.toolArgs || {},
          requestId,
          pending.description || null
        );
        if (ws.readyState === 1) {
          try {
            ws.send(serializeMessage(rePromptMsg).replace(/\0/g, ''));
          } catch (err) {
            console.error(`[rc-handler] Failed to re-send permission request: ${err.message}`);
          }
        }
      }
      // Check MongoDB for permissions not yet restored to memory
      try {
        const persisted = await rcStore.getPermissions(sessionId);
        for (const [toolUseId, data] of Object.entries(persisted)) {
          if (sentIds.has(toolUseId)) continue;
          const msg = createRcPermissionRequestMessage(
            sessionId, data.toolName || 'unknown', data.toolArgs || {}, toolUseId, data.description || null
          );
          if (ws.readyState === 1) {
            try { ws.send(serializeMessage(msg).replace(/\0/g, '')); } catch {}
          }
        }
      } catch {}

      // Re-emit thinking state so phone can resume its timer
      if (session.thinkingStartedAt) {
        const thinkingMsg = createRcThinkingMessage(sessionId, '', session.thinkingStartedAt);
        if (ws.readyState === 1) {
          try { ws.send(serializeMessage(thinkingMsg).replace(/\0/g, '')); } catch {}
        }
      }
      // Re-emit running-tool rows so a phone that opened mid-turn sees the
      // in-flight tools now, not on the next heartbeat.
      replayInFlightTools(sessionId, session, ws);
    })();
    return;
  }

  if (envelope.type === 'rc_setting_change') {
    const { setting, value } = envelope;
    console.log(`[rc-handler] Setting change from phone: session=${sessionId} ${setting}=${value}`);
    // Forward as control_request to desktop
    sendToDesktop(session.desktopWs, {
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'set_' + setting, [setting]: value }
    });
    return;
  }

  if (envelope.type === 'rc_interrupt') {
    // Send interrupt control_request to desktop
    sendToDesktop(session.desktopWs, {
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' }
    });
    // Phone toggled the stop button -- clear thinking indicator immediately
    // so the UI doesn't sit there spinning while the CLI tears down.
    emitThinkingEnd(sessionId, session);
    console.log(`[rc-handler] Interrupt from phone: session=${sessionId}`);
    return;
  }

  console.log(`[rc-handler] Unhandled phone RC message type: ${envelope.type}`);
}

/**
 * Handle a revive request from the phone for an ended session.
 * Reactivates the session in the store and starts a new desktop process.
 * @param {string} deviceId
 * @param {Object} envelope
 * @param {import('ws').WebSocket} ws
 */
export async function handleRcRevive(deviceId, envelope, ws) {
  const sessionId = envelope.sessionId;
  const workDir = envelope.workDir || null;

  console.log(`[rc-handler] Revive request from phone: session=${sessionId} workDir=${workDir}`);

  // Reactivate in store
  try {
    await rcStore.reactivate(sessionId);
  } catch (err) {
    console.error(`[rc-handler] Failed to reactivate session in store: ${err.message}`);
  }

  // Notify phone that session is being revived (send session start)
  const startMsg = createRcSessionStartMessage(sessionId, workDir);
  if (ws.readyState === 1) {
    try {
      const payload = serializeMessage(startMsg).replace(/\0/g, '');
      ws.send(payload);
    } catch (err) {
      console.error(`[rc-handler] Failed to send session_start for revive: ${err.message}`);
    }
  }

  return { sessionId, workDir };
}

/**
 * Find the session ID associated with a device.
 * @param {string} deviceId
 * @returns {string|null}
 */
/**
 * If the session is active in the store but absent from rcSessions
 * (its CLI exited), ask pc-agent to spawn a new CLI for it. Dedup via
 * inFlightRespawns so concurrent phone messages don't multi-spawn.
 * @param {string} sessionId
 */
function maybeRespawnCli(sessionId) {
  if (!respawnCliFn) return;
  if (rcSessions.has(sessionId)) return;
  if (inFlightRespawns.has(sessionId)) return;

  // The dedup guard stays until the desktop WS actually connects (cleared by
  // handleRemoteControlConnection -> clearRespawnGuard) or a 120s ceiling
  // expires. This prevents the phone's retry loop from spawning extra CLIs
  // during the cold-start window (~10-30s + context resume time).
  const ceilingTimer = setTimeout(() => {
    clearRespawnGuard(sessionId);
  }, RESPAWN_CEILING_MS);

  const p = (async () => {
    try {
      const stored = await rcStore.get(sessionId);
      if (!stored || !stored.workDir) {
        console.log(`[rc-handler] Skip respawn for ${sessionId}: not found or no workDir`);
        expirePendingPhoneMessages(sessionId);
        clearRespawnGuard(sessionId);
        return;
      }
      // Session ended (12h timeout or explicit termination) but phone still
      // has it -- reactivate so the CLI can attach. This mirrors what
      // handleRcRevive does for the explicit revive RPC.
      if (stored.status === 'ended') {
        console.log(`[rc-handler] Reactivating ended session ${sessionId} for respawn`);
        await rcStore.reactivate(sessionId);
      } else if (stored.status !== 'active') {
        console.log(`[rc-handler] Skip respawn for ${sessionId}: status=${stored.status}`);
        expirePendingPhoneMessages(sessionId);
        clearRespawnGuard(sessionId);
        return;
      }
      const mode = toCliMode(stored.permissionMode || DEFAULT_ORCHESTRATOR_MODE);
      console.log(`[rc-handler] Respawning CLI for active session ${sessionId} (workDir=${stored.workDir}, mode=${mode})`);

      // Retry loop: after orchestrator restart, pc-agent may not have
      // reconnected yet (typically ~1-2s). Retry every 2s for up to 30s
      // instead of immediately failing with "Remote session failed to attach".
      const RESPAWN_RETRY_INTERVAL_MS = 2000;
      const RESPAWN_RETRY_DEADLINE_MS = 30_000;
      const deadline = Date.now() + RESPAWN_RETRY_DEADLINE_MS;
      let lastErr;
      while (Date.now() < deadline) {
        try {
          await respawnCliFn(sessionId, stored.workDir, mode);
          console.log(`[rc-handler] Respawn request acked for ${sessionId}; guard stays until desktop WS connects`);
          return; // success -- do NOT clear the guard
        } catch (err) {
          lastErr = err;
          // Only retry if pc-agent is not connected yet; other errors are fatal
          if (!err.message?.includes('not connected')) throw err;
          console.log(`[rc-handler] pc-agent not connected yet, retrying respawn for ${sessionId} in ${RESPAWN_RETRY_INTERVAL_MS}ms`);
          await new Promise(r => setTimeout(r, RESPAWN_RETRY_INTERVAL_MS));
        }
      }
      throw lastErr || new Error('respawn retry deadline exceeded');
    } catch (err) {
      console.error(`[rc-handler] Respawn failed for ${sessionId}: ${err.message}`);
      expirePendingPhoneMessages(sessionId);
      clearRespawnGuard(sessionId);
    }
  })();

  inFlightRespawns.set(sessionId, { promise: p, timer: ceilingTimer });
}

/** Clear the in-flight respawn dedup guard for a session. */
function clearRespawnGuard(sessionId) {
  // The adopt guard shares the "desktop WS is now connected" clear point: once
  // the CLI attaches the session enters rcSessions and neither guard is needed.
  inFlightAdopts.delete(sessionId);
  const entry = inFlightRespawns.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  inFlightRespawns.delete(sessionId);
}

/**
 * Adopt-only reconciliation: if the user has an interactive CLI open for this
 * session on the PC (started at the terminal, so the orchestrator never saw
 * it), ask pc-agent to attach to it. NEVER spawns -- opening an old chat must
 * not start a CLI. Fires on chat-open (transcript request) so the phone shows
 * the session as live without the user having to send a message first.
 *
 * Guarded so a phone re-requesting the transcript cannot stack attach calls.
 * On a successful adopt the desktop WS connects and clears the guard; on no-op
 * or failure the guard is cleared here.
 */
function maybeAdoptCli(sessionId, requestingWs = null) {
  if (!adoptCliFn) return;
  if (rcSessions.has(sessionId)) return;
  if (inFlightRespawns.has(sessionId)) return;
  if (inFlightAdopts.has(sessionId)) return;
  inFlightAdopts.add(sessionId);
  const ceiling = setTimeout(() => inFlightAdopts.delete(sessionId), ADOPT_CEILING_MS);
  ceiling.unref?.();
  (async () => {
    let adopted = false;
    try {
      // A session the user started at the terminal has NO store row at all --
      // that is the whole point of this path. So a missing row is NOT a reason
      // to bail: fall back to a null workDir and let pc-agent resolve the CLI's
      // real cwd from its own live-session registry by sessionId.
      const stored = await rcStore.get(sessionId).catch(() => null);
      // Deliberately NOT gated on stored.status. A row reads "ended" whenever
      // the desktop WS dropped -- which happens on every 1000 close, and the
      // attached CLI treats 1000 as permanent and never reconnects. Refusing to
      // adopt those left a running CLI with nothing mirroring it: the phone
      // showed the chat as live but received no thinking state and no new
      // messages, so the transcript silently fell behind the real session.
      //
      // Adopting is safe regardless of the stored status because pc-agent only
      // ever attaches to a CLI that is actually alive right now; if the user
      // really did terminate the session, there is no process to attach to and
      // this is a no-op. Liveness on the PC is the authority here, not a status
      // the store may have written minutes ago.
      const workDir = stored?.workDir || null;
      const mode = toCliMode(stored?.permissionMode || DEFAULT_ORCHESTRATOR_MODE);
      const result = await adoptCliFn(sessionId, workDir, mode);
      adopted = result?.adopted === true;
      // A terminal-started session has no store row, so the desktop-connect path
      // (which recovers workDir only from the store) would send workDir=null to
      // the phone and could not export history. Persist the pc-agent-resolved
      // workDir now so both the folder chip and the JSONL transcript work.
      const resolvedWorkDir = result?.workDir || workDir;
      if (adopted && resolvedWorkDir && !stored) {
        await rcStore.create(sessionId, resolvedWorkDir, mode).catch(err =>
          console.log(`[rc-handler] Could not persist adopted session ${sessionId}: ${err.message}`));
        // The first transcript request (which triggered this adopt) returned
        // empty: with no store row there was no workDir to export the JSONL
        // spine from. Now that the workDir is known, send the catch-up
        // transcript so the phone shows the existing history without the user
        // reopening the chat.
        if (requestingWs && requestingWs.readyState === 1) {
          try {
            const transcript = await buildCatchUpTranscript(sessionId, resolvedWorkDir);
            if (transcript.length > 0) {
              const catchUpMsg = createRcTranscriptMessage(sessionId, transcript);
              requestingWs.send(serializeMessage(catchUpMsg).replace(/\0/g, ''));
            }
          } catch (err) {
            console.log(`[rc-handler] Adopt catch-up transcript failed for ${sessionId}: ${err.message}`);
          }
        }
      }
      console.log(`[rc-handler] Adopt-on-open for ${sessionId}: adopted=${adopted} (workDir=${resolvedWorkDir || 'unresolved'})`);
    } catch (err) {
      console.log(`[rc-handler] Adopt-on-open for ${sessionId} failed: ${err.message}`);
    } finally {
      // On a successful adopt the desktop WS connects a moment later and
      // clearRespawnGuard removes the guard. Holding it until then stops a
      // rapid second transcript request (phone onResume) from firing a
      // redundant adopt round-trip in that window; the ceiling stays armed as
      // the backstop so the guard cannot leak if the WS never arrives.
      // On no-op/failure nothing else will clear it, so drop it now.
      if (!adopted) {
        clearTimeout(ceiling);
        inFlightAdopts.delete(sessionId);
      }
    }
  })();
}

/**
 * Queue a phone message for a sessionId whose desktop WS has not yet attached.
 * @param {string} sessionId
 * @param {string} deviceId
 * @param {Object} envelope
 * @param {import('ws').WebSocket} ws
 */
function enqueuePhoneMessage(sessionId, deviceId, envelope, ws) {
  let entry = pendingPhoneMessages.get(sessionId);
  if (!entry) {
    entry = { items: [], expiryTimer: null };
    pendingPhoneMessages.set(sessionId, entry);
  }
  // Dedup by requestId -- the phone retries the same message with the same
  // ID. Without dedup, the CLI receives N copies on drain and generates N
  // duplicate responses, filling context to 100%.
  const reqId = envelope.requestId;
  if (reqId) {
    const idx = entry.items.findIndex(i => i.envelope.requestId === reqId);
    if (idx >= 0) {
      entry.items[idx] = { deviceId, envelope, ws };
      return;
    }
  }
  entry.items.push({ deviceId, envelope, ws });
  if (!entry.expiryTimer) {
    entry.expiryTimer = setTimeout(() => expirePendingPhoneMessages(sessionId), PENDING_PHONE_MSG_TTL_MS);
  }
}

/**
 * Replay queued phone messages once the desktop WS has connected for sessionId.
 * @param {string} sessionId
 */
function drainPendingPhoneMessages(sessionId) {
  const entry = pendingPhoneMessages.get(sessionId);
  if (!entry) return;
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  pendingPhoneMessages.delete(sessionId);
  if (entry.items.length > 0) {
    console.log(`[rc-handler] Replaying ${entry.items.length} queued phone message(s) for session ${sessionId}`);
  }
  for (const { deviceId, envelope, ws } of entry.items) {
    try {
      handleRcPhoneMessage(deviceId, envelope, ws);
    } catch (err) {
      console.error(`[rc-handler] Failed to replay queued message: ${err.message}`);
    }
  }
}

/**
 * Called when queued phone messages time out (desktop never attached).
 * Emits rc_error to every affected phone so its UI can exit the thinking state.
 * @param {string} sessionId
 */
function expirePendingPhoneMessages(sessionId) {
  const entry = pendingPhoneMessages.get(sessionId);
  if (!entry) return;
  pendingPhoneMessages.delete(sessionId);
  console.log(`[rc-handler] Pending phone messages for session ${sessionId} expired (${entry.items.length} dropped)`);
  const errMsg = createRcErrorMessage(
    sessionId,
    'Remote session failed to attach. Try again.',
    'orchestrator'
  );
  const notified = new Set();
  for (const { deviceId, ws } of entry.items) {
    if (notified.has(deviceId)) continue;
    notified.add(deviceId);
    if (ws && ws.readyState === 1) {
      try {
        ws.send(serializeMessage(errMsg).replace(/\0/g, ''));
      } catch (err) {
        console.error(`[rc-handler] Failed to send rc_error to ${deviceId}: ${err.message}`);
      }
    }
  }
}

function findSessionForDevice(deviceId) {
  // Check by stored phoneDeviceId
  for (const [sessionId, session] of rcSessions) {
    if (session.phoneDeviceId === deviceId) return sessionId;
  }
  // Fallback: any active session (single-session assumption for now)
  if (rcSessions.size === 1) {
    return rcSessions.keys().next().value;
  }
  // Use envelope.sessionId if available (caller should have checked)
  return null;
}

/**
 * Called when a phone device reconnects (sends identify message).
 * Drains pending queue and sends catch-up transcript.
 * @param {string} deviceId
 * @param {import('ws').WebSocket} ws
 */
export async function notifyPhoneReconnect(deviceId, ws) {
  if (rcSessions.size === 0) return;

  // Check each session -- only claim sessions that belong to this device (or have no phone yet)
  for (const [sessionId, session] of rcSessions) {
    if (!session.phoneDeviceId || session.phoneDeviceId === deviceId) {
      session.phoneDeviceId = deviceId;
    } else {
      continue; // Skip sessions owned by a different phone
    }
    console.log(`[rc-handler] Phone reconnected for session ${sessionId}`);

    // Replay the pending queue. This used to be cleared on the grounds that
    // the transcript covers it, which is not true for the frames that matter
    // most: a tool's `complete` written into a half-open socket is lost, and
    // the transcript catch-up races the live turn, so the phone can be left
    // ticking forever on a tool that finished while it was disconnected.
    //
    // Replaying is safe because every rc_tool_status carries a monotonic per
    // tool seq and the phone drops anything it has already applied.
    try {
      const queued = await rcStore.drainPendingQueue(sessionId);
      let replayed = 0;
      for (const item of queued) {
        const msg = item?.message;
        if (!msg) continue;
        if (ws.readyState !== 1) break;
        try {
          ws.send(serializeMessage(msg).replace(/\0/g, ''));
          replayed++;
        } catch (err) {
          console.error(`[rc-handler] Replay failed for session ${sessionId}: ${err.message}`);
          break;
        }
      }
      if (queued.length > 0) {
        console.log(`[rc-handler] Replayed ${replayed}/${queued.length} queued messages for session ${sessionId}`);
      }
    } catch (err) {
      console.error(`[rc-handler] Failed to drain pending queue: ${err.message}`);
    }

    // Send transcript for UI catch-up. JSONL spine + Mongo phone-only entries.
    try {
      const transcript = await buildCatchUpTranscript(sessionId, session.workDir || null);
      if (transcript.length > 0) {
        const catchUpMsg = createRcTranscriptMessage(sessionId, transcript);
        if (ws.readyState === 1) {
          const payload = serializeMessage(catchUpMsg).replace(/\0/g, '');
          ws.send(payload);
        }
      }
    } catch (err) {
      console.error(`[rc-handler] Failed to send transcript: ${err.message}`);
    }

    // Re-send pending permission requests with original tool info.
    // Check both in-memory (current session) and MongoDB (survived restart).
    const inMemoryIds = new Set(session.pendingPermissions.keys());
    for (const [requestId, pending] of session.pendingPermissions) {
      const rePromptMsg = createRcPermissionRequestMessage(
        sessionId,
        pending.toolName || 'unknown',
        pending.toolArgs || {},
        requestId,
        pending.description || null
      );
      if (ws.readyState === 1) {
        try {
          const payload = serializeMessage(rePromptMsg).replace(/\0/g, '');
          ws.send(payload);
        } catch (err) {
          console.error(`[rc-handler] Failed to re-send permission request: ${err.message}`);
        }
      }
    }
    // Fallback: check MongoDB for permissions not yet restored to memory
    // (e.g. phone reconnected before replay ended)
    try {
      const persisted = await rcStore.getPermissions(sessionId);
      for (const [toolUseId, data] of Object.entries(persisted)) {
        if (inMemoryIds.has(toolUseId)) continue;
        const msg = createRcPermissionRequestMessage(
          sessionId, data.toolName || 'unknown', data.toolArgs || {}, toolUseId, data.description || null
        );
        if (ws.readyState === 1) {
          try { ws.send(serializeMessage(msg).replace(/\0/g, '')); } catch {}
        }
      }
    } catch {}

    // Send session start so phone knows there is an active session
    const startMsg = createRcSessionStartMessage(sessionId, session.workDir || null);
    if (ws.readyState === 1) {
      try {
        const payload = serializeMessage(startMsg).replace(/\0/g, '');
        ws.send(payload);
      } catch (err) {
        console.error(`[rc-handler] Failed to send session_start on reconnect: ${err.message}`);
      }
    }

    // Re-emit thinking state so phone can resume its timer from the correct start time
    if (session.thinkingStartedAt) {
      const thinkingMsg = createRcThinkingMessage(sessionId, '', session.thinkingStartedAt);
      if (ws.readyState === 1) {
        try { ws.send(serializeMessage(thinkingMsg).replace(/\0/g, '')); } catch {}
      }
    }
    // Re-emit running-tool rows so a reconnecting phone (or one attaching to a
    // session already mid-turn) sees the in-flight tools immediately.
    replayInFlightTools(sessionId, session, ws);
  }
}

/**
 * Get all active RC sessions (for REST API).
 * @returns {Array<{ sessionId: string, phoneDeviceId: string|null, permissionMode: string, createdAt: Date, pendingPermissions: number }>}
 */
/**
 * Bind an RC session to a specific phone device ID.
 */
/**
 * Pre-register the orchestrator-side permission mode for a session that the
 * gateway just created in the store. The desktop WS attaches afterwards and
 * will adopt this mode. Drained on first handleRemoteControlConnection for
 * sessionId.
 * @param {string} sessionId
 * @param {string} mode orchestrator-side name
 */
export function registerOrchestratorSessionMode(sessionId, mode) {
  pendingSessionModes.set(sessionId, mode);
}

export function bindSessionToPhone(sessionId, deviceId) {
  const session = rcSessions.get(sessionId);
  if (session) {
    session.phoneDeviceId = deviceId;
    console.log(`[rc-handler] Bound session ${sessionId} to phone ${deviceId}`);
  }
}

/**
 * Drive the CLI stream-json handler directly against a caller-supplied session
 * object. Exists so the tool-status and thinking event paths can be tested
 * without standing up a CLI, a phone WS and MongoDB.
 * @param {string} sessionId
 * @param {Object} session
 * @param {Object} parsed a stream-json event
 */
export function __processDesktopMessageForTest(sessionId, session, parsed) {
  return processDesktopMessage(sessionId, session, parsed);
}

/**
 * Register a session object under an id so the test harness can exercise code
 * paths that look the session up by id (sendToPhone, cleanup).
 */
export function __registerSessionForTest(sessionId, session) {
  rcSessions.set(sessionId, session);
}

export function __endThinkingForTest(sessionId, session) {
  return emitThinkingEnd(sessionId, session);
}

export function getActiveSessions() {
  const result = [];
  for (const [sessionId, session] of rcSessions) {
    result.push({
      sessionId,
      phoneDeviceId: session.phoneDeviceId,
      permissionMode: session.permissionMode,
      createdAt: session.createdAt,
      pendingPermissions: session.pendingPermissions.size,
      ...turnStateOf(session)
    });
  }
  return result;
}

/**
 * Whether a session is mid-turn right now, and since when.
 *
 * The phone learns "thinking" from live WS events, so a chat that was already
 * running a turn before the app started listening shows no indicator at all.
 * Exposing it on the REST surface lets the chat list recover that state on a
 * cold open instead of waiting for the next event.
 * @param {Object} session
 */
function turnStateOf(session) {
  const toolCount = session.toolInFlight ? session.toolInFlight.size : 0;
  return { thinking: !!session.thinkingStartedAt || toolCount > 0 };
}

/**
 * Get a specific RC session (for REST API).
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSession(sessionId) {
  const session = rcSessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId,
    phoneDeviceId: session.phoneDeviceId,
    permissionMode: session.permissionMode,
    createdAt: session.createdAt,
    pendingPermissions: session.pendingPermissions.size,
    desktopConnected: session.desktopWs.readyState === 1
  };
}

/**
 * End a specific RC session (for REST API or shutdown).
 * @param {string} sessionId
 */
export async function endSession(sessionId) {
  if (!rcSessions.has(sessionId)) return;
  const session = rcSessions.get(sessionId);
  if (!session) return;

  console.log(`[rc-handler] Ending session ${sessionId}`);

  // Kill the CLI process on the PC first so it can't reconnect.
  if (killCliFn) {
    try {
      await killCliFn(sessionId);
    } catch (err) {
      console.error(`[rc-handler] killCli failed for ${sessionId}: ${err.message}`);
    }
  }

  // Mark ended in store before closing WS to prevent reconnect races.
  await rcStore.end(sessionId).catch(err => {
    console.error(`[rc-handler] Failed to end session in store: ${err.message}`);
  });

  // Notify phone
  const endMsg = createRcSessionEndMessage(sessionId);
  await sendToPhone(sessionId, endMsg).catch(() => {});

  // Notify desktop
  sendToDesktop(session.desktopWs, {
    type: 'result',
    text: 'Session ended',
    session_ended: true
  });

  // Close desktop WS
  try {
    session.desktopWs.close(1000, 'session_ended');
  } catch {}

  cleanupSession(sessionId, session);
}

/**
 * End all active RC sessions (for shutdown).
 */
export async function endAllSessions() {
  const sessionIds = [...rcSessions.keys()];
  for (const sessionId of sessionIds) {
    await endSession(sessionId);
  }
}
