/**
 * Device tool definitions for LLM inference.
 * Tools are device-type-aware: phone tools run on the phone,
 * glasses tools run on the glasses (relayed via phone BT).
 * Navigation tools run on the phone for both device types.
 */

const JOURNEY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'prepare_journey',
      description: 'Prepare a navigation journey to a destination. MUST be called before start_journey. Returns route details including ETA, distance, and step-by-step directions. The user MUST confirm before you call start_journey. You MUST ask the user which transport_type they want to use EVERY time -- never assume it. For transit routes, the response includes detailed steps (walk, metro, bus, etc.).',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Destination address (e.g. "Tverskaya 1, Moscow"). Provide either address OR toLat+toLng.'
          },
          toLat: { type: 'number', description: 'Destination latitude (use if address not provided)' },
          toLng: { type: 'number', description: 'Destination longitude (use if address not provided)' },
          transport_type: {
            type: 'string',
            enum: ['walking', 'car', 'bus', 'bicycle'],
            description: 'REQUIRED. Transport type: "walking", "car" (driving), "bus" (public transit), or "bicycle". Always ask the user before calling.'
          }
        },
        required: ['transport_type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'start_journey',
      description: 'Start navigation for a previously prepared journey. prepare_journey MUST have been called first AND the user must have confirmed. Do NOT call this in the same message as prepare_journey -- always present the route details to the user and wait for their explicit confirmation first.',
      parameters: {
        type: 'object',
        properties: {
          methodId: {
            type: 'string',
            description: 'The methodId returned by prepare_journey'
          }
        },
        required: ['methodId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stop_journey',
      description: 'Stop the current active navigation journey.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'modify_journey',
      description: 'Add a waypoint to the current active navigation route. Accepts either an address string or coordinates.',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Waypoint address (e.g. "Pushkinskaya Square, Moscow"). Provide either address OR waypointLat+waypointLng.'
          },
          waypointLat: { type: 'number', description: 'Waypoint latitude' },
          waypointLng: { type: 'number', description: 'Waypoint longitude' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_journey',
      description: 'Get the current navigation journey status. Returns state (IDLE/PLANNING/ACTIVE), destination, transport mode, ETA, and route steps if available.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_eta',
      description: 'Get the current ETA for the active navigation journey. Returns 0 if no journey is active.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_eta_to_address',
      description: 'Get the estimated travel time to a given address by a specific transport type. Does NOT start or prepare a journey -- query only. Use etaSeconds to determine the nearest/closest destination (always compare by travel time, not distance). You MUST ask the user which transport_type they want EVERY time.',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Destination address (e.g. "Tverskaya 1, Moscow"). Provide either address OR toLat+toLng.'
          },
          toLat: { type: 'number', description: 'Destination latitude (use if address not provided)' },
          toLng: { type: 'number', description: 'Destination longitude (use if address not provided)' },
          transport_type: {
            type: 'string',
            enum: ['walking', 'car', 'bus', 'bicycle'],
            description: 'REQUIRED. Transport type: "walking", "car" (driving), "bus" (public transit), or "bicycle".'
          }
        },
        required: ['transport_type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_places',
      description: 'Search for places, businesses, or points of interest (restaurants, cafes, pharmacies, gas stations, etc.). Supports searching near the current location, near specific coordinates, or in a named area. After presenting results to the user, ALWAYS offer to navigate to one of the found places using prepare_journey with the place coordinates (toLat/toLng).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for (e.g. "restaurant", "coffee shop", "pharmacy", "Italian pizza")'
          },
          area: {
            type: 'string',
            description: 'Named area to search in (e.g. "Moscow center", "Tverskaya street", "near Red Square"). Gets geocoded to coordinates. If omitted and no lat/lng provided, searches near current GPS location.'
          },
          lat: { type: 'number', description: 'Search center latitude. Overrides area if both provided.' },
          lng: { type: 'number', description: 'Search center longitude. Overrides area if both provided.' },
          radius: {
            type: 'number',
            description: 'Search radius in meters (100-10000). Defaults to 1000.'
          }
        },
        required: ['query']
      }
    }
  }
];

