import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore, isValidSessionId } from "../memory/session.js";

test("session ids are validated", () => {
  assert.equal(isValidSessionId("123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isValidSessionId("short"), false);
  assert.equal(isValidSessionId("../etc/passwd"), false);
  assert.equal(isValidSessionId(42), false);
});

test("messages are appended in order and trimmed to the configured cap", async () => {
  const store = new SessionStore({
    ttlMs: 60_000,
    maxSessions: 10,
    maxMessagesPerSession: 4,
  });
  await store.init();

  const session = store.getOrCreate("test-session-0001", "Asia/Kolkata");
  assert.equal(session.timeZone, "Asia/Kolkata");

  store.appendUserMessage(session.id, "one");
  store.appendAssistantMessage(session.id, "two");
  store.appendUserMessage(session.id, "three");
  store.appendAssistantMessage(session.id, "four");
  store.appendUserMessage(session.id, "five");

  const messages = store.getMessages(session.id);
  assert.equal(messages.length, 4);
  assert.equal(messages[0]?.content, "two");
  assert.equal(messages[3]?.content, "five");
  assert.equal(messages[3]?.role, "user");

  await store.close();
});

test("sessions, sources and timestamps survive a restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "minimi-session-"));
  const file = path.join(dir, "sessions.json");

  try {
    const store = new SessionStore({
      ttlMs: 60_000,
      maxSessions: 10,
      maxMessagesPerSession: 50,
      persistPath: file,
    });
    await store.init();

    const session = store.getOrCreate();
    store.appendUserMessage(session.id, "What did I ask on 3 November?");
    const assistant = store.appendAssistantMessage(session.id, "You asked about Kyoto.", [
      { title: "Kyoto guide", url: "https://example.com/kyoto", provider: "duckduckgo" },
    ]);
    assert.ok(assistant.id.length > 0);

    await store.close();

    const restored = new SessionStore({
      ttlMs: 60_000,
      maxSessions: 10,
      maxMessagesPerSession: 50,
      persistPath: file,
    });
    await restored.init();

    const loaded = restored.get(session.id);
    assert.ok(loaded);
    assert.equal(loaded?.messages.length, 2);
    assert.equal(loaded?.messages[0]?.content, "What did I ask on 3 November?");
    assert.equal(loaded?.messages[1]?.sources?.[0]?.url, "https://example.com/kyoto");
    assert.match(loaded?.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

    await restored.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a session removes it", async () => {
  const store = new SessionStore({ ttlMs: 60_000, maxSessions: 10, maxMessagesPerSession: 10 });
  await store.init();

  const session = store.getOrCreate("delete-me-session");
  assert.equal(store.delete(session.id), true);
  assert.equal(store.get(session.id), undefined);
  assert.equal(store.delete(session.id), false);

  await store.close();
});
