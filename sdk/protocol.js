/**
 * WebSocket message protocol for orchestrator <-> agent communication.
 * All messages are JSON-encoded envelopes with a `type` field.
 */

export const MSG_TYPE = {
  // Agent -> Orchestrator on connect
  REGISTER: 'register',
  // Orchestrator -> Agent (or reverse for response)
  REQUEST: 'request',
  RESPONSE: 'response',
  // Health ping/pong
  HEALTH: 'health',
  // Orchestrator -> Device
  DEVICE_COMMAND: 'device_command',
  // Device -> Orchestrator
  DEVICE_RESPONSE: 'device_response',
  // Error
  ERROR: 'error',
  // TTS
  TTS_AUDIO: 'tts_audio',
  TTS_INTERRUPT: 'tts_interrupt',
  // Abort
  ABORT: 'abort',
  // Remote desktop streaming
  STREAM_REQUEST: 'stream_request',
  STREAM_ACK: 'stream_ack',
  STREAM_STOP: 'stream_stop',
  STREAM_SWITCH_MONITOR: 'stream_switch_monitor',
  STREAM_ENDED: 'stream_ended',
  // Stream connection (orchestrator -> device, tells device to open dedicated WS)
  STREAM_CONNECT: 'stream_connect',
  // Audio relay
  AUDIO_RELAY_START: 'audio_relay_start',
  AUDIO_RELAY_STOP: 'audio_relay_stop',
  AUDIO_RELAY_ACK: 'audio_relay_ack',
  AUDIO_RELAY_CONFIG: 'audio_relay_config',
  AUDIO_RELAY_ERROR: 'audio_relay_error',
  STREAM_ERROR: 'stream_error',
  // WebRTC signaling (peer-to-peer audio/video)
  WEBRTC_INITIATE: 'webrtc_initiate',
  WEBRTC_OFFER: 'webrtc_offer',
  WEBRTC_ANSWER: 'webrtc_answer',
  WEBRTC_ICE: 'webrtc_ice',
  // Tool status (agent -> orchestrator -> device)
  TOOL_STATUS: 'tool_status',
  // Todo management (device <-> orchestrator)
  TODO_LIST: 'todo_list',
  TODO_CREATE: 'todo_create',
  TODO_UPDATE: 'todo_update',
  TODO_DELETE: 'todo_delete',
  TODO_MOVE: 'todo_move',
  TODO_RESULT: 'todo_result',
  // Telegram saved messages (device <-> orchestrator)
  TELEGRAM_SAVED: 'telegram_saved',
  TELEGRAM_SAVED_RESULT: 'telegram_saved_result',
  // ReID merge notification (reid-db-handler -> orchestrator -> device)
  REID_MERGE: 'reid_merge',
  // Job scheduling (device <-> orchestrator)
  JOB_LIST: 'job_list',
  JOB_CREATE: 'job_create',
  JOB_UPDATE: 'job_update',
  JOB_DELETE: 'job_delete',
  JOB_RESULT: 'job_result',
  JOB_NOTIFICATION: 'job_notification',
  // Telegram chat (device <-> orchestrator <-> pc-agent)
  TELEGRAM_CHAT_LIST: 'telegram_chat_list',
  TELEGRAM_CHAT_LIST_RESULT: 'telegram_chat_list_result',
  TELEGRAM_MESSAGES: 'telegram_messages',
  TELEGRAM_MESSAGES_RESULT: 'telegram_messages_result',
  TELEGRAM_SEND: 'telegram_send',
  TELEGRAM_SEND_RESULT: 'telegram_send_result',
  TELEGRAM_SUBSCRIBE: 'telegram_subscribe',
  TELEGRAM_UNSUBSCRIBE: 'telegram_unsubscribe',
  TELEGRAM_NEW_MESSAGE: 'telegram_new_message',
  TELEGRAM_TOPICS: 'telegram_topics',
  TELEGRAM_TOPICS_RESULT: 'telegram_topics_result',
  // Remote Control (claude orc CLI <-> orchestrator <-> phone)
  RC_SESSION_START: 'rc_session_start',
  RC_SESSION_END: 'rc_session_end',
  RC_MESSAGE: 'rc_message',
  RC_PERMISSION_REQUEST: 'rc_permission_request',
  RC_PERMISSION_RESPONSE: 'rc_permission_response',
  RC_TOOL_STATUS: 'rc_tool_status',
  RC_PLAN_UPDATE: 'rc_plan_update',
  RC_AGENT_STATUS: 'rc_agent_status',
  RC_THINKING: 'rc_thinking',
  RC_THINKING_END: 'rc_thinking_end',
  RC_MODE_CHANGE: 'rc_mode_change',
  RC_USER_INPUT: 'rc_user_input',
  RC_USER_RESPONSE: 'rc_user_response',
  RC_USER_MESSAGE: 'rc_user_message',
  RC_USER_MESSAGE_ACK: 'rc_user_message_ack',
  RC_TRANSCRIPT: 'rc_transcript',
  RC_ERROR: 'rc_error',
  // Assistant (real-time conversational fact-check) -- isolated session per device
  ASSISTANT: 'assistant',
  ASSISTANT_NEW: 'assistant_new',
  ASSISTANT_RESULT: 'assistant_result'
};

