import 'dotenv/config';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { StringDecoder } from 'string_decoder';
import { WebSocket, WebSocketServer } from 'ws';
import config from './config.js';
import app, { rejectedDevices, initGateway, sendDirectAgentRequest } from './gateway.js';
import { handleAgentConnection, startHealthChecks, stopHealthChecks, onAgentMessage } from './registry.js';
import { handleRequest, initDispatcher } from './dispatcher.js';
import { SessionManager } from './session.js';
import { AssistantManager } from './assistant.js';
import { ChatStore } from './chat-store.js';
import { parseMessage, serializeMessage, MSG_TYPE, createRequestMessage } from '@orchestrator/sdk/protocol';
import { streamTts, generateAudio, generateNotifAudio, splitSentences, segmentByLanguage } from './tts.js';
import { connectDb, closeDb, getDb } from './db.js';
import { TodoStore } from './todo-store.js';
import { JobStore } from './job-store.js';
import { RcStore } from './rc-store.js';
import { initRcHandler, handleRemoteControlConnection, handleRcPhoneMessage, handleRcRevive, notifyPhoneReconnect, endAllSessions as endAllRcSessions } from './rc-handler.js';
import { initScheduler, startScheduler, stopScheduler, getAutonomousSystemPrompt } from './job-scheduler.js';
import { getAgent, getManifests } from './registry.js';

const REJECTION_PHRASE = 'Извините, но я не понимаю вас. Если вы считаете что это ошибка, попробуйте заняться дыхательной гимнастикой. Задержка дыхания на 10 минут должна помочь.';

const chatStore = new ChatStore(config.chatHistoryDir);
await chatStore.init();

// Separate store for copilot (real-time fact-check/coaching) sessions. Same
// /app/data mount, but an isolated index so copilot sessions never mix with the
// normal chat history.
const copilotStore = new ChatStore(config.copilotHistoryDir);
await copilotStore.init();

await connectDb(config.mongoUrl);
const todoStore = new TodoStore(getDb());
await todoStore.ensureOrder();

const jobStore = new JobStore(getDb());

const rcStore = new RcStore(getDb());
await rcStore.init();

const sessionManager = new SessionManager({
  sessionTimeoutMs: config.sessionTimeoutMs,
  compactionThreshold: config.compactionThreshold,
  communicatorUrl: config.communicatorUrl,
  apiKey: config.apiKey,
  llmModel: config.llmModel,
  chatStore
});
sessionManager.startCleanup();
initDispatcher(sessionManager, chatStore, todoStore, jobStore);

// Isolated session store for the Assistant fact-check feature. Kept separate
// from sessionManager so its growing transcript history never collides with
// the normal chat conversation context.
const assistantManager = new AssistantManager({
  sessionTimeoutMs: config.sessionTimeoutMs,
  // Defaults to "haiku" inside AssistantManager (fastest, no forced thinking).
  // Override only via ASSISTANT_LLM_MODEL, never the global LLM_MODEL.
  llmModel: process.env.ASSISTANT_LLM_MODEL,
  copilotStore
});
assistantManager.startCleanup();

const server = http.createServer(app.callback());

const wss = new WebSocketServer({ noServer: true });

// Device WebSocket connections: deviceId -> ws
const deviceConnections = new Map();

initGateway(chatStore, sessionManager, deviceConnections, jobStore, rcStore, copilotStore);
// Auto-respawn callback: ask pc-agent to spawn a fresh CLI for an active
// session whose previous CLI exited. Triggered when the phone resumes a
// chat and the orchestrator finds the session in the store but not in
// rcSessions. Reuses the existing remote_session_start RPC -- no new
// pc-agent action needed.
async function respawnCli(sessionId, workDir, cliPermissionMode) {
  const agentEntry = getAgent('pc-agent');
  if (!agentEntry) {
    throw new Error('pc-agent not connected; cannot respawn CLI');
  }
  // pc-agent rewrites wsUrl host/port from its own orchestratorUrl, so a
  // placeholder hostname is fine here.
  const wsUrl = `wss://placeholder/ws/remote-control?session=${sessionId}`;
  const response = await sendDirectAgentRequest(agentEntry, {
    requestId: crypto.randomUUID(),
    action: 'remote_session_start',
    workDir,
    sessionId,
    wsUrl,
    apiKey: config.apiKey,
    permissionMode: cliPermissionMode
  }, 90000);
  if (response.status === 'error') {
    throw new Error(response.text || 'remote_session_start failed');
  }
}

// Kill CLI callback: ask pc-agent to SIGTERM/SIGKILL the actual CLI process
// for a session so it can't reconnect after endSession() closes the WS.
async function killCli(sessionId) {
  const agentEntry = getAgent('pc-agent');
  if (!agentEntry) {
    console.warn('[server] pc-agent not connected; cannot kill CLI for', sessionId);
    return;
  }
  const response = await sendDirectAgentRequest(agentEntry, {
    requestId: crypto.randomUUID(),
    action: 'remote_session_stop_by_session_id',
    sessionId
  }, 15000);
  if (response.status === 'error') {
    console.error(`[server] killCli failed for ${sessionId}:`, response.text);
  }
}

initRcHandler(rcStore, deviceConnections, {
  sessionTimeoutMs: config.rcSessionTimeoutMs,
  respawnCli,
  killCli
});

// Sweep stale RC sessions on startup (zombies from prior crashes / desktop disconnects)
// and periodically (every 10 min) so sessions whose desktop WS disconnected mid-life
// eventually get marked ended even without an orchestrator restart.
const RC_STALE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
rcStore.endStaleSessions(config.rcSessionTimeoutMs).then(n => {
  if (n > 0) console.log(`[server] Startup: ended ${n} stale RC sessions`);
}).catch(err => {
  console.error('[server] Startup stale RC sweep failed:', err.message);
});
const rcStaleSweepInterval = setInterval(() => {
  rcStore.endStaleSessions(config.rcSessionTimeoutMs).then(n => {
    if (n > 0) console.log(`[server] Sweep: ended ${n} stale RC sessions`);
  }).catch(() => {});
}, RC_STALE_SWEEP_INTERVAL_MS);
rcStaleSweepInterval.unref();

// Sweep stale voice conversations on startup (orphans from unclean shutdowns)
chatStore.closeStaleConversations(config.sessionTimeoutMs).then(n => {
  if (n > 0) console.log("[server] Startup: closed " + n + " stale voice conversations");
}).catch(err => {
  console.error("[server] Startup stale conversation sweep failed:", err.message);
});

// Reset jobs stuck in running from a prior crash
jobStore.resetStaleRunningJobs().then(n => {
  if (n > 0) console.log("[server] Startup: reset " + n + " stale running jobs to failed");
}).catch(err => {
  console.error("[server] Startup stale job reset failed:", err.message);
});

// Create a silent WS wrapper: passes device commands through (for phone tools like
// take_photo, get_geolocation) but suppresses tool_status messages (no UI animations).
// TTS is already safe: it's triggered in the WS request handler, not by handleRequest.
// Chat is already safe: jobs use isolated scheduler-uuid sessions.
function createSilentDeviceWs(ws) {
  if (!ws) return null;
  return {
    get readyState() { return ws.readyState; },
    send(data) {
      try {
        const parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
        if (parsed.type === 'tool_status') return;
      } catch {}
      ws.send(data);
    },
    on(event, handler) { ws.on(event, handler); },
    removeListener(event, handler) { ws.removeListener(event, handler); }
  };
}

// Job scheduler -- execute due jobs via handleRequest
// Uses a unique deviceId per job to isolate from the phone user's active session.
// Phone tools available when connected, but no TTS/chat/tool-status animations on phone.
// Phone gets a push notification on completion via job-scheduler's sendJobNotification.
async function executeJob(job) {
  let phoneWs = null;
  for (const [, ws] of deviceConnections) {
    if (ws._deviceType === 'phone' && ws.readyState === 1) {
      phoneWs = ws;
      break;
    }
  }
  const jobDeviceId = `scheduler-${crypto.randomUUID()}`;
  console.log(`[job-scheduler] Executing job "${job.name}" with jobDeviceId=${jobDeviceId}, phoneConnected=${!!phoneWs}`);
  const result = await handleRequest({
    requestId: crypto.randomUUID(),
    text: job.prompt,
    deviceId: jobDeviceId,
    deviceType: 'phone',
    userSystemPrompt: getAutonomousSystemPrompt(getManifests())
  }, createSilentDeviceWs(phoneWs));
  // Capture conversationId from the isolated session, then clean it up
  const session = sessionManager.sessions.get(jobDeviceId);
  result.conversationId = session?.conversationId || null;
  sessionManager.removeSession(jobDeviceId);
  return result;
}

initScheduler(jobStore, executeJob, deviceConnections, sessionManager);
startScheduler(30000);

// Active TTS streams: requestId -> { abort }
const activeTtsStreams = new Map();

// Aborted request IDs: skip TTS for these
const abortedRequests = new Set();

// Telegram new message subscriber: the device WS that wants real-time push
let telegramSubscriberWs = null;

