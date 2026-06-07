import { serializeMessage, MSG_TYPE } from '@orchestrator/sdk/protocol';

const AUTONOMOUS_SYSTEM_PROMPT_BASE = `You are an autonomous AI assistant executing a scheduled job. There is NO user present to interact with -- you must complete this task entirely on your own.

You have tools available to you. Use the get_current_time tool when you need the current date or time. The system will route your request to the appropriate agent (web search, shell commands, etc.) based on what you ask for -- you do not need to worry about routing.

STRICT RULES:
1. NEVER perform destructive actions (deleting files, dropping databases, uninstalling software, modifying system configurations, sending messages on behalf of the user, making purchases, or any action that cannot be easily undone).
2. This is for SMALL, well-defined tasks only. If the task requires substantial work, creative decisions, or would take a human more than 5 minutes, respond with a summary of what would need to be done and flag it for user review.
3. If something is broken or requires fixing that goes beyond a trivial change -- DO NOT attempt to fix it. Report the issue clearly and leave it for the user.
4. If you are unsure about ANY aspect of the task, err on the side of caution and report what you found rather than taking action.
5. NEVER access or modify credentials, passwords, API keys, or security-sensitive data.
6. NEVER send emails, messages, or communications to anyone.
7. Respond in English with a concise summary of what you did or found.
8. If agents are unavailable or a tool fails, report the failure clearly -- do not retry indefinitely or attempt workarounds.
9. NO amateur performance. Be precise, thorough, and professional in your execution and reporting.
10. If you CANNOT complete the task and need user clarification, start your response with exactly "[NEEDS_INPUT]" followed by a clear explanation of what you need from the user. The system will notify the user and let them continue the conversation with you.`;

/** @type {import('./job-store.js').JobStore|null} */
let jobStore = null;

/** @type {Function|null} */
let executeFn = null;

/** @type {Map<string, import('ws').WebSocket>|null} */
let deviceConnections = null;

/** @type {import('./session.js').SessionManager|null} */
let sessionManager = null;

/** @type {NodeJS.Timeout|null} */
let schedulerInterval = null;

let isRunning = false;

/**
 * Initialize the scheduler.
 * @param {import('./job-store.js').JobStore} store
 * @param {Function} dispatchFn - async (job, deviceConnections, sessionManager) => result
 * @param {Map<string, import('ws').WebSocket>} dc
 * @param {import('./session.js').SessionManager} sm
 */
export function initScheduler(store, dispatchFn, dc, sm) {
  jobStore = store;
  executeFn = dispatchFn;
  deviceConnections = dc;
  sessionManager = sm;
}

/**
 * Start the scheduler tick loop.
 * @param {number} [intervalMs=30000]
 */
export function startScheduler(intervalMs = 30000) {
  if (schedulerInterval) return;
  console.log(`[job-scheduler] Starting scheduler (interval: ${intervalMs}ms)`);
  tick();
  schedulerInterval = setInterval(tick, intervalMs);
}

/**
 * Stop the scheduler.
 */
export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[job-scheduler] Scheduler stopped');
  }
}

/**
 * Get the autonomous system prompt with available agent capabilities.
 * @param {Array<{ id: string, name: string, capabilities: string[] }>} [manifests] - Available agent manifests
 * @returns {string}
 */
export function getAutonomousSystemPrompt(manifests = []) {
  if (manifests.length === 0) return AUTONOMOUS_SYSTEM_PROMPT_BASE;

  const capabilityLines = manifests.map(m => {
    const caps = (m.capabilities || []).join(', ');
    return `- ${m.name}: ${caps}`;
  });

  return AUTONOMOUS_SYSTEM_PROMPT_BASE + '\n\nAVAILABLE CAPABILITIES (the system can route your request to these agents):\n' + capabilityLines.join('\n');
}

/**
 * Send job notification to all connected devices.
 * @param {string} jobId
 * @param {string} jobName
 * @param {string} status
 * @param {string|null} resultText
 */
function sendJobNotification(jobId, jobName, status, resultText) {
  if (!deviceConnections) return;
  let message;
  if (status === 'needs_input') {
    message = `Job "${jobName}" needs your input`;
  } else if (status === 'failed') {
    message = `Job "${jobName}" failed`;
  } else {
    message = `Job "${jobName}" completed`;
  }

  const msg = serializeMessage({
    type: MSG_TYPE.JOB_NOTIFICATION,
    jobId,
    jobName,
    status,
    result: resultText || null,
    message
  });

  for (const [, ws] of deviceConnections) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  }
}

/**
 * Broadcast updated job list to all connected devices.
 */
async function broadcastJobUpdate() {
  if (!deviceConnections || !jobStore) return;
  try {
    const jobs = await jobStore.list();
    const msg = serializeMessage({ type: MSG_TYPE.JOB_RESULT, action: 'list', jobs });
    for (const [, ws] of deviceConnections) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
  } catch (err) {
    console.error('[job-scheduler] Failed to broadcast job update:', err.message);
  }
}

/**
 * Process due jobs.
 */
async function tick() {
  if (!jobStore || !executeFn) return;
  if (isRunning) {
    console.log('[job-scheduler] Tick skipped, previous still running');
    return;
  }
  isRunning = true;

  try {
    const dueJobs = await jobStore.findDueJobs();
    if (dueJobs.length === 0) {
      isRunning = false;
      return;
    }

    console.log(`[job-scheduler] Found ${dueJobs.length} due job(s)`);

    for (const job of dueJobs) {
      console.log(`[job-scheduler] Executing job "${job.name}" (${job.id})`);
      await jobStore.markRunning(job.id);
      broadcastJobUpdate();

      try {
        const result = await executeFn(job, deviceConnections, sessionManager);
        const conversationId = result.conversationId || null;

        if (result.text && result.text.startsWith('[NEEDS_INPUT]')) {
          await jobStore.markNeedsInput(job.id, result.text, conversationId);
          console.log(`[job-scheduler] Job "${job.name}" needs user input`);
          sendJobNotification(job.id, job.name, 'needs_input', result.text);
        } else if (result.status === 'success') {
          await jobStore.markCompleted(job.id, result.text, conversationId);
          console.log(`[job-scheduler] Job "${job.name}" completed successfully`);
          sendJobNotification(job.id, job.name, 'completed', result.text);
        } else {
          await jobStore.markFailed(job.id, result.text || 'Unknown error', conversationId);
          console.log(`[job-scheduler] Job "${job.name}" failed: ${result.text}`);
          sendJobNotification(job.id, job.name, 'failed', result.text);
        }
      } catch (err) {
        console.error(`[job-scheduler] Job "${job.name}" threw error:`, err.message);
        await jobStore.markFailed(job.id, err.message);
        sendJobNotification(job.id, job.name, 'failed', err.message);
      }

      await broadcastJobUpdate();
    }
  } catch (err) {
    console.error('[job-scheduler] Tick error:', err.message);
  } finally {
    isRunning = false;
  }
}
