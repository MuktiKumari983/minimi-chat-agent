/**
 * Shared domain types. Kept framework-agnostic so memory, tools and the agent
 * can be tested independently of Express or the OpenAI SDK.
 */

export type ChatRole = "user" | "assistant";

export interface Source {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  provider: string;
}

export interface StoredMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** ISO-8601 UTC timestamp. The system prompt exposes these to the model. */
  createdAt: string;
  /** Citations attached to assistant answers, used to rehydrate the UI. */
  sources?: Source[];
}

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Last timezone supplied by the client (IANA name), if any. */
  timeZone?: string;
  messages: StoredMessage[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const EMPTY_USAGE: TokenUsage = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});
