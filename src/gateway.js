import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import multer from '@koa/multer';
import { v4 as uuidv4 } from 'uuid';
import FormData from 'form-data';
import config from './config.js';
import crypto from 'crypto';
import { handleRequest } from './dispatcher.js';
import * as registry from './registry.js';
import { createRequestMessage, parseMessage, serializeMessage, MSG_TYPE } from '@orchestrator/sdk/protocol';
import { endSession } from './rc-handler.js';
import { DEFAULT_ORCHESTRATOR_MODE, validateOrchestratorMode, toCliMode } from './permission-mode.js';

/** Devices that failed speaker verification -- next WS request gets rejection response. */
export const rejectedDevices = new Set();

/** @type {import('./chat-store.js').ChatStore|null} */
let chatStore = null;

/** @type {import('./session.js').SessionManager|null} */
let sessionManager = null;

/** @type {Map<string, import('ws').WebSocket>|null} */
let deviceConnections = null;

/** @type {import('./job-store.js').JobStore|null} */
let jobStore = null;

/** @type {import('./rc-store.js').RcStore|null} */
let rcStore = null;

/** @type {import('./chat-store.js').ChatStore|null} */
let copilotStore = null;

/**
 * Provide chat store, session manager, device connections, job store, RC store, and copilot store for REST routes.
 * @param {import('./chat-store.js').ChatStore} cs
 * @param {import('./session.js').SessionManager} sm
 * @param {Map<string, import('ws').WebSocket>} [dc]
 * @param {import('./job-store.js').JobStore} [js]
 * @param {import('./rc-store.js').RcStore} [rs]
 * @param {import('./chat-store.js').ChatStore} [cps]
 */
export function initGateway(cs, sm, dc, js, rs, cps) {
  chatStore = cs;
  sessionManager = sm;
  deviceConnections = dc || null;
  jobStore = js || null;
  rcStore = rs || null;
  copilotStore = cps || null;
  if (!process.env.ORCHESTRATOR_PUBLIC_HOST) {
    console.warn('[gateway] WARN: ORCHESTRATOR_PUBLIC_HOST is not set; falling back to request Host header for SDK wsUrl. Operator should configure this in production to prevent host-header injection.');
  }
}

const app = new Koa();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const MULTIPART_PATHS = ['/api/v1/transcribe', '/api/v1/reid/persons/search/photo'];

// Conditionally apply bodyParser (skip for multipart routes)
app.use(async (ctx, next) => {
  if (MULTIPART_PATHS.includes(ctx.path)) {
    return await next();
  }
  return bodyParser({ jsonLimit: '5mb' })(ctx, next);
});

// API key auth middleware
app.use(async (ctx, next) => {
  // Skip auth for health endpoint
  if (ctx.path === '/api/v1/health' || ctx.path.startsWith('/api/v1/tiles/')) {
    return await next();
  }

  const authHeader = ctx.get('Authorization');
  const apiKeyHeader = ctx.get('x-api-key');

  let providedKey = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.substring(7);
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  }

  if (!providedKey) {
    ctx.status = 401;
    ctx.body = { error: { message: 'Missing API key', status: 401 } };
    console.log(`[gateway] Rejected: missing API key (${ctx.method} ${ctx.path})`);
    return;
  }

  if (providedKey !== config.apiKey) {
    ctx.status = 403;
    ctx.body = { error: { message: 'Invalid API key', status: 403 } };
    console.log(`[gateway] Rejected: invalid API key (${ctx.method} ${ctx.path})`);
    return;
  }

  await next();
});

