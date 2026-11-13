/* =============================================================================
   Minimi Chat — client
   No framework by design: the entire UI is ~600 lines of dependency-free JS,
   served statically. It consumes the SSE stream over fetch(POST), renders
   markdown safely (escape first, then format), and restores session history.
   ========================================================================== */

const STORAGE_KEY = "minimi.session.v1";

const ICONS = {
  copy: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="8.5" y="8.5" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 8.5V6.8A1.8 1.8 0 0 0 13.7 5H6.8A1.8 1.8 0 0 0 5 6.8v6.9a1.8 1.8 0 0 0 1.8 1.8h1.7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 4.5 21 20H3L12 4.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.2M12 17.1v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
  error: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.7v5M12 16.1v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

const els = {
  messages: document.getElementById("messages"),
  welcome: document.getElementById("welcome"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  statusLine: document.getElementById("status-line"),
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("banner-text"),
  newChat: document.getElementById("new-chat"),
  newChatMobile: document.getElementById("new-chat-mobile"),
  topbarTitle: document.getElementById("topbar-title"),
  topbarSub: document.getElementById("topbar-sub"),
  modelName: document.getElementById("model-name"),
  searchName: document.getElementById("search-name"),
  searchPillText: document.getElementById("search-pill-text"),
  searchDot: document.getElementById("search-dot"),
  llmDot: document.getElementById("llm-dot"),
  sessionShort: document.getElementById("session-short"),
};

const welcomeTemplate = els.welcome.cloneNode(true);
const assistantByArticle = new WeakMap();

const state = {
  sessionId: getOrCreateSessionId(),
  controller: null,
  sending: false,
  stopped: false,
  streamDone: false,
  generation: 0,
  health: null,
  currentAssistant: null,
  statusText: "",
};

/* =============================================================================
   Helpers
   ========================================================================== */

function createSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function getOrCreateSessionId() {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  } catch {
    // localStorage can be unavailable in private modes; fall back to memory.
  }
  const id = createSessionId();
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Ignore.
  }
  return id;
}

function persistSessionId() {
  try {
    localStorage.setItem(STORAGE_KEY, state.sessionId);
  } catch {
    // Ignore.
  }
}

function getTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatClock(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatFullDate(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function setDot(element, ok) {
  if (!element) return;
  element.classList.remove("ok", "err");
  element.classList.add(ok ? "ok" : "err");
}

function setBanner(message) {
  if (!message) {
    els.banner.hidden = true;
    return;
  }
  els.bannerText.textContent = message;
  els.banner.hidden = false;
}

function setStatus(text) {
  if (state.statusText === text) return;
  state.statusText = text;
  els.statusLine.replaceChildren();
  if (!text) return;

  const spinner = document.createElement("span");
  spinner.className = "mini-spinner";
  const label = document.createElement("span");
  label.textContent = text;
  els.statusLine.append(spinner, label);
}

function updateSessionLabel() {
  els.sessionShort.textContent = state.sessionId.slice(0, 8);
}

function updateTitle(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  els.topbarTitle.textContent = clean ? truncate(clean, 64) : "New conversation";
  els.topbarSub.textContent = "Live research · session memory";
}

function isNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 180;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

/* =============================================================================
   Safe markdown rendering
   -----------------------------------------------------------------------------
   Strategy: escape ALL HTML first, then transform a deliberately small subset
   of markdown. This makes injection impossible regardless of model output.
   ========================================================================== */

function renderMarkdown(source) {
  const raw = String(source ?? "").replace(/\r\n/g, "\n").replace(/\u0000/g, "");
  if (!raw.trim()) return "";

  const codeBlocks = [];
  let text = escapeHtml(raw);

  // Fenced code blocks -> placeholders (content is already escaped).
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const language = String(lang || "").replace(/[^a-zA-Z0-9_+-]/g, "");
    const token = `\u0000CODE${codeBlocks.length}\u0000`;
    const classAttr = language ? ` class="language-${language}"` : "";
    codeBlocks.push(`<pre><code${classAttr}>${code.replace(/\n$/, "")}</code></pre>`);
    return `\n\n${token}\n\n`;
  });

  // Inline code -> placeholders.
  const inlineCode = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `\u0000INLINE${inlineCode.length}\u0000`;
    inlineCode.push(`<code>${code}</code>`);
    return token;
  });

  // Markdown links (http/https only).
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );

  // Bare URLs.
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g,
    (_match, lead, url) =>
      `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );

  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const lines = text.split("\n");
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.type}>`);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const codeMatch = trimmed.match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) {
      flushParagraph();
      flushList();
      out.push(codeBlocks[Number(codeMatch[1])] ?? "");
      continue;
    }

    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      flushParagraph();
      flushList();
      out.push("<hr>");
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(bullet ? bullet[1] : numbered[1]);
      continue;
    }

    if (trimmed.startsWith("&gt;")) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${trimmed.replace(/^&gt;\s?/, "")}</blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  let html = out.join("");
  html = html.replace(/\u0000INLINE(\d+)\u0000/g, (_match, index) => inlineCode[Number(index)] ?? "");
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => codeBlocks[Number(index)] ?? "");
  return html;
}

