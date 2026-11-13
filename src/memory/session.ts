import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger, errorMeta } from "../lib/logger.js";
import type { Session, Source, StoredMessage } from "../types.js";

/**
 * In-process session memory with optional debounced, atomic disk persistence.
 *
 * Why this design?
 * - A hiring-challenge agent runs as a single Node process. A Map is the
 *   fastest possible store and keeps the critical path allocation-free.
 * - Sessions must survive a dev-server restart (`tsx watch` reloads on every
 *   file save!), so mutations are snapshot-persisted to JSON. Writes are
 *   debounced and atomic (tmp file + rename) to avoid corrupting the file.
 * - TTL + LRU-ish caps prevent unbounded memory growth in a long-lived process.
 *
 * Scaling note: for multi-instance deployments replace this class with a Redis
 * backed implementation behind the same small surface (getOrCreate/append/get).
 */

export interface SessionStoreOptions {
  ttlMs: number;
  maxSessions: number;
  maxMessagesPerSession: number;
  /** Absolute path, or null/undefined to keep memory only. */
  persistPath?: string | null;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id);
}

interface PersistedShape {
  version: 1;
  savedAt: string;
  sessions: Session[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<StoredMessage>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string" &&
    typeof m.createdAt === "string"
  );
}

function isStoredSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<Session>;
  return (
    isValidSessionId(s.id) &&
    typeof s.createdAt === "string" &&
    typeof s.updatedAt === "string" &&
    Array.isArray(s.messages) &&
    s.messages.every(isStoredMessage)
  );
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly options: SessionStoreOptions;
  private cleanupTimer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  private writing = false;
  private dirty = false;
  private initialized = false;

  constructor(options: SessionStoreOptions) {
    this.options = options;
  }

  /** Load persisted state and start the TTL sweeper. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.loadFromDisk();
    this.pruneAll();

    const interval = Math.max(60_000, Math.min(this.options.ttlMs, 600_000));
    this.cleanupTimer = setInterval(() => this.pruneAll(), interval);
    this.cleanupTimer.unref?.();
  }

  /**
   * Return an existing session or create one. The browser generates a UUID
   * before its first message, so accepting a client-supplied valid id keeps
   * the session stable across reloads even before it exists server-side.
   */
  getOrCreate(id?: string, timeZone?: string): Session {
    let session = id ? this.sessions.get(id) : undefined;

    if (!session) {
      const sessionId = isValidSessionId(id) ? id : randomUUID();
      const timestamp = nowIso();
      session = {
        id: sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
        ...(timeZone ? { timeZone } : {}),
      };
      this.sessions.set(sessionId, session);
      this.enforceMaxSessions();
    }

    if (timeZone && session.timeZone !== timeZone) session.timeZone = timeZone;
    this.touch(session, true);
    return session;
  }

  /** Read a session without creating one. Reading extends its TTL. */
  get(id: string): Session | undefined {
    if (!isValidSessionId(id)) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.touch(session, true);
    return session;
  }

  getMessages(id: string): readonly StoredMessage[] {
    return this.sessions.get(id)?.messages ?? [];
  }

  appendUserMessage(sessionId: string, content: string): StoredMessage {
    const session = this.getOrCreate(sessionId);
    const message: StoredMessage = {
      id: randomUUID(),
      role: "user",
      content,
      createdAt: nowIso(),
    };
    session.messages.push(message);
    this.trimMessages(session);
    this.touch(session, true);
    return message;
  }

  appendAssistantMessage(sessionId: string, content: string, sources?: Source[]): StoredMessage {
    const session = this.getOrCreate(sessionId);
    const message: StoredMessage = {
      id: randomUUID(),
      role: "assistant",
      content,
      createdAt: nowIso(),
      ...(sources && sources.length > 0 ? { sources } : {}),
    };
    session.messages.push(message);
    this.trimMessages(session);
    this.touch(session, true);
    return message;
  }

  delete(id: string): boolean {
    if (!isValidSessionId(id)) return false;
    const removed = this.sessions.delete(id);
    if (removed) this.schedulePersist();
    return removed;
  }

  /** Flush pending writes and stop timers. Call during graceful shutdown. */
  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.cleanupTimer = undefined;
    this.persistTimer = undefined;
    await this.persistNow();
  }

  /** Persist immediately (useful in tests and shutdown). */
  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.persistNow();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private touch(session: Session, persist: boolean): void {
    session.updatedAt = nowIso();
    if (persist) this.schedulePersist();
  }

  private trimMessages(session: Session): void {
    const max = this.options.maxMessagesPerSession;
    if (session.messages.length > max) {
      session.messages.splice(0, session.messages.length - max);
    }
  }

  private enforceMaxSessions(): void {
    while (this.sessions.size > this.options.maxSessions) {
      let oldestId: string | undefined;
      let oldestUpdated = Number.POSITIVE_INFINITY;
      for (const session of this.sessions.values()) {
        const updated = Date.parse(session.updatedAt);
        if (updated < oldestUpdated) {
          oldestUpdated = updated;
          oldestId = session.id;
        }
      }
      if (!oldestId) break;
      this.sessions.delete(oldestId);
    }
  }

  private pruneAll(): void {
    const cutoff = Date.now() - this.options.ttlMs;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.updatedAt) < cutoff) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      logger.debug("pruned expired sessions", { removed, remaining: this.sessions.size });
      this.schedulePersist();
    }
  }

  private schedulePersist(delayMs = 400): void {
    if (!this.options.persistPath) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistNow();
    }, delayMs);
    this.persistTimer.unref?.();
  }

  private async persistNow(): Promise<void> {
    const target = this.options.persistPath;
    if (!target) return;

    if (this.writing) {
      this.dirty = true;
      return;
    }

    this.writing = true;
    this.dirty = false;

    try {
      const payload: PersistedShape = {
        version: 1,
        savedAt: nowIso(),
        sessions: [...this.sessions.values()],
      };
      const directory = path.dirname(target);
      await mkdir(directory, { recursive: true });

      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(payload), "utf8");
      try {
        await rename(tmp, target);
      } catch {
        // Windows can refuse to replace an existing destination; fall back.
        await rm(target, { force: true });
        await rename(tmp, target);
      }
    } catch (error) {
      logger.warn("failed to persist sessions", errorMeta(error));
    } finally {
      this.writing = false;
      if (this.dirty) {
        this.dirty = false;
        this.schedulePersist(100);
      }
    }
  }

  private async loadFromDisk(): Promise<void> {
    const target = this.options.persistPath;
    if (!target) return;

    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn("failed to read persisted sessions", errorMeta(error));
      }
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedShape> | unknown[];
      const sessions = Array.isArray(parsed) ? parsed : parsed.sessions;
      if (!Array.isArray(sessions)) return;

      let loaded = 0;
      for (const candidate of sessions) {
        if (!isStoredSession(candidate)) continue;
        const session: Session = {
          ...candidate,
          messages: candidate.messages.slice(-this.options.maxMessagesPerSession),
        };
        this.sessions.set(session.id, session);
        loaded += 1;
      }
      this.enforceMaxSessions();
      logger.info("loaded persisted sessions", { count: loaded });
    } catch (error) {
      logger.warn("ignoring corrupt session file", errorMeta(error));
    }
  }
}
