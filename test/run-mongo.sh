#!/usr/bin/env bash
# Starts a throwaway mongo:7 on port 27117 for tests. Idempotent.
set -e
if ! docker ps --format '{{.Names}}' | grep -q '^orch-test-mongo$'; then
  docker rm -f orch-test-mongo >/dev/null 2>&1 || true
  docker run -d --name orch-test-mongo -p 27117:27017 mongo:7 >/dev/null
  for i in $(seq 1 30); do
    docker exec orch-test-mongo mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break
    sleep 1
  done
fi
echo "mongodb://127.0.0.1:27117"