/* =============================================================================
   Message rendering
   ========================================================================== */

function hideWelcome() {
  const welcome = els.messages.querySelector(".welcome");
  if (welcome) welcome.remove();
}

function resetMessages() {
  els.messages.replaceChildren(welcomeTemplate.cloneNode(true));
}

function appendUserMessage(text, createdAt) {
  const alreadyHasMessages = Boolean(els.messages.querySelector(".message"));
  hideWelcome();

  const article = document.createElement("article");
  article.className = "message user";

  const body = document.createElement("div");
  body.className = "message-body";

  const bubble = document.createElement("div");
  bubble.className = "user-bubble";
  bubble.textContent = text;

  const meta = document.createElement("div");
  meta.className = "user-meta";
  const time = document.createElement("time");
  time.dateTime = createdAt || new Date().toISOString();
  time.title = formatFullDate(createdAt);
  time.textContent = formatClock(createdAt);
  meta.append(time);

  body.append(bubble, meta);
  article.append(body);
  els.messages.append(article);

  if (!alreadyHasMessages) updateTitle(text);
  scrollToBottom(true);
  return article;
}

function appendAssistantShell() {
  const article = document.createElement("article");
  article.className = "message assistant";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "M";

  const body = document.createElement("div");
  body.className = "message-body";

  const head = document.createElement("div");
  head.className = "message-head";

  const author = document.createElement("span");
  author.className = "author";
  author.textContent = "Minimi";

  const modelTag = document.createElement("span");
  modelTag.className = "model-tag";
  modelTag.textContent = state.health?.model || "agent";

  const time = document.createElement("time");
  time.className = "message-time";
  const nowIso = new Date().toISOString();
  time.dateTime = nowIso;
  time.title = formatFullDate(nowIso);
  time.textContent = formatClock(nowIso);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-btn";
  copyBtn.dataset.action = "copy";
  copyBtn.title = "Copy answer";
  copyBtn.setAttribute("aria-label", "Copy answer");
  copyBtn.innerHTML = ICONS.copy;

  head.append(author, modelTag, time, copyBtn);

  const toolStack = document.createElement("div");
  toolStack.className = "tool-stack";

  const content = document.createElement("div");
  content.className = "markdown";

  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = "<span></span><span></span><span></span>";
  content.append(typing);

  const sources = document.createElement("div");
  sources.className = "sources-slot";

  const foot = document.createElement("div");
  foot.className = "message-foot";
  foot.hidden = true;

  body.append(head, toolStack, content, sources, foot);
  article.append(avatar, body);
  els.messages.append(article);

  const assistant = {
    article,
    contentEl: content,
    toolStack,
    sourcesEl: sources,
    footEl: foot,
    copyBtn,
    raw: "",
    typingEl: typing,
    toolChips: new Map(),
    renderQueued: false,
    completed: false,
  };

  assistantByArticle.set(article, assistant);
  scrollToBottom(true);
  return assistant;
}

function removeTyping(assistant) {
  if (assistant.typingEl) {
    assistant.typingEl.remove();
    assistant.typingEl = null;
  }
}

function scheduleRender(assistant) {
  if (assistant.renderQueued) return;
  assistant.renderQueued = true;
  requestAnimationFrame(() => {
    assistant.renderQueued = false;
    if (!assistant.contentEl.isConnected) return;
    assistant.contentEl.innerHTML = renderMarkdown(assistant.raw);
    scrollToBottom();
  });
}

function appendDelta(assistant, text) {
  if (!assistant || typeof text !== "string" || !text) return;
  if (!assistant.raw) removeTyping(assistant);
  assistant.raw += text;
  scheduleRender(assistant);
}

