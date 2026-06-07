/**
 * CodeExecutionEngine - runs LLM-generated Python code with tool access.
 *
 * How it works:
 * 1. Starts a temporary HTTP server on a random port
 * 2. Generates a Python preamble with tool function stubs that call back to the HTTP server
 * 3. Spawns `python3 -c <preamble + user_code>` subprocess
 * 4. HTTP server routes tool calls to the provided toolExecutor callback
 * 5. Captures stdout/stderr, returns them when subprocess exits
 */

import http from 'http';
import { spawn } from 'child_process';

/**
 * Generate a Python function definition from a tool schema.
 * @param {{ name: string, description: string, input_schema: object }} tool
 * @returns {string} Python function code
 */
function generatePythonFunction(tool) {
  const props = tool.input_schema?.properties || {};
  const required = tool.input_schema?.required || [];

  const requiredParams = [];
  const optionalParams = [];

  for (const [name, prop] of Object.entries(props)) {
    if (required.includes(name)) {
      requiredParams.push(name);
    } else {
      const defaultVal = prop.default !== undefined
        ? JSON.stringify(prop.default)
        : 'None';
      optionalParams.push(`${name}=${defaultVal}`);
    }
  }

  const paramStr = [...requiredParams, ...optionalParams].join(', ');
  const argKeys = Object.keys(props);
  const argsDict = argKeys.map(k => `"${k}": ${k}`).join(', ');

  // Escape the description for Python docstring -- escape backslashes and double quotes
  const escapedDesc = (tool.description || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  return [
    `def ${tool.name}(${paramStr}):`,
    `    """${escapedDesc}"""`,
    `    return _call_tool("${tool.name}", {${argsDict}})`
  ].join('\n');
}

/**
 * Generate a Python function signature string for LLM description.
 * @param {{ name: string, description: string, input_schema: object }} tool
 * @returns {string} Human-readable signature like "web_search(query, num_results=10) - Search the web"
 */
export function generateToolSignature(tool) {
  const props = tool.input_schema?.properties || {};
  const required = tool.input_schema?.required || [];

  const requiredParams = [];
  const optionalParams = [];

  for (const [name, prop] of Object.entries(props)) {
    if (required.includes(name)) {
      requiredParams.push(name);
    } else {
      const defaultVal = prop.default !== undefined
        ? JSON.stringify(prop.default)
        : 'None';
      optionalParams.push(`${name}=${defaultVal}`);
    }
  }

  const paramStr = [...requiredParams, ...optionalParams].join(', ');
  return `${tool.name}(${paramStr}) - ${tool.description || ''}`;
}

/**
 * Generate the full Python preamble with tool stubs.
 * @param {number} port - HTTP server port
 * @param {Array<{ name: string, description: string, input_schema: object }>} tools
 * @returns {string} Python code preamble
 */
function generatePreamble(port, tools) {
  const toolFunctions = tools.map(generatePythonFunction).join('\n\n');

  return `import json, sys, urllib.request, traceback

def _call_tool(name, args):
    # Filter out None values (optional params not provided)
    filtered = {k: v for k, v in args.items() if v is not None}
    data = json.dumps({"name": name, "input": filtered}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:${port}/tool",
        data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode())
        if result.get("error"):
            raise Exception(result["error"])
        val = result.get("result")
        if isinstance(val, str):
            try:
                return json.loads(val)
            except (json.JSONDecodeError, ValueError):
                pass
        return val

${toolFunctions}

# === LLM CODE ===
`;
}

export class CodeExecutionEngine {
  /**
   * Execute Python code with tool access.
   * @param {string} code - Python code to execute
   * @param {(name: string, input: object) => Promise<any>} toolExecutor - Callback to execute tools
   * @param {Array<{ name: string, description: string, input_schema: object }>} tools - Tool definitions
   * @param {{ timeoutMs?: number }} options
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, toolCallCount: number }>}
   */
  async execute(code, toolExecutor, tools, options = {}) {
    const { timeoutMs = 120000 } = options;
    let toolCallCount = 0;
    let criticalError = null;

    // Wrap toolExecutor to capture DelegationError/DeviceInputError
    const wrappedToolExecutor = async (name, input) => {
      toolCallCount++;
      try {
        return await toolExecutor(name, input);
      } catch (err) {
        if (err.name === 'DelegationError' || err.name === 'DeviceInputError') {
          criticalError = err;
        }
        throw err;
      }
    };

    // Start temporary HTTP server
    const { server, port } = await this.startToolServer(wrappedToolExecutor);

    try {
      // Generate full Python script
      const preamble = generatePreamble(port, tools);
      const fullScript = preamble + code;

      // Execute Python
      const result = await this.runPython(fullScript, timeoutMs);

      // Re-throw critical errors that occurred during tool execution
      if (criticalError) {
        throw criticalError;
      }

      return { ...result, toolCallCount };
    } finally {
      // Always close the server
      server.close();
    }
  }

  /**
   * Start a temporary HTTP server that routes tool calls.
   * @param {(name: string, input: object) => Promise<any>} toolExecutor
   * @returns {Promise<{ server: http.Server, port: number }>}
   */
  startToolServer(toolExecutor) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/tool') {
          res.writeHead(404);
          res.end();
          return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { name, input } = JSON.parse(body);
            const result = await toolExecutor(name, input);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      // Listen on random port
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ server, port });
      });

      server.on('error', reject);
    });
  }

  /**
   * Run a Python script as a subprocess.
   * @param {string} script - Full Python script to execute
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
   */
  runPython(script, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn('python3', ['-c', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        timeout: timeoutMs
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
      proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Python execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // Close stdin immediately -- script gets all input via command arg
      proc.stdin.end();
    });
  }
}