// Routes
app.use(async (ctx) => {
  if (ctx.path === '/api/v1/health' && ctx.method === 'GET') {
    ctx.body = { status: 'ok', timestamp: new Date().toISOString() };
    return;
  }

  if (ctx.path === '/api/v1/transcribe' && ctx.method === 'POST') {
    await handleTranscribe(ctx);
    return;
  }

  if (ctx.path === '/api/v1/translate' && ctx.method === 'POST') {
    await handleTranslate(ctx);
    return;
  }

  if (ctx.path === '/api/v1/request' && ctx.method === 'POST') {
    const { text, image, deviceId, deviceType, model, userSystemPrompt } = ctx.request.body || {};

    if (!deviceId || !deviceType) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required fields: deviceId, deviceType', status: 400 } };
      return;
    }

    if (!text && !image) {
      ctx.status = 400;
      ctx.body = { error: { message: 'At least one of text or image is required', status: 400 } };
      return;
    }

    const requestId = uuidv4();
    console.log(`[gateway] Request ${requestId} from device ${deviceId} (${deviceType})`);

    try {
      const deviceWs = deviceConnections?.get(deviceId) || null;
      const result = await handleRequest({
        requestId,
        text,
        imageBase64: image,
        model,
        userSystemPrompt,
        deviceId,
        deviceType
      }, deviceWs);

      ctx.body = { requestId, ...result };
    } catch (err) {
      console.error(`[gateway] Request ${requestId} failed:`, err.message);
      ctx.status = 500;
      ctx.body = { error: { message: 'Internal server error', status: 500 } };
    }
    return;
  }

  // --- Remote session routes (direct agent RPC, no classifier/session) ---
  if (ctx.path === '/api/v1/remote-sessions/dirs' && ctx.method === 'GET') {
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.body = { available: false, dirs: [] };
      return;
    }
    const dirs = agentEntry.manifest.remoteSessionDirs || [];
    ctx.body = { available: true, dirs };
    return;
  }

  if (ctx.path === '/api/v1/remote-sessions/start' && ctx.method === 'POST') {
    const { workDir, deviceId, permissionMode: rawPermissionMode } = ctx.request.body || {};
    if (!workDir) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing workDir', status: 400 } };
      return;
    }
    const orchestratorMode = (rawPermissionMode == null || rawPermissionMode === '')
      ? DEFAULT_ORCHESTRATOR_MODE
      : rawPermissionMode;
    if (!validateOrchestratorMode(orchestratorMode)) {
      ctx.status = 400;
      ctx.body = { error: { message: 'invalid_permission_mode', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'PC agent not available', status: 503 } };
      return;
    }
    try {
      // Create RC session in store before telling pc-agent to spawn
      const sessionId = crypto.randomUUID();
      await rcStore.create(sessionId, workDir, orchestratorMode);

      // Bind session to requesting phone device
      if (deviceId) {
        const { bindSessionToPhone, registerOrchestratorSessionMode } = await import('./rc-handler.js');
        bindSessionToPhone(sessionId, deviceId);
        registerOrchestratorSessionMode(sessionId, orchestratorMode);
      } else {
        const { registerOrchestratorSessionMode } = await import('./rc-handler.js');
        registerOrchestratorSessionMode(sessionId, orchestratorMode);
      }

      // TODO: ORCHESTRATOR_PUBLIC_HOST should be configured in production to prevent
      // host-header injection from leaking the API key in the SDK URL.
      const publicHost = process.env.ORCHESTRATOR_PUBLIC_HOST || ctx.request.headers.host;
      const wsUrl = `wss://${publicHost}/ws/remote-control?session=${sessionId}`;
      const requestId = uuidv4();

      const response = await sendDirectAgentRequest(agentEntry, {
        requestId,
        action: 'remote_session_start',
        workDir,
        sessionId,
        wsUrl,
        apiKey: config.apiKey,
        permissionMode: toCliMode(orchestratorMode)
      }, 90000);
      if (response.status === 'error') {
        await rcStore.end(sessionId).catch(() => {});
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = { sessionId, workDir };
    } catch (err) {
      console.error('[gateway] Remote session start failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/remote-sessions/stop' && ctx.method === 'POST') {
    const { pid } = ctx.request.body || {};
    if (pid == null) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing pid', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'PC agent not available', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'remote_session_stop',
        pid
      }, 10000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = { status: 'ok' };
    } catch (err) {
      console.error('[gateway] Remote session stop failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/remote-sessions' && ctx.method === 'GET') {
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'PC agent not available', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'remote_session_list'
      }, 10000);
      const sessions = response.data?.sessions || [];

      // Enrich with titles and permissionMode from RC store
      if (rcStore && sessions.length > 0) {
        try {
          for (const s of sessions) {
            if (s.sessionId) {
              const rcDoc = await rcStore.get(s.sessionId);
              if (rcDoc?.title) s.title = rcDoc.title;
              if (rcDoc?.permissionMode) s.permissionMode = rcDoc.permissionMode;
            }
          }
        } catch (e) {
          console.error('[gateway] Failed to enrich session data:', e.message);
        }
      }

      ctx.body = { sessions };
    } catch (err) {
      console.error('[gateway] Remote session list failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/remote-sessions/commands' && ctx.method === 'GET') {
    ctx.body = { commands: [
      // Built-in commands
      { name: 'help', description: 'Show available commands' },
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'compact', description: 'Compact conversation to save context' },
      { name: 'cost', description: 'Show token usage and costs' },
      { name: 'memory', description: 'Edit CLAUDE.md memory files' },
      { name: 'model', description: 'Switch AI model' },
      { name: 'status', description: 'Show current session status' },
      { name: 'config', description: 'View or change configuration' },
      { name: 'diff', description: 'Show recent file changes' },
      { name: 'resume', description: 'Resume a previous conversation' },
      { name: 'review', description: 'Review code changes' },
      { name: 'pr_comments', description: 'View PR review comments' },
      { name: 'vim', description: 'Toggle vim keybindings' },
      { name: 'theme', description: 'Change color theme' },
      { name: 'mcp', description: 'Manage MCP servers' },
      { name: 'context', description: 'Show context window usage' },
      { name: 'init', description: 'Initialize CLAUDE.md for project' },
      { name: 'tasks', description: 'View and manage tasks' },
      { name: 'skills', description: 'List available skills' },
      { name: 'files', description: 'Show files in conversation context' },
      { name: 'effort', description: 'Set reasoning effort level' },
      { name: 'fast', description: 'Toggle fast output mode' },
      { name: 'exit', description: 'Exit the session' },
      { name: 'commit', description: 'Commit staged changes with AI message' },
      { name: 'plan', description: 'Enter plan mode for structured task planning' },
      { name: 'bug', description: 'Report a bug or issue' },
      { name: 'login', description: 'Log in to your account' },
      { name: 'logout', description: 'Log out of your account' },
      { name: 'permissions', description: 'View or change tool permissions' },
      { name: 'terminal-setup', description: 'Configure terminal integration' },
      // Superpowers skills
      { name: 'simplify', description: 'Review changed code for reuse, quality, and efficiency' },
      { name: 'loop', description: 'Run a prompt on recurring interval' },
      { name: 'interface-design:init', description: 'Initialize interface design system' },
      { name: 'interface-design:audit', description: 'Audit code against design system' },
      { name: 'interface-design:critique', description: 'Critique build for craft quality' },
      { name: 'frontend-design', description: 'Create production-grade frontend interfaces' },
      // Context-mode commands
      { name: 'context-mode:ctx-stats', description: 'Show context window savings' },
      { name: 'context-mode:ctx-doctor', description: 'Run context-mode diagnostics' },
      { name: 'context-mode:ctx-upgrade', description: 'Update context-mode plugin' },
    ]};
    return;
  }

  // --- Telegram bot interaction routes (direct agent RPC via pc-agent) ---
  if (ctx.path === '/api/v1/telegram/bot/send' && ctx.method === 'POST') {
    const { botUsername, text, silenceMs } = ctx.request.body || {};
    if (!botUsername || !text) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required fields: botUsername, text', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_bot_send',
        botUsername,
        text,
        silenceMs: silenceMs || 3000,
      }, (silenceMs || 3000) + 30000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = response.data;
    } catch (err) {
      console.error('[gateway] Telegram bot send failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/telegram/bot/send-photo' && ctx.method === 'POST') {
    const { botUsername, photoBase64, silenceMs } = ctx.request.body || {};
    if (!botUsername || !photoBase64) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required fields: botUsername, photoBase64', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_bot_send_photo',
        botUsername,
        photoBase64,
        silenceMs: silenceMs || 3000,
      }, (silenceMs || 3000) + 30000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = response.data;
    } catch (err) {
      console.error('[gateway] Telegram bot send-photo failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  // Telegram avatar: fetch via HTTP to keep WS payload small
  const avatarMatch = ctx.path.match(/^\/api\/v1\/telegram\/avatar\/(.+)$/);
  if (avatarMatch && ctx.method === 'GET') {
    const chatId = decodeURIComponent(avatarMatch[1]);
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_download_avatar',
        chatId,
      }, 15000);
      if (response.status === 'error' || !response.data?.avatar) {
        ctx.status = 404;
        ctx.body = { error: { message: 'Avatar not available', status: 404 } };
        return;
      }
      const buf = Buffer.from(response.data.avatar, 'base64');
      ctx.type = 'image/jpeg';
      ctx.body = buf;
    } catch (err) {
      console.error('[gateway] Telegram avatar failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/telegram/bot/click' && ctx.method === 'POST') {
    const { botUsername, messageId, buttonText, silenceMs } = ctx.request.body || {};
    if (!botUsername || !messageId || !buttonText) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required fields: botUsername, messageId, buttonText', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_bot_click',
        botUsername,
        messageId,
        buttonText,
        silenceMs: silenceMs || 3000,
      }, (silenceMs || 3000) + 30000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = response.data;
    } catch (err) {
      console.error('[gateway] Telegram bot click failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  const entityMatch = ctx.path.match(/^\/api\/v1\/telegram\/entity\/([^/]+)$/);
  if (entityMatch && ctx.method === 'GET') {
    const username = entityMatch[1];
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_get_entity',
        username: username.startsWith('@') ? username : `@${username}`,
      }, 15000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = response.data;
    } catch (err) {
      console.error('[gateway] Telegram get entity failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/telegram/mute' && ctx.method === 'POST') {
    const { username } = ctx.request.body || {};
    if (!username) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required field: username', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_mute_chat',
        username,
      }, 15000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = { status: 'ok' };
    } catch (err) {
      console.error('[gateway] Telegram mute failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/telegram/unblock' && ctx.method === 'POST') {
    const { username } = ctx.request.body || {};
    if (!username) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required field: username', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_unblock_user',
        username,
      }, 15000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = { status: 'ok' };
    } catch (err) {
      console.error('[gateway] Telegram unblock failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/telegram/find-redirect-bot' && ctx.method === 'POST') {
    const { deadBotUsername, triedBots, redirectText } = ctx.request.body || {};
    if (!deadBotUsername) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required field: deadBotUsername', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_find_redirect_bot',
        deadBotUsername,
        triedBots: triedBots || [],
        redirectText: redirectText || '',
      }, 60000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = response.data;
    } catch (err) {
      console.error('[gateway] Telegram find redirect bot failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  const messagesMatch = ctx.path.match(/^\/api\/v1\/telegram\/messages\/([^/]+)$/);
  if (messagesMatch && ctx.method === 'GET') {
    const chat = decodeURIComponent(messagesMatch[1]);
    const limit = parseInt(ctx.query.limit) || 10;
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_read_messages',
        chat,
        limit,
      }, 15000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = response.data;
    } catch (err) {
      console.error('[gateway] Telegram read messages failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  if (ctx.path === '/api/v1/telegram/send-message' && ctx.method === 'POST') {
    const { chat, text } = ctx.request.body || {};
    if (!chat || !text) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required fields: chat, text', status: 400 } };
      return;
    }
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) {
      ctx.status = 503;
      ctx.body = { error: { message: 'pc-agent not connected', status: 503 } };
      return;
    }
    try {
      const response = await sendDirectAgentRequest(agentEntry, {
        requestId: uuidv4(),
        action: 'telegram_send_message',
        chat,
        text,
      }, 15000);
      if (response.status === 'error') {
        ctx.status = 500;
        ctx.body = { error: { message: response.text, status: 500 } };
        return;
      }
      ctx.body = response.data;
    } catch (err) {
      console.error('[gateway] Telegram send message failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: err.message, status: 500 } };
    }
    return;
  }

  // --- Copilot chat logs REST routes (read-only) ---
  // Mirrors /api/v1/chats but backed by the separate copilot store. Auth is the
  // shared Bearer/x-api-key middleware applied above. No create/delete.
  const copilotRouteMatch = ctx.path.match(/^\/api\/v1\/copilot-chats(?:\/([^/]+))?$/);
  if (copilotRouteMatch && copilotStore) {
    const conversationId = copilotRouteMatch[1];

    // GET /api/v1/copilot-chats - list copilot sessions as summaries
    if (!conversationId && ctx.method === 'GET') {
      const limit = parseInt(ctx.query.limit) || 50;
      const offset = parseInt(ctx.query.offset) || 0;
      const { conversations, total } = copilotStore.listConversations({ limit, offset });
      ctx.body = {
        conversations: conversations.map(c => ({
          id: c.id,
          startedAt: c.startedAt,
          lastActivityAt: c.lastActivityAt,
          turnCount: c.turnCount,
          // Title from the first turn's interlocutorText (stored as
          // firstUserMessage on the index at appendRawTurn time; falls back to
          // wearerText there), else the startedAt date string. No fabrication.
          title: c.firstUserMessage || c.startedAt
        })),
        total,
        offset,
        limit
      };
      return;
    }

    // GET /api/v1/copilot-chats/:id - full session detail
    if (conversationId && ctx.method === 'GET') {
      const conversation = await copilotStore.getConversationTurns(conversationId);
      if (!conversation) {
        ctx.status = 404;
        ctx.body = { error: { message: 'Copilot conversation not found', status: 404 } };
        return;
      }
      ctx.body = {
        header: conversation.header,
        turns: conversation.turns,
        close: conversation.close
      };
      return;
    }
  }

  // --- Chat history REST routes ---
  const chatRouteMatch = ctx.path.match(/^\/api\/v1\/chats(?:\/([^/]+)(\/message)?)?$/);
  if (chatRouteMatch && chatStore) {
    const conversationId = chatRouteMatch[1];
    const isMessageRoute = !!chatRouteMatch[2];

    // GET /api/v1/chats - list or search conversations
    if (!conversationId && ctx.method === 'GET') {
      const limit = parseInt(ctx.query.limit) || 50;
      const offset = parseInt(ctx.query.offset) || 0;
      const search = ctx.query.search;
      if (search) {
        ctx.body = await chatStore.searchConversations(search, { limit, offset });
      } else {
        ctx.body = chatStore.listConversations({ limit, offset });
      }
      return;
    }

    // POST /api/v1/chats - create new conversation (optionally with first message)
    if (!conversationId && ctx.method === 'POST') {
      const { text, image, deviceId, deviceType, userSystemPrompt } = ctx.request.body || {};

      const effectiveDeviceId = deviceId || 'rest-client';
      const effectiveDeviceType = deviceType || 'phone';

      // Close any existing session for this device
      const existingSession = sessionManager.sessions.get(effectiveDeviceId);
      if (existingSession) {
        await chatStore.closeConversation(existingSession.conversationId, 'new_chat');
        sessionManager.removeSession(effectiveDeviceId);
      }

      // Create fresh session (auto-creates conversation in chatStore)
      const session = sessionManager.getSession(effectiveDeviceId, effectiveDeviceType);

      // If no text or image, just create the conversation without sending a message
      if (!text && !image) {
        console.log(`[gateway] New empty chat -> conversation ${session.conversationId} from ${effectiveDeviceId}`);
        ctx.body = { conversationId: session.conversationId };
        return;
      }

      const requestId = uuidv4();
      console.log(`[gateway] New chat ${requestId} -> conversation ${session.conversationId} from ${effectiveDeviceId}`);

      try {
        const chatDeviceWs = deviceConnections?.get(effectiveDeviceId) || null;
        const result = await handleRequest({
          requestId,
          text,
          imageBase64: image,
          userSystemPrompt,
          deviceId: effectiveDeviceId,
          deviceType: effectiveDeviceType
        }, chatDeviceWs);

        ctx.body = { conversationId: session.conversationId, requestId, ...result };
      } catch (err) {
        console.error(`[gateway] New chat ${requestId} failed:`, err.message);
        ctx.status = 500;
        ctx.body = { error: { message: 'Internal server error', status: 500 } };
      }
      return;
    }

    // GET /api/v1/chats/:id - get conversation detail
    if (conversationId && !isMessageRoute && ctx.method === 'GET') {
      const conversation = await chatStore.getConversationTurns(conversationId);
      if (!conversation) {
        ctx.status = 404;
        ctx.body = { error: { message: 'Conversation not found', status: 404 } };
        return;
      }
      ctx.body = conversation;
      return;
    }

    // DELETE /api/v1/chats/:id - delete conversation
    if (conversationId && !isMessageRoute && ctx.method === 'DELETE') {
      // Close any active session holding this conversation
      for (const [deviceId, session] of sessionManager.sessions) {
        if (session.conversationId === conversationId) {
          sessionManager.removeSession(deviceId);
          break;
        }
      }
      const deleted = await chatStore.deleteConversation(conversationId);
      if (!deleted) {
        ctx.status = 404;
        ctx.body = { error: { message: 'Conversation not found', status: 404 } };
        return;
      }
      ctx.body = { status: 'ok' };
      return;
    }

    // POST /api/v1/chats/:id/message - send message to resume conversation
    if (conversationId && isMessageRoute && ctx.method === 'POST') {
      const { text, image, deviceId, deviceType, userSystemPrompt } = ctx.request.body || {};

      if (!text && !image) {
        ctx.status = 400;
        ctx.body = { error: { message: 'At least one of text or image is required', status: 400 } };
        return;
      }

      const effectiveDeviceId = deviceId || 'rest-client';
      const effectiveDeviceType = deviceType || 'phone';

      // Load conversation turns for session resume
      const conversation = await chatStore.getConversationTurns(conversationId);
      if (!conversation) {
        ctx.status = 404;
        ctx.body = { error: { message: 'Conversation not found', status: 404 } };
        return;
      }

      // Reopen if closed
      chatStore.reopenConversation(conversationId);

      // Create/resume session from history
      await sessionManager.createSessionFromHistory(
        effectiveDeviceId, effectiveDeviceType, conversationId, conversation.turns || []
      );

      // Send the new message through the normal pipeline
      const requestId = uuidv4();
      console.log(`[gateway] Chat resume ${requestId} for conversation ${conversationId} from ${effectiveDeviceId}`);

      try {
        const chatDeviceWs = deviceConnections?.get(effectiveDeviceId) || null;
        const result = await handleRequest({
          requestId,
          text,
          imageBase64: image,
          userSystemPrompt,
          deviceId: effectiveDeviceId,
          deviceType: effectiveDeviceType
        }, chatDeviceWs);

        // Send WS response frame so phone UI picks it up via onResponse -> broadcastChatMessage
        if (chatDeviceWs && chatDeviceWs.readyState === 1) {
          try {
            chatDeviceWs.send(serializeMessage({ type: 'response', requestId, ...result }));
          } catch (e) {
            console.warn(`[gateway] Failed to send WS response for chat resume ${requestId}: ${e.message}`);
          }
        }

        ctx.body = { requestId, ...result };
      } catch (err) {
        console.error(`[gateway] Chat resume ${requestId} failed:`, err.message);
        ctx.status = 500;
        ctx.body = { error: { message: 'Internal server error', status: 500 } };
      }
      return;
    }
  }

  // --- ReID Analytics multipart proxy (search by photo) ---
  if (ctx.path === '/api/v1/reid/persons/search/photo' && ctx.method === 'POST') {
    await upload.single('image')(ctx, () => Promise.resolve());

    if (!ctx.file) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing image file', status: 400 } };
      return;
    }

    const form = new FormData();
    form.append('image', ctx.file.buffer, {
      filename: ctx.file.originalname || 'face.webp',
      contentType: ctx.file.mimetype || 'image/webp',
    });

    // Forward additional body fields (threshold, limit, etc.)
    const bodyFields = ctx.request.body || {};
    for (const [key, value] of Object.entries(bodyFields)) {
      form.append(key, String(value));
    }

    const reidPath = 'persons/search/photo';
    const qs = ctx.querystring ? `?${ctx.querystring}` : '';
    const targetUrl = `${config.reidAnalyticsUrl}/api/reid/${reidPath}${qs}`;
    console.log(`[gateway] REID_PROXY_REQ multipart POST /${reidPath} imgSize=${ctx.file.size} threshold=${bodyFields.threshold || 'default'} limit=${bodyFields.limit || 'default'} -> ${config.reidAnalyticsUrl}`);

    let response;
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: form.getBuffer(),
      });
    } catch (err) {
      console.error(`[gateway] ReID multipart proxy failed:`, err.message);
      ctx.status = 502;
      ctx.body = { error: { message: 'ReID analytics service unavailable', status: 502 } };
      return;
    }

    if (!response.ok) {
      ctx.status = response.status;
      try {
        ctx.body = await response.json();
      } catch {
        ctx.body = { error: { message: 'ReID analytics error', status: response.status } };
      }
      return;
    }

    const respBody = await response.json();
    const topMatch = respBody?.persons?.[0];
    console.log(`[gateway] REID_PROXY_RESP multipart POST /${reidPath} status=${response.status} personCount=${respBody?.persons?.length || 0}${topMatch ? ` topMatchId=${topMatch.id} topMatchScore=${topMatch.similarity}` : ''}`);
    ctx.body = respBody;
    return;
  }

  // --- ReID merge webhook (reid-db-handler -> orchestrator -> devices) ---
  if (ctx.path === '/api/v1/webhooks/reid/merge' && ctx.method === 'POST') {
    const { source_person_id, target_person_id, target_display_name } = ctx.request.body;
    console.log(`[gateway] Reid merge webhook: ${source_person_id} -> ${target_person_id}`);

    if (deviceConnections) {
      const msg = JSON.stringify({
        type: 'reid_merge',
        source_person_id,
        target_person_id,
        target_display_name: target_display_name || null
      });
      for (const [, ws] of deviceConnections) {
        if (ws.readyState === 1) {
          try { ws.send(msg); } catch {}
        }
      }
    }

    ctx.body = { status: 'ok' };
    return;
  }

  // --- ReID Analytics proxy ---
  const reidMatch = ctx.path.match(/^\/api\/v1\/reid\/(.+)$/);
  if (reidMatch) {
    const reidPath = reidMatch[1];
    const qs = ctx.querystring ? `?${ctx.querystring}` : '';
    const targetUrl = `${config.reidAnalyticsUrl}/api/reid/${reidPath}${qs}`;
    const sightingsPersonId = (ctx.method === 'POST' && reidPath.includes('sightings')) ? (ctx.request.body?.person_id || 'n/a') : null;
    console.log(`[gateway] REID_PROXY_REQ ${ctx.method} /${reidPath}${sightingsPersonId ? ` person_id=${sightingsPersonId}` : ''} -> ${config.reidAnalyticsUrl}`);

    let fetchOpts = {
      method: ctx.method,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
    };

    if (ctx.method === 'POST' || ctx.method === 'PUT') {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(ctx.request.body || {});
    }

    let response;
    try {
      response = await fetch(targetUrl, fetchOpts);
    } catch (err) {
      console.error(`[gateway] ReID proxy failed:`, err.message);
      ctx.status = 502;
      ctx.body = { error: { message: 'ReID analytics service unavailable', status: 502 } };
      return;
    }

    // Stream binary responses (images, osint assets) directly
    if (reidPath.includes('/image') || reidPath.startsWith('osint-photos/') || reidPath.startsWith('osint-reports/')) {
      ctx.status = response.status;
      ctx.set('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
      const arrayBuf = await response.arrayBuffer();
      console.log(`[gateway] REID_PROXY_RESP ${ctx.method} /${reidPath} status=${response.status} bytes=${arrayBuf.byteLength}`);
      ctx.body = Buffer.from(arrayBuf);
      return;
    }

    // JSON responses
    if (!response.ok) {
      ctx.status = response.status;
      try {
        ctx.body = await response.json();
      } catch {
        ctx.body = { error: { message: 'ReID analytics error', status: response.status } };
      }
      console.log(`[gateway] REID_PROXY_RESP ${ctx.method} /${reidPath} status=${response.status}`);
      return;
    }

    if (response.status === 204) {
      ctx.status = 204;
      console.log(`[gateway] REID_PROXY_RESP ${ctx.method} /${reidPath} status=204`);
      return;
    }

    const respJson = await response.json();
    const contentLen = response.headers.get('content-length') || JSON.stringify(respJson).length;
    console.log(`[gateway] REID_PROXY_RESP ${ctx.method} /${reidPath} status=${response.status} bodyLen=${contentLen}`);
    ctx.body = respJson;
    return;
  }

  // --- Tiles proxy (no auth, binary) ---
  const tilesMatch = ctx.path.match(/^\/api\/v1\/tiles\/(.+)$/);
  if (tilesMatch) {
    const tilePath = tilesMatch[1];
    const qs = ctx.querystring ? `?${ctx.querystring}` : '';
    const targetUrl = `${config.reidAnalyticsUrl}/api/tiles/${tilePath}${qs}`;
    console.log(`[gateway] Proxying tiles /${tilePath} -> ${config.reidAnalyticsUrl}`);

    let response;
    try {
      response = await fetch(targetUrl, { method: 'GET' });
    } catch (err) {
      console.error(`[gateway] Tiles proxy failed:`, err.message);
      ctx.status = 502;
      ctx.body = { error: { message: 'Tile service unavailable', status: 502 } };
      return;
    }

    if (!response.ok) {
      ctx.status = response.status;
      ctx.body = { error: { message: 'Tile fetch failed', status: response.status } };
      return;
    }

    ctx.status = 200;
    ctx.set('Content-Type', response.headers.get('content-type') || 'image/png');
    ctx.set('Cache-Control', response.headers.get('cache-control') || 'public, max-age=86400');
    const arrayBuf = await response.arrayBuffer();
    ctx.body = Buffer.from(arrayBuf);
    return;
  }

  // GET /api/v1/remote-control/dirs -- list distinct RC session directories
  if (ctx.path === '/api/v1/remote-control/dirs' && ctx.method === 'GET' && rcStore) {
    try {
      const dirs = await rcStore.getDistinctWorkDirs();
      ctx.body = { dirs: dirs.filter(d => d != null) };
    } catch (err) {
      console.error('[gateway] RC dirs failed:', err.message);
      ctx.status = 500;
      ctx.body = { error: { message: 'Internal server error', status: 500 } };
    }
    return;
  }

  // --- Remote control session REST routes ---
  const rcSessionMatch = ctx.path.match(/^\/api\/v1\/remote-control\/sessions(?:\/([^/]+)(\/transcript)?)?$/);
  if (rcSessionMatch && rcStore) {
    const sessionId = rcSessionMatch[1];
    const isTranscriptRoute = !!rcSessionMatch[2];

    // GET /api/v1/remote-control/sessions -- list or search RC sessions
    if (!sessionId && ctx.method === 'GET') {
      try {
        const search = ctx.query.search;
        const workDir = ctx.query.workDir || null;
        const limit = parseInt(ctx.query.limit) || 50;
        const offset = parseInt(ctx.query.offset) || 0;
        if (search) {
          const { sessions, total } = await rcStore.searchSessions(search, { limit, offset });
          ctx.body = { sessions, total, limit, offset };
        } else {
          const { sessions, total } = await rcStore.listRecentFiltered({ workDir, limit, offset });
          ctx.body = { sessions, total, limit, offset };
        }
      } catch (err) {
        console.error('[gateway] RC list/search sessions failed:', err.message);
        ctx.status = 500;
        ctx.body = { error: { message: 'Internal server error', status: 500 } };
      }
      return;
    }

    // POST /api/v1/remote-control/sessions -- create a new RC session
    if (!sessionId && ctx.method === 'POST') {
      const { workDir } = ctx.request.body || {};
      const newSessionId = crypto.randomUUID();
      try {
        await rcStore.create(newSessionId, workDir || null);
        console.log(`[gateway] RC session created: ${newSessionId}`);
        ctx.body = {
          sessionId: newSessionId,
          wsUrl: `/ws/remote-control?session=${newSessionId}`,
        };
      } catch (err) {
        console.error('[gateway] RC create session failed:', err.message);
        ctx.status = 500;
        ctx.body = { error: { message: 'Internal server error', status: 500 } };
      }
      return;
    }

    // DELETE /api/v1/remote-control/sessions/:id -- end an RC session
    if (sessionId && !isTranscriptRoute && ctx.method === 'DELETE') {
      const existing = await rcStore.get(sessionId);
      if (!existing) {
        ctx.status = 404;
        ctx.body = { error: { message: `Session ${sessionId} not found`, status: 404 } };
        return;
      }
      try {
        await endSession(sessionId);
        ctx.body = { status: 'ok' };
      } catch (err) {
        console.error(`[gateway] RC end session ${sessionId} failed:`, err.message);
        ctx.status = 500;
        ctx.body = { error: { message: 'Internal server error', status: 500 } };
      }
      return;
    }

    // GET /api/v1/remote-control/sessions/:id/transcript -- get session transcript
    if (sessionId && isTranscriptRoute && ctx.method === 'GET') {
      const existing = await rcStore.get(sessionId);
      if (!existing) {
        ctx.status = 404;
        ctx.body = { error: { message: `Session ${sessionId} not found`, status: 404 } };
        return;
      }
      try {
        const transcript = await rcStore.getTranscript(sessionId);
        ctx.body = { transcript };
      } catch (err) {
        console.error(`[gateway] RC get transcript ${sessionId} failed:`, err.message);
        ctx.status = 500;
        ctx.body = { error: { message: 'Internal server error', status: 500 } };
      }
      return;
    }
  }

  // --- Job scheduling REST routes ---
  const jobRouteMatch = ctx.path.match(/^\/api\/v1\/jobs(?:\/([^/]+))?$/);
  if (jobRouteMatch && jobStore) {
    const jobId = jobRouteMatch[1];

    // GET /api/v1/jobs -- list all jobs
    if (!jobId && ctx.method === 'GET') {
      const jobs = await jobStore.list();
      ctx.body = { jobs };
      return;
    }

    // POST /api/v1/jobs -- create job
    if (!jobId && ctx.method === 'POST') {
      const { name, prompt, scheduledAt } = ctx.request.body || {};
      if (!name || !prompt || !scheduledAt) {
        ctx.status = 400;
        ctx.body = { error: { message: 'Missing required fields: name, prompt, scheduledAt', status: 400 } };
        return;
      }
      const scheduledDate = new Date(scheduledAt);
      if (isNaN(scheduledDate.getTime())) {
        ctx.status = 400;
        ctx.body = { error: { message: 'Invalid scheduledAt date', status: 400 } };
        return;
      }
      const job = await jobStore.create(name, prompt, scheduledDate);
      ctx.body = { job };
      return;
    }

    // PUT /api/v1/jobs/:id -- update job
    if (jobId && ctx.method === 'PUT') {
      const fields = {};
      const body = ctx.request.body || {};
      if (body.name !== undefined) fields.name = body.name;
      if (body.prompt !== undefined) fields.prompt = body.prompt;
      if (body.scheduledAt !== undefined) {
        const d = new Date(body.scheduledAt);
        if (isNaN(d.getTime())) {
          ctx.status = 400;
          ctx.body = { error: { message: 'Invalid scheduledAt date', status: 400 } };
          return;
        }
        fields.scheduledAt = d;
      }
      const job = await jobStore.update(jobId, fields);
      if (!job) {
        ctx.status = 404;
        ctx.body = { error: { message: 'Job not found', status: 404 } };
        return;
      }
      ctx.body = { job };
      return;
    }

    // DELETE /api/v1/jobs/:id -- delete job
    if (jobId && ctx.method === 'DELETE') {
      const deleted = await jobStore.remove(jobId);
      if (!deleted) {
        ctx.status = 404;
        ctx.body = { error: { message: 'Job not found', status: 404 } };
        return;
      }
      ctx.body = { status: 'ok' };
      return;
    }
  }

  ctx.status = 404;
  ctx.body = { error: { message: 'Not found', status: 404 } };
});

