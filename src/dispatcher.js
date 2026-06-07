import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  MSG_TYPE,
  parseMessage,
  serializeMessage,
  createRequestMessage,
  createDeviceCommandMessage,
  createErrorMessage,
  createToolStatusMessage
} from '@orchestrator/sdk/protocol';
import { AGENT_RESPONSE_STATUS } from '@orchestrator/sdk/types';
import { getDeviceTools, isDeviceTool, isNotImplemented, isTodoTool, isJobTool, isTimeTool, buildDeviceCommand } from '@orchestrator/sdk/device-tools';
import { classify } from './classifier.js';
import { directLLM } from './direct-llm.js';
import { format } from './aggregator.js';
import * as registry from './registry.js';

const DEFAULT_TIMEOUT_MS = 600_000;

// Global instructions injected into every agent's system prompt
const GLOBAL_AGENT_INSTRUCTIONS = [
  'You MUST respond in the same language the user writes in. If the user writes in Russian, your entire response MUST be in Russian. If in English, respond in English. Match their language exactly.',
  'NEVER use emojis in your responses. No emoticons, no unicode emoji characters. Plain text only.',
].join('\n');

/** @type {import('./session.js').SessionManager|null} */
let sessionManager = null;

/** @type {import('./chat-store.js').ChatStore|null} */
let chatStore = null;

/** @type {import('./todo-store.js').TodoStore|null} */
let todoStore = null;

/** @type {import('./job-store.js').JobStore|null} */
let jobStore = null;

/** Per-device request serialization -- prevents concurrent handleRequest on the same session */
const deviceRequestChains = new Map();

/**
 * Initialize the dispatcher with a session manager, chat store, todo store, and job store.
 * @param {import('./session.js').SessionManager} sm
 * @param {import('./chat-store.js').ChatStore} [cs]
 * @param {import('./todo-store.js').TodoStore} [ts]
 * @param {import('./job-store.js').JobStore} [js]
 */
export function initDispatcher(sm, cs, ts, js) {
  sessionManager = sm;
  chatStore = cs || null;
  todoStore = ts || null;
  jobStore = js || null;
}

/**
 * Build user content from text and optional image.
 * @param {string} text
 * @param {string} [imageBase64]
 * @returns {string|Array<{type: string, [key: string]: any}>}
 */
function buildUserContent(text, imageBase64) {
  if (!imageBase64) return text;
  const mimeType = imageBase64.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
  return [
    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
    { type: 'text', text }
  ];
}

/**
 * Sum two usage objects together, accumulating token counts.
 */
function sumUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens || 0) + (b.cache_creation_input_tokens || 0),
    cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0),
  };
}

/**
 * Forward TOOL_STATUS messages from an agent's WebSocket to the device WebSocket,
 * and collect them for persistence in chat history.
 * @param {import('ws').WebSocket} agentWs
 * @param {import('ws').WebSocket} deviceWs
 * @param {string} matchRequestId - requestId to match on agent messages
 * @param {string} [overrideRequestId] - if set, rewrite requestId before forwarding (for delegation)
 * @returns {{ stop: () => void, collected: Array<object> }}
 */
function forwardToolStatus(agentWs, deviceWs, matchRequestId, overrideRequestId) {
  const collected = [];
  function handler(raw) {
    try {
      const envelope = parseMessage(raw.toString());
      if (envelope.type === MSG_TYPE.TOOL_STATUS && envelope.requestId === matchRequestId) {
        // Collect for persistence -- update existing entry on completion, otherwise add new
        if (envelope.status === 'complete' && envelope.toolCallId) {
          const existing = collected.find(c => c.toolCallId === envelope.toolCallId);
          if (existing) {
            existing.status = 'complete';
            if (envelope.toolResult) existing.toolResult = envelope.toolResult;
          } else {
            collected.push({ toolCallId: envelope.toolCallId, toolName: envelope.toolName, toolArgs: envelope.toolArgs, status: 'complete', toolResult: envelope.toolResult || null });
          }
        } else if (envelope.status === 'calling') {
          collected.push({ toolCallId: envelope.toolCallId, toolName: envelope.toolName, toolArgs: envelope.toolArgs, status: 'calling', toolResult: null });
        }

        if (overrideRequestId) {
          envelope.requestId = overrideRequestId;
          deviceWs.send(serializeMessage(envelope));
        } else {
          deviceWs.send(raw.toString());
        }
      }
    } catch {}
  }
  agentWs.on('message', handler);
  return { stop: () => agentWs.removeListener('message', handler), collected };
}

