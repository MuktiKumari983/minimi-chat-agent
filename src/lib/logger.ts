import { config } from "../config.js";

/**
 * Tiny structured logger. We deliberately avoid a heavy dependency (pino,
 * winston) because the surface area is small and JSON lines are easy to ship
 * to any collector. Level filtering happens at call time.
 *
 * Privacy: callers must not log raw user messages or API keys. Every call site
 * in this project logs metadata (session ids, durations, provider names).
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const threshold = LEVEL_ORDER[config.logLevel];

function write(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...meta,
  };

  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};

/** Convert an unknown thrown value into safe, log-friendly metadata. */
export function errorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: config.env === "development" ? error.stack : undefined,
    };
  }
  return { error: String(error) };
}
