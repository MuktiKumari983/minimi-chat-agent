/**
 * Error taxonomy used across the app.
 *
 * Every error that can reach the HTTP layer carries a safe, user-facing
 * message plus an HTTP status and a stable machine-readable code. Internal
 * details (provider responses, stack traces) are logged but never sent to the
 * browser unless deliberately safe (e.g. model-not-found).
 */

export interface AppErrorOptions {
  status?: number;
  code?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.status = options.status ?? 500;
    this.code = options.code ?? "internal_error";
  }
}

/** Missing/invalid configuration (API keys, provider settings). */
export class ConfigError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, "status"> = {}) {
    super(message, { ...options, status: 503, code: options.code ?? "not_configured" });
    this.name = "ConfigError";
  }
}

/** A web-search provider failed. Recoverable: the model receives an error result. */
export class SearchError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, "status"> = {}) {
    super(message, { ...options, status: 502, code: options.code ?? "search_failed" });
    this.name = "SearchError";
  }
}

/**
 * Wraps an agent failure, preserving any text that was already streamed so the
 * UI can keep the partial answer visible alongside the error.
 */
export class AgentError extends AppError {
  readonly partialText?: string;

  constructor(
    message: string,
    options: AppErrorOptions & { partialText?: string } = {},
  ) {
    super(message, options);
    this.name = "AgentError";
    this.partialText = options.partialText;
  }
}

/** Detect aborts coming from fetch, the OpenAI SDK, or timers. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.name === "AbortError" ||
      error.name === "APIUserAbortError" ||
      error.name === "TimeoutError" ||
      error.message === "This operation was aborted"
    );
  }
  return false;
}

/** Small abort helper that never reports a timeout as a user abort. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}

/** Convert anything thrown into a safe AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) {
    return new AppError("The request was cancelled.", { status: 499, code: "aborted" });
  }
  return new AppError("An unexpected error occurred. Please try again.", {
    status: 500,
    code: "internal_error",
    cause: error,
  });
}