function renderSources(assistant, sources) {
  assistant.sourcesEl.replaceChildren();
  if (!Array.isArray(sources) || sources.length === 0) return;

  const seen = new Set();
  const valid = [];
  for (const source of sources) {
    if (!source || typeof source.url !== "string" || seen.has(source.url)) continue;
    if (!/^https?:\/\//i.test(source.url)) continue;
    seen.add(source.url);
    valid.push(source);
  }
  if (valid.length === 0) return;

  const wrap = document.createElement("div");
  wrap.className = "sources";

  const title = document.createElement("div");
  title.className = "sources-title";
  title.textContent = `Sources · ${valid.length}`;

  const grid = document.createElement("div");
  grid.className = "source-grid";

  for (const source of valid.slice(0, 8)) {
    let host;
    try {
      host = new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }

    const link = document.createElement("a");
    link.className = "source-card";
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const hostEl = document.createElement("span");
    hostEl.className = "source-host";
    hostEl.textContent = host;

    const nameEl = document.createElement("span");
    nameEl.className = "source-title";
    nameEl.textContent = source.title || host;

    link.append(hostEl, nameEl);
    grid.append(link);
  }

  wrap.append(title, grid);
  assistant.sourcesEl.append(wrap);
}

function metricsLabel(metrics) {
  if (!metrics || typeof metrics !== "object") return "";
  const parts = [];
  if (Number.isFinite(metrics.searches) && metrics.searches > 0) {
    parts.push(`${metrics.searches} search${metrics.searches === 1 ? "" : "es"}`);
  }
  if (Number.isFinite(metrics.totalMs) && metrics.totalMs > 0) {
    parts.push(`${(metrics.totalMs / 1000).toFixed(1)}s`);
  }
  return parts.join(" · ");
}

function finalizeAssistant(assistant, payload) {
  removeTyping(assistant);

  const text =
    typeof payload?.text === "string" && payload.text.trim() ? payload.text : assistant.raw;
  assistant.raw = text;
  assistant.contentEl.innerHTML = renderMarkdown(text);
  renderSources(assistant, payload?.sources ?? []);

  const foot = [metricsLabel(payload?.metrics), payload?.usage?.totalTokens
    ? `${Number(payload.usage.totalTokens).toLocaleString()} tokens`
    : ""]
    .filter(Boolean)
    .join(" · ");

  if (foot) {
    assistant.footEl.textContent = foot;
    assistant.footEl.hidden = false;
  }

  assistant.completed = true;
  assistant.copyBtn.classList.remove("copied");
  assistant.copyBtn.innerHTML = ICONS.copy;
  scrollToBottom();
}

function showAssistantError(assistant, message, partialText) {
  removeTyping(assistant);

  if (typeof partialText === "string" && partialText.length > assistant.raw.length) {
    assistant.raw = partialText;
  }
  if (assistant.raw.trim()) {
    assistant.contentEl.innerHTML = renderMarkdown(assistant.raw);
  } else {
    assistant.contentEl.replaceChildren();
  }

  const card = document.createElement("div");
  card.className = "error-card";

  const icon = document.createElement("span");
  icon.innerHTML = ICONS.error;

  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = "Request failed";
  const detail = document.createElement("span");
  detail.textContent = message || "Something went wrong. Please try again.";
  copy.append(heading, detail);

  card.append(icon, copy);
  assistant.article.querySelector(".message-body")?.append(card);
  scrollToBottom();
}

function markStopped(assistant) {
  removeTyping(assistant);
  if (assistant.raw.trim()) {
    assistant.contentEl.innerHTML = renderMarkdown(assistant.raw);
  }
  const note = document.createElement("div");
  note.className = "stop-note";
  note.textContent = assistant.raw.trim() ? "Generation stopped." : "Generation stopped before an answer was produced.";
  assistant.article.querySelector(".message-body")?.append(note);
}

/* =============================================================================
   Tool indicators
   ========================================================================== */

function handleToolEvent(assistant, event) {
  if (!assistant || !event || typeof event.id !== "string") return;

  let parts = assistant.toolChips.get(event.id);
  if (!parts) {
    const chip = document.createElement("div");
    chip.className = "tool-chip searching";

    const icon = document.createElement("span");
    icon.className = "tool-icon";
    icon.innerHTML = `<span class="tool-spinner"></span>`;

    const label = document.createElement("span");
    label.className = "tool-label";

    const meta = document.createElement("span");
    meta.className = "tool-meta";

    chip.append(icon, label, meta);
    assistant.toolStack.append(chip);
    parts = { chip, icon, label, meta };
    assistant.toolChips.set(event.id, parts);
  }

  const query = typeof event.query === "string" ? event.query : "";

  if (event.status === "started") {
    parts.chip.className = "tool-chip searching";
    parts.icon.innerHTML = `<span class="tool-spinner"></span>`;
    parts.label.textContent = query ? `Searching “${query}”` : "Searching the web";
    parts.meta.textContent = "live";
  } else if (event.status === "completed") {
    parts.chip.className = "tool-chip done";
    parts.icon.innerHTML = ICONS.check;
    parts.label.textContent = query ? `Searched “${query}”` : "Web search";

    const meta = [];
    if (Number.isFinite(event.resultCount)) {
      meta.push(`${event.resultCount} result${event.resultCount === 1 ? "" : "s"}`);
    }
    if (Number.isFinite(event.durationMs)) {
      meta.push(`${(event.durationMs / 1000).toFixed(1)}s`);
    }
    if (event.cached) meta.push("cached");
    parts.meta.textContent = meta.join(" · ");
  } else {
    parts.chip.className = "tool-chip failed";
    parts.icon.innerHTML = ICONS.warn;
    parts.label.textContent = query ? `Search failed “${query}”` : "Web search failed";
    parts.meta.textContent = event.error ? truncate(event.error, 48) : "error";
    parts.chip.title = event.error || "Search failed";
  }

  scrollToBottom();
}

/* =============================================================================
   SSE transport
   ========================================================================== */

async function consumeSse(body, assistant, generation) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (generation !== state.generation) return;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleSseBlock(block, assistant, generation);
        boundary = buffer.indexOf("\n\n");
      }
    }

    if (buffer.trim()) handleSseBlock(buffer, assistant, generation);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}

