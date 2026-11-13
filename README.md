# Minimi Chat Agent

A production-minded conversational agent built with TypeScript, Express, and OpenAI-compatible function calling. It streams answers over SSE, decides for itself when to search the web, cites its sources, and remembers each conversation with timestamped, restart-safe session memory.

## Key Features

- **Temporal awareness** — every request rebuilds the system prompt with the authoritative UTC clock, the browser's IANA local time, session start time, and a timestamped transcript of earlier turns. This lets the model resolve relative dates and answer questions like *"What did I ask you on 3 November?"*.
- **Model-driven web search** — the model chooses when to call the single `web_search` tool. Tavily is used when a key is available; otherwise search gracefully falls back to keyless DuckDuckGo. Results are cached, de-duplicated, and cited inline.
- **Parallel tool execution with loop guards** — tool-call argument fragments are accumulated from the stream, up to four searches run in parallel, and `MAX_TOOL_ITERATIONS` forces a final answer round with tools disabled once the budget is exhausted.
- **Streaming SSE responses** — typed `meta`, `status`, `tool`, `delta`, `done`, and `error` events over a normal POST. First tokens are forwarded immediately; heartbeats keep proxies from closing idle streams.
- **Persistent session memory** — browser-generated session UUIDs, an in-memory store with TTL/LRU caps, and debounced atomic JSON persistence (`data/sessions.json`). History survives reloads and dev-server restarts.
- **Security and validation** — helmet CSP without `unsafe-inline`, escape-first markdown rendering, zod-validated configuration and requests, per-IP rate limiting, body/message size caps, server-side secrets only, and abort-on-disconnect.
- **Dependency-free UI** — vanilla HTML/CSS/JS chat client with streaming text, tool indicators, source cards, copy buttons, error states, and session restore. No frontend build step.

## Quick Start

Requirements: **Node.js >= 20**.

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
npm run dev
```

Open **http://localhost:3000**.

Configure `.env` before chatting:

- **`LLM_API_KEY`** — required. Any OpenAI-compatible provider that supports streaming and tool calling works (OpenAI, Groq, OpenRouter, Together, Ollama, vLLM, …).
- **`LLM_BASE_URL`** and **`LLM_MODEL`** — set these when not using the OpenAI defaults (`https://api.openai.com/v1`, `gpt-4o-mini`).
- **`TAVILY_API_KEY`** — optional. Without it, or if Tavily fails in `auto` mode, search automatically uses keyless DuckDuckGo.

The UI and `/api/health` still load without an LLM key; chat requests return a configuration hint until one is set.

### Production

```bash
npm run build
npm start
```

## Architecture & Project Structure

```text
minimi-chat-agent/
├── src/
│   ├── agent/          # LLM loop, streamed tool calls, temporal system prompt
│   ├── tools/          # web_search: Tavily + DuckDuckGo, cache, retries
│   ├── memory/         # SessionStore: TTL/LRU caps + JSON persistence
│   ├── lib/            # Logger, typed errors, async helpers
│   ├── tests/          # Unit tests for prompt, search, and sessions
│   ├── config.ts       # Zod-validated environment configuration
│   └── index.ts        # Express server, SSE chat endpoint, session API
├── public/             # Vanilla chat UI (HTML, CSS, JS)
├── .env.example        # All configuration options with defaults
├── DESIGN.md           # Architecture decisions, trade-offs, and future work
└── package.json
```

Browser → `POST /api/chat` (SSE) → Express → `ChatAgent` → OpenAI-compatible model + `web_search` → `SessionStore`.

For request lifecycle, design rationale, error handling, and rejected alternatives, see **[DESIGN.md](DESIGN.md)**.

## Available Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the server with hot reload via `tsx watch` on `http://localhost:3000` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server (`node dist/index.js`) |
| `npm run typecheck` | Type-check the full source tree without emitting |
| `npm test` | Run the unit test suite with `node:test` |
