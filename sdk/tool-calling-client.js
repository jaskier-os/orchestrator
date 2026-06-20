/**
 * ToolCallingClient - regular OpenAI function calling loop.
 *
 * Replaces PTCClient. Instead of having the LLM write Python code,
 * tools are called via structured function calls. The LLM directly
 * writes the final response after seeing tool results.
 *
 * Usage:
 *   const client = new ToolCallingClient({
 *     communicatorUrl: 'http://localhost:10000',
 *     apiKey: 'xxx',
 *     model: 'sonnet',
 *   });
 *
 *   const result = await client.execute({
 *     messages: [...],
 *     tools: [{ type: 'function', function: { name, description, parameters } }],
 *     toolExecutor: async (name, input) => { ... },
 *   });
 */

export { DelegationError, DeviceInputError } from './ptc-client.js';

export class ToolCallingClient {
  /**
   * @param {Object} options
   * @param {string} options.communicatorUrl
   * @param {string} options.apiKey
   * @param {string} options.model
   */
  constructor({ communicatorUrl, apiKey, model }) {
    this.communicatorUrl = communicatorUrl;
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Execute a task using regular tool calling.
   *
   * @param {Object} options
   * @param {Array} options.messages - Messages array (system + user + history)
   * @param {Array} options.tools - OpenAI-format tool definitions
   * @param {(name: string, input: object) => Promise<string>} options.toolExecutor
   * @param {(name: string, input: object) => void} [options.onToolCall] - Called before each tool execution
   * @param {number} [options.maxTokens=8192]
   * @returns {Promise<{ text: string, rounds: number, toolCallCount: number }>}
   *
   * Safety cap of 25 rounds prevents runaway loops while allowing deep
   * multi-tool research chains. If the model needs more than 25 rounds,
   * that is a model regression to investigate, not normal behaviour.
   */
  async execute(options) {
    const {
      messages,
      tools,
      toolExecutor,
      onToolCall,
      maxTokens = 8192,
      maxRounds = 25
    } = options;

    const msgs = [...messages];
    let totalToolCalls = 0;
    let round = 0;

    while (round < maxRounds) {
      const response = await this.callLLM(msgs, tools, maxTokens);
      const { text, toolCalls } = this.parseResponse(response);

      // No tool calls -- LLM responded directly. This is the only exit.
      if (!toolCalls || toolCalls.length === 0) {
        return { text, rounds: round + 1, toolCallCount: totalToolCalls };
      }

      // Build assistant message with all tool calls
      const assistantMsg = {
        role: 'assistant',
        content: text || '',
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments)
          }
        }))
      };
      msgs.push(assistantMsg);

      // Execute each tool call
      for (const tc of toolCalls) {
        const name = tc.function.name;
        let input;
        try {
          input = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch {
          input = {};
          console.error(`[ToolCalling] Failed to parse arguments for ${name}, using empty object`);
        }

        totalToolCalls++;
        console.log(`[ToolCalling] Round ${round + 1}: ${name}(${JSON.stringify(input).substring(0, 100)})`);

        if (onToolCall) {
          try { onToolCall(name, input); } catch {}
        }

        let result;
        try {
          result = await toolExecutor(name, input);
        } catch (err) {
          // DelegationError and DeviceInputError propagate up
          if (err.name === 'DelegationError' || err.name === 'DeviceInputError') {
            throw err;
          }
          result = `Error: ${err.message}`;
        }

        // Stringify non-string results
        const content = typeof result === 'string' ? result : JSON.stringify(result);

        msgs.push({
          role: 'tool',
          tool_call_id: tc.id,
          content
        });
      }
      round++;
    }

    // Exhausted maxRounds -- return the last text or a fallback
    console.error(`[ToolCalling] Exhausted ${maxRounds} rounds without final response`);
    const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
    return {
      text: lastAssistant?.content || 'I was unable to complete the research within the allowed number of steps.',
      rounds: round,
      toolCallCount: totalToolCalls
    };
  }

  /**
   * Call the LLM via Communicator.
   * @param {Array} messages
   * @param {Array} tools
   * @param {number} maxTokens
   * @returns {Promise<Object>}
   */
  async callLLM(messages, tools, maxTokens) {
    const body = {
      model: this.model,
      messages,
      stream: false,
      max_tokens: maxTokens
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.communicatorUrl}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Communicator API error ${response.status}: ${text}`);
    }

    return response.json();
  }

  /**
   * Parse an LLM response (handles both OpenAI and Anthropic formats).
   * @param {Object} response
   * @returns {{ text: string, toolCalls: Array|null }}
   */
  parseResponse(response) {
    // Anthropic native format
    if (response.role === 'assistant' && Array.isArray(response.content)) {
      let text = '';
      const toolCalls = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: block.input
            }
          });
        }
      }

      return { text, toolCalls: toolCalls.length > 0 ? toolCalls : null };
    }

    // OpenAI format
    const message = response.choices?.[0]?.message;
    if (!message) {
      throw new Error('Invalid API response: no message in response');
    }

    let toolCalls = message.tool_calls || null;
    if (toolCalls) {
      toolCalls = toolCalls.map(tc => {
        let args = tc.function.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        return { ...tc, function: { ...tc.function, arguments: args } };
      });
    }

    return {
      text: message.content || '',
      toolCalls
    };
  }
}
