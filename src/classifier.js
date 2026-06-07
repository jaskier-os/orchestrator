import config from './config.js';

/**
 * Classify user intent using LLM via the Communicator API.
 * @param {string} text - User's request text
 * @param {import('../sdk/types.js').AgentManifest[]} manifests - Available agent manifests
 * @param {Array<{role: string, content: any}>} [sessionHistory] - Recent conversation for context
 * @returns {Promise<import('../sdk/types.js').ClassificationResult>}
 */
export async function classify(text, manifests, sessionHistory) {
  const agentSummary = manifests.map(m => ({
    id: m.id,
    name: m.name,
    capabilities: m.capabilities
  }));

  const systemPrompt = [
    'You are a JSON-only intent classifier. Output EXACTLY one JSON object, nothing else.',
    'DO NOT answer questions. DO NOT provide information. DO NOT explain anything.',
    'ANY text that is not the JSON object is a critical failure.',
    '',
    'Available agents:',
    JSON.stringify(agentSummary),
    '',
    'Output format (ONLY this, no other text before or after):',
    '{"agentId":"...","intent":"...","confidence":0.XX}',
    '',
    'Built-in capabilities (handled without any agent -- set confidence < 0.1 for these):',
    '- Personal todo/task management: add task, list tasks, check/complete task, modify task, delete task',
    '- Navigation and local places: find nearby restaurants/cafes/places, navigate/directions to a place, start/stop journey',
    '- Alarm management: set alarm, delete alarm, dismiss alarm',
    '- Scheduled AI jobs: create job, list jobs, delete job, schedule a task to run later',
    '- General conversation, questions, chat',
    '',
    'Rules:',
    '- If the request matches a built-in capability above, set confidence < 0.1 (no agent needed).',
    '- Pick the agent whose capabilities best match the request.',
    '- Use conversation context to resolve references like "it", "that", "do it", etc.',
    '- If no agent matches well, set confidence < 0.5.',
    '- NEVER respond to the user. ONLY output the JSON object.'
  ].join('\n');

  // Include recent conversation context (last few turns) for disambiguation.
  // sessionHistory is expected to be clean user/assistant turns without the
  // current pending user turn (see Session.getHistoryForAgent). Multimodal
  // arrays are flattened to text since the classifier prompt is text-only.
  const contextMessages = [];
  if (sessionHistory && sessionHistory.length > 0) {
    const recent = sessionHistory.slice(-5);
    for (const msg of recent) {
      if (!msg || !msg.content) continue;
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
          : '';
      if (content && content.length > 0) {
        contextMessages.push({ role: msg.role, content });
      }
    }
  }

  const url = `${config.communicatorUrl}/api/chat/completions`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...contextMessages,
    { role: 'user', content: text }
  ];

  const callClassifier = async (msgs) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: msgs,
        stream: false,
        max_tokens: 200
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Classifier request failed (${response.status}): ${errorText}`);
    }

    return response.json();
  };

  let data = await callClassifier(messages);
  let content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Classifier returned empty response');
  }

  // Parse the JSON from the LLM response
  let jsonMatch = content.match(/\{[\s\S]*\}/);

  // Retry up to 5 times if the LLM answered instead of classifying
  for (let attempt = 1; !jsonMatch && attempt <= 5; attempt++) {
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: 'Wrong. Output ONLY the JSON classification object: {"agentId":"...","intent":"...","confidence":0.XX}' });
    data = await callClassifier(messages);
    content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`Classifier retry ${attempt} returned empty response`);
    }
    jsonMatch = content.match(/\{[\s\S]*\}/);
  }
  if (!jsonMatch) {
    throw new Error(`Classifier failed after 5 retries: ${content.slice(0, 200)}`);
  }

  const result = JSON.parse(jsonMatch[0]);

  if (typeof result.confidence !== 'number') {
    throw new Error(`Classifier returned invalid structure: ${JSON.stringify(result)}`);
  }

  // Empty agentId with low confidence = built-in capability, force fallback
  if (!result.agentId) {
    result.confidence = 0;
  }

  return {
    agentId: result.agentId || 'none',
    intent: result.intent || '',
    confidence: result.confidence,
    usage: data.usage || null
  };
}
