import net from 'net';
import { execSync } from 'child_process';

const DEFAULT_PORT = 10808;
const DEFAULT_HOST = '127.0.0.1';

function probePort(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

function gsetting(key) {
  return execSync(`gsettings get ${key}`, {
    timeout: 2000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim().replace(/'/g, '');
}

function getGnomeProxy() {
  try {
    const mode = gsetting('org.gnome.system.proxy mode');
    if (mode !== 'manual') return null;

    const host = gsetting('org.gnome.system.proxy.http host');
    const port = parseInt(gsetting('org.gnome.system.proxy.http port'), 10);

    if (host && port > 0) return `http://${host}:${port}`;
    return null;
  } catch {
    // gsettings not available (Docker, non-GNOME, etc.)
    return null;
  }
}

function getGnomeSocksProxy() {
  try {
    const mode = gsetting('org.gnome.system.proxy mode');
    if (mode !== 'manual') return null;

    const host = gsetting('org.gnome.system.proxy.socks host');
    const port = parseInt(gsetting('org.gnome.system.proxy.socks port'), 10);

    if (host && port > 0) return { host, port };
    return null;
  } catch {
    return null;
  }
}

export async function setupProxy(agentName) {
  // 1. Explicit env vars (highest priority)
  let proxyUrl = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  // 2. GNOME system proxy settings
  if (!proxyUrl) {
    proxyUrl = getGnomeProxy();
    if (proxyUrl) {
      console.log(`[${agentName}] Proxy from GNOME settings: ${proxyUrl}`);
    }
  }

  // 3. Fallback: probe default v2RayN port
  if (!proxyUrl && await probePort(DEFAULT_HOST, DEFAULT_PORT)) {
    proxyUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  }

  if (!proxyUrl) {
    console.log(`[${agentName}] No proxy detected`);
    return null;
  }

  // Set env vars for child processes (curl, wget, claude, etc.)
  process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxyUrl;
  process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || proxyUrl;
  process.env.ALL_PROXY = process.env.ALL_PROXY || proxyUrl.replace('http://', 'socks://');
  process.env.NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.0/8,::1,communicator,orchestrator,mcp-server';

  // Detect SOCKS proxy for MTProto clients (Telegram, etc.)
  // Priority: GNOME socks settings > same host/port as HTTP proxy (v2ray typically serves both)
  let socksProxy = getGnomeSocksProxy();
  if (!socksProxy) {
    // v2ray/xray commonly serve SOCKS5 on the same port as HTTP
    const parsed = new URL(proxyUrl);
    const socksHost = parsed.hostname;
    const socksPort = parseInt(parsed.port, 10);
    if (socksHost && socksPort > 0) {
      socksProxy = { host: socksHost, port: socksPort };
    }
  }

  // Create undici ProxyAgent for native fetch (optional — not all agents ship undici)
  let dispatcher = null;
  try {
    const { ProxyAgent } = await import('undici');
    dispatcher = new ProxyAgent(proxyUrl);
  } catch {
    // undici not available in this agent's node_modules — skip HTTP dispatcher
  }

  console.log(`[${agentName}] Proxy detected: ${proxyUrl}${socksProxy ? ` (SOCKS5: ${socksProxy.host}:${socksProxy.port})` : ''}`);
  return { dispatcher, socksProxy };
}
