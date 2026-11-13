import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated configuration.
 *
 * Design notes:
 * - `.env` is loaded exactly once, here, before anything else reads process.env.
 * - Every value is validated and coerced with zod so the rest of the codebase
 *   can rely on strong types (no `process.env.X!` scattered across modules).
 * - The process does NOT crash when the LLM key is missing: the UI can still
 *   load and /api/health reports the missing dependency. Chat requests return a
 *   clear 503 instead of a stack trace. This makes local onboarding and demos
 *   much friendlier while still being production-safe.
 */

const boolString = (defaultValue: "true" | "false" = "false") =>
  z
    .string()
    .default(defaultValue)
    .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase()));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TRUST_PROXY: boolString(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // LLM (OpenAI-compatible)
  LLM_API_KEY: z.string().trim().optional(),
  OPENAI_API_KEY: z.string().trim().optional(), // conventional alias
  LLM_BASE_URL: z.string().trim().url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(90_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(0).max(32_000).default(0),
  LLM_STREAM_USAGE: boolString("true"),

  // Search
  SEARCH_PROVIDER: z.enum(["auto", "tavily", "duckduckgo"]).default("auto"),
  TAVILY_API_KEY: z.string().trim().optional(),
  SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(12_000),
  SEARCH_CACHE_TTL_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
  SEARCH_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(10_000).default(200),

  // Agent
  MAX_TOOL_ITERATIONS: z.coerce.number().int().min(0).max(10).default(4),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(2).max(200).default(24),
  TIMELINE_MAX_ENTRIES: z.coerce.number().int().min(0).max(1_000).default(80),
  TIMELINE_MAX_CHARS: z.coerce.number().int().min(500).max(50_000).default(6_000),
  MAX_MESSAGE_CHARS: z.coerce.number().int().min(100).max(100_000).default(8_000),

  // Sessions
  SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(525_600).default(1_440),
  MAX_SESSIONS: z.coerce.number().int().min(1).max(100_000).default(1_000),
  MAX_MESSAGES_PER_SESSION: z.coerce.number().int().min(4).max(5_000).default(200),
  PERSIST_SESSIONS: boolString("true"),
  SESSION_FILE: z.string().trim().min(1).default("data/sessions.json"),

  // HTTP
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(10_000).default(30),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast only for genuinely invalid configuration (e.g. a malformed URL).
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  port: env.PORT,
  trustProxy: env.TRUST_PROXY,
  logLevel: env.LOG_LEVEL,

  llm: {
    apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || "",
    baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ""),
    model: env.LLM_MODEL,
    temperature: env.LLM_TEMPERATURE,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxRetries: env.LLM_MAX_RETRIES,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    streamUsage: env.LLM_STREAM_USAGE,
  },

  search: {
    provider: env.SEARCH_PROVIDER,
    tavilyApiKey: env.TAVILY_API_KEY || "",
    maxResults: env.SEARCH_MAX_RESULTS,
    timeoutMs: env.SEARCH_TIMEOUT_MS,
    cacheTtlMs: env.SEARCH_CACHE_TTL_MS,
    cacheMaxEntries: env.SEARCH_CACHE_MAX_ENTRIES,
  },

  agent: {
    maxToolIterations: env.MAX_TOOL_ITERATIONS,
    maxHistoryMessages: env.MAX_HISTORY_MESSAGES,
    timelineMaxEntries: env.TIMELINE_MAX_ENTRIES,
    timelineMaxChars: env.TIMELINE_MAX_CHARS,
    maxMessageChars: env.MAX_MESSAGE_CHARS,
  },

  session: {
    ttlMs: env.SESSION_TTL_MINUTES * 60_000,
    maxSessions: env.MAX_SESSIONS,
    maxMessagesPerSession: env.MAX_MESSAGES_PER_SESSION,
    persist: env.PERSIST_SESSIONS,
    file: env.SESSION_FILE,
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX_REQUESTS,
  },
} as const;

export function isLlmConfigured(): boolean {
  return config.llm.apiKey.length > 0;
}