/**
 * Create an assistant batch request (device -> orchestrator). Carries the
 * latest transcribed speech for both speakers plus the cards currently shown on
 * the HUD (id + kind + heard phrase + note) so the model can decide which to
 * dismiss and avoid duplicates. activeCards sent back by the device may or may
 * not include "kind"; a missing kind is tolerated on input.
 * @param {string} requestId
 * @param {string} wearerText
 * @param {string} interlocutorText
 * @param {Array<{id: string, kind?: string, heard: string, note: string}>} activeCards
 */
export function createAssistantMessage(requestId, wearerText, interlocutorText, activeCards) {
  return {
    type: MSG_TYPE.ASSISTANT,
    requestId,
    wearerText: wearerText || '',
    interlocutorText: interlocutorText || '',
    activeCards: activeCards || []
  };
}

/**
 * Create an assistant result (orchestrator -> device). Each card carries a
 * "kind" ("reply" = a ready-to-say line in the wearer's voice, or "note" =
 * context/recall/warning to know), a "heard" trigger phrase (shown on the META
 * line), and a "note" whose *single-asterisk* spans the UI renders as glow+bold
 * highlights. The server owns the id.
 * @param {string} requestId
 * @param {Array<{id: string, kind: string, heard: string, note: string}>} cards new cards to draw
 * @param {string[]} dismiss card IDs to remove (wearer used/said the heard phrase)
 */
export function createAssistantResultMessage(requestId, cards, dismiss) {
  return {
    type: MSG_TYPE.ASSISTANT_RESULT,
    requestId,
    cards: cards || [],
    dismiss: dismiss || []
  };
}

/**
 * Create an assistant-new message (device -> orchestrator) to reset the
 * isolated assistant session for the device.
 */
export function createAssistantNewMessage() {
  return { type: MSG_TYPE.ASSISTANT_NEW };
}

/**
 * Create an ack envelope for a phone-originated rc_user_message. Sent back to
 * the same phone WS so the sender can mark the in-flight message as delivered
 * and stop retrying. The phone matches by requestId; sessionId is included
 * for routing on the phone side (the WS multiplexes all sessions).
 *
 * @param {string} sessionId
 * @param {string} requestId client-generated UUID echoed back unchanged
 * @returns {{type: string, sessionId: string, requestId: string}}
 */
export function createRcUserMessageAckMessage(sessionId, requestId) {
  return { type: MSG_TYPE.RC_USER_MESSAGE_ACK, sessionId, requestId };
}

/**
 * Create a register message (agent -> orchestrator).
 * @param {import('./types.js').AgentManifest} manifest
 */
export function createRegisterMessage(manifest) {
  return { type: MSG_TYPE.REGISTER, manifest };
}

/**
 * Create a request message (orchestrator -> agent).
 * @param {import('./types.js').AgentRequest} payload
 */
export function createRequestMessage(payload) {
  return { type: MSG_TYPE.REQUEST, payload };
}

/**
 * Create a response message (agent -> orchestrator).
 * @param {import('./types.js').AgentResponse|import('./types.js').AgentInputRequest|import('./types.js').AgentDelegationRequest} payload
 */
export function createResponseMessage(payload) {
  return { type: MSG_TYPE.RESPONSE, payload };
}

/**
 * Create a health message.
 * @param {"ping"|"pong"} status
 */
export function createHealthMessage(status = 'pong') {
  return { type: MSG_TYPE.HEALTH, status };
}

/**
 * Create a device command message (orchestrator -> device).
 * @param {string} requestId
 * @param {import('./types.js').DeviceCommand} command
 */
export function createDeviceCommandMessage(requestId, command) {
  return { type: MSG_TYPE.DEVICE_COMMAND, requestId, command };
}

/**
 * Create a device response message (device -> orchestrator).
 * @param {import('./types.js').DeviceCommandResponse} payload
 */
export function createDeviceResponseMessage(payload) {
  return { type: MSG_TYPE.DEVICE_RESPONSE, payload };
}

/**
 * Create an error message.
 * @param {string} requestId
 * @param {string} message
 */
