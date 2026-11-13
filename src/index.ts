import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import compression from "compression";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import { ChatAgent } from "./agent/core.js";
import { config, isLlmConfigured } from "./config.js";
import { AgentError, AppError, isAbortError, toAppError } from "./lib/errors.js";
import { errorMeta, logger } from "./lib/logger.js";
import { SessionStore, isValidSessionId } from "./memory/session.js";
import { getSearchProvider, isSearchConfigured } from "./tools/search.js";

/**
 * HTTP layer.
 *
 * Streaming uses Server-Sent Events over a POST request (fetch + ReadableStream
 * on the client) rather than WebSockets:
 *  - one-way server -> client stream is exactly what chat needs
 *  - works through proxies/CDNs with plain HTTP/1.1
 *  - no extra dependency or reconnect protocol to secure
 *
 * The SSE contract: meta | status | tool | delta | done | error.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");
const persistPath = config.session.persist
  ? path.resolve(process.cwd(), config.session.file)
  : null;

const store = new SessionStore({
  ttlMs: config.session.ttlMs,
  maxSessions: config.session.maxSessions,
  maxMessagesPerSession: config.session.maxMessagesPerSession,
  persistPath,
});
await store.init();

const agent = new ChatAgent(store);
const app = express();

if (config.trustProxy) app.set("trust proxy", 1);
app.disable("x-powered-by");

// Security headers. The UI uses only same-origin static assets, so a strict
// CSP works without 'unsafe-inline'.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Disabled so plain-HTTP local development is not upgraded to https
        // by the browser. Terminate TLS at the proxy in production.
        upgradeInsecureRequests: null,
      },
    },
  }),
);

// Never compress SSE: compression buffers tokens and breaks the "instant"
// streaming feel. Everything else (HTML/CSS/JS, JSON) is compressed.
app.use(
  compression({
    filter: (req, res) => req.path !== "/api/chat" && compression.filter(req, res),
  }),
);

app.use(express.json({ limit: "256kb" }));

const chatLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many requests. Please slow down and try again shortly.",
    },
  },
});

const chatRequestSchema = z.object({
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid session id.")
    .optional(),
  message: z
    .string()
    .trim()
    .min(1, "Message cannot be empty.")
    .max(config.agent.maxMessageChars, "Message is too long."),
  timeZone: z.string().trim().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    model: config.llm.model,
    llmConfigured: isLlmConfigured(),
    search: {
      provider: getSearchProvider(),
      configured: isSearchConfigured(),
    },
  });
});

app.get("/api/sessions/:id", (req: Request, res: Response) => {
  const id = req.params.id;
  if (!isValidSessionId(id)) {
    res.status(400).json({ error: { code: "invalid_session", message: "Invalid session id." } });
    return;
  }

  const session = store.get(id);
  if (!session) {
    res.status(404).json({ error: { code: "session_not_found", message: "Session not found." } });
    return;
  }

  res.json({
    session: {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      timeZone: session.timeZone,
      messages: session.messages,
    },
  });
});

app.delete("/api/sessions/:id", (req: Request, res: Response) => {
  const id = req.params.id;
  if (!isValidSessionId(id) || !store.delete(id)) {
    res.status(404).json({ error: { code: "session_not_found", message: "Session not found." } });
    return;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Streaming chat endpoint
// ---------------------------------------------------------------------------

app.post("/api/chat", chatLimiter, async (req: Request, res: Response) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
    });
    return;
  }

  if (!isLlmConfigured()) {
    res.status(503).json({
      error: {
        code: "llm_not_configured",
        message: "Chat is not configured. Add LLM_API_KEY to your .env file and restart.",
      },
    });
    return;
  }

  const sessionId = parsed.data.sessionId ?? randomUUID();

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.socket?.setNoDelay(true);

  let closed = false;
  let finished = false;
  const controller = new AbortController();

  const send = (event: string, data: unknown): void => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      logger.debug("failed to write SSE event", { event, ...errorMeta(error) });
    }
  };

  // Keep intermediaries from closing an idle connection while the model is
  // thinking or a search is running.
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        // The close handler will clean up.
      }
    }
  }, 15_000);
  heartbeat.unref?.();

  const onClose = (): void => {
    closed = true;
    clearInterval(heartbeat);
    if (!finished) controller.abort();
  };
  res.on("close", onClose);

  send("meta", {
    sessionId,
    model: config.llm.model,
    searchProvider: getSearchProvider(),
    startedAt: new Date().toISOString(),
  });

  try {
    const result = await agent.run({
      sessionId,
      userMessage: parsed.data.message,
      ...(parsed.data.timeZone ? { timeZone: parsed.data.timeZone } : {}),
      signal: controller.signal,
      emit: {
        status: (event) => send("status", event),
        tool: (event) => send("tool", event),
        delta: (event) => send("delta", event),
      },
    });

    send("done", {
      sessionId,
      messageId: result.messageId,
      text: result.text,
      sources: result.sources,
      usage: result.usage,
      metrics: result.metrics,
    });
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      logger.info("chat stream aborted", { sessionId });
    } else {
      const appError = error instanceof AppError ? error : toAppError(error);
      logger.error("chat request failed", {
        sessionId,
        code: appError.code,
        status: appError.status,
        ...errorMeta(error),
      });

      send("error", {
        code: appError.code,
        message: appError.message,
        ...(error instanceof AgentError && error.partialText
          ? { partialText: error.partialText }
          : {}),
      });
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
});

app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: { code: "not_found", message: "API route not found." } });
});

app.use(
  express.static(publicDir, {
    etag: true,
    maxAge: config.env === "production" ? "1h" : 0,
    setHeaders: (res, filePath) => {
      // HTML must revalidate so deploys pick up new asset references.
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

// Centralised error handler. Never leaks stacks or provider internals.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;

  if (error instanceof SyntaxError && "status" in error && (error as { status?: number }).status === 400) {
    res.status(400).json({ error: { code: "invalid_json", message: "Malformed JSON body." } });
    return;
  }

  const appError = toAppError(error);
  logger.error("unhandled request error", {
    code: appError.code,
    status: appError.status,
    ...errorMeta(error),
  });
  res.status(appError.status).json({
    error: { code: appError.code, message: appError.message },
  });
});

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

const server = app.listen(config.port, () => {
  logger.info("Minimi Chat Agent listening", {
    url: `http://localhost:${config.port}`,
    env: config.env,
    model: config.llm.model,
    llmConfigured: isLlmConfigured(),
    searchProvider: getSearchProvider(),
    searchConfigured: isSearchConfigured(),
    sessionPersistence: Boolean(persistPath),
  });

  if (!isLlmConfigured()) {
    logger.warn(
      "LLM_API_KEY is not set — the UI will load, but chat requests will return 503 until it is configured.",
    );
  }
  if (!isSearchConfigured()) {
    logger.warn(
      "Tavily is selected but TAVILY_API_KEY is missing — web search will fail until it is configured.",
    );
  }
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });

  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();

  server.close();
  try {
    await store.close();
  } catch (error) {
    logger.warn("failed to flush sessions during shutdown", errorMeta(error));
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", errorMeta(reason));
});
