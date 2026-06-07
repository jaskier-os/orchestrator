/**
 * Shared type definitions for the orchestrator + agent system.
 * These are the canonical interfaces from the architecture doc.
 * Since this is plain JS (no TS), types are documented via JSDoc.
 */

/**
 * @typedef {Object} AgentManifest
 * @property {string} id - Unique agent identifier (e.g. "pc-agent", "obsidian-agent")
 * @property {string} name - Human-readable name
 * @property {string[]} capabilities - Used by intent classifier
 * @property {("text"|"image"|"audio"|"screen")[]} inputTypes
 * @property {string} healthEndpoint - Path for health checks
 * @property {string[]} [remoteSessionDirs] - Directories available for remote coding sessions (PC agent only)
 */

/**
 * @typedef {Object} AgentRequest
 * @property {string} requestId
 * @property {string} intent - Classified intent
 * @property {string} [text] - Transcribed speech / user text
 * @property {string} [imageBase64] - Camera frame
 * @property {string} [model] - LLM model alias (opus/sonnet/haiku), forwarded to communicator
 * @property {Record<string, any>} context - Device info, session history
 * @property {Array<{id: string, name: string, capabilities: string[]}>} [context.availableAgents] - Sibling agents for delegation
 */

/**
 * @typedef {Object} AgentResponse
 * @property {string} requestId
 * @property {"success"|"error"|"partial"} status
 * @property {string} [text] - Answer text
 * @property {string} [action] - What was done (for PC agent)
 * @property {Record<string, any>} [data] - Structured payload
 */

/**
 * @typedef {Object} AgentInputRequest
 * @property {string} requestId
 * @property {"needs_input"} status
 * @property {DeviceCommand} deviceCommand
 */

/**
 * @typedef {Object} DeviceCommand
 * @property {"get_geolocation"|"take_photo"|"record_audio"|"record_video"|"record_ar_screen"|"start_translation"|"stop_translation"|"capture_image"|"capture_screen"|"confirm"|"choose"|"network_scan"} type
 * @property {Record<string, any>} [params] - Tool arguments from LLM
 * @property {string} [targetDeviceId]
 * @property {string} [prompt] - Spoken/shown to user
 * @property {number} [timeout] - ms before aborting
 * @property {Record<string, any>} [scanConfig] - Configuration for network_scan commands
 */

/**
 * @typedef {Object} DeviceCommandResponse
 * @property {string} requestId
 * @property {string} commandType
 * @property {string} [imageBase64]
 * @property {string} [screenBase64]
 * @property {string} [text]
 * @property {Record<string, any>} [data] - Generic structured data from device tools
 */

/**
 * @typedef {Object} AgentDelegationRequest
 * @property {string} requestId
 * @property {"needs_agent"} status
 * @property {DelegationPayload} agentRequest
 */

/**
 * @typedef {Object} DelegationPayload
 * @property {string} [targetAgentId]
 * @property {string} [text]
 * @property {string} [imageBase64]
 * @property {Record<string, any>} context
 */

/**
 * @typedef {Object} ClassificationResult
 * @property {string} agentId
 * @property {string} intent
 * @property {number} confidence
 */

export const AGENT_RESPONSE_STATUS = {
  SUCCESS: 'success',
  ERROR: 'error',
  PARTIAL: 'partial',
  NEEDS_INPUT: 'needs_input',
  NEEDS_AGENT: 'needs_agent'
};
