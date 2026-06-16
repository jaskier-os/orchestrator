import Joi from 'joi';

const schema = Joi.object({
  port: Joi.number().integer().min(1).max(65535).default(10001),
  communicatorUrl: Joi.string().uri().default('http://localhost:10000'),
  apiKey: Joi.string().required(),
  llmModel: Joi.string().default('sonnet'),
  ttsUrl: Joi.string().uri().default('http://localhost:10007'),
  piperTtsUrl: Joi.string().uri().default('http://localhost:10013'),
  ttsRoutingMode: Joi.string().valid('language-split', 'teratts').default('language-split'),
  sessionTimeoutMs: Joi.number().integer().min(1000).default(600_000),
  compactionThreshold: Joi.number().integer().min(1000).default(180_000),
  transcriberUrl: Joi.string().uri().default('http://localhost:10003'),
  transcriberWsUrl: Joi.string().default('ws://localhost:10003/ws/stream'),
  anthropicSttUrl: Joi.string().uri().default('http://localhost:10016'),
  translatorUrl: Joi.string().uri().default('http://localhost:10015'),
  reidAnalyticsUrl: Joi.string().uri().default('http://localhost:3400'),
  speakerVerificationEnabled: Joi.boolean().default(false),
  chatHistoryDir: Joi.string().default('./data/chat-history'),
  copilotHistoryDir: Joi.string().default('./data/copilot-history'),
  mongoUrl: Joi.string().default('mongodb://localhost:27017'),
  rcSessionTimeoutMs: Joi.number().integer().min(1000).default(43_200_000),
}).unknown(false);

const { value, error } = schema.validate({
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  communicatorUrl: process.env.COMMUNICATOR_URL,
  apiKey: process.env.API_KEY,
  llmModel: process.env.LLM_MODEL,
  ttsUrl: process.env.TTS_URL,
  piperTtsUrl: process.env.PIPER_TTS_URL,
  ttsRoutingMode: process.env.TTS_ROUTING_MODE,
  sessionTimeoutMs: process.env.SESSION_TIMEOUT_MS ? Number(process.env.SESSION_TIMEOUT_MS) : undefined,
  compactionThreshold: process.env.COMPACTION_THRESHOLD ? Number(process.env.COMPACTION_THRESHOLD) : undefined,
  transcriberUrl: process.env.TRANSCRIBER_URL,
  transcriberWsUrl: process.env.TRANSCRIBER_WS_URL,
  anthropicSttUrl: process.env.ANTHROPIC_STT_URL,
  translatorUrl: process.env.TRANSLATOR_URL,
  reidAnalyticsUrl: process.env.REID_ANALYTICS_URL,
  speakerVerificationEnabled: process.env.SPEAKER_VERIFICATION_ENABLED === 'true',
  chatHistoryDir: process.env.CHAT_HISTORY_DIR,
  copilotHistoryDir: process.env.COPILOT_HISTORY_DIR,
  mongoUrl: process.env.MONGO_URL,
  rcSessionTimeoutMs: process.env.RC_SESSION_TIMEOUT_MS ? Number(process.env.RC_SESSION_TIMEOUT_MS) : undefined,
}, { stripUnknown: true });

if (error) {
  console.error('[config] Validation error:', error.message);
  process.exit(1);
}

const config = Object.freeze(value);
export default config;
