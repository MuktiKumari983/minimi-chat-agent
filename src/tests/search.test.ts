import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSearchResultsForModel,
  getSearchProvider,
  isSearchConfigured,
  type SearchResponse,
} from "../tools/search.js";

function sampleResponse(): SearchResponse {
  return {
    query: "AI regulation November 2026",
    provider: "tavily",
    foundAt: "2026-11-13T14:32:05.000Z",
    cached: false,
    results: [
      {
        title: "EU AI Act update",
        url: "https://example.com/ai-act",
        snippet: "Regulators published new guidance this week.",
        publishedAt: "Thu, 12 Nov 2026",
        provider: "tavily",
      },
      {
        title: "US policy roundup",
        url: "https://example.org/policy",
        snippet: "A summary of federal activity.",
        provider: "tavily",
      },
    ],
  };
}

test("search results are rendered with titles, URLs and publication dates", () => {
  const output = formatSearchResultsForModel(sampleResponse());

  assert.match(output, /Web search results for "AI regulation November 2026"/);
  assert.match(output, /via tavily/);
  assert.match(output, /EU AI Act update/);
  assert.match(output, /https:\/\/example\.com\/ai-act/);
  assert.match(output, /Published: Thu, 12 Nov 2026/);
  assert.match(output, /US policy roundup/);
});

test("cached responses are labelled", () => {
  const response = { ...sampleResponse(), cached: true };
  assert.match(formatSearchResultsForModel(response), /\(cached\)/);
});

test("empty result sets produce a clear message", () => {
  const response = { ...sampleResponse(), results: [] };
  const output = formatSearchResultsForModel(response);
  assert.match(output, /returned no results/);
  assert.match(output, /broader or differently worded query/);
});

test("output respects the context budget", () => {
  const response = sampleResponse();
  response.results = Array.from({ length: 8 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example.com/${index}`,
    snippet: "x".repeat(500),
    provider: "tavily" as const,
  }));

  const output = formatSearchResultsForModel(response, 1_200);
  assert.ok(output.length <= 1_400, `output was ${output.length} chars`);
  assert.match(output, /omitted for length/);
});

test("search configuration has a valid resolved provider", () => {
  const provider = getSearchProvider();
  assert.ok(provider === "tavily" || provider === "duckduckgo");
  assert.equal(typeof isSearchConfigured(), "boolean");
});
