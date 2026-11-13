import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { config } from "../config.js";
import { AppError, AgentError, ConfigError, isAbortError } from "../lib/errors.js";
import { mapWithConcurrency, truncate } from "../lib/async.js";
import { logger, errorMeta } from "../lib/logger.js";
import { SessionStore } from "../memory/session.js";
import { executeToolCall, getToolDefinitions, previewToolCall } from "../tools/index.js";
import { buildSystemPrompt, resolveTimeZone } from "./prompt.js";
import type { AgentEmitter, AgentResult, AgentToolEvent } from "./types.js";
import type { Source, TokenUsage } from "../types.js";

/**
 * The agent loop: stream an LLM response; if the model asks for tools, execute
 * them (in parallel) and continue; otherwise finish.
 *
 * Key implementation details:
 * - Streaming is preserved across tool rounds. OpenAI-compatible providers
 *   stream tool-call fragments, which we accumulate by index.
 * - Tool results are appended as `role: "tool"` messages, then the model is
 *   called again. Up to MAX_TOOL_ITERATIONS rounds; a final "no tools" round
 *   guarantees a natural-language answer even if the model keeps searching.
 * - Any text emitted before a tool call stays visible (models often say
 *   "Let me check that"), and rounds are separated by a blank line.
 * - Provider errors are translated into safe AppErrors and partial output is
 *   preserved for the UI.
 */

const MAX_PARALLEL_TOOL_CALLS = 4;
const HISTORY_MESSAGE_CHAR_LIMIT = 8_000;
const EMPTY_RESPONSE =
  "I'm sorry — I couldn't produce an answer. Please try rephrasing the question or ask again.";

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface StreamRoundResult {
  content: string;
  toolCalls: AccumulatedToolCall[];
  usage?: TokenUsage;
}

interface StreamRoundOptions {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  toolsEnabled: boolean;
  /** Emitted before the first content token (blank line between rounds). */
  prefix: string;
  signal: AbortSignal;
  emit: AgentEmitter;
}

export interface RunAgentInput {
  sessionId: string;
  userMessage: string;
  timeZone?: string;
  signal: AbortSignal;
  emit: AgentEmitter;
}

export class ChatAgent {
  private readonly store: SessionStore;
  private client: OpenAI | null = null;
  private streamUsageSupported = config.llm.streamUsage;

  constructor(store: SessionStore) {
    this.store = store;
  }

  async run(input: RunAgentInput): Promise<AgentResult> {
    const startedAt = Date.now();
    const now = new Date();

    const session = this.store.getOrCreate(input.sessionId, input.timeZone);
    const userMessage = this.store.appendUserMessage(session.id, input.userMessage);
    const priorMessages = session.messages.filter((message) => message.id !== userMessage.id);

    const timeZone = resolveTimeZone(input.timeZone ?? session.timeZone);
    const systemPrompt = buildSystemPrompt({
      now,
      timeZone,
      sessionCreatedAt: session.createdAt,
      timelineMessages: priorMessages,
      model: config.llm.model,
      timelineOptions: {
        maxEntries: config.agent.timelineMaxEntries,
        maxChars: config.agent.timelineMaxChars,
      },
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...this.toHistory(priorMessages),
      { role: "user", content: input.userMessage },
    ];

    const sourcesByUrl = new Map<string, Source>();
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    let visibleText = "";
    let llmMs = 0;
    let toolMs = 0;
    let toolCalls = 0;
    let searches = 0;
    let budgetNoticeAdded = false;
    let round = 0;

    try {
      while (true) {
        const toolsEnabled = round < config.agent.maxToolIterations;

        if (!toolsEnabled && !budgetNoticeAdded) {
          budgetNoticeAdded = true;
          messages.push({
            role: "system",
            content:
              "The tool-use budget is exhausted. Do not call any more tools. Answer now using the conversation and any search results already provided. Be explicit if information is missing.",
          });
        }

        input.emit.status({
          phase: "thinking",
          message:
            round === 0
              ? "Thinking…"
              : toolsEnabled
                ? "Reviewing the information…"
                : "Writing the final answer…",
        });

        const roundStartedAt = Date.now();
        const result = await this.streamRound({
          messages,
          toolsEnabled,
          prefix: visibleText.trim().length > 0 ? "\n\n" : "",
          signal: input.signal,
          emit: input.emit,
        });
        llmMs += Date.now() - roundStartedAt;

        if (result.usage) addUsage(usage, result.usage);
        visibleText += result.content;

        if (result.toolCalls.length === 0 || !toolsEnabled) {
          if (!toolsEnabled && result.toolCalls.length > 0) {
            logger.warn("model requested tools after budget was exhausted", {
              sessionId: session.id,
              toolCalls: result.toolCalls.length,
            });
          }
          return this.finalize({
            sessionId: session.id,
            visibleText,
            sources: [...sourcesByUrl.values()],
            usage,
            startedAt,
            llmMs,
            toolMs,
            toolCalls,
            searches,
            emit: input.emit,
          });
        }

        // Record the assistant's tool-call turn verbatim so the next completion
        // has a valid transcript (required by the chat-completions protocol).
        messages.push({
          role: "assistant",
          content: result.content.trim() ? result.content : null,
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments || "{}" },
          })),
        });

