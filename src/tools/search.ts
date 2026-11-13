import { setTimeout as sleep } from "node:timers/promises";
import { load } from "cheerio";
import { z } from "zod";
import { config } from "../config.js";
import { ConfigError, SearchError, isAbortError, throwIfAborted } from "../lib/errors.js";
import { logger, errorMeta } from "../lib/logger.js";
import type { Source } from "../types.js";

/**
 * Web search tool.
 *
 * Providers:
 *  1. Tavily  — purpose-built LLM search API, fast, returns clean snippets.
 *  2. DuckDuckGo HTML — keyless fallback. No API key means the project runs
 *     out of the box, which matters for a review environment.
 *
 * Production hardening included here:
 *  - short TTL response cache + in-flight request de-duplication
 *  - per-request timeout and bounded retries with backoff on 429/5xx
 *  - normalised, deduplicated, length-capped results
 *  - automatic Tavily -> DuckDuckGo fallback in `auto` mode
 *  - never throws raw provider errors to the model; failures become tool output
 */

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const MAX_QUERY_CHARS = 400;
const MAX_SNIPPET_CHARS = 700;
const MODEL_CONTEXT_BUDGET = 6_000;

const DDG_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 MinimiChat/1.0",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
};

export type ResolvedSearchProvider = "tavily" | "duckduckgo";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
  provider: ResolvedSearchProvider;
}

export interface SearchResponse {
  query: string;
  provider: ResolvedSearchProvider;
  foundAt: string;
  results: SearchResult[];
  cached: boolean;
}

interface CacheEntry {
  expiresAt: number;
  value: SearchResponse;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SearchResponse>>();

/** Which provider will actually be used for the next search. */
export function getSearchProvider(): ResolvedSearchProvider {
  if (config.search.provider === "tavily") return "tavily";
  if (config.search.provider === "duckduckgo") return "duckduckgo";
  return config.search.tavilyApiKey ? "tavily" : "duckduckgo";
}

export function isSearchConfigured(): boolean {
  return getSearchProvider() !== "tavily" || config.search.tavilyApiKey.length > 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function performWebSearch(
  rawQuery: string,
  maxResults = config.search.maxResults,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  if (!query) throw new SearchError("The search query was empty.");

  const limit = Math.min(Math.max(maxResults, 1), 10);
  const provider = getSearchProvider();
  const cacheKey = `${provider}:${limit}:${query.toLowerCase()}`;

  const cached = readCache(cacheKey);
  if (cached) return cached;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<SearchResponse> => {
    try {
      const response = await runProviderSearch(provider, query, limit, signal);
      writeCache(cacheKey, response);
      return response;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

/** Human/LLM-friendly rendering of search results, bounded to the token budget. */
export function formatSearchResultsForModel(
  response: SearchResponse,
  maxChars = MODEL_CONTEXT_BUDGET,
): string {
  const cachedNote = response.cached ? " (cached)" : "";

  if (response.results.length === 0) {
    return `Web search for "${response.query}" via ${response.provider} returned no results at ${response.foundAt}${cachedNote}. Consider a broader or differently worded query.`;
  }

  let output = `Web search results for "${response.query}" via ${response.provider} at ${response.foundAt}${cachedNote}.`;
  let included = 0;

  for (const [index, result] of response.results.entries()) {
    const published = result.publishedAt ? `\n   Published: ${result.publishedAt}` : "";
    const block = `${index + 1}. ${result.title}\n   URL: ${result.url}${published}\n   ${result.snippet}`;

    if (output.length + block.length + 2 > maxChars) break;
    output += `\n\n${block}`;
    included += 1;
  }

  if (included === 0) {
    output += `\n\n${response.results[0]?.title ?? "Result"} — ${response.results[0]?.url ?? ""}`.slice(
      0,
      maxChars,
    );
  } else if (included < response.results.length) {
    output += `\n\n(${response.results.length - included} more result(s) omitted for length.)`;
  }

  return output;
}

export function toSources(response: SearchResponse): Source[] {
  return response.results.map((result) => ({
    title: result.title,
    url: result.url,
    ...(result.snippet ? { snippet: result.snippet } : {}),
    ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    provider: result.provider,
  }));
}

// ---------------------------------------------------------------------------
// Provider orchestration
// ---------------------------------------------------------------------------

async function runProviderSearch(
  primary: ResolvedSearchProvider,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  if (primary === "tavily") {
    try {
      return await searchWithTavily(query, limit, signal);
    } catch (error) {
      const canFallback = config.search.provider === "auto";
      if (!canFallback || signal?.aborted || isAbortError(error)) throw error;

      logger.warn("Tavily search failed; falling back to DuckDuckGo", errorMeta(error));
      return searchWithDuckDuckGo(query, limit, signal);
    }
  }

  return searchWithDuckDuckGo(query, limit, signal);
}

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

const tavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        content: z.string().nullish(),
        published_date: z.string().nullish(),
        score: z.number().optional(),
      }),
    )
    .default([]),
});

