import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { config } from "../config.js";
import { AppError, isAbortError } from "../lib/errors.js";
import { logger, errorMeta } from "../lib/logger.js";
import type { Source } from "../types.js";
import {
  formatSearchResultsForModel,
  performWebSearch,
  toSources,
} from "./search.js";

/**
 * Tool registry.
 *
 * The registry is deliberately tiny: one tool, one schema, one executor. It
 * keeps the model-facing contract (JSON schema + description) next to the
 * implementation so they cannot drift. Adding a tool means adding a definition
 * and a branch here — the agent loop stays unchanged.
 */

export const webSearchTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web for current information. Use for recent news, live prices, sports results, weather, releases, laws, or to verify facts that may have changed. Do not use for math, coding, casual conversation, or stable knowledge.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A short, specific search query. Resolve relative dates to explicit dates/years before searching.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "How many results to return. Defaults to the server setting (usually 5).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export function getToolDefinitions(): ChatCompletionTool[] {
  return [webSearchTool];
}

const searchArgsSchema = z.object({
  query: z.string().trim().min(2).max(400),
  max_results: z.coerce.number().int().min(1).max(10).optional(),
});

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolCallResult {
  id: string;
  name: string;
  ok: boolean;
  content: string;
  sources: Source[];
  query?: string;
  provider?: string;
  resultCount?: number;
  cached?: boolean;
  durationMs: number;
  error?: string;
}

/** Best-effort extraction of display data for the UI before execution. */
export function previewToolCall(rawArgs: string): { query?: string } {
  try {
    const parsed = searchArgsSchema.partial().safeParse(JSON.parse(rawArgs || "{}"));
    if (parsed.success && parsed.data.query) return { query: parsed.data.query };
  } catch {
    // Invalid JSON is handled by the executor; previews are cosmetic.
  }
  return {};
}

/**
 * Execute a model-requested tool call. All failures are converted into tool
 * output so the model can explain the problem and continue the conversation
 * instead of the whole request crashing.
 */
export async function executeToolCall(
  call: ToolCallRequest,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  const startedAt = Date.now();

  if (call.name !== "web_search") {
    logger.warn("model requested an unknown tool", { tool: call.name });
    return {
      id: call.id,
      name: call.name,
      ok: false,
      content: `Tool error: unknown tool "${call.name}". Only web_search is available.`,
      sources: [],
      durationMs: Date.now() - startedAt,
      error: "unknown_tool",
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(call.arguments || "{}");
  } catch {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      content:
        "Tool error: web_search arguments were not valid JSON. Retry with a JSON object containing a `query` string.",
      sources: [],
      durationMs: Date.now() - startedAt,
      error: "invalid_arguments",
    };
  }

  const args = searchArgsSchema.safeParse(parsedJson);
  if (!args.success) {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      content:
        "Tool error: web_search requires a non-empty `query` (2-400 characters) and an optional `max_results` between 1 and 10.",
      sources: [],
      durationMs: Date.now() - startedAt,
      error: "invalid_arguments",
    };
  }

  try {
    const response = await performWebSearch(
      args.data.query,
      args.data.max_results ?? config.search.maxResults,
      signal,
    );

    return {
      id: call.id,
      name: call.name,
      ok: true,
      content: formatSearchResultsForModel(response),
      sources: toSources(response),
      query: response.query,
      provider: response.provider,
      resultCount: response.results.length,
      cached: response.cached,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;

    const message =
      error instanceof AppError
        ? error.message
        : "The search provider is unavailable or returned an unexpected error.";

    logger.warn("web search tool failed", { ...errorMeta(error), query: args.data.query });

    return {
      id: call.id,
      name: call.name,
      ok: false,
      content: `Web search failed: ${message} Answer from your own knowledge only if it is safe to do so, and clearly tell the user the lookup did not succeed.`,
      sources: [],
      query: args.data.query,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  }
}
