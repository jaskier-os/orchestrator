#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "[orchestrator] Installing dependencies..."
npm install --silent

echo "[orchestrator] Starting on port 10001..."
exec node src/index.js