async function searchWithTavily(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const apiKey = config.search.tavilyApiKey;
  if (!apiKey) {
    throw new ConfigError(
      "Tavily is selected but TAVILY_API_KEY is missing. Add it to .env or set SEARCH_PROVIDER=duckduckgo.",
      { code: "search_not_configured" },
    );
  }

  const response = await fetchWithRetry(
    TAVILY_ENDPOINT,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey, // older Tavily deployments expect this in the body
        query,
        search_depth: "basic",
        topic: "general",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        max_results: limit,
      }),
    },
    signal,
  );

  const payload = tavilyResponseSchema.safeParse(await response.json().catch(() => null));
  if (!payload.success) {
    throw new SearchError("Tavily returned an unexpected response format.");
  }

  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const item of payload.data.results) {
    const url = normalizeHttpUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    results.push({
      title: cleanText(item.title) || hostnameOf(url),
      url,
      snippet: truncateText(cleanText(item.content ?? ""), MAX_SNIPPET_CHARS),
      ...(item.published_date ? { publishedAt: item.published_date } : {}),
      ...(typeof item.score === "number" ? { score: item.score } : {}),
      provider: "tavily",
    });

    if (results.length >= limit) break;
  }

  return {
    query,
    provider: "tavily",
    foundAt: new Date().toISOString(),
    results,
    cached: false,
  };
}

// ---------------------------------------------------------------------------
// DuckDuckGo (keyless fallback)
// ---------------------------------------------------------------------------

async function searchWithDuckDuckGo(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  let results: SearchResult[] = [];
  let anySuccess = false;
  let lastError: unknown;

  try {
    const html = await fetchDuckDuckGoHtml(query, signal);
    anySuccess = true;
    results = parseDuckDuckGoHtml(html, limit);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    lastError = error;
    logger.warn("DuckDuckGo HTML endpoint failed", errorMeta(error));
  }

  if (results.length === 0) {
    try {
      const html = await fetchDuckDuckGoLite(query, signal);
      anySuccess = true;
      results = parseDuckDuckGoLite(html, limit);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      lastError = error;
      logger.warn("DuckDuckGo Lite endpoint failed", errorMeta(error));
    }
  }

  if (!anySuccess && lastError) {
    throw lastError instanceof SearchError
      ? lastError
      : new SearchError("DuckDuckGo search failed. Check your network connection.", {
          cause: lastError,
        });
  }

  return {
    query,
    provider: "duckduckgo",
    foundAt: new Date().toISOString(),
    results,
    cached: false,
  };
}

async function fetchDuckDuckGoHtml(query: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchWithRetry(
    DDG_HTML_ENDPOINT,
    {
      method: "POST",
      headers: {
        ...DDG_HEADERS,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
    },
    signal,
  );
  return response.text();
}

async function fetchDuckDuckGoLite(query: string, signal?: AbortSignal): Promise<string> {
  const url = `${DDG_LITE_ENDPOINT}?${new URLSearchParams({ q: query, kl: "wt-wt" }).toString()}`;
  const response = await fetchWithRetry(url, { method: "GET", headers: DDG_HEADERS }, signal);
  return response.text();
}

function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  $(".result").each((_index, element) => {
    if (results.length >= limit) return false;

    const container = $(element);
    const anchor = container.find("a.result__a").first();
    const url = normalizeDdgUrl(anchor.attr("href"));
    const title = cleanText(anchor.text());
    if (!url || !title || seen.has(url)) return;

    seen.add(url);
    results.push({
      title,
      url,
      snippet: truncateText(
        cleanText(container.find(".result__snippet").first().text()),
        MAX_SNIPPET_CHARS,
      ),
      provider: "duckduckgo",
    });
  });

  return results;
}

function parseDuckDuckGoLite(html: string, limit: number): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  $("a.result-link").each((_index, element) => {
    if (results.length >= limit) return false;

    const anchor = $(element);
    const url = normalizeDdgUrl(anchor.attr("href"));
    const title = cleanText(anchor.text());
    if (!url || !title || seen.has(url)) return;

    const row = anchor.closest("tr");
    const snippet = cleanText(row.nextAll("tr").find(".result-snippet").first().text());

    seen.add(url);
    results.push({
      title,
      url,
      snippet: truncateText(snippet, MAX_SNIPPET_CHARS),
      provider: "duckduckgo",
    });
  });

  return results;
}

function normalizeDdgUrl(href: string | undefined): string | null {
  if (!href) return null;

  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const wrapped = parsed.searchParams.get("uddg");
    if (wrapped) return normalizeHttpUrl(decodeURIComponent(wrapped));
    if (parsed.hostname.endsWith("duckduckgo.com")) return null; // ads/navigation
    return normalizeHttpUrl(parsed.toString());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  attempts = 2,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal);

    const timeout = AbortSignal.timeout(config.search.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const response = await fetch(url, { ...init, signal: combined });
      if (response.ok) return response;

      const detail = cleanText(await response.text().catch(() => "")).slice(0, 200);
      lastError = new SearchError(
        `Search provider returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`,
        { code: "search_http_error" },
      );

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts - 1) throw lastError;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new SearchError(
          `Search request timed out after ${Math.round(config.search.timeoutMs / 1000)}s.`,
          { code: "search_timeout", cause: error },
        );
      }
      if (error instanceof SearchError) throw error;

      lastError = error;
      if (attempt === attempts - 1) break;
    }

    await sleep(300 * (attempt + 1), undefined, { signal });
  }

  throw lastError instanceof SearchError
    ? lastError
    : new SearchError("The search request failed. Check your network connection.", {
        cause: lastError,
      });
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readCache(key: string): SearchResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  // Refresh insertion order for an LRU-ish eviction policy.
  cache.delete(key);
  cache.set(key, entry);

  return { ...entry.value, cached: true };
}

function writeCache(key: string, value: SearchResponse): void {
  if (config.search.cacheTtlMs <= 0) return;

  cache.set(key, {
    expiresAt: Date.now() + config.search.cacheTtlMs,
    value,
  });

  while (cache.size > config.search.cacheMaxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function normalizeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}