const ALARM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'setup_alarm',
      description: 'Set a native alarm on the phone clock app. Time is in 24-hour format, device local timezone. The alarm fires even if the app is closed.',
      parameters: {
        type: 'object',
        properties: {
          hour: { type: 'number', description: 'Hour in 24h format (0-23)' },
          minutes: { type: 'number', description: 'Minutes (0-59)' },
          title: { type: 'string', description: 'Alarm label (e.g. "Drink water", "Wake up")' },
          days: {
            type: 'array',
            items: { type: 'number' },
            description: 'Days to repeat (1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri, 7=Sat). Omit for one-time alarm.'
          }
        },
        required: ['hour', 'minutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_alarm',
      description: 'Delete or dismiss an existing alarm from the phone clock app. Provide time and/or title to match the alarm. At least one must be provided.',
      parameters: {
        type: 'object',
        properties: {
          hour: { type: 'number', description: 'Hour of the alarm to delete (0-23)' },
          minutes: { type: 'number', description: 'Minutes of the alarm to delete (0-59)' },
          title: { type: 'string', description: 'Label of the alarm to delete' }
        }
      }
    }
  }
];

const TIME_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time. Returns ISO timestamp, unix epoch, and human-readable format.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

const TODO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all current tasks with their IDs, text, completion status, and position. Call this before update_task, move_task, or delete_task to get the task ID.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_task',
      description: 'Add a new task to the top of the user\'s task list.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The task text (e.g. "Buy groceries", "Call dentist")'
          }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Update an existing task. Use to rename a task (change its text) or set its completion status. Call list_tasks first to get the task ID.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The task ID (24-char hex string from list_tasks)'
          },
          text: {
            type: 'string',
            description: 'New text for the task (omit to keep current text)'
          },
          completed: {
            type: 'boolean',
            description: 'Set to true to mark as completed, false to mark as not completed (omit to keep current status)'
          }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_task',
      description: 'Move a task to a different position in the list. Position 0 is the top. Call list_tasks first to see current positions.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The task ID (24-char hex string from list_tasks)'
          },
          position: {
            type: 'number',
            description: 'Target position (0-based index). 0 = top of list.'
          }
        },
        required: ['id', 'position']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Permanently delete a task from the list. Call list_tasks first to get the task ID.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The task ID (24-char hex string from list_tasks)'
          }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_saved_messages',
      description: 'Read the last N messages from the user\'s Telegram Saved Messages. Returns an array of messages with id, sender, text, and date.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of messages to fetch (1-100). Defaults to 5.'
          }
        }
      }
    }
  }
];

const JOB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_jobs',
      description: 'List all scheduled AI jobs. Jobs run autonomously at their scheduled time. Returns job ID, name, prompt, scheduled time, and status.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_job',
      description: 'Schedule an autonomous AI job to run at a specific time. The job will execute the given prompt without user interaction.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short name for the job (e.g. "Weather check", "News summary")'
          },
          prompt: {
            type: 'string',
            description: 'The prompt/instruction the AI will execute when the job runs'
          },
          scheduled_at: {
            type: 'string',
            description: 'ISO 8601 datetime when the job should run (e.g. "2026-03-28T09:00:00.000Z")'
          }
        },
        required: ['name', 'prompt', 'scheduled_at']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_job',
      description: 'Delete a scheduled job by ID. Call list_jobs first to get the job ID.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The job ID (24-char hex string from list_jobs)'
          }
        },
        required: ['id']
      }
    }
  }
];

const PHONE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_geolocation',
      description: 'Get the current GPS location of the device. Returns latitude, longitude, accuracy, altitude, speed, and address.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'take_photo',
      description: 'Take a photo using the phone camera.',
      parameters: {
        type: 'object',
        properties: {
          camera: {
            type: 'string',
            enum: ['back', 'front'],
            description: 'Which camera to use. Defaults to back camera.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_audio',
      description: 'Record audio from the phone microphone for a specified duration.',
      parameters: {
        type: 'object',
        properties: {
          duration_seconds: {
            type: 'number',
            description: 'How long to record in seconds (1-300). Defaults to 10.'
          }
        }
      }
    }
  },
  ...JOURNEY_TOOLS,
  ...TODO_TOOLS,
  ...JOB_TOOLS,
  ...ALARM_TOOLS,
  ...TIME_TOOLS
];

