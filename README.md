# AI Orchestrator

Central AI orchestrator that routes requests from client devices (phone, glasses,
desktop) to specialized agents and back-end services. It exposes an HTTP + WebSocket
gateway, manages chat/remote-control sessions, classifies and dispatches requests,
aggregates streaming responses, and coordinates speech (STT/TTS) and translation
services. Agents connect to the orchestrator over WebSocket using the shared
`@orchestrator/sdk` (vendored in `./sdk`).

This repository is also the canonical home of `@orchestrator/sdk`. Other repos that
need the SDK vendor a point-in-time copy of the `sdk/` folder from here.

## Prerequisites

- Node.js 20+ (the Dockerfile uses `node:20-alpine`).
- npm (ships with Node).
- MongoDB reachable at `MONGO_URL` (defaults to `mongodb://localhost:27017`).
- `ffmpeg` available on `PATH` for audio handling (the Docker image installs it).
- Peer services (Communicator, TTS, transcriber, translator, ReID analytics) are
  optional for boot; the orchestrator starts and connects to them lazily when a
  request needs them. MongoDB, however, must be reachable at startup.

## Setup

1. Copy the example environment file and fill in values:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env`. At minimum set `API_KEY` to a value of your choosing (this key is
   required on inbound API/WS requests and is sent to the Communicator as a Bearer
   token). Every other variable defaults to a `localhost` service URL, so a single
   machine running the companion services works out of the box. Each variable is
   documented inline in `.env.example`.

## Build

No build/transpile step is required (plain ES modules). Install dependencies:

```bash
npm ci
```

`npm ci` also resolves the vendored SDK via the `file:./sdk` dependency in
`package.json`.

## Run

```bash
npm start        # node src/index.js
# or
npm run dev      # node --watch src/index.js (auto-restart)
# or
./run.sh         # install + start
```

The server listens on `PORT` (default `10001`). Health check:

```bash
curl http://localhost:10001/api/v1/health
```

### Docker

```bash
docker build -t ai-orchestrator .
docker run --rm -p 10001:10001 --env-file .env ai-orchestrator
```

## Tests

```bash
node test/split-sentences.test.js
node test/history-handoff.test.js
node tests/rc-race.test.js     # needs a running orchestrator; honors ORCH_WS / ORCH_RC_WS / API_KEY
```

## Optional TLS / VPN

By default the orchestrator and its agents communicate over plain HTTP/WebSocket
(`http://`, `ws://`), so the project runs with no certificates and no VPN.

- Agents (via `@orchestrator/sdk` `BaseAgent`) connect using the URL they are
  configured with. To use TLS, point them at a `wss://` URL and set
  `NODE_EXTRA_CA_CERTS` to a CA bundle file. If `NODE_EXTRA_CA_CERTS` is unset or
  the file is missing, the agent falls back to a plain connection and does not
  crash.
- For remote-control callbacks, set `ORCHESTRATOR_PUBLIC_HOST` to the public
  `host:port` (and front the orchestrator with a TLS-terminating proxy) so agents
  dial back over `wss://`. If unset, the orchestrator uses the inbound request
  Host header.

Never commit certificate or key files (`*.pem`, `*.crt`, `*.key`, `*.p12`,
`*.pfx`); they are gitignored.

## The `@orchestrator/sdk` (`./sdk`)

`sdk/` is the source of truth for the shared agent SDK: the WebSocket protocol,
`BaseAgent` base class, tool-calling clients, the code-execution engine, and the
device-tool definitions. `package.json` depends on it as `file:./sdk`, so a fresh
clone is fully self-contained.

Other repositories that need the SDK vendor a point-in-time copy of this `sdk/`
folder (e.g. into their own `sdk/` or `vendor/orchestrator-sdk/`). To update a
vendored copy, re-copy `sdk/` from this repository (group `jaskier-os`, repo
`orchestrator`). Do not introduce a live git/registry dependency on it; keep
consumers self-contained.

## Model files

This service does not ship trained model weights. Speech synthesis uses voice
names (e.g. `am_echo`) resolved by the external TTS service, not bundled weights.
