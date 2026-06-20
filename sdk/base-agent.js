/**
 * BaseAgent - abstract base class for all agents.
 * Handles WebSocket connection to orchestrator, auto-reconnect, manifest registration,
 * and a simple HTTP health endpoint.
 */

import WebSocket from 'ws';
import http from 'http';
import { readFileSync } from 'fs';
import {
  createRegisterMessage,
  createResponseMessage,
  createHealthMessage,
  createToolStatusMessage,
  createToolCompleteMessage,
  parseMessage,
  serializeMessage,
  MSG_TYPE
} from './protocol.js';
import { DelegationError } from './ptc-client.js';

export class BaseAgent {
  /**
   * @param {import('./types.js').AgentManifest} manifest
   * @param {Object} options
   * @param {string} options.orchestratorUrl - WebSocket URL of orchestrator
   * @param {number} [options.healthPort] - Port for HTTP health endpoint (0 = disabled)
   * @param {number} [options.reconnectBaseMs] - Base reconnect delay (default 1000)
   * @param {number} [options.reconnectMaxMs] - Max reconnect delay (default 30000)
   */
  constructor(manifest, options = {}) {
    this.manifest = manifest;
    this.orchestratorUrl = options.orchestratorUrl || 'ws://localhost:10001';
    this.healthPort = options.healthPort || 0;
    this.reconnectBaseMs = options.reconnectBaseMs || 1000;
    this.reconnectMaxMs = options.reconnectMaxMs || 30000;

    this.ws = null;
    this.connected = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.pongReceived = true;
    this.healthServer = null;
    this.shutdownRequested = false;
    /** @type {Array<{method: string, path: string, handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void|Promise<void>}>} */
    this.extraRoutes = [];
  }

  /**
   * Register an additional HTTP route on the health server. Intended for
   * subclasses that need to expose lightweight side-channel endpoints
   * (file uploads, debug info, etc.) without standing up a separate
   * listener. Must be called before start().
   * @param {string} method HTTP method (case-insensitive)
   * @param {string} path Exact-match request path (no params/wildcards)
   * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void|Promise<void>} handler
   */
  registerHttpRoute(method, path, handler) {
    this.extraRoutes.push({ method: method.toUpperCase(), path, handler });
  }

  /**
   * Start the agent: connect to orchestrator + start health server.
   */
  async start() {
    if (this.healthPort > 0) {
      this.startHealthServer();
    }
    this.connect();
    this.setupGracefulShutdown();
  }

