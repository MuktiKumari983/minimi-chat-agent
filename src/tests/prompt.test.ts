import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSystemPrompt,
  getTemporalContext,
  renderTimeline,
  resolveTimeZone,
  toUtcStamp,
} from "../agent/prompt.js";
import type { StoredMessage } from "../types.js";

const NOW = new Date("2026-11-13T14:32:05.000Z");

test("temporal context exposes UTC and the user's local clock", () => {
  const context = getTemporalContext(NOW, "Asia/Kolkata");

  assert.equal(context.utcHuman, "Friday, November 13, 2026 at 14:32:05 UTC");
  assert.equal(context.localHuman, "Friday, November 13, 2026 at 20:02:05");
  assert.equal(context.localDateIso, "2026-11-13");
  assert.match(context.utcOffset, /GMT\+05:30/);
  assert.equal(context.timeZone, "Asia/Kolkata");
});

test("invalid timezones fall back safely", () => {
  const zone = resolveTimeZone("Not/ARealZone");
  assert.ok(zone.length > 0);
  assert.doesNotThrow(() => getTemporalContext(NOW, zone));
});

test("timeline includes timestamps, roles and content", () => {
  const messages: StoredMessage[] = [
    {
      id: "m1",
      role: "user",
      content: "What is the best time to visit Kyoto?\nI am planning a trip.",
      createdAt: "2026-11-03T09:15:22.000Z",
    },
    {
      id: "m2",
      role: "assistant",
      content: "Spring and autumn are the most popular seasons.",
      createdAt: "2026-11-03T09:15:40.000Z",
    },
  ];

  const timeline = renderTimeline(messages);
  assert.match(timeline, /2026-11-03 09:15:22 UTC \| user/);
  assert.match(timeline, /2026-11-03 09:15:40 UTC \| assistant/);
  assert.match(timeline, /Kyoto/);
  assert.match(timeline, /Spring and autumn/);
});

test("timeline respects the entry budget and reports omissions", () => {
  const messages: StoredMessage[] = Array.from({ length: 10 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
    createdAt: `2026-11-0${(index % 9) + 1}T10:00:00.000Z`,
  }));

  const timeline = renderTimeline(messages, { maxEntries: 3 });
  assert.match(timeline, /7 earlier turn\(s\) omitted/);
  assert.match(timeline, /message 9/);
  assert.doesNotMatch(timeline, /message 0/);
});

test("system prompt is temporally grounded and carries the conversation timeline", () => {
  const prompt = buildSystemPrompt({
    now: NOW,
    timeZone: "Asia/Kolkata",
    sessionCreatedAt: "2026-11-01T08:00:00.000Z",
    model: "test-model",
    timelineMessages: [
      {
        id: "m1",
        role: "user",
        content: "What did you recommend for flights?",
        createdAt: "2026-11-03T09:15:22.000Z",
      },
    ],
  });

  assert.match(prompt, /Current time \(authoritative\)/);
  assert.match(prompt, /Friday, November 13, 2026 at 14:32:05 UTC/);
  assert.match(prompt, /Friday, November 13, 2026 at 20:02:05/);
  assert.match(prompt, /Asia\/Kolkata, GMT\+05:30/);
  assert.match(prompt, /2026-11-13/);
  assert.match(prompt, /web_search/);
  assert.match(prompt, /still correct/);
  assert.match(prompt, /2026-11-03 09:15:22 UTC \| user/);
});

test("UTC stamp formatting is stable and rejects invalid dates", () => {
  assert.equal(toUtcStamp("2026-11-03T09:15:22.123Z"), "2026-11-03 09:15:22 UTC");
  assert.equal(toUtcStamp("not-a-date"), "unknown time");
});