        input.emit.status({
          phase: "searching",
          message:
            result.toolCalls.length > 1
              ? `Searching the web (${result.toolCalls.length} queries)…`
              : "Searching the web…",
        });

        for (const call of result.toolCalls) {
          const preview = previewToolCall(call.arguments);
          const event: AgentToolEvent = {
            id: call.id,
            name: call.name,
            status: "started",
            ...(preview.query ? { query: preview.query } : {}),
          };
          input.emit.tool(event);
        }

        const toolResults = await mapWithConcurrency(
          result.toolCalls,
          MAX_PARALLEL_TOOL_CALLS,
          (call) => executeToolCall(call, input.signal),
        );

        for (const toolResult of toolResults) {
          toolCalls += 1;
          toolMs += toolResult.durationMs;
          if (toolResult.name === "web_search") searches += 1;

          input.emit.tool({
            id: toolResult.id,
            name: toolResult.name,
            status: toolResult.ok ? "completed" : "failed",
            ...(toolResult.query ? { query: toolResult.query } : {}),
            ...(toolResult.provider ? { provider: toolResult.provider } : {}),
            ...(typeof toolResult.resultCount === "number"
              ? { resultCount: toolResult.resultCount }
              : {}),
            ...(typeof toolResult.cached === "boolean" ? { cached: toolResult.cached } : {}),
            durationMs: toolResult.durationMs,
            ...(toolResult.error ? { error: toolResult.error } : {}),
          });

          for (const source of toolResult.sources) {
            if (!sourcesByUrl.has(source.url)) sourcesByUrl.set(source.url, source);
          }

          messages.push({
            role: "tool",
            tool_call_id: toolResult.id,
            content: toolResult.content,
          });
        }