function handleSseBlock(block, assistant, generation) {
  if (generation !== state.generation) return;

  let event = "message";
  const dataLines = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return;

  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }

  switch (event) {
    case "meta": {
      if (typeof data.sessionId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(data.sessionId)) {
        state.sessionId = data.sessionId;
        persistSessionId();
        updateSessionLabel();
      }
      break;
    }
    case "status": {
      if (typeof data.message === "string") setStatus(data.message);
      break;
    }
    case "tool": {
      handleToolEvent(assistant, data);
      break;
    }
    case "delta": {
      appendDelta(assistant, data.text);
      setStatus("Responding…");
      break;
    }
    case "done": {
      state.streamDone = true;
      finalizeAssistant(assistant, data);
      setStatus("");
      updateSessionLabel();
      break;
    }
    case "error": {
      state.streamDone = true;
      showAssistantError(assistant, data.message, data.partialText);
      setStatus("");
      break;
    }
    default:
      break;
  }
}

async function extractErrorMessage(response) {
  try {
    const data = await response.json();
    if (data?.error?.message) return data.error.message;
  } catch {
    // Not JSON.
  }
  return `Request failed (${response.status}).`;
}

/* =============================================================================
   Sending / lifecycle
   ========================================================================== */

function setSending(sending) {
  state.sending = sending;
  els.send.hidden = sending;
  els.stop.hidden = !sending;
  els.composer.setAttribute("aria-busy", sending ? "true" : "false");
  autoResize();
}

async function sendMessage(rawText) {
  if (state.sending) return;

  const text = String(rawText ?? "").trim();
  if (!text) return;

  if (state.health && state.health.llmConfigured === false) {
    setBanner("Chat is not configured. Add LLM_API_KEY to .env and restart the server.");
    return;
  }

  const generation = ++state.generation;
  state.sending = true;
  state.stopped = false;
  state.streamDone = false;

  appendUserMessage(text);
  els.input.value = "";
  autoResize();
  setSending(true);
  setStatus("Thinking…");

  const assistant = appendAssistantShell();
  state.currentAssistant = assistant;

  const controller = new AbortController();
  state.controller = controller;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        sessionId: state.sessionId,
        message: text,
        timeZone: getTimeZone(),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await extractErrorMessage(response));
    }

    const contentType = response.headers.get("content-type") || "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      throw new Error("The server did not return a streaming response.");
    }

    await consumeSse(response.body, assistant, generation);

    if (
      generation === state.generation &&
      !state.streamDone &&
      !state.stopped &&
      !assistant.completed
    ) {
      throw new Error("The connection ended before the answer finished. Please try again.");
    }
  } catch (error) {
    if (generation !== state.generation) return;

    if (state.stopped || error?.name === "AbortError") {
      markStopped(assistant);
    } else {
      showAssistantError(
        assistant,
        error instanceof Error ? error.message : "Network error. Please try again.",
      );
    }
  } finally {
    if (generation === state.generation) {
      state.sending = false;
      state.controller = null;
      setSending(false);
      setStatus("");
    }
  }
}