async function handleTranscribe(ctx) {
  await upload.single('audio')(ctx, () => Promise.resolve());

  const file = ctx.file;
  if (!file) {
    ctx.status = 400;
    ctx.body = { error: { message: 'Missing audio file', status: 400 } };
    return;
  }

  const deviceId = ctx.query.deviceId || '';
  const provider = ctx.query.provider || 'local';
  const language = ctx.query.language || '';

  // Try Anthropic STT if requested
  if (provider === 'anthropic') {
    console.log(`[gateway] Attempting Anthropic STT for device '${deviceId}', language=${language}`);
    try {
      const anthropicUrl = `${config.anthropicSttUrl}/transcribe?language=${encodeURIComponent(language)}`;
      const anthropicResponse = await fetch(anthropicUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.buffer,
        signal: AbortSignal.timeout(15000),
      });
      if (anthropicResponse.ok) {
        const result = await anthropicResponse.json();
        console.log(`[gateway] Anthropic STT success: "${(result.text || '').substring(0, 60)}"`);
        ctx.body = result;
        return;
      }
      console.error(`[gateway] Anthropic STT HTTP ${anthropicResponse.status}, falling back to local`);
    } catch (err) {
      console.error(`[gateway] Anthropic STT failed: ${err.message}, falling back to local`);
    }
  }

  // Local transcriber (default or fallback)
  const form = new FormData();
  form.append('audio', file.buffer, {
    filename: file.originalname || 'recording.wav',
    contentType: file.mimetype || 'audio/wav',
  });

  const transcriberParams = new URLSearchParams({
    verify_speaker: 'true',
    device_id: deviceId,
  });

  if (ctx.query.sample_rate) {
    transcriberParams.set('sample_rate', ctx.query.sample_rate);
  }

  const url = `${config.transcriberUrl}/transcribe?${transcriberParams}`;
  console.log(`[gateway] Proxying transcribe for device '${deviceId}' -> ${config.transcriberUrl}`);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: form.getBuffer(),
    });
  } catch (err) {
    console.error(`[gateway] Transcriber request failed:`, err.message);
    ctx.status = 502;
    ctx.body = { error: { message: 'Transcriber service unavailable', status: 502 } };
    return;
  }

  const data = await response.json();

  if (!response.ok) {
    ctx.status = response.status;
    ctx.body = data;
    return;
  }

  // Enforce speaker verification policy
  if (config.speakerVerificationEnabled && data.speaker_verified === false) {
    console.log(`[gateway] Speaker verification failed for device '${deviceId}' (similarity=${data.speaker_similarity})`);
    rejectedDevices.add(deviceId);
    ctx.body = { text: data.text, language: data.language };
    return;
  }

  ctx.body = data;
}