        round += 1;
      }
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) throw error;

      logger.error("agent run failed", {
        sessionId: session.id,
        round,
        ...errorMeta(error),
      });

      const friendly = friendlyLlmError(error);
      throw new AgentError(friendly.message, {
        status: friendly.status,
        code: friendly.code,
        cause: error,
        partialText: visibleText.trim() || undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Streaming / OpenAI plumbing
  // -------------------------------------------------------------------------

  private async streamRound(options: StreamRoundOptions): Promise<StreamRoundResult> {
    const client = this.getClient();

    const buildParams = (
      includeUsage: boolean,
    ): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming => ({
      model: config.llm.model,
      messages: options.messages,
      temperature: config.llm.temperature,
      stream: true,
      ...(options.toolsEnabled
        ? { tools: getToolDefinitions(), tool_choice: "auto" as const }
        : { tool_choice: "none" as const }),
      ...(config.llm.maxOutputTokens > 0 ? { max_tokens: config.llm.maxOutputTokens } : {}),
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    });

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create(buildParams(this.streamUsageSupported), {
        signal: options.signal,
      });
    } catch (error) {
      // Some OpenAI-compatible servers reject `stream_options`. Retry once
      // without usage reporting rather than failing the whole conversation.
      if (this.streamUsageSupported && isStreamOptionsUnsupported(error)) {
        this.streamUsageSupported = false;
        logger.warn("LLM provider rejected stream_options; retrying without token usage", {
          model: config.llm.model,
        });
        stream = await client.chat.completions.create(buildParams(false), {
          signal: options.signal,
        });
      } else {
        throw error;
      }
    }

    let content = "";
    let contentStarted = false;
    let usage: TokenUsage | undefined;
    const toolCallParts = new Map<number, AccumulatedToolCall>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;

      if (delta?.content) {
        if (!contentStarted) {
          contentStarted = true;
          if (options.prefix) {
            content += options.prefix;
            options.emit.delta(options.prefix);
          }
        }
        content += delta.content;
        options.emit.delta(delta.content);
      }

      for (const part of delta?.tool_calls ?? []) {
        const index = part.index ?? 0;
        let current = toolCallParts.get(index);
        if (!current) {
          current = { id: "", name: "", arguments: "" };
          toolCallParts.set(index, current);
        }
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name = part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
      }

      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        };
      }
    }

    const toolCalls = [...toolCallParts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id || randomUUID(),
        name: call.name,
        arguments: call.arguments,
      }))
      .filter((call) => call.name.length > 0);

    return { content, toolCalls, usage };
  }

  private getClient(): OpenAI {
    if (!config.llm.apiKey) {
      throw new ConfigError(
        "The chat model is not configured. Add LLM_API_KEY to your .env file and restart the server.",
        { code: "llm_not_configured" },
      );
    }

    if (!this.client) {
      this.client = new OpenAI({
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl,
        timeout: config.llm.timeoutMs,
        maxRetries: config.llm.maxRetries,
      });
    }

    return this.client;
  }

  private toHistory(messages: readonly { role: "user" | "assistant"; content: string }[]) {
    const recent = messages.slice(-config.agent.maxHistoryMessages);
    return recent.map((message): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      const content = truncate(message.content, HISTORY_MESSAGE_CHAR_LIMIT);
      return message.role === "user"
        ? { role: "user", content }
        : { role: "assistant", content };
    });
  }

  private finalize(input: {
    sessionId: string;
    visibleText: string;
    sources: Source[];
    usage: TokenUsage;
    startedAt: number;
    llmMs: number;
    toolMs: number;
    toolCalls: number;
    searches: number;
    emit: AgentEmitter;
  }): AgentResult {
    const text = input.visibleText.trim() || EMPTY_RESPONSE;
    const stored = this.store.appendAssistantMessage(input.sessionId, text, input.sources);
    const metrics = {
      totalMs: Date.now() - input.startedAt,
      llmMs: input.llmMs,
      toolMs: input.toolMs,
      toolCalls: input.toolCalls,
      searches: input.searches,
    };

    logger.info("agent run completed", {
      sessionId: input.sessionId,
      totalMs: metrics.totalMs,
      llmMs: metrics.llmMs,
      toolMs: metrics.toolMs,
      toolCalls: metrics.toolCalls,
      searches: metrics.searches,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      sourceCount: input.sources.length,
    });

    return {
      text,
      sources: input.sources,
      usage: input.usage,
      metrics,
      messageId: stored.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addUsage(total: TokenUsage, increment: TokenUsage): void {
  total.promptTokens += increment.promptTokens;
  total.completionTokens += increment.completionTokens;
  total.totalTokens += increment.totalTokens;
}

function isStreamOptionsUnsupported(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIError &&
    error.status === 400 &&
    /stream_options|stream options/i.test(error.message)
  );
}

interface FriendlyError {
  status: number;
  code: string;
  message: string;
}

function friendlyLlmError(error: unknown): FriendlyError {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
  }

  if (error instanceof OpenAI.APIError) {
    const status = error.status;

    if (status === 401 || status === 403) {
      return {
        status: 502,
        code: "llm_auth_failed",
        message:
          "The language model provider rejected the API key. Check LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL.",
      };
    }
    if (status === 404) {
      return {
        status: 502,
        code: "llm_model_not_found",
        message: `The provider could not find the configured model "${config.llm.model}". Check LLM_MODEL and LLM_BASE_URL.`,
      };
    }
    if (status === 429) {
      return {
        status: 429,
        code: "llm_rate_limited",
        message:
          "The language model provider is rate limiting requests. Please wait a moment and try again.",
      };
    }
    if (status === 400) {
      return {
        status: 502,
        code: "llm_bad_request",
        message: `The model provider rejected the request: ${truncate(error.message, 300)}`,
      };
    }
    if (typeof status === "number" && status >= 500) {
      return {
        status: 502,
        code: "llm_provider_error",
        message: "The language model provider is temporarily unavailable. Please try again.",
      };
    }
    return {
      status: 502,
      code: "llm_error",
      message: "The language model provider returned an error. Please try again.",
    };
  }

  if (error instanceof Error && /timeout|timed out/i.test(error.message)) {
    return {
      status: 504,
      code: "llm_timeout",
      message: "The language model took too long to respond. Please try again.",
    };
  }

  return {
    status: 502,
    code: "agent_error",
    message: "Something went wrong while generating the answer. Please try again.",
  };
}
