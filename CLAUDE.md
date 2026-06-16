# CLAUDE.md -- orchestrator

This file provides guidance to Claude Code when working in this repository.

IMPORTANT: NEVER USE EMOJIS ANYWHERE IN LOGGING, CODE OR OTHER TEXT.

IMPORTANT: Treat this codebase as work in progress. Never do backwards-compatibility or
legacy support unless explicitly asked to. Remove code that becomes redundant.

## What this repo is

The orchestrator is the central router of the whole system. Client devices (phone, glasses,
desktop) connect here; it classifies intent, dispatches to specialized agents and backend
services (communicator/LLM, STT, translation, TTS, ReID analytics), holds session/chat state
in MongoDB, and streams results back over HTTP and WebSocket. It is a Koa server listening on
**port 10001**.

This repo is also the canonical home of **`@orchestrator/sdk`**, which lives in `./sdk` and is
consumed by every agent. The orchestrator depends on it via `file:./sdk`, so the copy here is
the source of truth -- edit it in place and the orchestrator picks it up.

Because this repo is the architectural hub, the **whole-system reference** (the full component
map, port table, and how everything connects across all the standalone repos) lives at the
bottom of this file under "System architecture (all repos)". Other repos point here for the big
picture.

## Build / run

```bash
npm install
cp .env.example .env   # edit before first run (PORT, API_KEY, MONGO_URL, *_URL endpoints)
npm run dev            # node --watch src/index.js
npm start              # plain node
```

`run.sh` does install + start. Docker: `docker build -t orchestrator . && docker run -p 10001:10001 --env-file .env orchestrator`. The Dockerfile copies `sdk/` before `npm ci` (because of the `file:./sdk` dependency) and installs `ffmpeg` for audio handling. Healthcheck hits `/api/v1/health`.

Requires Node >= 20. Stack: Koa 2, `mongodb`, `ws` (WebSocket), `@koa/multer`/`multer` (uploads), `joi` (config validation), system `ffmpeg` (in the image).

## Configuration

All config is env vars; `.env.example` is the source of truth. Key ones:
- `PORT` (10001), `API_KEY` -- bind + shared auth key (required on inbound API/WS, and sent to the Communicator as a Bearer token). Generate your own; never reuse the example.
- `MONGO_URL` -- session/chat store.
- `LLM_MODEL` -- default model alias forwarded to the Communicator (opus/sonnet/haiku).
- Peer-service endpoints it routes to: `COMMUNICATOR_URL`, `TTS_URL`, `PIPER_TTS_URL`, `TRANSCRIBER_URL` / `TRANSCRIBER_WS_URL`, `ANTHROPIC_STT_URL`, `TRANSLATOR_URL`, `REID_ANALYTICS_URL`. All default to localhost so the orchestrator runs standalone with no VPN and no certificates.
- `SESSION_TIMEOUT_MS`, `RC_SESSION_TIMEOUT_MS`, `COMPACTION_THRESHOLD`, `CHAT_HISTORY_DIR`, `COPILOT_HISTORY_DIR` -- session/history behavior.
- `ORCHESTRATOR_PUBLIC_HOST` -- public host:port that remote agents (pc-agent) dial back for remote-control sessions; falls back to the inbound Host header if unset (set it in production to avoid host-header injection).
- `NODE_EXTRA_CA_CERTS` -- optional CA bundle for `wss://`; if unset/missing the SDK BaseAgent stays on plain `ws://` and does not crash.

### TTS routing (`TTS_ROUTING_MODE`)

Controls how `src/tts.js` chooses a TTS engine. Joi-validated; invalid values fail fast at startup.

- `language-split` (default) -- detects Cyrillic vs. Latin per segment and routes
  English -> Kokoro (`TTS_URL`), Russian -> TeraTTS (`PIPER_TTS_URL`), mixed text
  -> per-segment synthesis concatenated into one WAV.
