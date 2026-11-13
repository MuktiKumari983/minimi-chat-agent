import type { Source, TokenUsage } from "../types.js";

/** Real-time events emitted by the agent while a response is generated. */
export type AgentPhase = "thinking" | "searching" | "responding";

export interface AgentStatus {
  phase: AgentPhase;
  message: string;
}

export interface AgentToolEvent {
  id: string;
  name: string;
  status: "started" | "completed" | "failed";
  query?: string;
  provider?: string;
  resultCount?: number;
  cached?: boolean;
  durationMs?: number;
  error?: string;
}

export interface AgentEmitter {
  status(event: AgentStatus): void;
  tool(event: AgentToolEvent): void;
  delta(text: string): void;
}

export interface AgentMetrics {
  totalMs: number;
  llmMs: number;
  toolMs: number;
  toolCalls: number;
  searches: number;
}

export interface AgentResult {
  text: string;
  sources: Source[];
  usage: TokenUsage;
  metrics: AgentMetrics;
  messageId: string;
}