async function handleTranslate(ctx) {
  const { text, source_lang, target_lang } = ctx.request.body || {};

  if (!text || !target_lang) {
    ctx.status = 400;
    ctx.body = { error: { message: 'Missing required fields: text, target_lang', status: 400 } };
    return;
  }

  const url = `${config.translatorUrl}/translate`;
  console.log(`[gateway] Proxying translate -> ${config.translatorUrl}`);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ text, source_lang, target_lang }),
    });
  } catch (err) {
    console.error(`[gateway] Translator request failed:`, err.message);
    ctx.status = 502;
    ctx.body = { error: { message: 'Translator service unavailable', status: 502 } };
    return;
  }

  const data = await response.json();

  if (!response.ok) {
    ctx.status = response.status;
    ctx.body = data;
    return;
  }

  ctx.body = data;
}

/**
 * Send a direct request to an agent via WebSocket and wait for the response.
 * Bypasses the dispatcher/classifier -- used for static actions like remote sessions.
 * @param {{ ws: import('ws').WebSocket }} agentEntry
 * @param {Object} payload - Must include requestId
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<import('@orchestrator/sdk/types').AgentResponse>}
 */
export function sendDirectAgentRequest(agentEntry, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const { requestId } = payload;
    const msg = createRequestMessage(payload);

    const timeout = setTimeout(() => {
      agentEntry.ws.removeListener('message', onMessage);
      reject(new Error('Agent request timed out'));
    }, timeoutMs);

    function onMessage(raw) {
      let envelope;
      try {
        envelope = parseMessage(raw.toString());
      } catch {
        return;
      }
      if (envelope.type === MSG_TYPE.RESPONSE && envelope.payload?.requestId === requestId) {
        clearTimeout(timeout);
        agentEntry.ws.removeListener('message', onMessage);
        resolve(envelope.payload);
      }
    }

    agentEntry.ws.on('message', onMessage);
    agentEntry.ws.send(serializeMessage(msg));
  });
}

export default app;