/**
 * Send a tool status message to the device (for direct LLM tool calls).
 */
function sendToolStatusToDevice(deviceWs, requestId, toolName, toolArgs) {
  if (!deviceWs || deviceWs.readyState !== 1) return;
  try {
    deviceWs.send(serializeMessage(createToolStatusMessage(requestId, toolName, toolArgs)));
  } catch {}
}

/**
 * Handle an incoming device request through the full orchestrator loop.
 * Serializes requests per deviceId so concurrent calls queue instead of racing.
 * @param {{ requestId: string, text?: string, imageBase64?: string, deviceId: string, deviceType: string }} request
 * @param {import('ws').WebSocket | null} deviceWs - Device WebSocket for input requests (null for HTTP-only)
 * @returns {Promise<{ text: string, data?: Record<string, any>, status: string, usage?: object }>}
 */
export async function handleRequest(request, deviceWs) {
  const { deviceId } = request;
  const prev = deviceRequestChains.get(deviceId);
  let releaseLock;
  const gate = new Promise(r => { releaseLock = r; });
  deviceRequestChains.set(deviceId, gate);

  if (prev) {
    console.log(`[dispatcher] Queuing request for ${deviceId} -- previous request in flight`);
    await prev;
  }

  try {
    return await _handleRequestInner(request, deviceWs);
  } finally {
    releaseLock();
    if (deviceRequestChains.get(deviceId) === gate) {
      deviceRequestChains.delete(deviceId);
    }
  }
}