export function createErrorMessage(requestId, message) {
  return { type: MSG_TYPE.ERROR, requestId, message };
}

/**
 * Create a TTS audio message (orchestrator -> device).
 * @param {string} requestId
 * @param {{ audioBase64: string, sentenceIndex: number, totalSentences: number, text: string, isFinal: boolean }} payload
 */
export function createTtsAudioMessage(requestId, payload) {
  return { type: MSG_TYPE.TTS_AUDIO, requestId, ...payload };
}

/**
 * Create a TTS interrupt message (device -> orchestrator).
 * @param {string} requestId
 */
export function createTtsInterruptMessage(requestId) {
  return { type: MSG_TYPE.TTS_INTERRUPT, requestId };
}

/**
 * Create an abort message (device -> orchestrator).
 * @param {string} requestId
 */
export function createAbortMessage(requestId) {
  return { type: MSG_TYPE.ABORT, requestId };
}

/**
 * Create a stream request message (phone -> orchestrator).
 * @param {string} targetDeviceId
 * @param {string} [resolution]
 */
export function createStreamRequestMessage(targetDeviceId, resolution = '720p', monitor = 0) {
  return { type: MSG_TYPE.STREAM_REQUEST, targetDeviceId, resolution, monitor };
}

/**
 * Create a stream ack message (orchestrator -> phone).
 * @param {number} streamId
 * @param {{ width: number, height: number, fps: number }} params
 */
export function createStreamAckMessage(streamId, params) {
  return { type: MSG_TYPE.STREAM_ACK, streamId, ...params };
}

/**
 * Create a stream stop message (phone -> orchestrator -> desktop).
 * @param {number} streamId
 */
export function createStreamStopMessage(streamId) {
  return { type: MSG_TYPE.STREAM_STOP, streamId };
}

/**
 * Create a stream ended message (desktop -> orchestrator -> phone).
 * @param {number} streamId
 * @param {string} [reason]
 */
export function createStreamEndedMessage(streamId, reason) {
  return { type: MSG_TYPE.STREAM_ENDED, streamId, reason };
}

/**
 * Create a tool status message (agent -> orchestrator -> device).
 * @param {string} requestId
 * @param {string} toolName
 * @param {Object} [toolArgs] - Tool arguments to display
 * @param {string} [toolCallId] - Unique ID per tool call (for stacking in UI)
 */
export function createToolStatusMessage(requestId, toolName, toolArgs, toolCallId) {
  return {
    type: MSG_TYPE.TOOL_STATUS,
    requestId,
    toolName,
    toolArgs: toolArgs || {},
    toolCallId: toolCallId || '',
    status: 'calling'
  };
}

/**
 * Create a tool complete message with result (agent -> orchestrator -> device).
 * @param {string} requestId
 * @param {string} toolName
 * @param {string} toolCallId - Must match the toolCallId from the corresponding status message
 * @param {string} [toolResult] - Stringified tool result
 */
export function createToolCompleteMessage(requestId, toolName, toolCallId, toolResult) {
  return {
    type: MSG_TYPE.TOOL_STATUS,
    requestId,
    toolName,
    toolCallId,
    status: 'complete',
    toolResult: toolResult || null
  };
}

/**
 * Create an RC session start message (CLI -> orchestrator -> phone).
 * @param {string} sessionId
 * @param {string} workDir
 */
export function createRcSessionStartMessage(sessionId, workDir) {
  return { type: MSG_TYPE.RC_SESSION_START, sessionId, workDir };
}

/**
 * Create an RC session end message.
 * @param {string} sessionId
 */
export function createRcSessionEndMessage(sessionId) {
  return { type: MSG_TYPE.RC_SESSION_END, sessionId };
}

/**
 * Create an RC message (assistant text output).
 * @param {string} sessionId
 * @param {string} text
 * @param {boolean} isFinal
 * @param {string} [requestId]
 */
export function createRcMessage(sessionId, text, isFinal, requestId) {
  return { type: MSG_TYPE.RC_MESSAGE, sessionId, text, isFinal, requestId: requestId || null };
}

/**
 * Create an RC permission request message (CLI -> orchestrator -> phone).
 * @param {string} sessionId
 * @param {string} toolName
 * @param {Object} toolArgs
 * @param {string} requestId
 * @param {string} [description]
 */
export function createRcPermissionRequestMessage(sessionId, toolName, toolArgs, requestId, description) {
  return { type: MSG_TYPE.RC_PERMISSION_REQUEST, sessionId, toolName, toolArgs, requestId, description: description || null };
}

/**
 * Create an RC permission response message (phone -> orchestrator -> CLI).
 * @param {string} sessionId
 * @param {string} requestId
 * @param {boolean} approved
 * @param {string} [modeChange]
 */
