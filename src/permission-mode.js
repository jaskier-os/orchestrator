export const ORCHESTRATOR_MODES = ['ask_on_potentially_safe', 'acceptAll', 'bypassAll', 'plan'];
export const CLI_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
export const DEFAULT_ORCHESTRATOR_MODE = 'ask_on_potentially_safe';

// Phone uses short names; map to orchestrator names.
const PHONE_TO_ORCHESTRATOR = {
  'default': 'ask_on_potentially_safe',
  'acceptEdits': 'acceptAll',
  'bypassAll': 'bypassAll',
  'plan': 'plan',
};

/**
 * Normalize a mode value from any source (phone short name or orchestrator
 * canonical name) into the orchestrator canonical form. Returns null if
 * the value is not recognized.
 */
export function normalizeMode(value) {
  if (ORCHESTRATOR_MODES.includes(value)) return value;
  return PHONE_TO_ORCHESTRATOR[value] || null;
}

export function toCliMode(orchestratorMode) {
  switch (orchestratorMode) {
    case 'ask_on_potentially_safe': return 'default';
    case 'acceptAll': return 'acceptEdits';
    case 'bypassAll': return 'bypassPermissions';
    case 'plan': return 'plan';
    default:
      throw new Error('invalid_permission_mode: ' + orchestratorMode);
  }
}

// Orchestrator canonical -> phone short name (for UI display).
export function toPhoneMode(orchestratorMode) {
  switch (orchestratorMode) {
    case 'ask_on_potentially_safe': return 'default';
    case 'acceptAll': return 'acceptEdits';
    case 'bypassAll': return 'bypassAll';
    case 'plan': return 'plan';
    default: return orchestratorMode;
  }
}

export function validateOrchestratorMode(value) {
  return ORCHESTRATOR_MODES.includes(value);
}