async function _handleRequestInner(request, deviceWs) {
  const { requestId, text, imageBase64, model, deviceId, deviceType, userSystemPrompt } = request;

  // Session management
  const session = sessionManager.getSession(deviceId, deviceType);
  session.touch();
  if (userSystemPrompt) {
    session.userSystemPrompt = userSystemPrompt;
  }
  await sessionManager.compactIfNeeded(session);

  const userContent = buildUserContent(text, imageBase64);
  session.addUserMessage(userContent);

  // Classify intent
  const manifests = registry.getManifests();
  if (manifests.length === 0) {
    persistTurn(session, { requestId, userText: text, userImage: imageBase64, classification: null, response: { status: 'error', text: 'No agents are currently available.', agentId: null } });
    return { text: 'No agents are currently available.', status: 'error' };
  }

  let classification;
  const MAX_CLASSIFY_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_CLASSIFY_RETRIES; attempt++) {
    try {
      classification = await classify(text || '', manifests, session.getHistoryForAgent());
      break;
    } catch (err) {
      console.error(`[dispatcher] Classification failed (attempt ${attempt}/${MAX_CLASSIFY_RETRIES}) for request ${requestId}:`, err.message);
      if (attempt < MAX_CLASSIFY_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      } else {
        persistTurn(session, { requestId, userText: text, userImage: imageBase64, classification: null, response: { status: 'error', text: 'Failed to classify request.', agentId: null } });
        return { text: 'Failed to classify request.', status: 'error' };
      }
    }
  }

  let usage = classification.usage || null;

  const isJobMode = !!session.userSystemPrompt;
  const fallbackThreshold = isJobMode ? 0.3 : 0.5;

  if (classification.confidence < fallbackThreshold) {
    console.log(`[dispatcher] Low confidence (${classification.confidence}, threshold=${fallbackThreshold}) for request ${requestId}, falling back to direct LLM`);
    const deviceTools = getDeviceTools(deviceType);
    const messages = session.getMessages();
    const collectedToolCalls = [];
    let llmResult = await directLLM(messages, model, deviceTools, GLOBAL_AGENT_INSTRUCTIONS);
    usage = sumUsage(usage, llmResult.usage);

    // Device tool call loop -- process ALL tool calls per assistant message before calling LLM again
    while (llmResult.toolCalls && llmResult.toolCalls.length > 0 && deviceWs && deviceWs.readyState === 1) {
      // Fix null content on assistant messages with tool_calls (Communicator rejects null)
      const assistantMsg = { ...llmResult.assistantMessage, content: llmResult.assistantMessage.content || '' };
      messages.push(assistantMsg);

      // Process every tool call in this assistant message
      for (const toolCall of llmResult.toolCalls) {
        const toolName = toolCall.function.name;
        let toolArgs;
        try { toolArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch { toolArgs = {}; }

        console.log(`[dispatcher] Direct LLM called tool: ${toolName}`);
        sendToolStatusToDevice(deviceWs, requestId, toolName, toolArgs);

        const toolCallRecord = { id: toolCall.id, name: toolName, arguments: toolArgs, result: null, status: 'complete' };

        // Handle todo tools server-side (no device roundtrip)
        if (isTodoTool(toolName) && todoStore) {
          let todoResult;
          try {
            todoResult = await handleTodoTool(toolName, toolArgs, deviceWs);
          } catch (err) {
            console.error(`[dispatcher] Todo tool failed:`, err.message);
            toolCallRecord.result = JSON.stringify({ error: err.message });
            toolCallRecord.status = 'error';
            collectedToolCalls.push(toolCallRecord);
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: err.message }) });
            continue;
          }
          toolCallRecord.result = JSON.stringify(todoResult);
          collectedToolCalls.push(toolCallRecord);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(todoResult) });
          continue;
        }

        // Handle job tools server-side (no device roundtrip)
        if (isJobTool(toolName) && jobStore) {
          let jobResult;
          try {
            jobResult = await handleJobTool(toolName, toolArgs, deviceWs);
          } catch (err) {
            console.error(`[dispatcher] Job tool failed:`, err.message);
            toolCallRecord.result = JSON.stringify({ error: err.message });
            toolCallRecord.status = 'error';
            collectedToolCalls.push(toolCallRecord);
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: err.message }) });
            continue;
          }
          toolCallRecord.result = JSON.stringify(jobResult);
          collectedToolCalls.push(toolCallRecord);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(jobResult) });
          continue;
        }

        // Handle time tool server-side (no device roundtrip)
        if (isTimeTool(toolName)) {
          const now = new Date();
          const timeResult = {
            iso: now.toISOString(),
            unix: Math.floor(now.getTime() / 1000),
            readable: now.toLocaleString('en-US', { timeZone: 'Europe/Moscow', dateStyle: 'full', timeStyle: 'long' })
          };
          toolCallRecord.result = JSON.stringify(timeResult);
          collectedToolCalls.push(toolCallRecord);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(timeResult) });
          continue;
        }

        if (!isDeviceTool(toolName) || isNotImplemented(toolName)) {
          const errorMsg = isNotImplemented(toolName) ? `Tool "${toolName}" is not yet implemented.` : `Unknown tool "${toolName}".`;
          toolCallRecord.result = JSON.stringify({ error: errorMsg });
          toolCallRecord.status = 'error';
          collectedToolCalls.push(toolCallRecord);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: errorMsg }) });
          continue;
        }

        const deviceCommand = buildDeviceCommand(toolName, toolArgs);
        deviceCommand.deviceType = deviceType;
        let deviceResponse;
        try {
          deviceResponse = await sendDeviceCommandAndWait(deviceWs, requestId, deviceCommand);
        } catch (err) {
          console.error(`[dispatcher] Device command failed in direct LLM:`, err.message);
          toolCallRecord.result = JSON.stringify({ error: err.message });
          toolCallRecord.status = 'error';
          collectedToolCalls.push(toolCallRecord);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: err.message }) });
          continue;
        }

        // Build tool result -- use multimodal format for images to avoid token explosion
        let toolContent;
        if (deviceResponse.imageBase64) {
          const mimeType = deviceResponse.imageBase64.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
          toolContent = [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${deviceResponse.imageBase64}` } },
            { type: 'text', text: deviceResponse.text || 'Photo captured.' }
          ];
          // Store text placeholder instead of base64 in history
          toolCallRecord.result = deviceResponse.text || '[image]';
        } else {
          const toolResult = { ...deviceResponse.data };
          if (deviceResponse.text) toolResult.text = deviceResponse.text;
          toolContent = JSON.stringify(toolResult);
          toolCallRecord.result = toolContent;
        }

        collectedToolCalls.push(toolCallRecord);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolContent });
      }

      // All tool results collected, call LLM again
      llmResult = await directLLM(messages, model, deviceTools, GLOBAL_AGENT_INSTRUCTIONS);
      usage = sumUsage(usage, llmResult.usage);
    }

    // Persist all intermediate tool messages to session so follow-up turns have full context
    // (e.g., restaurant coordinates from search_places needed for prepare_journey)
    const sessionMessages = session.getMessages();
    const newMessages = messages.slice(sessionMessages.length);
    for (const msg of newMessages) {
      session.messages.push(msg);
    }

    sessionManager.updateUsage(session, llmResult.usage);
    const formatted = format({ text: llmResult.text, status: 'success' }, deviceType);
    persistTurn(session, { requestId, userText: text, userImage: imageBase64, classification, response: { status: 'success', text: formatted.text, agentId: 'direct-llm' }, usage, toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined });
    return { ...formatted, status: 'success', usage };
  }

  console.log(`[dispatcher] Request ${requestId} -> agent "${classification.agentId}" (intent: ${classification.intent}, confidence: ${classification.confidence})`);

  // Route to agent
  const agentEntry = registry.getAgent(classification.agentId);
  if (!agentEntry) {
    persistTurn(session, { requestId, userText: text, userImage: imageBase64, classification, response: { status: 'error', text: `Agent "${classification.agentId}" is not available.`, agentId: classification.agentId } });
    return { text: `Agent "${classification.agentId}" is not available.`, status: 'error' };
  }

  const availableAgents = manifests
    .filter(m => m.id !== classification.agentId)
    .map(m => ({ id: m.id, name: m.name, capabilities: m.capabilities }));

  const agentRequest = {
    requestId,
    intent: classification.intent,
    text,
    imageBase64,
    model,
    context: { deviceId, deviceType, deviceTools: getDeviceTools(deviceType), sessionHistory: session.getHistoryForAgent(), availableAgents, globalInstructions: GLOBAL_AGENT_INSTRUCTIONS, autonomousInstructions: isJobMode ? session.userSystemPrompt : null }
  };

  // Session loop -- forward agent tool status to device during processing, collect for persistence
  const allCollectedToolCalls = [];
  let fwd = deviceWs ? forwardToolStatus(agentEntry.ws, deviceWs, requestId) : null;
  let response = await sendToAgentAndWait(agentEntry, agentRequest);
  if (fwd) { fwd.stop(); allCollectedToolCalls.push(...fwd.collected); }

  while (true) {
    if (response.status === AGENT_RESPONSE_STATUS.SUCCESS || response.status === AGENT_RESPONSE_STATUS.ERROR || response.status === AGENT_RESPONSE_STATUS.PARTIAL) {
      if (fwd) fwd.stop();
      if (response.status === AGENT_RESPONSE_STATUS.SUCCESS || response.status === AGENT_RESPONSE_STATUS.PARTIAL) {
        session.addAssistantMessage(response.text);
      }
      const formatted = format(response, deviceType);
      const agentToolCalls = buildAgentToolCalls(allCollectedToolCalls);
      persistTurn(session, { requestId, userText: text, userImage: imageBase64, classification, response: { status: response.status, text: formatted.text, agentId: classification.agentId }, usage, toolCalls: agentToolCalls.length > 0 ? agentToolCalls : undefined });
      return { ...formatted, status: response.status, usage };
    }

    if (response.status === AGENT_RESPONSE_STATUS.NEEDS_INPUT) {
      if (!deviceWs || deviceWs.readyState !== 1) {
        if (fwd) fwd.stop();
        return { text: 'Agent needs device input but no device connection available.', status: 'error' };
      }

      // Send command to device, wait for device response
      response.deviceCommand.deviceType = deviceType;
      console.log(`[dispatcher] Agent needs device input for ${requestId}: ${response.deviceCommand?.type} (originalText: "${response.deviceCommand?.originalText?.substring(0, 80)}")`);
      let deviceResponse;
      try {
        deviceResponse = await sendDeviceCommandAndWait(deviceWs, requestId, response.deviceCommand);
      } catch (err) {
        console.error(`[dispatcher] Device command failed for request ${requestId}:`, err.message);
        if (fwd) fwd.stop();
        return { text: `Device command failed: ${err.message}`, status: 'error' };
      }

      console.log(`[dispatcher] Device response for ${requestId}: hasData=${!!deviceResponse.data}, hasText=${!!deviceResponse.text}, text="${(deviceResponse.text || '').substring(0, 100)}", dataKeys=${deviceResponse.data ? Object.keys(deviceResponse.data).join(',') : 'none'}`);

      // Notify device that processing continues (resets glasses timeout)
      sendToolStatusToDevice(deviceWs, requestId, response.deviceCommand?.type || 'processing');

      // Feed device response back to agent as a follow-up request
      const followUp = {
        requestId,
        intent: classification.intent,
        text: deviceResponse.text,
        imageBase64: deviceResponse.imageBase64 || deviceResponse.screenBase64,
        context: {
          deviceId, deviceType, commandType: deviceResponse.commandType,
          originalText: response.deviceCommand?.originalText,
          agentState: response._agentState || null,
          deviceToolResult: true,
          deviceResultData: deviceResponse.data || null,
          deviceResponseText: deviceResponse.text || null,
          deviceTools: getDeviceTools(deviceType),
          sessionHistory: session.getHistoryForAgent(),
          availableAgents,
          globalInstructions: GLOBAL_AGENT_INSTRUCTIONS,
          autonomousInstructions: isJobMode ? session.userSystemPrompt : null
        }
      };

      fwd = deviceWs ? forwardToolStatus(agentEntry.ws, deviceWs, requestId) : null;
      response = await sendToAgentAndWait(agentEntry, followUp);
      if (fwd) { fwd.stop(); allCollectedToolCalls.push(...fwd.collected); }
      continue;
    }

    if (response.status === AGENT_RESPONSE_STATUS.NEEDS_AGENT) {
      const delegation = response.agentRequest;
      let delegateEntry;

      if (delegation.targetAgentId) {
        delegateEntry = registry.getAgent(delegation.targetAgentId);
      }

      if (!delegateEntry) {
        // Classify to find the right agent
        const delegateClassification = await classify(delegation.text || '', registry.getManifests());
        delegateEntry = registry.getAgent(delegateClassification.agentId);

        if (!delegateEntry) {
          if (fwd) fwd.stop();
          return { text: `Delegation target agent is not available.`, status: 'error' };
        }
      }

      const delegateRequest = {
        requestId: uuidv4(),
        intent: delegation.text || '',
        text: delegation.text,
        imageBase64: delegation.imageBase64,
        context: delegation.context || {}
      };

      // Forward delegate tool status but rewrite requestId to original so client stopToolAnimation works
      const delegateFwd = deviceWs ? forwardToolStatus(delegateEntry.ws, deviceWs, delegateRequest.requestId, requestId) : null;
      const delegateResponse = await sendToAgentAndWait(delegateEntry, delegateRequest);
      if (delegateFwd) { delegateFwd.stop(); allCollectedToolCalls.push(...delegateFwd.collected); }

      // Feed delegation result back to original agent
      const currentAvailableAgents = registry.getManifests()
        .filter(m => m.id !== classification.agentId)
        .map(m => ({ id: m.id, name: m.name, capabilities: m.capabilities }));
      const followUp = {
        requestId,
        intent: classification.intent,
        text: delegateResponse.text,
        context: { ...agentRequest.context, availableAgents: currentAvailableAgents, delegationResult: delegateResponse }
      };

      fwd = deviceWs ? forwardToolStatus(agentEntry.ws, deviceWs, requestId) : null;
      response = await sendToAgentAndWait(agentEntry, followUp);
      if (fwd) { fwd.stop(); allCollectedToolCalls.push(...fwd.collected); }
      continue;
    }

    // Unknown status
    if (fwd) fwd.stop();
    console.error(`[dispatcher] Unknown response status: ${response.status}`);
    const agentToolCalls = buildAgentToolCalls(allCollectedToolCalls);
    persistTurn(session, { requestId, userText: text, userImage: imageBase64, classification, response: { status: 'error', text: 'Received unknown response from agent.', agentId: classification.agentId }, usage, toolCalls: agentToolCalls.length > 0 ? agentToolCalls : undefined });
    return { text: 'Received unknown response from agent.', status: 'error' };
  }
}

/**
 * Convert collected TOOL_STATUS messages from agent forwarding into persistable toolCalls array.
 * Deduplicates by toolCallId, preferring the entry with a result.
 * @param {Array<object>} collected
 * @returns {Array<{ id: string, name: string, arguments: object, result: string|null, status: string }>}
 */
function buildAgentToolCalls(collected) {
  const byId = new Map();
  for (const c of collected) {
    const id = c.toolCallId || `${c.toolName}-${Date.now()}`;
    const existing = byId.get(id);
    if (!existing || (c.status === 'complete' && existing.status !== 'complete')) {
      byId.set(id, { id, name: c.toolName, arguments: c.toolArgs || {}, result: c.toolResult || null, status: c.status || 'complete' });
    }
  }
  return Array.from(byId.values());
}

/**
 * Persist a turn to the chat store (fire-and-forget).
 * @param {import('./session.js').Session} session
 * @param {object} turnData
 */
function persistTurn(session, turnData) {
  if (!chatStore) return;
  const meta = { deviceId: session.deviceId, deviceType: session.deviceType };
  chatStore.appendTurn(session.conversationId, turnData, meta).catch(err => {
    console.error(`[dispatcher] Failed to persist turn:`, err.message);
  });
}

/**
 * Send a request to an agent and wait for the response.
 * @param {{ ws: import('ws').WebSocket, manifest: import('../sdk/types.js').AgentManifest }} agentEntry
 * @param {import('../sdk/types.js').AgentRequest} agentRequest
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function sendToAgentAndWait(agentEntry, agentRequest, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const { ws } = agentEntry;
    const { requestId } = agentRequest;

    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Agent response timeout after ${timeoutMs}ms for request ${requestId}`));
    }, timeoutMs);

    function handler(raw) {
      let envelope;
      try {
        envelope = parseMessage(raw.toString());
      } catch {
        return;
      }

      if (envelope.type === MSG_TYPE.RESPONSE && envelope.payload?.requestId === requestId) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(envelope.payload);
      }
    }

    ws.on('message', handler);

    const msg = createRequestMessage(agentRequest);
    ws.send(serializeMessage(msg));
  });
}