export function createRcPermissionResponseMessage(sessionId, requestId, approved, modeChange) {
  return { type: MSG_TYPE.RC_PERMISSION_RESPONSE, sessionId, requestId, approved, modeChange: modeChange || null };
}

/**
 * Create an RC tool status message (CLI -> orchestrator -> phone).
 * @param {string} sessionId
 * @param {string} toolName
 * @param {string} status
 * @param {Object} [toolArgs]
 * @param {string} [result]
 * @param {string} [toolCallId] - Unique per-invocation ID (Claude's tool_use block.id)
 */
export function createRcToolStatusMessage(sessionId, toolName, status, toolArgs, result, toolCallId) {
  return { type: MSG_TYPE.RC_TOOL_STATUS, sessionId, toolName, status, toolArgs: toolArgs || null, result: result || null, toolCallId: toolCallId || null };
}

/**
 * Create an RC plan update message (CLI -> orchestrator -> phone).
 * @param {string} sessionId
 * @param {boolean} entering
 * @param {string} [planContent]
 */
export function createRcPlanUpdateMessage(sessionId, entering, planContent) {
  return { type: MSG_TYPE.RC_PLAN_UPDATE, sessionId, entering, planContent: planContent || null };
}

/**
 * Create an RC agent status message (CLI -> orchestrator -> phone).
 * @param {string} sessionId
 * @param {string} agentId
 * @param {string} name
 * @param {string} status
 * @param {number} [depth]
 */
export function createRcAgentStatusMessage(sessionId, agentId, name, status, depth) {
  return { type: MSG_TYPE.RC_AGENT_STATUS, sessionId, agentId, name, status, depth: depth ?? 0 };
}

/**
 * Create an RC thinking message (CLI -> orchestrator -> phone).
 * @param {string} sessionId
 * @param {string} text
 * @param {number} [startedAt] - epoch-ms when thinking began
 */
export function createRcThinkingMessage(sessionId, text, startedAt) {
  return { type: MSG_TYPE.RC_THINKING, sessionId, text, startedAt: startedAt || Date.now() };
}

/**
 * Create an RC thinking-end message (CLI -> orchestrator -> phone).
 * Emitted on every transition out of the thinking state: final assistant
 * message, user/orchestrator interrupt, or unexpected CLI exit. Phone uses
 * elapsedMs to render a "Thought for Xs" badge.
 * @param {string} sessionId
 * @param {number} elapsedMs
 */
export function createRcThinkingEndMessage(sessionId, elapsedMs) {
  return { type: MSG_TYPE.RC_THINKING_END, sessionId, elapsedMs: elapsedMs | 0 };
}

/**
 * Create an RC mode change message (phone -> orchestrator -> CLI).
 * @param {string} sessionId
 * @param {string} mode
 */
export function createRcModeChangeMessage(sessionId, mode) {
  return { type: MSG_TYPE.RC_MODE_CHANGE, sessionId, mode };
}

/**
 * Create an RC user input request message (CLI -> orchestrator -> phone).
 * @param {string} sessionId
 * @param {string} prompt
 * @param {string} requestId
 */
export function createRcUserInputMessage(sessionId, prompt, requestId) {
  return { type: MSG_TYPE.RC_USER_INPUT, sessionId, prompt, requestId };
}

/**
 * Create an RC user response message (phone -> orchestrator -> CLI).
 * @param {string} sessionId
 * @param {string} requestId
 * @param {string} text
 */
export function createRcUserResponseMessage(sessionId, requestId, text) {
  return { type: MSG_TYPE.RC_USER_RESPONSE, sessionId, requestId, text };
}

/**
 * Create an RC transcript message (orchestrator -> phone).
 * @param {string} sessionId
 * @param {Array} messages
 */
export function createRcTranscriptMessage(sessionId, messages) {
  return { type: MSG_TYPE.RC_TRANSCRIPT, sessionId, messages };
}

/**
 * Create an RC error message (orchestrator -> phone).
 * @param {string} sessionId
 * @param {string} error
 * @param {string} [source]
 */
export function createRcErrorMessage(sessionId, error, source) {
  return { type: MSG_TYPE.RC_ERROR, sessionId, error, source: source || 'system' };
}

/**
 * Parse a raw WebSocket message string into an envelope.
 * @param {string} raw
 * @returns {{ type: string, [key: string]: any }}
 */
export function parseMessage(raw) {
  return JSON.parse(raw);
}

/**
 * Serialize an envelope to a WebSocket message string.
 * @param {Object} envelope
 * @returns {string}
 */
export function serializeMessage(envelope) {
  return JSON.stringify(envelope);
}