// Forward agent push messages (e.g. telegram_new_message) to subscriber device
onAgentMessage((agentId, envelope) => {
  if (telegramSubscriberWs && telegramSubscriberWs.readyState === 1) {
    if (envelope.type === MSG_TYPE.TELEGRAM_NEW_MESSAGE) {
      telegramSubscriberWs.send(serializeMessage({
        type: MSG_TYPE.TELEGRAM_NEW_MESSAGE,
        message: envelope.message
      }));
    } else if (envelope.type === 'telegram_user_status') {
      telegramSubscriberWs.send(serializeMessage({
        type: 'telegram_user_status',
        userId: envelope.userId,
        isOnline: envelope.isOnline,
        lastSeen: envelope.lastSeen
      }));
    }
  } else if (telegramSubscriberWs) {
    telegramSubscriberWs = null;
  }
});

// Stream sessions: streamId -> { sourceDeviceId, sourceMainWs, targetDeviceId, targetMainWs, videoSourceWs, videoTargetWs, audioSourceWs, audioTargetWs, mouseSourceWs, mouseTargetWs, keyboardSourceWs, keyboardTargetWs, startedAt }
const streamSessions = new Map();
let nextStreamId = 1;

// Periodically prune orphaned stream sessions (both peers gone, or older than max age).
const STREAM_SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const STREAM_SESSION_PRUNE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [streamId, session] of streamSessions) {
    const aged = (now - (session.startedAt || 0)) > STREAM_SESSION_MAX_AGE_MS;
    const young = (now - (session.startedAt || 0)) < 10_000;
    const sourceClosed = !session.sourceMainWs || session.sourceMainWs.readyState !== 1;
    const targetClosed = !session.targetMainWs || session.targetMainWs.readyState !== 1;
    if (aged || (!young && sourceClosed && targetClosed)) {
      const reason = aged ? 'session_max_age' : 'both_peers_disconnected';
      console.log(`[server] Pruning orphaned stream session ${streamId} (${reason})`);
      try { endStreamSession(streamId, reason); } catch (e) { streamSessions.delete(streamId); }
    }
  }
}, STREAM_SESSION_PRUNE_INTERVAL_MS).unref();

// Pending stream tokens: token -> { streamId, deviceId, streamType, createdAt }
const pendingStreamTokens = new Map();

// Prune expired tokens every 15s (tokens older than 30s)
const tokenCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, info] of pendingStreamTokens) {
    if (now - info.createdAt > 30000) {
      pendingStreamTokens.delete(token);
    }
  }
}, 15000);

// Handle WebSocket upgrade requests
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  console.log(`[server] WS upgrade: ${url.pathname}`);

  if (url.pathname === '/ws/device') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleDeviceConnection(ws, request);
    });
  } else if (url.pathname === '/ws/transcribe') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTranscribeConnection(ws);
    });
  } else if (url.pathname === '/ws/transcriber') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTranscriberServiceConnection(ws);
    });
  } else if (url.pathname.startsWith('/ws/stream/')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleStreamConnection(ws, url);
    });
  } else if (url.pathname === '/ws/remote-control') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleRemoteControlConnection(ws, request);
    });
  } else {
    // Default: agent connection
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleAgentConnection(ws);
    });
  }
});

/**
 * Handle device WebSocket connection.
 */