/**
 * Send a device command and wait for the device response.
 * @param {import('ws').WebSocket} deviceWs
 * @param {string} requestId
 * @param {import('../sdk/types.js').DeviceCommand} command
 * @param {number} [timeoutMs]
 * @returns {Promise<import('../sdk/types.js').DeviceCommandResponse>}
 */
function sendDeviceCommandAndWait(deviceWs, requestId, command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const effectiveTimeout = command.timeout || timeoutMs;
    const timeout = setTimeout(() => {
      deviceWs.removeListener('message', handler);
      reject(new Error(`Device response timeout after ${effectiveTimeout}ms for request ${requestId}`));
    }, effectiveTimeout);

    function handler(raw) {
      let envelope;
      try {
        envelope = parseMessage(raw.toString());
      } catch {
        return;
      }

      if (envelope.type === MSG_TYPE.DEVICE_RESPONSE && envelope.payload?.requestId === requestId) {
        clearTimeout(timeout);
        deviceWs.removeListener('message', handler);
        resolve(envelope.payload);
      }
    }

    deviceWs.on('message', handler);

    const msg = createDeviceCommandMessage(requestId, command);
    deviceWs.send(serializeMessage(msg));
  });
}

/**
 * Handle a todo tool call server-side via TodoStore.
 * Pushes updated list to device after mutations.
 * @param {string} toolName
 * @param {Record<string, any>} toolArgs
 * @param {import('ws').WebSocket|null} deviceWs
 * @returns {Promise<object>}
 */
