/**
 * PTCClient - Programmatic Tool Calling client.
 *
 * Replaces custom agentic loops in agents. Instead of N LLM round-trips
 * (one per tool call, all results in context), the LLM writes Python code
 * that calls tools programmatically. Intermediate tool results stay in code,
 * only stdout goes back to the LLM.
 *
 * Usage:
 *   const ptc = new PTCClient({
 *     communicatorUrl: 'http://localhost:10000',
 *     apiKey: 'xxx',
 *     model: 'sonnet',
 *   });
 *
 *   const result = await ptc.execute({
 *     system: 'You are a web search agent...',
 *     userMessage: 'Find papers about CRISPR',
 *     tools: [
 *       { name: 'web_search', description: '...', input_schema: {...} }
 *     ],
 *     toolExecutor: async (name, input) => { ... },
 *   });
 */

import { CodeExecutionEngine, generateToolSignature } from './code-engine.js';

/**
 * Thrown by toolExecutor to signal delegation to another agent.
 * PTCClient catches this, kills the subprocess, and re-throws
 * for the agent's handle() to catch.
 */
export class DelegationError extends Error {
  constructor(agentId, query, context = {}) {
    super(`Delegation to ${agentId}: ${query}`);
    this.name = 'DelegationError';
    this.agentId = agentId;
    this.query = query;
    this.context = context;
  }
}

/**
 * Thrown by toolExecutor to signal that device input is needed.
 * PTCClient catches this, kills the subprocess, and re-throws
 * for the agent's handle() to catch.
 */
export class DeviceInputError extends Error {
  constructor(deviceCommand) {
    super(`Device input needed: ${deviceCommand.type}`);
    this.name = 'DeviceInputError';
    this.deviceCommand = deviceCommand;
  }
}

const PTC_SYSTEM_ADDITION = `
When you need to use tools or process data, call the execute_code tool with Python code.
The code environment has helper functions (listed in the tool description). Call them directly -- they are synchronous.
Use print() for any output. Only printed output will be visible to you and to the user.
For simple questions needing no tools, respond directly without code.
When writing code: process and filter tool results in code before printing. Print only the final answer or summary, not raw tool output.
Always respond to the user in English, regardless of what language they write in. The only exception is tool call arguments where the task explicitly requires another language (e.g. sending a Telegram message in Russian).`;

export class PTCClient {
  /**
   * @param {Object} options
   * @param {string} options.communicatorUrl - Base URL of the Communicator gateway
   * @param {string} options.apiKey - Auth key for Communicator
   * @param {string} options.model - LLM model alias or ID
   */
  constructor({ communicatorUrl, apiKey, model }) {
    this.communicatorUrl = communicatorUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.engine = new CodeExecutionEngine();
  }

