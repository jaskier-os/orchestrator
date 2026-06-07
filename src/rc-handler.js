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

// Kill CLI callback (set by initRcHandler). Called by endSession() to
// SIGTERM/SIGKILL the actual CLI process on the PC so it doesn't reconnect.
/** @type {((sessionId: string) => Promise<void>)|null} */
let killCliFn = null;

// Dedup in-flight respawns. Unlike the previous implementation which cleared
// on spawn-ack, this guard stays until the desktop WS actually connects (the
// session appears in rcSessions) or a 60s ceiling expires. This prevents the
// phone retry loop from spawning extra CLIs during the cold-start window.
/** @type {Map<string, { promise: Promise<void>, timer: NodeJS.Timeout }>} */
const inFlightRespawns = new Map();

/**
 * Initialize RC handler with dependencies.
 * @param {import('./rc-store.js').RcStore} store
 * @param {Map<string, import('ws').WebSocket>} connections
 * @param {{ sessionTimeoutMs?: number, respawnCli?: (sessionId: string, workDir: string, permissionMode: string) => Promise<void>, killCli?: (sessionId: string) => Promise<void> }} [options]
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
  if (options?.killCli) {
    killCliFn = options.killCli;
  }
  console.log(`[rc-handler] Initialized (sessionTimeout=${SESSION_TIMEOUT_MS}ms, respawnCli=${!!respawnCliFn}, killCli=${!!killCliFn})`);
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
  if (!session || !session.thinkingStartedAt) return;
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

  // Stop any in-flight agent heartbeat timers to prevent leaks.
  if (session.agentMeta) {
    for (const meta of session.agentMeta.values()) {
      if (meta && meta.heartbeatTimer) {
        clearInterval(meta.heartbeatTimer);
        meta.heartbeatTimer = null;
      }
    }
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
      replayFlushTimer: null
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
          const completeMsg = createRcToolStatusMessage(
            sessionId, toolName, 'complete', storedArgs, resultContent, toolUseId
          );
          // Re-attach agent metadata so the phone preserves the Agent label
          // on the completion event (toolName="Task" alone isn't enough).
          const agentMeta = toolUseId && session.agentMeta ? session.agentMeta.get(toolUseId) : null;
          if (agentMeta) {
            if (agentMeta.heartbeatTimer) {
              clearInterval(agentMeta.heartbeatTimer);
              agentMeta.heartbeatTimer = null;
            }
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
    const textParts = [];
    for (const block of blocks) {
      if (typeof block === 'string') {
        textParts.push(block);
      } else if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'thinking' && block.text) {
        emitThinking(sessionId, session, block.text);
      } else if (block.type === 'tool_use') {
        if (!session.lastToolArgs) session.lastToolArgs = new Map();
        if (!session.toolUseIdToName) session.toolUseIdToName = new Map();
        if (!session.agentMeta) session.agentMeta = new Map();
        session.lastToolArgs.set(block.id || block.name || 'unknown', block.input || null);
        if (block.id) session.toolUseIdToName.set(block.id, block.name || 'unknown');
        const statusMsg = createRcToolStatusMessage(
          sessionId,
          block.name || 'unknown',
          'calling',
          block.input || null,
          null,
          block.id || null
        );
        const { isAgent, agentName, agentTask } = describeAgentDispatch(block);
        if (isAgent) {
          statusMsg.isAgent = true;
          if (agentName) statusMsg.agentName = agentName;
          if (agentTask) statusMsg.agentTask = agentTask;
          if (block.id) {
            const meta = { toolName: block.name || 'Task', agentName, agentTask, startedAt: Date.now(), heartbeatTimer: null };
            // Heartbeat: emit a periodic rc_tool_status so the phone can refresh
            // the agent row's elapsed counter from a fresh server timestamp.
            // Note: Claude Code's CLI stream-json does NOT forward subagent
            // tool_use/usage events to the parent in real time -- the spawned
            // subprocess returns a single tool_result with a trailing <usage>
            // block on completion. So we cannot stream true incremental tool
            // count or token usage. The heartbeat is a status keep-alive
            // (Option C in the design doc) -- the counts only arrive at Complete.
            const HEARTBEAT_MS = 2000;
            meta._prevTokens = 0;
            meta._prevToolCount = 0;
            meta.heartbeatTimer = setInterval(() => {
              const stillTracked = session.agentMeta && session.agentMeta.get(block.id);
              if (!stillTracked) return;
              // Reset turn timer if the sub-agent made real progress (new
              // tokens spent or tools called) since the last heartbeat.
              const curTokens = meta.liveTokens || 0;
              const curTools = meta.liveToolCount || 0;
              if (curTokens > meta._prevTokens || curTools > meta._prevToolCount) {
                resetTurnTimer(sessionId, session);
                meta._prevTokens = curTokens;
                meta._prevToolCount = curTools;
              }
              const hb = createRcToolStatusMessage(sessionId, block.name || 'unknown', 'running', block.input || null, null, block.id || null);
              hb.isAgent = true;
              if (agentName) hb.agentName = agentName;
              if (agentTask) hb.agentTask = agentTask;
              hb.agentElapsedMs = Date.now() - meta.startedAt;
              // Forward live-accumulated counts (Tier A) so the row keeps
              // showing tools/tokens even between sub-agent message arrivals.
              if (meta.liveTokens != null) hb.agentTokens = meta.liveTokens;
              if (meta.liveToolCount != null) hb.agentToolCount = meta.liveToolCount;
              if (session.contextPct > 0) hb.contextPct = session.contextPct;
              sendToPhone(sessionId, hb, false);
            }, HEARTBEAT_MS);
            session.agentMeta.set(block.id, meta);
          }
        }
        if (session.contextPct > 0) statusMsg.contextPct = session.contextPct;
        sendToPhone(sessionId, statusMsg, false);
      }
    }
    if (textParts.length > 0) {
      const text = textParts.join('');
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
      sendToPhone(sessionId, partialMsg, shouldPersist);
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
    sendToPhone(sessionId, createRcToolStatusMessage(
      sessionId,
      parsed.name || 'unknown',
      'calling',
      parsed.input || null,
      null,
      parsed.id || null
    ), false);
    return;
  }

  // Tool result (top-level)
  if (type === 'tool_result') {
    const toolName = parsed.tool_name || parsed.name || 'unknown';
    const topLevelToolUseId = parsed.tool_use_id || null;
    const storedArgs = session.lastToolArgs?.get(topLevelToolUseId || toolName) || null;
    console.log(`[rc-handler] tool_result: tool=${toolName} toolUseId=${topLevelToolUseId} hasStoredArgs=${!!storedArgs} lastToolArgsKeys=${session.lastToolArgs ? [...session.lastToolArgs.keys()].join(',') : 'none'}`);
    if (storedArgs) session.lastToolArgs.delete(topLevelToolUseId || toolName);
    sendToPhone(sessionId, createRcToolStatusMessage(
      sessionId,
      toolName,
      'complete',
      storedArgs,
      typeof parsed.content === 'string' ? parsed.content.substring(0, 2000) : null,
      topLevelToolUseId
    ));
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
    const msg = createRcMessage(sessionId, '', true);
    if (session.contextPct > 0) msg.contextPct = session.contextPct;
    if (totalCost !== null) msg.costUsd = Math.round(totalCost * 10000) / 10000;
    sendToPhone(sessionId, msg, shouldPersist);
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
        const transcript = await rcStore.getTranscript(endedSessionId);
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
        const transcript = await rcStore.getTranscript(sessionId);
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
  const entry = inFlightRespawns.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  inFlightRespawns.delete(sessionId);
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

    // Drain pending queue (just clear it -- transcript already contains these messages)
    try {
      const queued = await rcStore.drainPendingQueue(sessionId);
      if (queued.length > 0) {
        console.log(`[rc-handler] Cleared ${queued.length} queued messages for session ${sessionId} (covered by transcript)`);
      }
    } catch (err) {
      console.error(`[rc-handler] Failed to drain pending queue: ${err.message}`);
    }

    // Send transcript for UI catch-up (single source of truth for message history)
    try {
      const transcript = await rcStore.getTranscript(sessionId);
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

export function getActiveSessions() {
  const result = [];
  for (const [sessionId, session] of rcSessions) {
    result.push({
      sessionId,
      phoneDeviceId: session.phoneDeviceId,
      permissionMode: session.permissionMode,
      createdAt: session.createdAt,
      pendingPermissions: session.pendingPermissions.size
    });
  }
  return result;
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