async function handleTodoTool(toolName, toolArgs, deviceWs) {
  if (toolName === 'list_tasks') {
    const todos = await todoStore.list();
    return { tasks: todos.map((t, i) => ({ id: t.id, text: t.text, completed: t.completed, position: i })) };
  }

  if (toolName === 'add_task') {
    const todo = await todoStore.create(toolArgs.text);
    pushTodoUpdate(deviceWs);
    return { created: { id: todo.id, text: todo.text, completed: todo.completed } };
  }

  if (toolName === 'update_task') {
    const fields = {};
    if (toolArgs.text !== undefined) fields.text = toolArgs.text;
    if (toolArgs.completed !== undefined) fields.completed = toolArgs.completed;
    if (Object.keys(fields).length === 0) throw new Error('No fields to update (provide text and/or completed)');
    const updated = await todoStore.update(toolArgs.id, fields);
    if (!updated) throw new Error(`Task not found: ${toolArgs.id}`);
    pushTodoUpdate(deviceWs);
    return { updated: { id: updated.id, text: updated.text, completed: updated.completed } };
  }

  if (toolName === 'move_task') {
    const moved = await todoStore.move(toolArgs.id, toolArgs.position);
    pushTodoUpdate(deviceWs);
    return { moved: { id: moved.id, text: moved.text, position: moved.order } };
  }

  if (toolName === 'delete_task') {
    const deleted = await todoStore.remove(toolArgs.id);
    if (!deleted) throw new Error(`Task not found: ${toolArgs.id}`);
    pushTodoUpdate(deviceWs);
    return { deleted: true, id: toolArgs.id };
  }

  if (toolName === 'read_saved_messages') {
    const limit = toolArgs.limit || 5;
    const agentEntry = registry.getAgent('pc-agent');
    if (!agentEntry) throw new Error('PC agent not available -- Telegram access requires the PC agent to be running');
    const requestId = crypto.randomUUID();
    const response = await sendToAgentAndWait(agentEntry, {
      requestId,
      action: 'telegram_read_messages',
      chat: 'me',
      limit
    });
    if (response.status === 'error') {
      throw new Error(response.text || 'Telegram fetch failed');
    }
    return { messages: response.data?.messages || [] };
  }

  throw new Error(`Unknown todo tool: ${toolName}`);
}