- `teratts` -- bypasses language detection; all text goes to TeraTTS
  (`PIPER_TTS_URL`), which pronounces English words via Russian phonemes (English
  g2p -> Russian phoneme symbols, no model retrain). Kokoro is left unused in this
  mode.

The flag is read at call time in `generateAudio`, `generateNotifAudio`, and
`streamTts`. The Kokoro / language-split code path is retained; switching back to
`language-split` restores it with no code change.

## Key files

**`src/`**
- `index.js` -- HTTP server + WebSocket upgrade, entrypoint.
- `gateway.js` -- Koa middleware, inbound API surface (`POST /api/v1/request`, `GET /api/v1/health`, uploads), auth.
- `classifier.js` -- LLM-based intent classification using registered agent manifests.
- `dispatcher.js` -- session loop: route to the chosen agent, handle `needs_input` / `needs_agent`, stream back.
- `registry.js` -- agent registry with health pings (auto-removes unresponsive agents).
- `aggregator.js` -- formats responses per device type (e.g. strip markdown, shorten for TTS).
- `config.js` -- Joi-validated env config.
- `session.js`, `chat-store.js`, `rc-store.js`, `rc-handler.js` -- session state, chat persistence (MongoDB), remote-control (RC) sessions.
- `assistant.js`, `direct-llm.js` -- assistant loop and direct LLM passthrough.
- `db.js` -- MongoDB connection. `job-scheduler.js`, `job-store.js`, `todo-store.js` -- scheduled jobs / todos. `tts.js` -- TTS routing. `permission-mode.js` -- permission gating.

**`sdk/` (`@orchestrator/sdk`)** -- shared library, vendored, not from a registry:
- `base-agent.js` -- `BaseAgent` class (WS auto-reconnect, manifest registration, graceful shutdown). Agents extend this.
- `protocol.js` -- message envelope types + `createXMessage` / `parseMessage` / `serializeMessage` helpers.
- `types.js` -- JSDoc type defs + `AGENT_RESPONSE_STATUS` constants.
- `ptc-client.js` (`PTCClient`, `DelegationError`, `DeviceInputError`), `tool-calling-client.js` (`ToolCallingClient`), `code-engine.js` (`CodeExecutionEngine`), `device-tools.js` (`PHONE_TOOLS` / `GLASSES_TOOLS` / `getDeviceTools` / `buildDeviceCommand`), `proxy.js`.
- `index.js` -- the public export surface. `sdk/package.json` declares the `exports` map.

## Agent interface contract

Every agent extends `BaseAgent` from `@orchestrator/sdk` and implements `handle(request)`,
returning `{ requestId, status, text? }`. Agents connect **outbound** to the orchestrator over
WebSocket and register a manifest (`id`, `name`, `capabilities`, `inputTypes`, `healthEndpoint`).
Adding a new agent requires no orchestrator code changes -- the classifier discovers registered
agents from their manifests.

**Response statuses** (`AGENT_RESPONSE_STATUS` in `sdk/types.js`):
- `success` / `error` / `partial` -- final response.
- `needs_input` -- agent needs device input (camera frame, geolocation, confirmation, etc.); carries a `DeviceCommand`.
- `needs_agent` -- agent wants to delegate to another agent; carries a `DelegationPayload`.

Device commands the orchestrator can ask a device to perform include `take_photo`,
`capture_image`, `capture_screen`, `record_audio`, `record_video`, `record_ar_screen`,
`get_geolocation`, `start_translation` / `stop_translation`, `confirm`, `choose`, `network_scan`
(see the `DeviceCommand` typedef in `sdk/types.js`).

To add an agent in its own repo: depend on `@orchestrator/sdk` (vendor it / `file:` path),
extend `BaseAgent`, implement `handle(request)`, point its `ORCHESTRATOR_URL` + `API_KEY` at this
service, and ship its Dockerfile. The orchestrator does not need to be redeployed for a new agent.

## Service management