function startNewChat() {
  state.generation += 1;
  state.stopped = true;

  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }

  state.sending = false;
  state.streamDone = false;
  state.currentAssistant = null;
  state.sessionId = createSessionId();
  persistSessionId();

  resetMessages();
  setSending(false);
  setStatus("");
  updateSessionLabel();
  updateTitle("");
  els.input.value = "";
  autoResize();
  els.input.focus();
}

function autoResize() {
  els.input.style.height = "auto";
  const height = Math.min(Math.max(els.input.scrollHeight, 28), 200);
  els.input.style.height = `${height}px`;
}

/* =============================================================================
   Health + session restore
   ========================================================================== */

async function loadHealth() {
  try {
    const response = await fetch("/api/health", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("health check failed");
    const health = await response.json();
    state.health = health;

    els.modelName.textContent = health.model || "unknown";
    const provider = health.search?.provider === "tavily" ? "Tavily" : "DuckDuckGo";
    els.searchName.textContent = provider;
    els.searchPillText.textContent = `Web search · ${provider}`;
    setDot(els.llmDot, Boolean(health.llmConfigured));
    setDot(els.searchDot, Boolean(health.search?.configured));

    if (!health.llmConfigured) {
      setBanner("Chat is not configured. Add LLM_API_KEY to .env and restart the server.");
    } else if (!health.search?.configured) {
      setBanner(
        "Web search is not configured. Add TAVILY_API_KEY or set SEARCH_PROVIDER=duckduckgo.",
      );
    } else {
      setBanner("");
    }
  } catch {
    setDot(els.llmDot, false);
    setDot(els.searchDot, false);
    els.modelName.textContent = "offline";
    els.searchName.textContent = "offline";
    setBanner("Cannot reach the server. Make sure `npm run dev` is running.");
  }
}

async function loadSession() {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return;

    const data = await response.json();
    const messages = data?.session?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    els.messages.replaceChildren();
    for (const message of messages) {
      if (!message || typeof message.content !== "string") continue;
      if (message.role === "user") {
        appendUserMessage(message.content, message.createdAt);
      } else if (message.role === "assistant") {
        const assistant = appendAssistantShell();
        finalizeAssistant(assistant, {
          text: message.content,
          sources: message.sources || [],
        });
        removeTyping(assistant);
      }
    }

    const firstUser = messages.find((message) => message.role === "user");
    if (firstUser) updateTitle(firstUser.content);
    requestAnimationFrame(() => scrollToBottom(true));
  } catch {
    // History is best-effort; a fresh conversation is still usable.
  }
}

async function copyAnswer(button) {
  const article = button.closest(".message");
  const assistant = article ? assistantByArticle.get(article) : null;
  if (!assistant?.raw) return;

  try {
    await navigator.clipboard.writeText(assistant.raw);
    button.classList.add("copied");
    button.innerHTML = ICONS.check;
    setTimeout(() => {
      button.classList.remove("copied");
      button.innerHTML = ICONS.copy;
    }, 1500);
  } catch {
    // Clipboard permission denied — ignore silently.
  }
}

/* =============================================================================
   Event wiring
   ========================================================================== */

function bindEvents() {
  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage(els.input.value);
  });

  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendMessage(els.input.value);
    }
  });

  els.input.addEventListener("input", autoResize);

  els.stop.addEventListener("click", () => {
    if (!state.sending) return;
    state.stopped = true;
    setStatus("Stopping…");
    state.controller?.abort();
  });

  els.newChat.addEventListener("click", startNewChat);
  els.newChatMobile.addEventListener("click", startNewChat);

  els.messages.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const suggestion = target.closest(".suggestion");
    if (suggestion) {
      const prompt = suggestion.getAttribute("data-prompt");
      if (prompt) void sendMessage(prompt);
      return;
    }

    const copyButton = target.closest("[data-action='copy']");
    if (copyButton) {
      void copyAnswer(copyButton);
    }
  });

  window.addEventListener("resize", () => scrollToBottom());
}

async function init() {
  updateSessionLabel();
  updateTitle("");
  bindEvents();
  autoResize();
  await loadHealth();
  await loadSession();
  els.input.focus();
}

void init();