/**
 * Handle a job tool call server-side via JobStore.
 * Pushes updated job list to device after mutations.
 * @param {string} toolName
 * @param {Record<string, any>} toolArgs
 * @param {import('ws').WebSocket|null} deviceWs
 * @returns {Promise<object>}
 */
async function handleJobTool(toolName, toolArgs, deviceWs) {
  if (toolName === 'list_jobs') {
    const jobs = await jobStore.list();
    return { jobs: jobs.map(j => ({ id: j._id?.toString() || j.id, name: j.name, prompt: j.prompt, scheduledAt: j.scheduledAt, status: j.status, result: j.result, error: j.error })) };
  }

  if (toolName === 'create_job') {
    const { name, prompt, scheduled_at } = toolArgs;
    if (!name || !prompt || !scheduled_at) throw new Error('Missing required fields: name, prompt, scheduled_at');
    const job = await jobStore.create(name, prompt, new Date(scheduled_at));
    pushJobUpdate(deviceWs);
    return { created: { id: job._id?.toString() || job.id, name: job.name, prompt: job.prompt, scheduledAt: job.scheduledAt, status: job.status } };
  }

  if (toolName === 'delete_job') {
    const deleted = await jobStore.remove(toolArgs.id);
    if (!deleted) throw new Error(`Job not found: ${toolArgs.id}`);
    pushJobUpdate(deviceWs);
    return { deleted: true, id: toolArgs.id };
  }

  throw new Error(`Unknown job tool: ${toolName}`);
}

/**
 * Push the full job list to the device so UI refreshes.
 * @param {import('ws').WebSocket|null} deviceWs
 */
function pushJobUpdate(deviceWs) {
  if (!deviceWs || deviceWs.readyState !== 1 || !jobStore) return;
  jobStore.list().then(jobs => {
    deviceWs.send(serializeMessage({ type: MSG_TYPE.JOB_RESULT, action: 'list', jobs }));
  }).catch(err => {
    console.error('[dispatcher] Failed to push job update:', err.message);
  });
}

/**
 * Push the full todo list to the device so UI refreshes.
 * @param {import('ws').WebSocket|null} deviceWs
 */
function pushTodoUpdate(deviceWs) {
  if (!deviceWs || deviceWs.readyState !== 1 || !todoStore) return;
  todoStore.list().then(todos => {
    deviceWs.send(serializeMessage({ type: MSG_TYPE.TODO_RESULT, action: 'list', todos }));
  }).catch(err => {
    console.error('[dispatcher] Failed to push todo update:', err.message);
  });
}