function handleDeviceConnection(ws, request) {
  let deviceId = null;
  let deviceType = null;

  console.log('[server] New device WebSocket connection');

  // Get the current WebSocket for this device (survives reconnects during async ops)
  const getWs = () => (deviceId && deviceConnections.get(deviceId)) || ws;
  const safeSend = (msg) => {
    const current = getWs();
    if (current.readyState === 1) {
      // Sanitize: remove null bytes and other chars that crash Android JNI Modified UTF-8
      const payload = serializeMessage(msg).replace(/\0/g, '');
      current.send(payload);
    }
  };

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return; // Main WS only handles JSON text messages

    const rawStr = raw.toString();
    let envelope;
    try {
      envelope = parseMessage(rawStr);
    } catch (err) {
      console.error(`[server] Failed to parse device message: ${err.message} raw=${rawStr.substring(0, 200)}`);
      return;
    }

    // Log all incoming device messages for debugging
    if (envelope.type !== 'identify' && envelope.type !== 'health') {
      console.log(`[server] Device msg from ${deviceId || 'unknown'}: type=${envelope.type} raw=${rawStr.substring(0, 100)}`);
    } else if (envelope.type === 'health') {
      console.log(`[server] Device msg from ${deviceId || 'unknown'}: type=${envelope.type}`);
    }

    // First message should identify the device
    if (!deviceId && envelope.type === 'identify') {
      deviceId = envelope.deviceId;
      deviceType = envelope.deviceType || 'pc';
      ws._deviceType = deviceType;
      ws._deviceId = deviceId;
      deviceConnections.set(deviceId, ws);
      console.log(`[server] Device identified: ${deviceId} (${deviceType})`);
      if (deviceType === 'phone') {
        notifyPhoneReconnect(deviceId, ws);
      }
      return;
    }

    // Handle device sending a request
    if (envelope.type === 'request') {
      const requestId = envelope.requestId || crypto.randomUUID();
      console.log(`[server] Device request ${requestId} from ${deviceId || 'unknown'}`);

      // Ack the request immediately so the phone can clear its retry state
      // before the heartbeat watchdog declares the WS dead and reconnects
      // (which used to trigger a duplicate send -> duplicate AI answer +
      // duplicate TTS for the same prompt).
      try {
        ws.send(serializeMessage({ type: 'request_ack', requestId }));
      } catch (err) {
        console.warn(`[server] Failed to ack request ${requestId}: ${err.message}`);
      }

      const FORCE_REJECTION = false;
      // Voice gate: unverified speaker gets a rejection response through the normal pipeline
      if (FORCE_REJECTION || (deviceId && rejectedDevices.delete(deviceId))) {
        console.log(`[server] Voice gate: rejection response for device '${deviceId}'`);
        const result = { status: 'success', text: REJECTION_PHRASE };
        ws.send(serializeMessage({ type: 'response', requestId, ...result }));
        const ttsStream = streamTts(requestId, result.text, () => deviceConnections.get(deviceId) || ws);
        activeTtsStreams.set(requestId, ttsStream);
        ttsStream.done.finally(() => activeTtsStreams.delete(requestId));
        return;
      }

      try {
        const result = await handleRequest({
          requestId,
          text: envelope.text,
          imageBase64: envelope.image,
          model: envelope.model,
          userSystemPrompt: envelope.userSystemPrompt,
          deviceId: deviceId || 'ws-device',
          deviceType: envelope.deviceType || deviceType || 'pc'
        }, ws);

        safeSend({
          type: 'response',
          requestId,
          ...result
        });

        // Start TTS stream if response was successful and not aborted
        if (abortedRequests.has(requestId)) {
          console.log(`[server] Request ${requestId} was aborted, skipping TTS`);
          abortedRequests.delete(requestId);
        } else if (result.status === 'success' && result.text) {
          // Abort any previous TTS stream for this device
          for (const [rid, stream] of activeTtsStreams) {
            stream.abort();
            activeTtsStreams.delete(rid);
          }

          const ttsStream = streamTts(requestId, result.text, () => deviceConnections.get(deviceId) || ws);
          activeTtsStreams.set(requestId, ttsStream);
          ttsStream.done.finally(() => {
            activeTtsStreams.delete(requestId);
          });
        }
      } catch (err) {
        console.error(`[server] Device request ${requestId} failed:`, err.message);
        safeSend({
          type: MSG_TYPE.ERROR,
          requestId,
          message: 'Internal server error'
        });
      }
    }

    // Handle new chat (reset session) from device
    if (envelope.type === 'new_chat') {
      const effectiveId = deviceId || 'ws-device';
      console.log(`[server] New chat requested by ${effectiveId}`);
      const existing = sessionManager.sessions.get(effectiveId);
      if (existing?.conversationId) {
        await chatStore.closeConversation(existing.conversationId, 'new_chat').catch(() => {});
      }
      sessionManager.removeSession(effectiveId);
    }

    // Handle assistant fact-check batch from device (isolated session)
    if (envelope.type === MSG_TYPE.ASSISTANT) {
      const requestId = envelope.requestId || crypto.randomUUID();
      const effectiveId = deviceId || 'ws-device';
      try {
        const { cards, dismiss } = await assistantManager.enqueueBatch(
          effectiveId,
          envelope.wearerText,
          envelope.interlocutorText,
          envelope.activeCards,
          envelope.model
        );
        safeSend({ type: MSG_TYPE.ASSISTANT_RESULT, requestId, cards, dismiss });
      } catch (err) {
        console.error(`[server] Assistant batch ${requestId} failed:`, err.message);
        safeSend({ type: MSG_TYPE.ASSISTANT_RESULT, requestId, cards: [], dismiss: [] });
      }
    }

    // Handle assistant session reset from device
    if (envelope.type === MSG_TYPE.ASSISTANT_NEW) {
      const effectiveId = deviceId || 'ws-device';
      assistantManager.resetSession(effectiveId);
    }

    // Handle abort from device
    if (envelope.type === 'abort') {
      const rid = envelope.requestId;
      console.log(`[server] Abort request for ${rid}`);
      abortedRequests.add(rid);
      const stream = activeTtsStreams.get(rid);
      if (stream) {
        stream.abort();
        activeTtsStreams.delete(rid);
      }
    }

    // Handle TTS interrupt from device
    if (envelope.type === 'tts_interrupt') {
      const rid = envelope.requestId;
      const stream = activeTtsStreams.get(rid);
      if (stream) {
        console.log(`[server] TTS interrupt for ${rid}`);
        stream.abort();
        activeTtsStreams.delete(rid);
      }
    }

    // Health ping from device -- respond with pong so device can detect stale connections
    if (envelope.type === 'health' && envelope.status === 'ping') {
      const currentWs = deviceConnections.get(deviceId) || ws;
      if (currentWs.readyState === 1) {
        currentWs.send(serializeMessage({ type: 'health', status: 'pong' }));
      }
      return;
    }

    // WebSocket size test: sends back messages of increasing size
    if (envelope.type === 'ws_size_test') {
      const sizes = [1000, 5000, 10000, 20000, 30000, 50000, 64000];
      for (const size of sizes) {
        const currentWs = deviceConnections.get(deviceId) || ws;
        if (currentWs.readyState !== 1) break;
        const payload = 'x'.repeat(size);
        await new Promise((resolve, reject) => {
          currentWs.send(serializeMessage({
            type: 'ws_size_test_result',
            size,
            payload,
          }), (err) => err ? reject(err) : resolve());
        });
        console.log(`[server] Size test: sent ${size} chars to ${deviceId}`);
        await new Promise(r => setTimeout(r, 1000)); // 1s between each
      }
      return;
    }

    // Notification TTS -- stream per-sentence to avoid oversized BT messages
    if (envelope.type === 'notification_tts') {
      const { notifId, sender, text, chat } = envelope;
      let ttsText;
      if (sender && chat) {
        // Messenger notification (Telegram etc.) -- include "X wrote:" prefix
        const hasCyrillic = /[\u0400-\u04FF]/.test(text + sender);
        const prefix = hasCyrillic ? 'пишет' : 'wrote';
        ttsText = `${sender} ${prefix}: ${text}`;
      } else if (sender) {
        // Non-messenger (alarm, job) -- just "sender: text", no "wrote"
        ttsText = `${sender}: ${text}`;
      } else {
        ttsText = text;
      }
      console.log(`[server] Notification TTS: ${ttsText.substring(0, 80)}`);
      try {
        // Generate Opus audio (English) or WAV (Russian)
        const audioBuffer = await generateNotifAudio(ttsText);
        console.log(`[server] Notification TTS: ${notifId} ${audioBuffer.length} bytes`);

        const currentWs = deviceConnections.get(deviceId) || ws;
        if (currentWs.readyState !== 1) {
          console.error(`[server] Notification TTS: device ${deviceId} disconnected`);
          return;
        }

        // Send as binary WS frame: [notifId 36 bytes] + [audio data]
        // Binary avoids base64 (33% overhead) + JSON parsing, different OkHttp code path
        const header = Buffer.alloc(36);
        header.write(notifId);
        const binaryPayload = Buffer.concat([header, audioBuffer]);

        await new Promise((resolve, reject) => {
          currentWs.send(binaryPayload, (err) => err ? reject(err) : resolve());
        });
        console.log(`[server] Notification TTS complete: ${notifId} (${binaryPayload.length} bytes binary)`);
      } catch (err) {
        console.error(`[server] Notification TTS failed: ${err.message}`);
        const currentWs = deviceConnections.get(deviceId) || ws;
        if (currentWs.readyState === 1) {
          currentWs.send(serializeMessage({
            type: 'notification_tts_audio',
            notifId,
            audioBase64: '',
            error: err.message,
          }));
        }
      }
      return;
    }

    // Todo: list
    if (envelope.type === MSG_TYPE.TODO_LIST) {
      try {
        const todos = await todoStore.list();
        safeSend({ type: MSG_TYPE.TODO_RESULT, action: 'list', todos });
      } catch (err) {
        console.error('[server] todo_list failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Todo: create
    if (envelope.type === MSG_TYPE.TODO_CREATE) {
      try {
        await todoStore.create(envelope.text);
        const todos = await todoStore.list();
        safeSend({ type: MSG_TYPE.TODO_RESULT, action: 'list', todos });
      } catch (err) {
        console.error('[server] todo_create failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Todo: update
    if (envelope.type === MSG_TYPE.TODO_UPDATE) {
      try {
        const fields = {};
        if (envelope.text !== undefined) fields.text = envelope.text;
        if (envelope.completed !== undefined) fields.completed = envelope.completed;
        if (envelope.priority !== undefined) fields.priority = envelope.priority;
        await todoStore.update(envelope.id, fields);
        const todos = await todoStore.list();
        safeSend({ type: MSG_TYPE.TODO_RESULT, action: 'list', todos });
      } catch (err) {
        console.error('[server] todo_update failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Todo: delete
    if (envelope.type === MSG_TYPE.TODO_DELETE) {
      try {
        await todoStore.remove(envelope.id);
        const todos = await todoStore.list();
        safeSend({ type: MSG_TYPE.TODO_RESULT, action: 'list', todos });
      } catch (err) {
        console.error('[server] todo_delete failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Todo: move (reorder)
    if (envelope.type === MSG_TYPE.TODO_MOVE) {
      try {
        await todoStore.move(envelope.id, envelope.position);
        const todos = await todoStore.list();
        safeSend({ type: MSG_TYPE.TODO_RESULT, action: 'list', todos });
      } catch (err) {
        console.error('[server] todo_move failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Job: list
    if (envelope.type === MSG_TYPE.JOB_LIST) {
      try {
        const jobs = await jobStore.list();
        safeSend({ type: MSG_TYPE.JOB_RESULT, action: 'list', jobs });
      } catch (err) {
        console.error('[server] job_list failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Job: create
    if (envelope.type === MSG_TYPE.JOB_CREATE) {
      try {
        const scheduledDate = new Date(envelope.scheduledAt);
        if (isNaN(scheduledDate.getTime())) throw new Error('Invalid scheduledAt date');
        const job = await jobStore.create(envelope.name, envelope.prompt, scheduledDate);
        const jobs = await jobStore.list();
        safeSend({ type: MSG_TYPE.JOB_RESULT, action: 'list', jobs });
      } catch (err) {
        console.error('[server] job_create failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Job: update
    if (envelope.type === MSG_TYPE.JOB_UPDATE) {
      try {
        const fields = {};
        if (envelope.name !== undefined) fields.name = envelope.name;
        if (envelope.prompt !== undefined) fields.prompt = envelope.prompt;
        if (envelope.scheduledAt !== undefined) {
          const d = new Date(envelope.scheduledAt);
          if (isNaN(d.getTime())) throw new Error('Invalid scheduledAt date');
          fields.scheduledAt = d;
        }
        const job = await jobStore.update(envelope.id, fields);
        const jobs = await jobStore.list();
        safeSend({ type: MSG_TYPE.JOB_RESULT, action: 'list', jobs });
      } catch (err) {
        console.error('[server] job_update failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Job: delete
    if (envelope.type === MSG_TYPE.JOB_DELETE) {
      try {
        await jobStore.remove(envelope.id);
        const jobs = await jobStore.list();
        safeSend({ type: MSG_TYPE.JOB_RESULT, action: 'list', jobs });
      } catch (err) {
        console.error('[server] job_delete failed:', err.message);
        safeSend({ type: MSG_TYPE.ERROR, message: err.message });
      }
    }

    // Telegram saved messages: dispatch to pc-agent
    if (envelope.type === MSG_TYPE.TELEGRAM_SAVED) {
      try {
        const agentEntry = getAgent('pc-agent');
        if (!agentEntry) {
          safeSend({
            type: MSG_TYPE.TELEGRAM_SAVED_RESULT,
            error: 'PC agent not available',
            messages: []
          });
        } else {
          const requestId = crypto.randomUUID();
          const response = await sendDirectAgentRequest(agentEntry, {
            requestId,
            action: 'telegram_read_messages',
            chat: 'me',
            limit: envelope.limit || 50
          });
          if (response.status === 'error') {
            safeSend({
              type: MSG_TYPE.TELEGRAM_SAVED_RESULT,
              error: response.text || 'Telegram fetch failed',
              messages: []
            });
          } else {
            safeSend({
              type: MSG_TYPE.TELEGRAM_SAVED_RESULT,
              messages: response.data?.messages || []
            });
          }
        }
      } catch (err) {
        console.error('[server] telegram_saved failed:', err.message);
        safeSend({
          type: MSG_TYPE.TELEGRAM_SAVED_RESULT,
          error: err.message,
          messages: []
        });
      }
    }

    // Telegram chat list: dispatch to pc-agent
    if (envelope.type === MSG_TYPE.TELEGRAM_CHAT_LIST) {
      console.log(`[server] Handling telegram_chat_list from ${deviceId}, limit=${envelope.limit}`);
      try {
        const agentEntry = getAgent('pc-agent');
        if (!agentEntry) {
          console.log('[server] telegram_chat_list: pc-agent NOT available');
          safeSend({ type: MSG_TYPE.TELEGRAM_CHAT_LIST_RESULT, error: 'PC agent not available', chats: [] });
        } else {
          console.log('[server] telegram_chat_list: dispatching to pc-agent');
          const requestId = crypto.randomUUID();
          const response = await sendDirectAgentRequest(agentEntry, {
            requestId,
            action: 'telegram_list_chats_detailed',
            limit: envelope.limit || 20
          });
          console.log(`[server] telegram_chat_list: pc-agent responded status=${response.status} chats=${response.data?.chats?.length ?? 0}`);
          if (response.status === 'error') {
            safeSend({ type: MSG_TYPE.TELEGRAM_CHAT_LIST_RESULT, error: response.text || 'Telegram fetch failed', chats: [] });
          } else {
            safeSend({ type: MSG_TYPE.TELEGRAM_CHAT_LIST_RESULT, chats: response.data?.chats || [] });
          }
        }
      } catch (err) {
        console.error('[server] telegram_chat_list failed:', err.message);
        safeSend({ type: MSG_TYPE.TELEGRAM_CHAT_LIST_RESULT, error: err.message, chats: [] });
      }
    }

    // Telegram messages: dispatch to pc-agent
    if (envelope.type === MSG_TYPE.TELEGRAM_MESSAGES) {
      console.log(`[server] Handling telegram_messages from ${deviceId}, chatId=${envelope.chatId} limit=${envelope.limit}`);
      try {
        const agentEntry = getAgent('pc-agent');
        if (!agentEntry) {
          console.log('[server] telegram_messages: pc-agent NOT available');
          safeSend({ type: MSG_TYPE.TELEGRAM_MESSAGES_RESULT, error: 'PC agent not available', messages: [] });
        } else {
          console.log('[server] telegram_messages: dispatching to pc-agent');
          const requestId = crypto.randomUUID();
          const response = await sendDirectAgentRequest(agentEntry, {
            requestId,
            action: 'telegram_read_messages',
            chat: envelope.chatId,
            limit: envelope.limit || 50,
            topicId: envelope.topicId || null,
            offsetId: envelope.offsetId || null
          });
          console.log(`[server] telegram_messages: pc-agent responded status=${response.status} msgs=${response.data?.messages?.length ?? 0}`);
          if (response.status === 'error') {
            safeSend({ type: MSG_TYPE.TELEGRAM_MESSAGES_RESULT, chatId: envelope.chatId, error: response.text || 'Telegram fetch failed', messages: [] });
          } else {
            safeSend({ type: MSG_TYPE.TELEGRAM_MESSAGES_RESULT, chatId: envelope.chatId, messages: response.data?.messages || [] });
          }
        }
      } catch (err) {
        console.error('[server] telegram_messages failed:', err.message);
        safeSend({ type: MSG_TYPE.TELEGRAM_MESSAGES_RESULT, chatId: envelope.chatId, error: err.message, messages: [] });
      }
    }

    // Telegram topics: dispatch to pc-agent
    if (envelope.type === MSG_TYPE.TELEGRAM_TOPICS) {
      try {
        const agentEntry = getAgent('pc-agent');
        if (!agentEntry) {
          safeSend({ type: MSG_TYPE.TELEGRAM_TOPICS_RESULT, error: 'PC agent not available', topics: [] });
        } else {
          const requestId = crypto.randomUUID();
          const response = await sendDirectAgentRequest(agentEntry, {
            requestId,
            action: 'telegram_list_topics',
            chatId: envelope.chatId,
            limit: envelope.limit || 20
          });
          if (response.status === 'error') {
            safeSend({ type: MSG_TYPE.TELEGRAM_TOPICS_RESULT, chatId: envelope.chatId, error: response.text, topics: [] });
          } else {
            safeSend({ type: MSG_TYPE.TELEGRAM_TOPICS_RESULT, chatId: envelope.chatId, topics: response.data?.topics || [] });
          }
        }
      } catch (err) {
        safeSend({ type: MSG_TYPE.TELEGRAM_TOPICS_RESULT, chatId: envelope.chatId, error: err.message, topics: [] });
      }
    }

    // Telegram send: dispatch to pc-agent
    if (envelope.type === MSG_TYPE.TELEGRAM_SEND) {
      try {
        const agentEntry = getAgent('pc-agent');
        if (!agentEntry) {
          safeSend({ type: MSG_TYPE.TELEGRAM_SEND_RESULT, error: 'PC agent not available' });
        } else {
          const requestId = crypto.randomUUID();
          const response = await sendDirectAgentRequest(agentEntry, {
            requestId,
            action: 'telegram_send_message',
            chat: envelope.chatId,
            text: envelope.text,
            topicId: envelope.topicId || null
          });
          if (response.status === 'error') {
            safeSend({ type: MSG_TYPE.TELEGRAM_SEND_RESULT, error: response.text || 'Telegram send failed' });
          } else {
            safeSend({ type: MSG_TYPE.TELEGRAM_SEND_RESULT, ...response.data });
          }
        }
      } catch (err) {
        console.error('[server] telegram_send failed:', err.message);
        safeSend({ type: MSG_TYPE.TELEGRAM_SEND_RESULT, error: err.message });
      }
    }

    // Telegram subscribe: store subscriber ws + forward to pc-agent
    if (envelope.type === MSG_TYPE.TELEGRAM_SUBSCRIBE) {
      telegramSubscriberWs = ws;
      console.log(`[server] Telegram subscriber set: ${deviceId}`);
      try {
        const agentEntry = getAgent('pc-agent');
        if (agentEntry) {
          const requestId = crypto.randomUUID();
          await sendDirectAgentRequest(agentEntry, { requestId, action: 'telegram_subscribe' });
        }
      } catch (err) {
        console.error('[server] telegram_subscribe to agent failed:', err.message);
      }
    }

    // Telegram unsubscribe: clear subscriber + forward to pc-agent
    if (envelope.type === MSG_TYPE.TELEGRAM_UNSUBSCRIBE) {
      telegramSubscriberWs = null;
      console.log(`[server] Telegram subscriber cleared: ${deviceId}`);
      try {
        const agentEntry = getAgent('pc-agent');
        if (agentEntry) {
          const requestId = crypto.randomUUID();
          await sendDirectAgentRequest(agentEntry, { requestId, action: 'telegram_unsubscribe' });
        }
      } catch (err) {
        console.error('[server] telegram_unsubscribe to agent failed:', err.message);
      }
    }

    // Phone requests a desktop stream
    if (envelope.type === MSG_TYPE.STREAM_REQUEST) {
      const targetWs = deviceConnections.get(envelope.targetDeviceId);
      if (!targetWs || targetWs.readyState !== 1) {
        ws.send(serializeMessage({
          type: MSG_TYPE.ERROR,
          message: `Target device '${envelope.targetDeviceId}' not connected`
        }));
        return;
      }
      const streamId = nextStreamId++;
      // Send stream_start to desktop as a device_command
      const monitor = envelope.monitor ?? 0;
      try {
        targetWs.send(serializeMessage({
          type: MSG_TYPE.DEVICE_COMMAND,
          command: {
            type: 'start_screen_stream',
            streamId,
            resolution: envelope.resolution || '720p',
            monitor,
            fps: envelope.fps || 24,
            preset: envelope.preset || 'ultrafast',
            profile: envelope.profile || 'baseline',
            keyframeInterval: envelope.keyframeInterval || 2
          }
        }));
      } catch {}

      // Store pending session -- will be confirmed when desktop responds
      streamSessions.set(streamId, {
        sourceDeviceId: envelope.targetDeviceId,
        sourceMainWs: targetWs,
        targetDeviceId: deviceId,
        targetMainWs: ws,
        videoSourceWs: null,
        videoTargetWs: null,
        audioSourceWs: null,
        audioTargetWs: null,
        mouseSourceWs: null,
        mouseTargetWs: null,
        keyboardSourceWs: null,
        keyboardTargetWs: null,
        pending: true,
        startedAt: Date.now()
      });
      console.log(`[server] Stream ${streamId}: requested from '${envelope.targetDeviceId}' by '${deviceId}'`);
    }

    // Desktop confirms stream start via device_response
    if (envelope.type === MSG_TYPE.DEVICE_RESPONSE && envelope.payload?.streamId) {
      const streamId = envelope.payload.streamId;
      const session = streamSessions.get(streamId);
      if (session && session.pending) {
        session.pending = false;
        // Send stream_ack to the requesting device (phone)
        try {
          session.targetMainWs.send(serializeMessage({
            type: MSG_TYPE.STREAM_ACK,
            streamId,
            width: envelope.payload.width,
            height: envelope.payload.height,
            fps: envelope.payload.fps,
            monitorCount: envelope.payload.monitorCount || 1
          }));
        } catch {}
        console.log(`[server] Stream ${streamId}: confirmed ${envelope.payload.width}x${envelope.payload.height}@${envelope.payload.fps}fps`);

        // Generate tokens for video + mouse and send stream_connect to both sides
        const tokens = generateStreamTokens(streamId, session.sourceDeviceId, session.targetDeviceId, ['video', 'mouse', 'keyboard']);

        for (const streamType of ['video', 'mouse', 'keyboard']) {
          const endpoint = `/ws/stream/${streamId}/${streamType}`;
          sendStreamConnect(session.sourceMainWs, streamId, streamType, endpoint, tokens[streamType].sourceToken);
          sendStreamConnect(session.targetMainWs, streamId, streamType, endpoint, tokens[streamType].targetToken);
        }
      }
    }

    // Phone or desktop stops a stream
    if (envelope.type === MSG_TYPE.STREAM_STOP) {
      const session = streamSessions.get(envelope.streamId);
      if (session) {
        // Forward stop to the desktop (source)
        if (session.sourceMainWs.readyState === 1) {
          try {
            session.sourceMainWs.send(serializeMessage({
              type: MSG_TYPE.DEVICE_COMMAND,
              command: { type: 'stop_screen_stream', streamId: envelope.streamId }
            }));
          } catch {}
        }
        endStreamSession(envelope.streamId, 'stopped');
        console.log(`[server] Stream ${envelope.streamId}: stopped by '${deviceId}'`);
      }
    }

    // Phone requests monitor switch on active stream
    if (envelope.type === MSG_TYPE.STREAM_SWITCH_MONITOR) {
      const session = streamSessions.get(envelope.streamId);
      if (session && session.sourceMainWs.readyState === 1) {
        try {
          session.sourceMainWs.send(serializeMessage({
            type: MSG_TYPE.DEVICE_COMMAND,
            command: { type: 'switch_monitor', monitor: envelope.monitor ?? 0 }
          }));
        } catch {}
        console.log(`[server] Stream ${envelope.streamId}: monitor switch to ${envelope.monitor ?? 0} by '${deviceId}'`);
      }
    }

    // Desktop signals stream ended
    if (envelope.type === MSG_TYPE.STREAM_ENDED) {
      endStreamSession(envelope.streamId, envelope.reason || 'unknown');
    }

    // Phone requests audio relay from desktop
    if (envelope.type === MSG_TYPE.AUDIO_RELAY_START) {
      const targetWs = deviceConnections.get(envelope.targetDeviceId);
      if (!targetWs || targetWs.readyState !== 1) {
        ws.send(serializeMessage({
          type: MSG_TYPE.ERROR,
          message: `Target device '${envelope.targetDeviceId}' not connected`
        }));
        return;
      }
      // Ensure a stream session exists so the ACK handler can find the phone.
      // If a previous audio-only session exists, recycle it (reset webrtcInitiated
      // so a fresh offer/answer cycle can start).
      let hasSession = false;
      for (const [sid, session] of streamSessions) {
        if (session.sourceMainWs === targetWs && session.targetMainWs === ws) {
          hasSession = true;
          if (session.webrtcInitiated) {
            session.webrtcInitiated = false;
            console.log(`[server] Audio relay: recycled session ${sid} (reset webrtcInitiated)`);
          }
          break;
        }
      }
      if (!hasSession) {
        const streamId = nextStreamId++;
        streamSessions.set(streamId, {
          sourceDeviceId: envelope.targetDeviceId,
          sourceMainWs: targetWs,
          targetDeviceId: deviceId,
          targetMainWs: ws,
          videoSourceWs: null,
          videoTargetWs: null,
          audioSourceWs: null,
          audioTargetWs: null,
          mouseSourceWs: null,
          mouseTargetWs: null,
          keyboardSourceWs: null,
          keyboardTargetWs: null,
          pending: false,
          audioOnly: true,
          startedAt: Date.now()
        });
        console.log(`[server] Audio relay: created audio-only session ${streamId} (${envelope.targetDeviceId} -> ${deviceId})`);
      }
      // Forward as device_command to the desktop
      try {
        targetWs.send(serializeMessage({
          type: MSG_TYPE.DEVICE_COMMAND,
          command: {
            type: 'start_audio_relay',
            bitrate: envelope.bitrate || 64000,
            desktopBuffer: envelope.desktopBuffer || 1.0,
            sampleRate: envelope.sampleRate || 48000,
            channels: envelope.channels || 2
          }
        }));
      } catch {}
      console.log(`[server] Audio relay: start requested from '${envelope.targetDeviceId}' by '${deviceId}'`);
    }

    // Phone stops audio relay
    if (envelope.type === MSG_TYPE.AUDIO_RELAY_STOP) {
      const targetWs = deviceConnections.get(envelope.targetDeviceId);
      if (targetWs && targetWs.readyState === 1) {
        try {
          targetWs.send(serializeMessage({
            type: MSG_TYPE.DEVICE_COMMAND,
            command: { type: 'stop_audio_relay' }
          }));
        } catch {}
      }
      // Clean up audio-only sessions (don't touch sessions that also have video)
      const audioStopIds = [];
      for (const [streamId, session] of streamSessions) {
        if (session.audioOnly && session.targetMainWs === ws && session.sourceDeviceId === envelope.targetDeviceId) {
          audioStopIds.push(streamId);
        }
      }
      for (const streamId of audioStopIds) {
        endStreamSession(streamId, 'audio_relay_stop');
      }
      console.log(`[server] Audio relay: stop requested for '${envelope.targetDeviceId}' by '${deviceId}'`);
    }

    // Phone sends audio relay config update (realtime, no restart)
    if (envelope.type === MSG_TYPE.AUDIO_RELAY_CONFIG) {
      const targetWs = deviceConnections.get(envelope.targetDeviceId);
      if (targetWs && targetWs.readyState === 1) {
        try {
          targetWs.send(serializeMessage({
            type: MSG_TYPE.DEVICE_COMMAND,
            command: {
              type: 'audio_relay_config',
              desktopBuffer: envelope.desktopBuffer || 1.0
            }
          }));
        } catch {}
      }
      console.log(`[server] Audio relay config update for '${envelope.targetDeviceId}' by '${deviceId}': buffer=${envelope.desktopBuffer}s`);
    }

    // Desktop reports audio relay error -- forward to phone and clean up session
    if (envelope.type === MSG_TYPE.AUDIO_RELAY_ERROR) {
      for (const [streamId, session] of streamSessions) {
        if (session.sourceMainWs === ws && session.audioOnly && session.targetMainWs.readyState === 1) {
          try {
            session.targetMainWs.send(serializeMessage({
              type: MSG_TYPE.AUDIO_RELAY_ERROR,
              reason: envelope.reason || 'unknown'
            }));
          } catch {}
          endStreamSession(streamId, `audio_relay_error: ${envelope.reason}`);
          break;
        }
      }
      console.log(`[server] Audio relay error from '${deviceId}': ${envelope.reason}`);
    }

    // Desktop reports stream error -- forward to phone
    if (envelope.type === MSG_TYPE.STREAM_ERROR) {
      for (const [streamId, session] of streamSessions) {
        if (session.sourceMainWs === ws && session.targetMainWs.readyState === 1) {
          try {
            session.targetMainWs.send(serializeMessage({
              type: MSG_TYPE.STREAM_ERROR,
              reason: envelope.reason || 'unknown',
              streamId
            }));
          } catch {}
          break;
        }
      }
      console.log(`[server] Stream error from '${deviceId}': ${envelope.reason}`);
    }

    // Desktop confirms audio relay started
    if (envelope.type === MSG_TYPE.AUDIO_RELAY_ACK) {
      // Find the session where this desktop is source and forward ACK to phone
      let matchedStreamId = null;
      for (const [streamId, session] of streamSessions) {
        if (session.sourceMainWs === ws && session.targetMainWs.readyState === 1) {
          matchedStreamId = streamId;
          try {
            session.targetMainWs.send(serializeMessage({
              type: MSG_TYPE.AUDIO_RELAY_ACK,
              sampleRate: envelope.sampleRate || 48000,
              channels: envelope.channels || 2,
              bitrate: envelope.bitrate || 64000,
              frameSize: envelope.frameSize || 2880,
              frameDurationMs: envelope.frameDurationMs || 60
            }));
          } catch {}

          // Send webrtc_initiate to desktop only once per session
          if (!session.webrtcInitiated) {
            session.webrtcInitiated = true;
            const initiateMsg = serializeMessage({
              type: MSG_TYPE.WEBRTC_INITIATE,
              streamId: matchedStreamId
            });
            session.sourceMainWs.send(initiateMsg);
            console.log('[server] Sent webrtc_initiate to desktop for stream %d', matchedStreamId);
          }

          break;
        }
      }
      console.log(`[server] Audio relay ACK from '${deviceId}'`);
    }

    // WebRTC signaling relay: offer from desktop -> phone
    if (envelope.type === MSG_TYPE.WEBRTC_OFFER) {
      const { streamId, sdp } = envelope;
      for (const [sid, session] of streamSessions) {
        if (sid === streamId && session.targetMainWs) {
          session.targetMainWs.send(serializeMessage({ type: MSG_TYPE.WEBRTC_OFFER, streamId, sdp }));
          console.log('[server] Relayed webrtc_offer for stream %d to phone', streamId);
          break;
        }
      }
    }

    // WebRTC signaling relay: answer from phone -> desktop
    if (envelope.type === MSG_TYPE.WEBRTC_ANSWER) {
      const { streamId, sdp } = envelope;
      for (const [sid, session] of streamSessions) {
        if (sid === streamId && session.sourceMainWs) {
          session.sourceMainWs.send(serializeMessage({ type: MSG_TYPE.WEBRTC_ANSWER, streamId, sdp }));
          console.log('[server] Relayed webrtc_answer for stream %d to desktop', streamId);
          break;
        }
      }
    }

    // WebRTC signaling relay: ICE candidates (bidirectional)
    if (envelope.type === MSG_TYPE.WEBRTC_ICE) {
      const { streamId, candidate, sdpMid, sdpMLineIndex } = envelope;
      for (const [sid, session] of streamSessions) {
        if (sid === streamId) {
          const peerWs = (ws === session.sourceMainWs) ? session.targetMainWs : session.sourceMainWs;
          if (peerWs && peerWs.readyState === 1) {
            peerWs.send(serializeMessage({ type: MSG_TYPE.WEBRTC_ICE, streamId, candidate, sdpMid, sdpMLineIndex }));
          }
          break;
        }
      }
    }

    // Remote control messages from phone -> rc-handler
    if (envelope.type === MSG_TYPE.RC_PERMISSION_RESPONSE || envelope.type === MSG_TYPE.RC_USER_RESPONSE || envelope.type === MSG_TYPE.RC_USER_MESSAGE || envelope.type === MSG_TYPE.RC_MODE_CHANGE || envelope.type === 'rc_interrupt' || envelope.type === 'rc_transcript_request' || envelope.type === 'rc_setting_change') {
      handleRcPhoneMessage(deviceId, envelope, ws);
      return;
    }

    // RC session revive from phone
    if (envelope.type === 'rc_revive') {
      handleRcRevive(deviceId, envelope, ws).then(result => {
        if (result) {
          // Start a new desktop session for the revived session
          // The phone will send the user message next, which will be queued
          console.log(`[index] RC session revived: ${result.sessionId}`);
        }
      }).catch(err => {
        console.error(`[index] RC revive failed: ${err.message}`);
      });
      return;
    }

    // Device responses (to device commands) are handled by the dispatcher's listener
  });

  ws.on('close', () => {
    if (deviceId) {
      // Only remove if this ws is still the active connection (avoids stale close events
      // from old connections deleting the new connection's entry)
      if (deviceConnections.get(deviceId) === ws) {
        deviceConnections.delete(deviceId);
        // Abort all active TTS streams only for the current connection
        for (const [rid, stream] of activeTtsStreams) {
          stream.abort();
          activeTtsStreams.delete(rid);
        }
        abortedRequests.clear();
      }

      // Clean up telegram subscriber if this device was the subscriber
      if (telegramSubscriberWs === ws) {
        telegramSubscriberWs = null;
        console.log(`[server] Telegram subscriber cleared on disconnect: ${deviceId}`);
        // Unsubscribe from pc-agent
        try {
          const agentEntry = getAgent('pc-agent');
          if (agentEntry) {
            const requestId = crypto.randomUUID();
            sendDirectAgentRequest(agentEntry, { requestId, action: 'telegram_unsubscribe' }).catch(() => {});
          }
        } catch {}
      }

      // Clean up stream sessions involving this device (collect IDs first to avoid mutating Map during iteration)
      const sessionIdsToEnd = [];
      for (const [streamId, session] of streamSessions) {
        if (session.sourceDeviceId === deviceId || session.targetDeviceId === deviceId) {
          sessionIdsToEnd.push(streamId);
        }
      }
      for (const streamId of sessionIdsToEnd) {
        const session = streamSessions.get(streamId);
        // If the disconnecting device was the requestor (target), tell the source to stop producing.
        if (session && session.targetDeviceId === deviceId && session.sourceMainWs && session.sourceMainWs.readyState === 1) {
          const stopType = session.audioOnly ? 'stop_audio_relay' : 'stop_screen_stream';
          try {
            session.sourceMainWs.send(serializeMessage({
              type: MSG_TYPE.DEVICE_COMMAND,
              command: { type: stopType }
            }));
            console.log(`[server] Stream ${streamId}: sent ${stopType} to source on requestor disconnect`);
          } catch {}
        }
        endStreamSession(streamId, 'device_disconnected');
      }

      console.log(`[server] Device disconnected: ${deviceId}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[server] Device WS error${deviceId ? ` (${deviceId})` : ''}:`, err.message);
  });
}

// --- Transcriber service (inbound connection from transcriber) ---
let connectedTranscriberWs = null;
let activeTranscribePhoneWs = null;
let pendingTranscribeConfig = null; // buffered start config when transcriber not yet connected

// Per-session state for provider routing.
//
// SINGLE-PHONE ASSUMPTION: this orchestrator currently routes one transcribe
// session at a time. The local transcriber bridge has no turn-ID concept, and
// the response routing in handleTranscriberServiceConnection writes back to
// activeTranscribePhoneWs without disambiguation. A second phone connecting to
// /ws/transcribe is rejected up-front (see handleTranscribeConnection) so we
// never silently overwrite the in-flight session. The Anthropic path (HTTP/SSE)
// is technically per-request and could fan out, but is gated by the same
// rejection for symmetry.
let activeProvider = null;       // 'local' | 'anthropic'
let audioBuffer = [];             // bounded ring of recent audio frames for fallback replay
let audioBufferBytes = 0;         // running byte count of audioBuffer
const AUDIO_BUFFER_MAX_BYTES = 10 * 16000 * 2; // ~10s of 16 kHz PCM16 mono = 320 KB
let startConfig = null;           // original start message for fallback replay
let activeSttHttp = null;         // { req, turnId, lang } while an Anthropic HTTP request is open

/**
 * Transcriber service connects here (inbound, like agents).
 * Stays connected persistently. Receives audio, sends back transcriptions.
 */
function handleTranscriberServiceConnection(ws) {
  console.log('[server] Transcriber service connected');
  connectedTranscriberWs = ws;

  // Replay start config so a reconnecting transcriber picks up the active session.
  // pendingTranscribeConfig is set when the phone sent start before any transcriber
  // was connected; startConfig is set on every start message the phone sends.
  const replayConfig = pendingTranscribeConfig?.toString() || startConfig;
  if (replayConfig && ws.readyState === WebSocket.OPEN) {
    console.log(`[transcribe-relay] Replaying start config to reconnected transcriber: ${replayConfig.substring(0, 80)}`);
    try { ws.send(replayConfig); } catch {}
    pendingTranscribeConfig = null;
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    console.log(`[transcriber-svc] Response from transcriber: ${text.substring(0, 80)}`);
    const phoneWs = activeTranscribePhoneWs;
    if (phoneWs && phoneWs.readyState === WebSocket.OPEN) {
      try { phoneWs.send(text); } catch {}
    } else {
      console.log(`[transcriber-svc] No active phone WS to relay to (phoneWs=${phoneWs ? 'exists' : 'null'}, readyState=${phoneWs?.readyState})`);
    }
  });

  ws.on('close', () => {
    console.log('[server] Transcriber service disconnected');
    if (connectedTranscriberWs === ws) connectedTranscriberWs = null;
  });

  ws.on('error', (err) => {
    console.error('[server] Transcriber service error:', err.message);
    if (connectedTranscriberWs === ws) connectedTranscriberWs = null;
  });
}

/**
 * Open an HTTP streaming POST to the Anthropic STT service for one utterance.
 * The request body is a chunked PCM16LE stream we write into as audio frames
 * arrive from the phone. The response is text/event-stream; we parse SSE events
 * and relay them to the phone (`partial` -> `transcription`, `final` -> `final`,
 * `error` -> trigger local fallback when retryable=false).
 *
 * Returns the request object on success or null if the service is unreachable.
 */
function openAnthropicSttHttp(lang, turnId) {
  let parsed;
  try {
    parsed = new URL(`${config.anthropicSttUrl}/v1/transcribe`);
  } catch (err) {
    console.error(`[anthropic-stt-http] Bad URL ${config.anthropicSttUrl}: ${err.message}`);
    return null;
  }
  parsed.searchParams.set('lang', lang || 'en');
  parsed.searchParams.set('turnId', turnId);

  const httpMod = parsed.protocol === 'https:' ? https : http;
  const req = httpMod.request({
    method: 'POST',
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Transfer-Encoding': 'chunked',
      'X-Turn-Id': turnId,
      'Accept': 'text/event-stream',
    },
  });

  req.on('response', (res) => {
    console.log(`[anthropic-stt-http] turn=${turnId} response status=${res.statusCode}`);
    if (res.statusCode !== 200) {
      // Bounded error-body collection so a misbehaving STT can't blow our heap.
      const ERROR_BODY_MAX = 4096;
      const errBufs = [];
      let errBytes = 0;
      let truncated = false;
      res.on('data', (c) => {
        if (errBytes >= ERROR_BODY_MAX) { truncated = true; return; }
        const take = Math.min(c.length, ERROR_BODY_MAX - errBytes);
        errBufs.push(c.subarray(0, take));
        errBytes += take;
        if (take < c.length) truncated = true;
      });
      res.on('end', () => {
        const body = Buffer.concat(errBufs).toString('utf8');
        console.error(`[anthropic-stt-http] turn=${turnId} non-200: ${body}${truncated ? '...[truncated]' : ''}`);
        if (activeSttHttp && activeSttHttp.req === req) {
          triggerLocalFallback();
        }
      });
      return;
    }

    // SSE parser. Use StringDecoder so multi-byte UTF-8 codepoints split across
    // TCP segments do not turn into replacement characters.
    const decoder = new StringDecoder('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let eventName = 'message';
        const lines = block.split('\n');
        let dataLine = '';
        for (const ln of lines) {
          if (ln.startsWith(':')) continue;
          if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
          else if (ln.startsWith('data:')) dataLine += ln.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload;
        try { payload = JSON.parse(dataLine); } catch { continue; }
        const phoneWs = activeTranscribePhoneWs;
        if (eventName === 'partial') {
          if (phoneWs && phoneWs.readyState === WebSocket.OPEN) {
            console.log(`[anthropic-stt-http] turn=${turnId} -> phone PARTIAL len=${(payload.text||'').length}`);
            try { phoneWs.send(JSON.stringify({ type: 'transcription', text: payload.text || '' })); } catch {}
          }
        } else if (eventName === 'final') {
          if (phoneWs && phoneWs.readyState === WebSocket.OPEN) {
            try { phoneWs.send(JSON.stringify({ type: 'final', text: payload.text || '' })); } catch {}
          }
        } else if (eventName === 'error') {
          console.error(`[anthropic-stt-http] turn=${turnId} sse error: ${payload.message || ''} retryable=${payload.retryable}`);
          if (payload.retryable === false) {
            if (activeSttHttp && activeSttHttp.req === req) triggerLocalFallback();
          } else if (phoneWs && phoneWs.readyState === WebSocket.OPEN) {
            try { phoneWs.send(JSON.stringify({ type: 'error', message: payload.message || 'STT error' })); } catch {}
          }
        }
      }
    });
    res.on('end', () => {
      console.log(`[anthropic-stt-http] turn=${turnId} response ended`);
      if (activeSttHttp && activeSttHttp.req === req) activeSttHttp = null;
      const phoneWs = activeTranscribePhoneWs;
      if (phoneWs && phoneWs.readyState === WebSocket.OPEN) {
        try { phoneWs.send(JSON.stringify({ type: 'done' })); } catch {}
      }
    });
    res.on('error', (err) => {
      console.error(`[anthropic-stt-http] turn=${turnId} response error: ${err.message}`);
      if (activeSttHttp && activeSttHttp.req === req) {
        activeSttHttp = null;
        triggerLocalFallback();
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[anthropic-stt-http] turn=${turnId} request error: ${err.message}`);
    if (activeSttHttp && activeSttHttp.req === req) {
      activeSttHttp = null;
      triggerLocalFallback();
    }
  });

  return req;
}

/**
 * Switch from Anthropic to local transcriber mid-session.
 * Replays buffered start config + audio frames to local transcriber.
 */
function triggerLocalFallback() {
  activeProvider = 'local';
  // Tear down any in-flight Anthropic HTTP request so frames don't keep streaming
  // into a dead pipe.
  if (activeSttHttp) {
    try { activeSttHttp.req.destroy(); } catch {}
    activeSttHttp = null;
  }
  const tWs = connectedTranscriberWs;
  if (!tWs || tWs.readyState !== WebSocket.OPEN) {
    console.error('[fallback] No local transcriber connected, cannot fall back');
    const phoneWs = activeTranscribePhoneWs;
    if (phoneWs && phoneWs.readyState === WebSocket.OPEN) {
      try { phoneWs.send(JSON.stringify({ type: 'error', message: 'Both Anthropic and local transcriber unavailable' })); } catch {}
    }
    return;
  }

  // Replay start config (without provider field, so transcriber handles it normally)
  if (startConfig) {
    let cfg;
    try { cfg = JSON.parse(startConfig); } catch { cfg = { type: 'start', sampleRate: 16000 }; }
    delete cfg.provider;
    const cfgStr = JSON.stringify(cfg);
    console.log(`[fallback] Replaying start config to local transcriber: ${cfgStr.substring(0, 80)}`);
    try { tWs.send(cfgStr); } catch {}
  }

  // Replay buffered audio
  console.log(`[fallback] Replaying ${audioBuffer.length} buffered audio frames to local transcriber`);
  for (const frame of audioBuffer) {
    try { tWs.send(frame, { binary: true }); } catch {}
  }
  audioBuffer = [];
  audioBufferBytes = 0;
}

/**
 * Phone connects here for streaming transcription.
 * Routes to Anthropic STT or local transcriber based on provider in start message.
 * Buffers audio for fallback replay when using Anthropic.
 */
function handleTranscribeConnection(phoneWs) {
  let binaryFrameCount = 0;
  let droppedFrameCount = 0;

  // Single-phone guard: close the previous connection if still open (stale WS
  // from before a reconnect or pod restart). Accepting the new one is safer than
  // rejecting, which causes reconnect loops.
  if (activeTranscribePhoneWs && activeTranscribePhoneWs.readyState === WebSocket.OPEN) {
    console.warn('[server] Closing stale transcribe phone connection, accepting new one');
    try { activeTranscribePhoneWs.close(1000, 'replaced'); } catch {}
  }

  console.log('[server] New transcribe relay connection');
  activeTranscribePhoneWs = phoneWs;
  activeProvider = null;
  audioBuffer = [];
  audioBufferBytes = 0;
  startConfig = null;

  phoneWs.on('message', (data, isBinary) => {
    if (isBinary) {
      binaryFrameCount++;

      if (activeProvider === 'anthropic') {
        // Bounded ring of recent audio frames: enough for fallback replay, capped
        // so a long anthropic session (or a stuck STT) can't grow the heap.
        const buf = Buffer.from(data);
        audioBuffer.push(buf);
        audioBufferBytes += buf.length;
        while (audioBufferBytes > AUDIO_BUFFER_MAX_BYTES && audioBuffer.length > 1) {
          audioBufferBytes -= audioBuffer.shift().length;
        }
        const sttReq = activeSttHttp?.req;
        if (sttReq && !sttReq.destroyed && sttReq.writable) {
          if (binaryFrameCount % 50 === 1) {
            console.log(`[transcribe-relay] Relayed binary frame #${binaryFrameCount} to Anthropic STT HTTP (${data.length} bytes)`);
          }
          try {
            const writeOk = sttReq.write(buf);
            if (!writeOk) {
              // Pause incoming phone audio until STT drains. Use the underlying
              // socket because the ws library does not expose pause/resume.
              const sock = phoneWs._socket;
              if (sock && !sock.isPaused()) {
                sock.pause();
                sttReq.once('drain', () => {
                  try { if (sock.isPaused()) sock.resume(); } catch {}
                });
              }
            }
          } catch (err) {
            console.error(`[transcribe-relay] STT write failed: ${err.message}`);
          }
        } else {
          console.log('[transcribe-relay] Anthropic STT request not writable, triggering fallback');
          triggerLocalFallback();
        }
        return;
      }

      // Local provider (or no provider yet)
      const tWs = connectedTranscriberWs;
      if (!tWs || tWs.readyState !== WebSocket.OPEN) {
        droppedFrameCount++;
        if (droppedFrameCount % 50 === 1) {
          console.log(`[transcribe-relay] DROPPED binary frame #${droppedFrameCount} (no transcriber connected)`);
        }
        return;
      }
      if (binaryFrameCount % 50 === 1) {
        console.log(`[transcribe-relay] Relayed binary frame #${binaryFrameCount} (${data.length} bytes)`);
      }
      try { tWs.send(data, { binary: true }); } catch {}
      return;
    }

    // JSON control message
    const text = data.toString();
    let msg;
    try { msg = JSON.parse(text); } catch { msg = null; }

    if (msg && msg.type === 'start') {
      const provider = msg.provider || 'local';
      startConfig = text;
      console.log(`[transcribe-relay] Start message: provider=${provider}, sourceLang=${msg.sourceLang || 'auto'}`);

      // End any prior in-flight Anthropic request before opening a new one.
      if (activeSttHttp) {
        try { activeSttHttp.req.destroy(); } catch {}
        activeSttHttp = null;
      }

      if (provider === 'anthropic') {
        const turnId = `t_${crypto.randomUUID()}`;
        const lang = msg.sourceLang || 'en';
        const req = openAnthropicSttHttp(lang, turnId);
        if (req) {
          activeProvider = 'anthropic';
          audioBuffer = [];
          audioBufferBytes = 0;
          activeSttHttp = { req, turnId, lang };
          console.log(`[transcribe-relay] Opened Anthropic STT HTTP turn=${turnId} lang=${lang}`);
        } else {
          activeProvider = 'local';
          console.log('[transcribe-relay] Failed to open Anthropic STT HTTP, falling back to local');
          const tWs = connectedTranscriberWs;
          const fwd = { ...msg };
          delete fwd.provider;
          if (tWs && tWs.readyState === WebSocket.OPEN) {
            try { tWs.send(JSON.stringify(fwd)); } catch {}
          } else {
            pendingTranscribeConfig = Buffer.from(JSON.stringify(fwd));
          }
        }
      } else {
        activeProvider = 'local';
        const tWs = connectedTranscriberWs;
        if (tWs && tWs.readyState === WebSocket.OPEN) {
          if (msg.provider) {
            delete msg.provider;
            try { tWs.send(JSON.stringify(msg)); } catch {}
          } else {
            try { tWs.send(text); } catch {}
          }
        } else {
          pendingTranscribeConfig = data;
          console.log(`[transcribe-relay] Buffered control (no transcriber): ${text.substring(0, 80)}`);
        }
      }
      return;
    }

    if (msg && msg.type === 'stop') {
      console.log(`[transcribe-relay] Stop message, activeProvider=${activeProvider}`);
      if (activeProvider === 'anthropic') {
        const sttReq = activeSttHttp?.req;
        if (sttReq && !sttReq.destroyed && sttReq.writable) {
          try { sttReq.end(); } catch {}
        }
      } else {
        const tWs = connectedTranscriberWs;
        if (tWs && tWs.readyState === WebSocket.OPEN) {
          try { tWs.send(text); } catch {}
        }
      }
      return;
    }

    // Other control messages -- only the local provider supports them.
    if (activeProvider === 'local') {
      const tWs = connectedTranscriberWs;
      if (tWs && tWs.readyState === WebSocket.OPEN) {
        try { tWs.send(text); } catch {}
      }
    }
  });

  phoneWs.on('close', () => {
    console.log('[server] Transcribe relay phone disconnected');
    if (activeTranscribePhoneWs === phoneWs) activeTranscribePhoneWs = null;
    if (activeProvider === 'anthropic') {
      const sttReq = activeSttHttp?.req;
      if (sttReq && !sttReq.destroyed && sttReq.writable) {
        try { sttReq.end(); } catch {}
      }
    } else {
      const tWs = connectedTranscriberWs;
      if (tWs && tWs.readyState === WebSocket.OPEN) {
        try { tWs.send(JSON.stringify({ type: 'stop' })); } catch {}
      }
    }
    activeProvider = null;
    audioBuffer = [];
    audioBufferBytes = 0;
    startConfig = null;
    activeSttHttp = null;
    pendingTranscribeConfig = null;
  });

  phoneWs.on('error', (err) => {
    console.error('[server] Transcribe relay error:', err.message);
  });
}

/**
 * Handle a dedicated stream WebSocket connection.
 * URL format: /ws/stream/<streamId>/<streamType>?token=<token>
 */
function handleStreamConnection(ws, url) {
  const parts = url.pathname.split('/'); // ['', 'ws', 'stream', '<streamId>', '<streamType>']
  const streamId = parseInt(parts[3], 10);
  const streamType = parts[4]; // 'video', 'audio', 'mouse', 'keyboard'
  const token = url.searchParams.get('token');

  if (!token || !streamType || isNaN(streamId)) {
    ws.close(4400, 'invalid_params');
    return;
  }

  const tokenInfo = pendingStreamTokens.get(token);
  if (!tokenInfo || tokenInfo.streamId !== streamId || tokenInfo.streamType !== streamType) {
    ws.close(4401, 'invalid_token');
    return;
  }

  // One-time use
  pendingStreamTokens.delete(token);

  const session = streamSessions.get(streamId);
  if (!session) {
    ws.close(4404, 'session_not_found');
    return;
  }

  // Determine if this device is source or target
  const isSource = tokenInfo.deviceId === session.sourceDeviceId;
  const slotKey = `${streamType}${isSource ? 'Source' : 'Target'}Ws`;
  session[slotKey] = ws;

  console.log(`[server] Stream ${streamId}: ${streamType} ${isSource ? 'source' : 'target'} connected`);

  // Check if the peer side is already connected
  const peerKey = `${streamType}${isSource ? 'Target' : 'Source'}Ws`;
  if (session[peerKey] && session[peerKey].readyState === 1) {
    setupStreamRelay(session, streamType);
  }

  ws.on('close', () => {
    session[slotKey] = null;
    console.log(`[server] Stream ${streamId}: ${streamType} ${isSource ? 'source' : 'target'} disconnected`);
    // If video closes, tear down the whole stream session.
    // For audio-only sessions, tear down when the audio slot closes.
    if (streamType === 'video') {
      endStreamSession(streamId, 'video_disconnected');
    } else if (streamType === 'audio' && session.audioOnly) {
      endStreamSession(streamId, 'audio_disconnected');
    }
  });

  ws.on('error', (err) => {
    console.error(`[server] Stream ${streamId} ${streamType} WS error:`, err.message);
  });
}

/**
 * Set up binary relay between source and target for a given stream type.
 */
function setupStreamRelay(session, streamType) {
  const sourceKey = `${streamType}SourceWs`;
  const targetKey = `${streamType}TargetWs`;
  const sourceWs = session[sourceKey];
  const targetWs = session[targetKey];

  if (!sourceWs || !targetWs) return;

  const backpressureThresholds = { video: 524288, audio: 2097152, mouse: 0, keyboard: 0 }; // audio: 2MB (prevents OOM while allowing ~10s buffer at 128kbps)
  const threshold = backpressureThresholds[streamType] ?? 0;

  if (streamType === 'mouse' || streamType === 'keyboard') {
    // Mouse/Keyboard: relay target -> source (phone sends to desktop)
    targetWs.on('message', (data, isBinary) => {
      if (!isBinary) return;
      if (sourceWs.readyState !== 1) return;
      try { sourceWs.send(data, { binary: true }); } catch {}
    });
  } else {
    // Video/Audio: relay source -> target (desktop sends to phone)
    sourceWs.on('message', (data, isBinary) => {
      if (!isBinary) return;
      if (targetWs.readyState !== 1) return;
      if (threshold > 0 && targetWs.bufferedAmount > threshold) return;
      try { targetWs.send(data, { binary: true }); } catch {}
    });
  }
}

/**
 * Generate one-time tokens for stream connections.
 * @returns {{ [streamType]: { sourceToken: string, targetToken: string } }}
 */
function generateStreamTokens(streamId, sourceDeviceId, targetDeviceId, streamTypes) {
  const result = {};
  for (const streamType of streamTypes) {
    const sourceToken = crypto.randomUUID();
    const targetToken = crypto.randomUUID();
    pendingStreamTokens.set(sourceToken, { streamId, deviceId: sourceDeviceId, streamType, createdAt: Date.now() });
    pendingStreamTokens.set(targetToken, { streamId, deviceId: targetDeviceId, streamType, createdAt: Date.now() });
    result[streamType] = { sourceToken, targetToken };
  }
  return result;
}

/**
 * Send a stream_connect message on a device's main WS.
 */
function sendStreamConnect(mainWs, streamId, streamType, endpoint, token) {
  if (mainWs.readyState !== 1) return;
  try {
    mainWs.send(serializeMessage({
      type: MSG_TYPE.STREAM_CONNECT,
      streamId,
      streamType,
      endpoint,
      token
    }));
  } catch {}
}

/**
 * End a stream session: close all dedicated WS connections, notify both sides, clean up.
 */
function endStreamSession(streamId, reason) {
  const session = streamSessions.get(streamId);
  if (!session) return;

  // Close all 8 dedicated WS connections
  const slotKeys = ['videoSourceWs', 'videoTargetWs', 'audioSourceWs', 'audioTargetWs', 'mouseSourceWs', 'mouseTargetWs', 'keyboardSourceWs', 'keyboardTargetWs'];
  for (const key of slotKeys) {
    if (session[key] && session[key].readyState === 1) {
      try { session[key].close(1000, reason); } catch {}
    }
    session[key] = null;
  }

  // Notify both sides via main WS
  const endMsg = serializeMessage({ type: MSG_TYPE.STREAM_ENDED, streamId, reason });
  if (session.sourceMainWs && session.sourceMainWs.readyState === 1) {
    try { session.sourceMainWs.send(endMsg); } catch {}
  }
  if (session.targetMainWs && session.targetMainWs.readyState === 1) {
    try { session.targetMainWs.send(endMsg); } catch {}
  }

  streamSessions.delete(streamId);
  console.log(`[server] Stream ${streamId}: ended (${reason})`);
}

// Start health checks
startHealthChecks(30000);

// Start server
server.listen(config.port, () => {
  console.log(`[server] Orchestrator running on port ${config.port}`);
  console.log(`[server] Communicator URL: ${config.communicatorUrl}`);
  console.log(`[server] LLM model: ${config.llmModel}`);
  console.log(`[server] TTS URL: ${config.ttsUrl}`);
});

// TURN relay handled by coturn (systemd service on host, port 3478)

// Graceful shutdown
async function shutdown() {
  console.log('[server] Shutting down...');
  stopScheduler();
  sessionManager.stopCleanup();
  assistantManager.stopCleanup();
  stopHealthChecks();

  // Close all open conversations and flush index
  for (const [, session] of sessionManager.sessions) {
    await chatStore.closeConversation(session.conversationId, 'shutdown').catch(() => {});
  }
  await chatStore.saveIndex();

  // End all active RC sessions (needs DB, so must run before closeDb)
  await endAllRcSessions();

  await closeDb();

  // Close all stream sessions
  for (const [streamId] of streamSessions) {
    endStreamSession(streamId, 'shutdown');
  }
  clearInterval(tokenCleanupInterval);
  pendingStreamTokens.clear();

  // Close all device connections
  for (const [id, ws] of deviceConnections) {
    ws.close();
  }
  deviceConnections.clear();

  wss.close(() => {
    server.close(() => {
      console.log('[server] Shutdown complete');
      process.exit(0);
    });
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('[server] Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => {
  console.error('[server] Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
});
