import { stripMarkdown } from './tts.js';

/**
 * Format agent responses based on device type.
 * @param {import('../sdk/types.js').AgentResponse} agentResponse
 * @param {string} deviceType
 * @returns {{ text: string, data?: Record<string, any> }}
 */
export function format(agentResponse, deviceType) {
  const text = agentResponse.text || '';
  const data = agentResponse.data;

  switch (deviceType) {
    case 'glasses':
    case 'phone': {
      const clean = stripMarkdown(text);
      return { text: clean, data };
    }

    case 'pc':
    default:
      return { text, data };
  }
}