  /**
   * Connect to orchestrator via WebSocket.
   */
  connect() {
    if (this.shutdownRequested) return;

    // Cancel any pending reconnect to prevent overlapping connect() calls
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    // Skip if current WS is already connecting or open
    if (this.ws && (this.ws.readyState === 0 /* CONNECTING */ || this.ws.readyState === 1 /* OPEN */)) {
      return;
    }

    console.log(`[${this.manifest.id}] Connecting to orchestrator: ${this.orchestratorUrl}`);

    // Reload CA certs from disk on each reconnect to handle VPN/cert changes
    const wsOptions = {};
    const caPath = process.env.NODE_EXTRA_CA_CERTS;
    if (caPath && this.orchestratorUrl.startsWith('wss://')) {
      try {
        wsOptions.ca = readFileSync(caPath);
      } catch (err) {
        console.error(`[${this.manifest.id}] Failed to read CA cert ${caPath}: ${err.message}`);
      }
    }

    const ws = new WebSocket(this.orchestratorUrl, wsOptions);
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return; // stale
      this.connected = true;
      this.reconnectAttempt = 0;
      this.pongReceived = true;
      console.log(`[${this.manifest.id}] Connected to orchestrator`);

      // Register manifest
      const msg = createRegisterMessage(this.manifest);
      ws.send(serializeMessage(msg));

      // Start client-side ping to detect half-open connections
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws !== ws) { clearInterval(this.pingInterval); return; }
        if (!this.pongReceived) {
          console.log(`[${this.manifest.id}] No pong received, connection dead`);
          ws.terminate();
          return;
        }
        this.pongReceived = false;
        ws.ping();
      }, 20000);
    });

    ws.on('pong', () => {
      this.pongReceived = true;
    });

    ws.on('message', async (raw) => {
      if (this.ws !== ws) return; // stale
      try {
        const envelope = parseMessage(raw.toString());
        await this.onMessage(envelope);
      } catch (err) {
        console.error(`[${this.manifest.id}] Failed to handle message:`, err.message);
      }
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) {
        console.log(`[${this.manifest.id}] Ignoring stale close (code=${code})`);
        return;
      }
      this.connected = false;
      if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
      console.log(`[${this.manifest.id}] Disconnected from orchestrator (code=${code} reason=${reason || 'none'})`);
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return; // stale
      console.error(`[${this.manifest.id}] WebSocket error:`, err.message);
    });
  }

  /**
   * Handle incoming WebSocket message.
   */
  async onMessage(envelope) {
    switch (envelope.type) {
      case MSG_TYPE.REQUEST: {
        const HANDLE_TIMEOUT_MS = 300_000; // 5 minutes
        try {
          const handlePromise = this.handle(envelope.payload);
          let timeoutId;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`handle() timed out after ${HANDLE_TIMEOUT_MS}ms`)), HANDLE_TIMEOUT_MS);
          });
          const result = await Promise.race([handlePromise, timeoutPromise]);
          clearTimeout(timeoutId);
          const response = createResponseMessage(result);
          this.send(response);
        } catch (err) {
          console.error(`[${this.manifest.id}] Handle error:`, err.message);
          const errorResponse = createResponseMessage({
            requestId: envelope.payload?.requestId,
            status: 'error',
            text: `Agent error: ${err.message}`
          });
          this.send(errorResponse);
        }
        break;
      }

      case MSG_TYPE.HEALTH: {
        const pong = createHealthMessage('pong');
        this.send(pong);
        break;
      }

      default:
        console.log(`[${this.manifest.id}] Unknown message type: ${envelope.type}`);
    }
  }

  /**
   * Send a message to the orchestrator.
   */
  send(envelope) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serializeMessage(envelope));
    } else {
      console.warn(`[${this.manifest.id}] Dropped message (ws not open): type=${envelope.type}`);
    }
  }

  /**
   * Send a tool status update to the orchestrator (forwarded to device for UI display).
   * @param {string} requestId
   * @param {string} toolName
   * @param {Object} [toolArgs]
   * @returns {string} toolCallId - Use this to send a matching completion via sendToolComplete
   */
  sendToolStatus(requestId, toolName, toolArgs) {
    const toolCallId = `${requestId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.send(createToolStatusMessage(requestId, toolName, toolArgs, toolCallId));
    return toolCallId;
  }

  /**
   * Send a tool completion with result to the orchestrator (persisted in chat history).
   * @param {string} requestId
   * @param {string} toolCallId - Must match the toolCallId returned by sendToolStatus
   * @param {string} toolName
   * @param {string} result - Stringified tool result
   */
  sendToolComplete(requestId, toolCallId, toolName, result) {
    this.send(createToolCompleteMessage(requestId, toolName, toolCallId, result));
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  scheduleReconnect() {
    if (this.shutdownRequested) return;

    const delay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxMs
    );
    this.reconnectAttempt++;

    console.log(`[${this.manifest.id}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Start a minimal HTTP health server.
   */
  startHealthServer() {
    this.healthServer = http.createServer(async (req, res) => {
      // Subclass-registered routes take precedence so they can shadow the
      // default /health if needed. Match on exact path + method.
      const reqUrl = (req.url || '').split('?')[0];
      const route = this.extraRoutes.find(r => r.method === req.method && r.path === reqUrl);
      if (route) {
        try {
          await route.handler(req, res);
        } catch (err) {
          console.error(`[${this.manifest.id}] Route handler error for ${req.method} ${reqUrl}: ${err?.stack || err?.message || err}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err?.message || String(err) }));
          }
        }
        return;
      }
      if (req.url === '/health' || req.url === this.manifest.healthEndpoint) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          agent: this.manifest.id,
          connected: this.connected
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.healthServer.listen(this.healthPort, () => {
      console.log(`[${this.manifest.id}] Health server on port ${this.healthPort}`);
    });
  }

  /**
   * Graceful shutdown handler.
   */
  setupGracefulShutdown() {
    const shutdown = () => {
      console.log(`[${this.manifest.id}] Shutting down...`);
      this.shutdownRequested = true;

      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.ws) this.ws.close();
      if (this.healthServer) this.healthServer.close();

      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Log and exit on uncaught exceptions -- let the container supervisor restart us
    // rather than running in a potentially corrupted state
    process.on('uncaughtException', (err) => {
      console.error(`[${this.manifest.id}] Uncaught exception -- exiting for restart:`, err.message, err.stack);
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      console.error(`[${this.manifest.id}] Unhandled rejection:`, reason);
    });
  }

  /**
   * Build a messages array with session history context for PTC.
   * @param {string} system - System prompt
   * @param {string|Array} userMessage - Current user message (string or content array)
   * @param {Array<{role: string, content: any}>} [sessionHistory] - Orchestrator session history
   * @param {string} [globalInstructions] - Global instructions to append to system prompt
   * @param {string} [autonomousInstructions] - Autonomous job instructions to append to system prompt
   * @returns {Array<{role: string, content: any}>}
   */
  buildMessagesWithHistory(system, userMessage, sessionHistory, globalInstructions, autonomousInstructions) {
    const messages = [];
    const systemContent = [system, globalInstructions, autonomousInstructions].filter(Boolean).join('\n\n');
    if (systemContent) messages.push({ role: 'system', content: systemContent });

    // sessionHistory is expected to be clean user/assistant history with the
    // current pending user turn already removed (see Session.getHistoryForAgent).
    // We just take the last few turns and pass them through as-is.
    if (sessionHistory && sessionHistory.length > 0) {
      const recent = sessionHistory.slice(-5);
      for (const msg of recent) {
        if (!msg || !msg.content) continue;
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    if (userMessage) messages.push({ role: 'user', content: userMessage });
    return messages;
  }

  /**
   * Convert OpenAI-format device tools to PTC tool format.
   * @param {Array} [deviceTools] - OpenAI-format tool definitions from orchestrator context
   * @returns {Array<{ name: string, description: string, input_schema: object }>}
   */
  convertDeviceTools(deviceTools) {
    if (!deviceTools || deviceTools.length === 0) return [];
    return deviceTools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));
  }

  /**
   * Build an OpenAI-format delegation tool definition from available agents.
   * Returns null if no agents are available.
   * @param {Array<{id: string, name: string, capabilities: string[]}>} availableAgents
   * @returns {{ type: 'function', function: { name: string, description: string, parameters: object } } | null}
   */
  buildDelegationTool(availableAgents) {
    if (!availableAgents || availableAgents.length === 0) return null;

    const agentList = availableAgents
      .map(a => `- "${a.id}" (${a.name}): ${a.capabilities.join(', ')}`)
      .join('\n');

    return {
      type: 'function',
      function: {
        name: 'delegate_to_agent',
        description: `Delegate a task to another specialized agent when the task falls outside your own capabilities. Available agents:\n${agentList}`,
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'ID of the agent to delegate to' },
            query: { type: 'string', description: 'The task or question for the target agent' }
          },
          required: ['agent_id', 'query']
        }
      }
    };
  }

  /**
   * Handle a delegate_to_agent tool call by throwing DelegationError.
   * Use in toolExecutor switch cases.
   * @param {{ agent_id: string, query: string }} args
   */
  handleDelegation(args) {
    if (!args.agent_id || !args.query) {
      throw new Error('delegate_to_agent requires agent_id and query');
    }
    throw new DelegationError(args.agent_id, args.query);
  }

  /**
   * Abstract method - agents must implement this.
   * @param {import('./types.js').AgentRequest} request
   * @returns {Promise<import('./types.js').AgentResponse|import('./types.js').AgentInputRequest|import('./types.js').AgentDelegationRequest>}
   */
  async handle(request) {
    throw new Error(`${this.manifest.id}: handle() not implemented`);
  }
}