  /**
   * Execute a task using PTC.
   *
   * @param {Object} options
   * @param {string} options.system - System prompt (personality/behavior only)
   * @param {string|Array} options.userMessage - User message (string or content array)
   * @param {Array<{ name: string, description: string, input_schema: object }>} options.tools - Tool definitions
   * @param {(name: string, input: object) => Promise<any>} options.toolExecutor - Callback to execute tools
   * @param {(name: string, input: object) => void} [options.onToolCall] - Called before each tool execution
   * @param {number} [options.maxRounds=5] - Max code execution rounds before stopping
   * @param {number} [options.maxTokens=8192] - Max tokens for LLM response
   * @param {number} [options.codeTimeoutMs=120000] - Timeout per code execution
   * @param {Array} [options.messages] - Pre-built messages array (overrides system/userMessage)
   * @returns {Promise<{ text: string, rounds: number, toolCallCount: number }>}
   */
  async execute(options) {
    const {
      system,
      userMessage,
      tools,
      toolExecutor,
      onToolCall,
      maxRounds = 5,
      maxTokens = 8192,
      codeTimeoutMs = 120000,
      messages: existingMessages
    } = options;

    // Build the execute_code tool definition
    const toolSignatures = tools.map(generateToolSignature).join('\n');
    const executeCodeTool = {
      type: 'function',
      function: {
        name: 'execute_code',
        description: `Execute Python code in an environment with these available functions:\n\n${toolSignatures}\n\nCall these functions directly (they are synchronous). Use print() to output results.`,
        parameters: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'Python code to execute. Has access to the functions listed above.'
            }
          },
          required: ['code']
        }
      }
    };

    // Build messages
    const messages = existingMessages
      ? this.ensurePTCSystem([...existingMessages])
      : this.buildMessages(system, userMessage);

    let totalToolCalls = 0;

    for (let round = 0; round < maxRounds; round++) {
      // Call LLM
      const response = await this.callLLM(messages, [executeCodeTool], maxTokens);

      // Parse response
      const { text, toolCalls } = this.parseResponse(response);

      // No tool calls -- LLM responded directly
      if (!toolCalls || toolCalls.length === 0) {
        return { text, rounds: round + 1, toolCallCount: totalToolCalls };
      }

      // Find the execute_code call
      const codeCall = toolCalls.find(tc => tc.function.name === 'execute_code');
      if (!codeCall) {
        // LLM called something unexpected -- treat text as the response
        return { text: text || 'No response generated.', rounds: round + 1, toolCallCount: totalToolCalls };
      }

      const code = typeof codeCall.function.arguments === 'string'
        ? JSON.parse(codeCall.function.arguments).code
        : codeCall.function.arguments.code;

      console.log(`[PTC] Round ${round + 1}: executing code (${code.length} chars)`);

      // Execute the code (wrap executor to notify on each tool call)
      const notifyingExecutor = onToolCall
        ? async (name, input) => { try { onToolCall(name, input); } catch {} return toolExecutor(name, input); }
        : toolExecutor;
      let execResult;
      try {
        execResult = await this.engine.execute(code, notifyingExecutor, tools, { timeoutMs: codeTimeoutMs });
        totalToolCalls += execResult.toolCallCount;
      } catch (err) {
        // DelegationError and DeviceInputError propagate up
        if (err.name === 'DelegationError' || err.name === 'DeviceInputError') {
          throw err;
        }
        // Other errors become stderr
        execResult = {
          stdout: '',
          stderr: `Execution error: ${err.message}`,
          exitCode: 1,
          toolCallCount: 0
        };
      }

      // Build the tool result
      let toolOutput = execResult.stdout.trim();
      if (execResult.exitCode !== 0 && execResult.stderr) {
        toolOutput += (toolOutput ? '\n' : '') + `[stderr]: ${execResult.stderr.trim()}`;
      }
      if (!toolOutput) {
        toolOutput = execResult.exitCode === 0
          ? '(no output)'
          : `Code failed with exit code ${execResult.exitCode}. stderr: ${execResult.stderr.trim() || 'none'}`;
      }

      console.log(`[PTC] Round ${round + 1}: code done, ${execResult.toolCallCount} tool calls, exit=${execResult.exitCode}, output=${toolOutput.length} chars`);

      // Append assistant message with tool call
      messages.push({
        role: 'assistant',
        content: text || '',
        tool_calls: [{
          id: codeCall.id,
          type: 'function',
          function: {
            name: 'execute_code',
            arguments: typeof codeCall.function.arguments === 'string'
              ? codeCall.function.arguments
              : JSON.stringify(codeCall.function.arguments)
          }
        }]
      });

      // Append tool result
      messages.push({
        role: 'tool',
        tool_call_id: codeCall.id,
        content: toolOutput
      });
    }

    // Exhausted maxRounds -- return last output
    const lastToolResult = messages.filter(m => m.role === 'tool').pop();
    return {
      text: lastToolResult?.content || 'Max code execution rounds reached.',
      rounds: maxRounds,
      toolCallCount: totalToolCalls
    };
  }

  /**
   * Ensure pre-built messages include the PTC system addition.
   * @param {Array} messages
   * @returns {Array}
   */
  ensurePTCSystem(messages) {
    if (messages.length > 0 && messages[0].role === 'system') {
      if (!messages[0].content.includes('execute_code')) {
        messages[0] = { ...messages[0], content: messages[0].content + PTC_SYSTEM_ADDITION };
      }
    }
    return messages;
  }

  /**
   * Build the initial messages array.
   * @param {string} system - System prompt
   * @param {string|Array} userMessage - User content
   * @returns {Array}
   */
  buildMessages(system, userMessage) {
    const messages = [];

    if (system) {
      messages.push({
        role: 'system',
        content: system + PTC_SYSTEM_ADDITION
      });
    }

    if (userMessage) {
      messages.push({
        role: 'user',
        content: userMessage
      });
    }

    return messages;
  }

  /**
   * Call the LLM via Communicator.
   * @param {Array} messages
   * @param {Array} tools
   * @param {number} maxTokens
   * @returns {Promise<Object>} Raw API response
   */
  async callLLM(messages, tools, maxTokens) {
    const response = await fetch(`${this.communicatorUrl}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: maxTokens,
        stream: false
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Communicator API error ${response.status}: ${body}`);
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
      toolCalls = toolCalls.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments
        }
      }));
    }

    return {
      text: message.content || '',
      toolCalls
    };
  }
}