const GLASSES_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_geolocation',
      description: 'Get the current GPS location (uses phone GPS via Bluetooth). Returns latitude, longitude, accuracy, altitude, speed, and address.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'take_photo',
      description: 'Take a photo using the glasses camera.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_audio',
      description: 'Record audio from the glasses microphone for a specified duration.',
      parameters: {
        type: 'object',
        properties: {
          duration_seconds: {
            type: 'number',
            description: 'How long to record in seconds (1-300). Defaults to 10.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_video',
      description: 'Record video from the glasses camera for a specified duration.',
      parameters: {
        type: 'object',
        properties: {
          duration_seconds: {
            type: 'number',
            description: 'How long to record in seconds (1-300). Defaults to 10.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_ar_screen',
      description: 'Record the AR screen overlay from the glasses for a specified duration.',
      parameters: {
        type: 'object',
        properties: {
          duration_seconds: {
            type: 'number',
            description: 'How long to record in seconds (1-300). Defaults to 10.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'start_translation',
      description: 'Start real-time translation on the glasses display. Translates spoken language in real-time.',
      parameters: {
        type: 'object',
        properties: {
          from_language: {
            type: 'string',
            description: 'Source language code (e.g. "en", "ru", "zh")'
          },
          to_language: {
            type: 'string',
            description: 'Target language code (e.g. "en", "ru", "zh")'
          }
        },
        required: ['from_language', 'to_language']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stop_translation',
      description: 'Stop the currently running real-time translation on the glasses.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'identify_person',
      description: 'Take a photo using the glasses camera and identify the person via face recognition against the ReID database. Returns the matched person ID, name, and similarity score. If a match is found, you MUST ask the user "I found a match. Should I look up more information about this person?" and wait for confirmation before calling lookup_person_info.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_person_info',
      description: 'Look up background information about a previously identified person using the Sherlock OSINT service. ONLY call this after identify_person returned a person ID AND the user confirmed they want to proceed.',
      parameters: {
        type: 'object',
        properties: {
          person_id: {
            type: 'string',
            description: 'The person ID returned by identify_person'
          }
        },
        required: ['person_id']
      }
    }
  },
  ...JOURNEY_TOOLS,
  ...TODO_TOOLS,
  ...JOB_TOOLS,
  ...ALARM_TOOLS,
  ...TIME_TOOLS
];

const TODO_TOOL_NAMES = new Set(['list_tasks', 'add_task', 'update_task', 'move_task', 'delete_task', 'read_saved_messages']);
const JOB_TOOL_NAMES = new Set(['list_jobs', 'create_job', 'delete_job']);

const ALL_DEVICE_TOOL_NAMES = new Set([
  'get_geolocation', 'take_photo', 'record_audio',
  'record_video', 'record_ar_screen',
  'start_translation', 'stop_translation',
  'identify_person', 'lookup_person_info',
  'prepare_journey', 'start_journey', 'stop_journey', 'modify_journey',
  'get_journey', 'get_eta', 'get_eta_to_address', 'search_places',
  'list_tasks', 'add_task', 'update_task', 'move_task', 'delete_task', 'read_saved_messages',
  'list_jobs', 'create_job', 'delete_job',
  'setup_alarm', 'delete_alarm',
  'get_current_time'
]);

const NOT_IMPLEMENTED_TOOLS = new Set([]);

/**
 * Get device tools for a given device type.
 * @param {string} deviceType - "phone" or "glasses"
 * @returns {Array} OpenAI-format tool definitions
 */
export function getDeviceTools(deviceType) {
  if (deviceType === 'glasses') return GLASSES_TOOLS;
  if (deviceType === 'phone') return PHONE_TOOLS;
  return [];
}

/**
 * Check if a tool name is a device tool.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isDeviceTool(toolName) {
  return ALL_DEVICE_TOOL_NAMES.has(toolName);
}

/**
 * Check if a device tool is not yet implemented.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isNotImplemented(toolName) {
  return NOT_IMPLEMENTED_TOOLS.has(toolName);
}

/**
 * Check if a tool is a todo/task tool (handled server-side, not on device).
 * @param {string} toolName
 * @returns {boolean}
 */
export function isTodoTool(toolName) {
  return TODO_TOOL_NAMES.has(toolName);
}

/**
 * Check if a tool is a job tool (handled server-side via JobStore, not on device).
 * @param {string} toolName
 * @returns {boolean}
 */
export function isJobTool(toolName) {
  return JOB_TOOL_NAMES.has(toolName);
}

/**
 * Check if a tool is a time tool (handled server-side, not on device).
 * @param {string} toolName
 * @returns {boolean}
 */
export function isTimeTool(toolName) {
  return toolName === 'get_current_time';
}

/**
 * Convert an LLM tool call to a DeviceCommand object.
 * @param {string} toolName
 * @param {Record<string, any>} toolArgs
 * @returns {{ type: string, params?: Record<string, any>, _notImplemented?: boolean }}
 */
export function buildDeviceCommand(toolName, toolArgs) {
  if (NOT_IMPLEMENTED_TOOLS.has(toolName)) {
    return { type: toolName, params: toolArgs, _notImplemented: true };
  }
  const command = { type: toolName };
  if (toolArgs && Object.keys(toolArgs).length > 0) {
    command.params = toolArgs;
  }
  return command;
}

export { PHONE_TOOLS, GLASSES_TOOLS };
