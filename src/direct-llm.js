/**
 * Direct LLM fallback -- when no agent matches, answer via Communicator directly.
 * Supports device tools: if the LLM calls a device tool, returns the tool call
 * for the dispatcher to handle via device command.
 */

import config from './config.js';

/**
 * Call the Communicator LLM API directly (no agent involved).
 * @param {Array<{role: string, content: any}>} messages - Full messages array
 * @param {string} [model] - Optional model override
 * @param {Array} [tools] - Optional OpenAI-format tool definitions
 * @returns {Promise<{ text: string, usage: object, toolCalls?: Array }>}
 */
export async function directLLM(messages, model, tools, globalInstructions) {
  // Inject global instructions as system message if provided
  let finalMessages = messages;
  if (globalInstructions) {
    const hasSystem = messages.length > 0 && messages[0].role === 'system';
    if (hasSystem) {
      finalMessages = [{ ...messages[0], content: messages[0].content + '\n\n' + globalInstructions }, ...messages.slice(1)];
    } else {
      finalMessages = [{ role: 'system', content: globalInstructions }, ...messages];
    }
  }

  const body = {
    model: model || config.llmModel,
    messages: finalMessages,
    stream: false
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(`${config.communicatorUrl}/api/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) {
    const respBody = await response.text();
    throw new Error(`Direct LLM request failed (${response.status}): ${respBody}`);
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;
  const toolCalls = message?.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    return {
      text: message.content || '',
      usage: data.usage || null,
      toolCalls,
      assistantMessage: message
    };
  }

  return {
    text: message?.content || '',
    usage: data.usage || null
  };
}