- **NEVER restart any service** unless the user explicitly asks. When a restart is needed, tell the user which service to restart and why.
- **Auto-deploy:** server-side services (orchestrator and agents) auto-deploy on git push to `main`. No manual restart needed -- just commit and push. GitLab CI builds this repo's Dockerfile with `docker buildx --push`, then bumps the image tag in the `infrastructure/deploy` repo, and Flux reconciles it onto the cluster (`.gitlab-ci.yml`).
- Logs: each service writes its own log; there is no shared monorepo log directory anymore. Use the deployed service's own logging / `kubectl logs`.
- NEVER modify Kubernetes env vars, secrets, or deployments directly via `kubectl set env` / `edit` / `patch`. All changes to deployed services go through the `infrastructure/deploy` manifests, committed and pushed so Flux reconciles them. Direct changes get overwritten and cause drift.

---

# System architecture (all repos)

This is the whole-system map. The codebase was split from a monorepo into separate standalone
repos; component names below are the new repo names (GitLab group/repo on the self-hosted GitLab),
not old monorepo paths. Other repos can reference this section as "the orchestrator repo's
system reference".

## Request flow

```
Devices (glasses / phone / desktop)
  -> Orchestrator (intent classification + routing + session state, port 10001)
      -> Specialized Agents (connect outbound via WebSocket)
           -> Communicator (LLM API gateway, port 10000)
                -> Anthropic Claude API
      -> Infrastructure services it routes to directly: STT/transcriber,
         translator, TTS (kokoro/piper), ReID analytics
```

Every use case is an Agent behind the Orchestrator, which classifies intent (via an LLM call
through the Communicator) and dispatches accordingly. All LLM calls go through the Communicator,
a Koa gateway that exposes an OpenAI-compatible endpoint and translates to Anthropic Claude.

The ReID subsystem is a parallel pipeline: cameras / glasses -> reid-worker (detection +
recognition) -> reid-db-handler (the only DB owner) -> reid-analytics (aggregation + dashboard).

## Repositories

GitLab groups on the self-hosted GitLab (self-signed cert -> `-k` / `http.sslVerify=false`).

**`jaskier-os/` (AI orchestration)**
- `jaskier-os/orchestrator` -- this repo. Central router/classifier/dispatcher; owns `@orchestrator/sdk`. Port 10001.
- `jaskier-os/communicator` -- LLM API gateway (Koa). OpenAI-compatible -> Anthropic Claude translation, streaming, multimodal, Yandex Cloud VM management. Port 10000.
- Agents (each its own repo, extend `@orchestrator/sdk`, connect outbound to the orchestrator):
  - `web-search` -- MCP tool server (web + academic search, URL reading, reverse image search; Express + Puppeteer) plus an agentic wrapper. MCP server port 10002.
  - `vision` -- image analysis (`analyze_image` via Communicator, `reverse_image_search` via MCP); can delegate to web-search. Health port 10005.
  - `reid` -- person re-identification agent bridging reid-worker capabilities to the orchestrator. Health port 10011.
  - `chat-history` -- conversation history store; dual interface (orchestrator agent over WS + standalone REST API). Port 10014.
  - `clickup` -- ClickUp integration (MCP server + agentic wrapper). Health port 10012.
  - `security-agent` -- network/system security tools agent. Health port 10009.
  - `pc-agent` -- local agent, natural language -> shell commands with safety validation; supports remote-control coding sessions. Health port 10004.
  - `obsidian-agent` -- local knowledge assistant (vault CRUD, RAG, web/science search, code execution, sub-agent spawning). Health port 10010.
- Infrastructure services:
  - `transcriber` -- audio transcription (FastAPI + faster-whisper). Port 10003.
  - `ocr` -- OCR / text extraction from images (FastAPI). Port 10006.
  - `kokoro-tts` -- Kokoro text-to-speech (Python). Port 10007.
  - `piper-tts` -- Piper text-to-speech (Python, lightweight). Port 10013.
  - `translator` -- NLLB-200 multilingual translation (FastAPI). Port 10015.
