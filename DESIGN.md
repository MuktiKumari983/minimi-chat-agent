# Minimi Chat Agent — Design

A production-minded chat agent built with TypeScript, Express, OpenAI-compatible function calling, and live web search. It streams answers token-by-token, decides for itself when to search, cites what it used, and keeps a timestamped, restart-safe memory of each session.

---

## Quick start

```bash
npm install
cp .env.example .env      # add LLM_API_KEY (Tavily optional)
npm run dev               # http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

Required: `LLM_API_KEY` for any OpenAI-compatible chat model that supports streaming + tool calling.
Optional: `TAVILY_API_KEY`. Without it, search automatically falls back to keyless DuckDuckGo.

Verification: `npm run typecheck`, `npm test`, `npm run build`.

---

## Architecture

```
Browser (vanilla JS, no build step)
  │  POST /api/chat  { sessionId, message, timeZone }
  │  <── SSE: meta · status · tool · delta · done · error
  ▼
Express server (src/index.ts)
  ├── helmet CSP, compression, rate limiting, zod validation
  ├── SessionStore            src/memory/session.ts
  │     in-memory Map + TTL/LRU caps + debounced atomic JSON persistence
  ├── ChatAgent               src/agent/core.ts
  │     ├── buildSystemPrompt src/agent/prompt.ts  (clock + timezone + timeline)
  │     ├── OpenAI-compatible streaming + tool-call accumulation
  │     └── web_search tool   src/tools/search.ts
  │           Tavily ──fallback──▶ DuckDuckGo HTML/Lite
  │           TTL cache + in-flight de-dupe + timeout/retry
  └── static UI               public/*
```

### Request lifecycle

1. Client sends the new message with its browser IANA timezone and persistent session id.
2. Server validates the payload, checks configuration, and opens an SSE stream immediately.
3. `SessionStore` appends the user turn with a UTC timestamp.
4. The system prompt is rebuilt with the authoritative UTC clock, the user's local time/date, and a timestamped transcript of earlier turns.
5. The model streams. Text deltas are forwarded to the browser as `delta` events.
6. If the model emits tool calls, the server accumulates the streamed argument fragments, emits `tool started`, executes searches in parallel (max 4), appends `role: "tool"` results, and loops.
7. When the model answers without a tool call — or the tool budget is exhausted after one final no-tools round — the assistant turn is persisted and a `done` event carries final text, sources, usage, and timings.
8. If the client disconnects, the `AbortController` cancels the model/search request and nothing partial is committed to memory.

---

## Key design decisions

### 1. Dynamic temporal prompt, per request

Every request rebuilds the system prompt with:

- UTC instant (human-readable + ISO)
- User-local instant derived from the client's IANA timezone (with server fallback)
- Local ISO date, UTC offset, session start time
- A timestamped timeline of earlier turns (`2026-11-03 09:15:22 UTC | user: …`)

Why the timeline is separate from chat history: OpenAI-style message history has no timestamps, so a model cannot answer *"What did I ask you on 3 November?"* from raw history alone. The timeline duplicates recent turns deliberately; it is capped by entries and characters, so token cost stays bounded.

Relative dates are resolved against this clock, not the model's training cutoff. Prompts also instruct the model to state assumptions when a date is ambiguous and to re-verify time-sensitive earlier answers with search.

**Trade-off:** a per-request clock defeats provider prompt caching. Correctness and freshness win for a conversational agent. Rejected: injecting the date only once at session start (wrong after midnight).

### 2. SSE over POST, not WebSockets

Chat is one-way streaming. SSE gives HTTP/1.1 compatibility, works through proxies/CDNs, needs no custom reconnect protocol, and is trivially proxied by the existing Express server. The browser uses `fetch()` + `ReadableStream` so the request can be a normal POST with a session id and timezone.

Events are small and typed: `meta`, `status`, `tool`, `delta`, `done`, `error`. Heartbeat comments every 15s keep intermediaries from closing a quiet connection while the model is thinking. Compression is explicitly disabled for `/api/chat` so tokens are not buffered.

Rejected: WebSockets (bidirectional machinery unused, harder to secure), plain long-polling (higher latency).

### 3. Tool use is model-driven, with a budget

The model sees one JSON-schema tool, `web_search`. It chooses when to call it. The prompt gives explicit triggers (news, prices, schedules, changed facts, verification requests, explicit "look it up") and non-triggers (math, coding, stable facts, casual chat). Several calls can run in parallel; there is a configurable iteration cap, after which the model gets one final round with tools disabled and an instruction to answer with what it has.

Rejected: always searching (slow, wasteful, noisy), regex-based intent routing (brittle), letting the client execute tools (leaks API keys, breaks session memory).

### 4. Search provider abstraction with graceful degradation

`SEARCH_PROVIDER=auto` uses Tavily when a key exists, otherwise DuckDuckGo. If Tavily fails in auto mode (rate limit, outage, invalid key), the search falls back to DuckDuckGo. Explicit `tavily`/`duckduckgo` modes do not silently fall back.

Both adapters share the same result shape. Results are normalised, de-duplicated, capped, and rendered with title, URL, publication date, and snippet. A short TTL cache plus in-flight de-duplication avoids duplicate provider calls for repeated/parallel queries. Timeouts are enforced per request; 429/5xx responses get bounded exponential backoff.

The model is instructed to cite exact URLs inline and never invent sources. The UI additionally renders a "Sources" card grid from structured results, so citations remain usable even if the model forgets a link.

Rejected: scraping arbitrary result pages (SSRF and parsing risk), returning raw provider JSON to the model (token bloat), a paid search dependency with no fallback (demo fragility).

### 5. Memory: fast in-process store, durable enough for a single node

Sessions live in a `Map` for zero-latency reads. Mutations are snapshot-persisted to `data/sessions.json` with a ~400ms debounce and atomic tmp-file + rename. TTL pruning, max sessions, and max messages per session bound memory. The browser generates the session UUID, so history survives reloads *and* dev-server restarts (`tsx watch`).

**Trade-off:** JSON snapshots are not multi-instance safe. For horizontal scale, swap `SessionStore` for Redis or Postgres behind the same small interface. Rejected for this scope: a database dependency (slower onboarding), no persistence at all (loses the core demo of recalling 3 November), cookies-only memory (cannot survive reload cleanly).

### 6. Streaming tool calls are accumulated, not guessed

Providers stream tool-call fragments: ids/names arrive once, arguments arrive in pieces, keyed by index. The agent accumulates by index, then builds a valid assistant `tool_calls` message and appends each tool result. This preserves protocol correctness across multi-round tool use. If a provider rejects `stream_options`, the agent retries once without usage reporting instead of failing the conversation.

### 7. Safety and operations

- **CSP** without `unsafe-inline`; all JS/CSS served same-origin.
- **Markdown is escaped first**, then a small subset is formatted. Model output cannot inject HTML; links are restricted to `http(s)`; code blocks are escaped.
- **Server-side secrets only.** The browser never sees provider keys.
- **Validation & limits:** zod request schema, 256kb body cap, 8k message cap, session-id regex, per-IP rate limiting.
- **Errors are typed:** `AppError` carries an HTTP status, stable code, and safe message. Provider auth/rate-limit/model errors are translated; raw provider bodies only reach logs.
- **Partial output survives failure:** streamed text stays visible with an error card, and the agent includes `partialText` in the error event.
- **Abort on disconnect** stops billing and search work.

---

## Error handling matrix

| Failure | Behaviour |
| --- | --- |
| Missing `LLM_API_KEY` | UI still loads; health shows red; chat returns 503 with a setup hint |
| LLM 401/403 | 502 `llm_auth_failed` with key/model hint |
| LLM 404 | 502 `llm_model_not_found`, model name included |
| LLM 429 / 5xx / timeout | 429 / 502 / 504 with retry guidance |
| Search provider failure | Tool returns an error string; model explains the failed lookup and continues |
| Tavily outage in `auto` mode | Automatic DuckDuckGo fallback |
| Invalid tool args / unknown tool | Tool error result; model can retry or answer |
| Client disconnect | Abort signal; no assistant turn persisted |
| Tool budget exhausted | Final no-tools round; explicit note if information is missing |

---

## Performance notes

- First token is forwarded immediately; no buffering.
- Search cache + in-flight de-duplication; parallel tool calls.
- History and timeline are character-capped; search output is capped at ~6k chars.
- Static assets get long cache headers in production; SSE bypasses compression.
- Rate limiting, body limits, and session caps prevent accidental resource blowups.

---

## Testing

`npm test` covers the highest-risk pure logic:

- UTC/local time formatting, invalid timezone fallback
- timeline timestamps, budgets, omission reporting
- system-prompt temporal grounding
- session append/trim, disk persistence round-trip, deletion
- search-result rendering, cached labels, empty results, context budget

`npm run typecheck` type-checks the full source tree, and `npm run build` produces `dist/` for `npm start`.

---

## Configuration reference

See `.env.example`. The important ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_API_KEY` | — | Required for chat |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `LLM_MODEL` | `gpt-4o-mini` | Must support tools + streaming |
| `SEARCH_PROVIDER` | `auto` | `auto` / `tavily` / `duckduckgo` |
| `TAVILY_API_KEY` | — | Enables Tavily |
| `MAX_TOOL_ITERATIONS` | `4` | Search rounds before forced answer |
| `MAX_HISTORY_MESSAGES` | `24` | Raw history sent to the model |
| `SESSION_TTL_MINUTES` | `1440` | Idle session expiry |
| `PERSIST_SESSIONS` | `true` | JSON persistence |
| `RATE_LIMIT_MAX_REQUESTS` | `30` | Per-IP per window |

---

## Deliberately rejected alternatives

- **React/Vite frontend** — a dependency-free static client starts faster, has no build step, and keeps the review surface small. The UI still streams, renders markdown, restores history, and shows tool/error/loading states.
- **LangChain / agent frameworks** — the loop is ~200 lines and fully observable. Frameworks would hide the exact tool-call/streaming semantics this task is evaluating.
- **Vector memory / RAG** — useful for long-term personalization, unnecessary for one session; adds embeddings cost and failure modes. The timestamped timeline covers the required recall behaviour.
- **Database** — a single-node JSON snapshot is appropriate for the scope and keeps `npm run dev` zero-setup. Redis/Postgres is the documented scale path.
- **Auth / multi-tenancy** — out of scope; session ids are unguessable UUIDs, but production would add user auth and ownership checks.
- **Streaming JSON tool arguments directly to the client** — leaks internal protocol and complicates the UI; the client only needs user-facing status.

---

## Future improvements

1. Redis-backed sessions and distributed rate limiting for multi-instance deployment.
2. User accounts, ownership checks, and encrypted session storage.
3. Summarise old turns instead of dropping them; hybrid semantic + recency memory.
4. Search result reranking and source-quality scoring; domain allow/deny lists.
5. Native provider adapters (Brave, Serper, Google CSE) behind the same interface.
6. Eval harness for tool-selection accuracy, citation correctness, and temporal reasoning.
7. OpenTelemetry traces + dashboards for latency, token spend, and search hit rate.
8. Prompt/response caching where compatible (stable prefix + volatile clock suffix).
9. Follow-up suggestion chips generated from the last answer.
10. File/document ingestion and multi-tool workflows (calendar, email, code execution).
