# orchestrator

> **Docs & wiki:** [github.com/jaskier-os/docs/wiki](https://github.com/jaskier-os/docs/wiki)

## What it is

The central router. Client devices (phone, glasses, desktop) connect here and it
dispatches to the specialized backend services - communicator (LLM), STT,
translation, TTS, ReID analytics - holds session/chat state in MongoDB, and
streams results back over HTTP and WebSocket. Koa server.

This repo is also the canonical home of `@orchestrator/sdk`, which lives in
`./sdk` and is consumed by the agents. The orchestrator depends on it via
`file:./sdk`, so the version here is the source.

## Build / run

Local dev:

```bash
npm install
cp .env.example .env   # edit before first run
npm run dev            # node --watch, src/index.js
npm start              # plain node
```

`run.sh` is the same (install + start). Listens on port 10001.

Docker:

```bash
docker build -t orchestrator .
docker run -p 10001:10001 --env-file .env orchestrator
```

The Dockerfile copies `sdk/` before `npm ci` because of the `file:./sdk`
dependency, and installs `ffmpeg` for audio handling. Healthcheck hits
`/api/v1/health`.

## Configuration

Config is env vars. `.env.example` is the source of truth - copy to `.env` and
edit. Key ones:

- `PORT`, `API_KEY` - bind + auth.
- `MONGO_URL` - session/chat store.
- The `*_URL` service endpoints it routes to: `COMMUNICATOR_URL`, `TTS_URL`,
  `PIPER_TTS_URL`, `TRANSCRIBER_URL` / `TRANSCRIBER_WS_URL`, `ANTHROPIC_STT_URL`,
  `TRANSLATOR_URL`, `REID_ANALYTICS_URL`.
- `SESSION_TIMEOUT_MS`, `COMPACTION_THRESHOLD`, `CHAT_HISTORY_DIR` - session
  behavior. See the example file for the rest.

## Dependencies

Node >= 20, Koa 2, `mongodb`, `ws` for WebSocket, `multer` for uploads, `ffmpeg`
(system package, in the image) for audio. `@orchestrator/sdk` is vendored in
`./sdk` - it's not pulled from a registry; edit it in place and the orchestrator
picks it up.