- Clients:
  - `desktop` -- voice listener (Python + PyQt6 + Vosk wake word + faster-whisper).
  - `phone` -- Android companion app (Kotlin). Connects to orchestrator; also hosts the glasses APK relay/sideloader.
  - `glasses` -- Rokid AR glasses listener app (Kotlin). Connects to the orchestrator via the phone relay.
- Obsidian plugins (their own repos): `repository-ai-chat` (AI chat plugin: RAG, tools, agentic), `smart-plugins-obsidian` (Smart Connections: embeddings + semantic search), `jsbrains` (modular JS framework, pnpm workspace).

**`reid/` (person re-identification)**
- `reid-db-handler` -- Node.js Koa API, the ONLY component allowed to touch the ReID/FAISS database. Owns ids, metadata, sightings, relations. Port 3001. Everything else goes through this API; nothing connects to the DB directly.
- `reid-worker` -- scalable Python worker: camera feed -> person/face/gait recognition (YOLOv8 + SCRFD + ArcFace, ONNX/FAISS, OpenGait) -> posts new data to reid-db-handler.
- `reid-analytics` -- backend aggregates reid-db-handler data for the frontend; frontend shows recognized-people catalogue, sightings, metadata. Backend port 3400 (`REID_ANALYTICS_URL` here defaults to `http://localhost:3400`).
- `rokid-reid` -- React Native (TypeScript) glasses app for ReID capture (package `repository.recon.reid`); detects on-device, sends results over Bluetooth to the phone relay which POSTs to reid-db-handler.

**`infrastructure/`**
- `infrastructure/deploy` -- Kubernetes deployment manifests (`apps/`, `clusters/`, `infrastructure/`). GitLab CI in each service repo bumps its image tag here; Flux (GitOps) reconciles onto the cluster. When changing a service's `.env` values, update the corresponding secrets here too.

## Port allocation

| Port  | Service                          |
|-------|----------------------------------|
| 10000 | Communicator (LLM API gateway)   |
| 10001 | Orchestrator (HTTP + WebSocket)  |
| 10002 | Web Search MCP server            |
| 10003 | Transcriber                      |
| 10004 | PC Agent (health)                |
| 10005 | Vision Agent (health)            |
| 10006 | OCR Service                      |
| 10007 | Kokoro TTS                       |
| 10009 | Security Agent (health)          |
| 10010 | Obsidian Agent (health)          |
| 10011 | ReID Agent (health)              |
| 10012 | ClickUp Agent (health)           |
| 10013 | Piper TTS                        |
| 10014 | Chat History Agent (REST API)    |
| 10015 | Translator (NLLB-200)            |
| 10016 | Anthropic STT (ANTHROPIC_STT_URL)|
| 3001  | ReID DB Handler                  |
| 3400  | ReID Analytics backend           |

## Tech-stack summary

| Area               | Choice                                                                 |
|--------------------|------------------------------------------------------------------------|
| Languages          | JavaScript ES modules (Node.js services), Python (clients, ML, TTS/STT/OCR/translation), Kotlin (phone/glasses), TypeScript (rokid-reid, obsidian plugins) |
| Server frameworks  | Koa (orchestrator, communicator, reid-db-handler), Express (MCP servers), FastAPI (transcriber, ocr, translator) |
| Agent connectivity | WebSocket -- agents connect outbound, orchestrator pushes tasks; no message broker |
| Intent classifier  | Claude via Communicator (LLM-based, uses agent manifests)              |
| LLM gateway        | Communicator (OpenAI API -> Anthropic Claude translation)             |
| Session/chat state | MongoDB (orchestrator)                                                 |
| ReID models        | YOLOv8, SCRFD, ArcFace (ONNX), OpenGait; FAISS for matching            |
| Auth               | Shared API key (Bearer token or `x-api-key` header)                   |
| Containerization   | Docker, GitLab CI buildx --push, Flux GitOps via `infrastructure/deploy` |
