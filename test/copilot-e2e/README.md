# Copilot e2e harnesses (live-AI WS drivers)

Standalone Node.js drivers that exercise the **live, deployed** Copilot
(formerly "assistant") ambient fact-check feature by speaking the glasses device
contract directly over the orchestrator's `/ws/device` WebSocket. They mock only
the speech input -- the AI inference is REAL (hits the deployed orchestrator ->
communicator -> Claude). No production code is touched.

These are evaluation/regression drivers, not unit tests, which is why they live
in their own `copilot-e2e/` subdir rather than alongside the `*.test.js` unit
tests in `orchestrator/test/`.

## Protocol each harness speaks

1. `identify {deviceId, deviceType:'glasses'}`
2. `assistant_new` -- reset an isolated session
3. per ~10s batch: `assistant {requestId, wearerText, interlocutorText, activeCards, model:'haiku'}`
   -> await `assistant_result {requestId, cards, dismiss}`
4. maintain local HUD state (newest-first, cap 5); add new cards, remove dismissed ids;
   pass `activeCards` back on the next batch.

Single-in-flight: await each result before sending the next batch. Fresh
`deviceId` + `assistant_new` per scenario.

## Harnesses

| File            | Drives                                                                 |
|-----------------|-----------------------------------------------------------------------|
| `drive-live.mjs`| Baseline live driver -- identify/assistant_new/per-batch card flow. Defaults to the prod TLS ingress (`wss://65.108.225.44:8443/ws/device`). |
| `audit.mjs`     | Usefulness AUDIT: richer scenarios (sales/investor objections, negotiation, recall-with-planted-error, fraud escalation, small talk) to grade card usefulness. |
| `stress.mjs`    | STRESS: four long worst-case scenarios, middle-skilled wearer vs hostile interlocutor. Writes `/tmp/copilot_stress.txt`. |
| `ru.mjs`        | Russian-language scenarios -- validates every card comes back in the wearer's language (Russian). Writes `$COPILOT_OUT` (default `/tmp/copilot_ru.txt`). |
| `stress-ru.mjs` | Russian stress scenarios. Writes `/tmp/copilot_stress_ru.txt`. |

`usefulness-audit-report.md` is a representative graded output kept for reference.

## How to run (against the LIVE deployed AI)

The harnesses target the deployed orchestrator. From a dev box, forward a local
port to the in-cluster orchestrator service, then point `COPILOT_WS` at it:

```bash
# 1. Resolve the orchestrator service clusterIP + port (10001) on the remote box
ssh hetzner 'kubectl get svc -A | grep orchestrator'   # k3s: use the cluster's kubectl

# 2. Local-forward 10901 -> <clusterIP>:10001 over SSH
ssh -L 10901:<orchestrator-clusterIP>:10001 hetzner -N &

# 3. Drive it
cd AI/orchestrator
npm install                                   # ensures ws is present in node_modules
COPILOT_WS=ws://127.0.0.1:10901/ws/device node test/copilot-e2e/audit.mjs
```

`drive-live.mjs` and `audit.mjs` honour `COPILOT_WS`; `stress-ru.mjs` currently
hardcodes `ws://127.0.0.1:10901/ws/device` (edit the const if your tunnel uses a
different port). `ru.mjs` also honours `COPILOT_OUT` for its capture file.

Note: these depend on the `ws` package declared in `orchestrator/package.json`.
Run `npm install` in `AI/orchestrator` first if `ERR_MODULE_NOT_FOUND` for `ws`
appears. `node --check` passes on all of them.
