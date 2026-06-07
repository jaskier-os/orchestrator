import {
  parseMessage,
  serializeMessage,
  createHealthMessage,
  MSG_TYPE
} from '@orchestrator/sdk/protocol';

/**
 * Agent Registry - manages connected agents and their manifests.
 */

/** @type {Map<string, { ws: import('ws').WebSocket, manifest: import('@orchestrator/sdk/types').AgentManifest, lastPing: number }>} */
const agents = new Map();

let healthCheckInterval = null;

// Callback for unhandled agent messages (set by index.js for push forwarding)
let agentMessageCallback = null;

/**
 * Set a callback to receive non-standard messages from agents (e.g. telegram_new_message pushes).
 * @param {function(string, Object): void} cb - Called with (agentId, envelope)
 */
export function onAgentMessage(cb) {
  agentMessageCallback = cb;
}

/**
 * Register an agent connection with its manifest.
 * @param {import('ws').WebSocket} ws
 * @param {import('@orchestrator/sdk/types').AgentManifest} manifest
 */
export function register(ws, manifest) {
  const existing = agents.get(manifest.id);
  if (existing && existing.ws !== ws) {
    console.log(`[registry] Agent "${manifest.id}" re-registering, replacing entry (old ws left to expire)`);
    // Do NOT close/terminate old WS - it may share nginx upstream with new WS.
    // Old WS will be cleaned up by health check timeout or its own close event.
  }

  agents.set(manifest.id, { ws, manifest, lastPing: Date.now() });
  console.log(`[registry] Agent registered: ${manifest.id} (${manifest.name})`);
  console.log(`[registry] Total agents: ${agents.size}`);
}

/**
 * Unregister an agent, but only if the given WS matches the current entry.
 * Prevents stale close events from removing a freshly re-registered agent.
 * @param {string} agentId
 * @param {import('ws').WebSocket} [ws] - If provided, only unregister if this WS is the current one
 */
export function unregister(agentId, ws) {
  const entry = agents.get(agentId);
  if (!entry) return;
  if (ws && entry.ws !== ws) {
    console.log(`[registry] Ignoring stale unregister for "${agentId}" (old WS close event)`);
    return;
  }
  agents.delete(agentId);
  console.log(`[registry] Agent unregistered: ${agentId}`);
  console.log(`[registry] Total agents: ${agents.size}`);
}

/**
 * Get an agent entry by ID.
 * @param {string} agentId
 * @returns {{ ws: import('ws').WebSocket, manifest: import('@orchestrator/sdk/types').AgentManifest, lastPing: number } | undefined}
 */
export function getAgent(agentId) {
  return agents.get(agentId);
}

/**
 * Get all connected agent manifests.
 * @returns {import('@orchestrator/sdk/types').AgentManifest[]}
 */
export function getManifests() {
  return Array.from(agents.values()).map(entry => entry.manifest);
}

/**
 * Start periodic health checks. Pings all agents and removes unresponsive ones.
 * @param {number} [intervalMs=30000]
 */
export function startHealthChecks(intervalMs = 30000) {
  if (healthCheckInterval) clearInterval(healthCheckInterval);

  healthCheckInterval = setInterval(() => {
    const now = Date.now();
    const pingMsg = serializeMessage(createHealthMessage('ping'));

    for (const [agentId, entry] of agents) {
      // WS-level dead connection check
      if (entry.ws.isAlive === false) {
        console.log(`[registry] Agent "${agentId}" WS dead (no pong), terminating`);
        entry.ws.terminate();
        unregister(agentId, entry.ws);
        continue;
      }

      // App-level health check: if agent hasn't responded within 2 intervals, remove
      if (now - entry.lastPing > intervalMs * 2) {
        console.log(`[registry] Agent "${agentId}" unresponsive (no health pong), removing`);
        entry.ws.terminate();
        unregister(agentId, entry.ws);
        continue;
      }

      if (entry.ws.readyState === 1) {
        entry.ws.isAlive = false;
        entry.ws.ping(); // WS-level ping
        entry.ws.send(pingMsg); // App-level health ping
      }
    }
  }, intervalMs);
}

/**
 * Stop health checks.
 */
export function stopHealthChecks() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

/**
 * Handle a new agent WebSocket connection.
 * Waits for the register message, then stores the agent.
 * @param {import('ws').WebSocket} ws
 */
export function handleAgentConnection(ws) {
  let registered = false;
  let agentId = null;

  const registrationTimeout = setTimeout(() => {
    if (!registered) {
      console.log('[registry] Agent connection timed out waiting for registration');
      ws.close();
    }
  }, 10000);

  ws.on('message', (raw) => {
    let envelope;
    try {
      envelope = parseMessage(raw.toString());
    } catch (err) {
      console.error('[registry] Failed to parse agent message:', err.message);
      return;
    }

    if (!registered) {
      if (envelope.type === MSG_TYPE.REGISTER && envelope.manifest) {
        clearTimeout(registrationTimeout);
        registered = true;
        agentId = envelope.manifest.id;
        register(ws, envelope.manifest);
      } else {
        console.log('[registry] Expected register message, got:', envelope.type);
      }
      return;
    }

    // After registration, handle health pongs
    if (envelope.type === MSG_TYPE.HEALTH && envelope.status === 'pong') {
      const entry = agents.get(agentId);
      if (entry) {
        entry.lastPing = Date.now();
      }
      return;
    }

    // Forward non-standard messages (e.g. telegram_new_message) to the callback
    if (agentMessageCallback && envelope.type !== MSG_TYPE.RESPONSE) {
      agentMessageCallback(agentId, envelope);
    }
  });

  ws.on('close', () => {
    clearTimeout(registrationTimeout);
    if (agentId) {
      unregister(agentId, ws);
    }
  });

  ws.on('error', (err) => {
    console.error(`[registry] Agent WS error${agentId ? ` (${agentId})` : ''}:`, err.message);
  });

  // WS-level ping/pong to detect dead TCP connections (complements app-level health)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}
