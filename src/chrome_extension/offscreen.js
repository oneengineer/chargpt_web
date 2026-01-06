let ws = null;
let state = {
  url: "ws://127.0.0.1:17321",
  connected: false,
  lastError: ""
};

// --- Error backhaul (errors only, no message text/DOM) ---
let __errWindowStart = Date.now();
let __errCount = 0;
const __errLast = new Map();
const __queuedEvents = [];

function __shouldSendErr(where, phase, message) {
  const now = Date.now();
  if (now - __errWindowStart > 60000) {
    __errWindowStart = now;
    __errCount = 0;
  }
  if (__errCount >= 20) return false;
  const key = `${where}|${phase}|${message}`;
  const last = __errLast.get(key) || 0;
  if (now - last < 5000) return false;
  __errLast.set(key, now);
  __errCount++;
  return true;
}

function __queueErrorEvent(where, phase, message, detail) {
  try {
    const msg = String(message || "Offscreen error");
    if (!__shouldSendErr(where, phase, msg)) return;
    const ev = {
      type: "browser_event",
      kind: "error",
      message: msg,
      detail: { where, phase, ...(detail && typeof detail === "object" ? detail : {}) },
      ts: Date.now()
    };
    __queuedEvents.push(ev);
    if (__queuedEvents.length > 50) __queuedEvents.shift();
  } catch {}
}

function __flushQueuedEvents() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (__queuedEvents.length > 0) {
    const ev = __queuedEvents.shift();
    try { ws.send(JSON.stringify(ev)); } catch { break; }
  }
}

// Upload artifacts received from VS Code.
// Each artifact is a single file (could be .md/.txt/.zip/anything) available via a localhost URL.
let artifacts = [];

let reconnectAttempts = 0;
const maxReconnectAttempts = 50;

function postToBackground(msg) {
  chrome.runtime.sendMessage({ type: "offscreen_message", data: msg }).catch(() => {});
}

function rememberArtifact(artifact) {
  if (!artifact || !artifact.id || !artifact.url) return;
  // De-dupe by id.
  artifacts = [artifact, ...artifacts.filter((a) => a.id !== artifact.id)];
  // Cap list size.
  if (artifacts.length > 200) artifacts = artifacts.slice(0, 200);
  postToBackground({ type: "artifact_added", artifact });
}

function setStatus(connected, err = "") {
  state.connected = connected;
  state.lastError = err || "";
  postToBackground({ type: "offscreen_status", connected: state.connected, error: state.lastError });
}

function nextDelayMs() {
  reconnectAttempts++;
  const base = 500;
  const max = 30000;
  const delay = Math.min(max, base * Math.pow(2, Math.min(10, reconnectAttempts)) );
  return delay;
}

function connect() {
  if (!state.url) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(state.url);
  } catch (e) {
    setStatus(false, String(e));
    __queueErrorEvent("offscreen", "ws_connect", "Failed to create WebSocket.", { error: String(e) });
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0;
    setStatus(true, "");
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
    __flushQueuedEvents();
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "pong") return;

    if (msg.type === "vscode_push" && msg.kind === "text") {
      postToBackground({ type: "from_vscode", text: msg.text || "" });
      return;
    }

    if (msg.type === "vscode_push" && msg.kind === "insert_and_send") {
      postToBackground({ type: "from_vscode_insert_and_send", text: msg.text || "", target: msg.target || null });
      return;
    }

    if (msg.type === "vscode_push" && msg.kind === "files") {
      postToBackground({
        type: "from_vscode_files",
        payload: {
          files: msg.files || [],
          uploadTarget: msg.uploadTarget || "chat",
          target: msg.target || null
        }
      });
      return;
    }

    if (msg.type === "vscode_push" && msg.kind === "session_open") {
      postToBackground({ type: "from_vscode_session_open", target: msg.target || null });
      return;
    }

    if (msg.type === "vscode_push" && msg.kind === "session_close") {
      postToBackground({ type: "from_vscode_session_close", target: msg.target || null });
      return;
    }

    if (msg.type === "artifact_ready" && msg.artifact) {
      rememberArtifact(msg.artifact);
      return;
    }
  };

  ws.onclose = () => {
    setStatus(false, "Disconnected.");
    __queueErrorEvent("offscreen", "ws_connect", "WebSocket closed.", { error: "Disconnected" });
    scheduleReconnect();
  };

  ws.onerror = () => {
    setStatus(false, "WebSocket error.");
    __queueErrorEvent("offscreen", "ws_connect", "WebSocket error.", {});
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  if (reconnectAttempts >= maxReconnectAttempts) {
    setStatus(false, "Disconnected (gave up reconnect).");
    return;
  }
  const delay = nextDelayMs();
  setTimeout(() => connect(), delay);
}

function sendPayloadToVscode(kind, data, page) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    __queueErrorEvent("offscreen", "ws_connect", "Dropped payload: websocket not open.", { payloadKind: String(kind || "") });
    return false;
  }
  try {
    ws.send(JSON.stringify({
      type: "browser_payload",
      kind,
      data,
      page,
      ts: Date.now()
    }));
    return true;
  } catch {
    __queueErrorEvent("offscreen", "ws_connect", "Failed to send payload.", { payloadKind: String(kind || "") });
    return false;
  }
}

function sendEventToVscode(event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    __queueErrorEvent("offscreen", "ws_connect", "Dropped event: websocket not open.", { eventType: String(event?.type || ""), eventKind: String(event?.kind || "") });
    return false;
  }
  try {
    ws.send(JSON.stringify(event));
    return true;
  } catch {
    __queueErrorEvent("offscreen", "ws_connect", "Failed to send event.", { eventType: String(event?.type || ""), eventKind: String(event?.kind || "") });
    return false;
  }
}

// Offscreen global guards.
try {
  self.addEventListener("error", (e) => {
    __queueErrorEvent("offscreen", "unknown", "Offscreen error.", { error: String(e?.message || e), stack: String(e?.error?.stack || "").slice(0, 4000) });
  });
  self.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    const msg = r && r.message ? String(r.message) : String(r || "unhandledrejection");
    const stack = String(r?.stack || "").slice(0, 4000);
    __queueErrorEvent("offscreen", "unknown", "Offscreen unhandledrejection: " + msg, { stack });
  });
} catch {}

function parseConversationId(url) {
  try {
    const u = new URL(url);
    // New UI: https://chatgpt.com/c/<id>
    const m1 = u.pathname.match(/\/c\/([^\/]+)/);
    if (m1) return m1[1];
    // Legacy: https://chat.openai.com/c/<id>
    const m2 = u.pathname.match(/\/c\/([^\/]+)/);
    if (m2) return m2[1];
  } catch {}
  return "";
}

async function runUploadJob(job) {
  const target = job?.target === "project" ? "project" : "chat";
  const tabId = job?.tabId;
  const requestedIds = Array.isArray(job?.artifactIds) ? job.artifactIds : [];
  if (!tabId || requestedIds.length === 0) {
    postToBackground({ type: "upload_failed", error: "Missing tabId or artifactIds." });
    return;
  }

  const expectedConv = String(job?.expectedConversationId || "");

  let tabUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab?.url || "";
  } catch {}

  if (expectedConv) {
    const actualConv = parseConversationId(tabUrl);
    if (actualConv && actualConv !== expectedConv) {
      postToBackground({
        type: "upload_failed",
        error: `Conversation mismatch. Expected ${expectedConv} but active tab is ${actualConv}.`
      });
      return;
    }
  }

  const selected = requestedIds
    .map((id) => artifacts.find((a) => a.id === id))
    .filter(Boolean);

  if (selected.length === 0) {
    postToBackground({ type: "upload_failed", error: "No matching artifacts found." });
    return;
  }

  const batchSize = target === "chat" ? 10 : 20;
  const batches = [];
  for (let i = 0; i < selected.length; i += batchSize) {
    batches.push(selected.slice(i, i + batchSize));
  }

  postToBackground({ type: "upload_started", target, total: selected.length, batches: batches.length });

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    postToBackground({ type: "upload_batch_started", target, batchIndex: i + 1, batchCount: batches.length, count: batch.length });
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tabId, {
        type: "uploadArtifactsBatch",
        target,
        items: batch.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: a.url })),
        expectedConversationId: expectedConv
      });
    } catch (e) {
      postToBackground({ type: "upload_failed", target, error: String(e) });
      return;
    }

    if (!resp?.ok) {
      postToBackground({ type: "upload_failed", target, error: resp?.error || "Upload failed." });
      return;
    }

    postToBackground({ type: "upload_batch_done", target, batchIndex: i + 1, uploaded: resp.uploaded || batch.length });
  }

  postToBackground({ type: "upload_done", target, uploaded: selected.length });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "offscreen_connect") {
    state.url = message.url || state.url;
    connect();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "offscreen_send") {
    const ok = sendPayloadToVscode(message.kind, message.data || "", message.page || {});
    sendResponse({ ok });
    return true;
  }

  if (message?.type === "offscreen_emit_event") {
    const ok = sendEventToVscode(message.event);
    sendResponse({ ok });
    return true;
  }

  if (message?.type === "offscreen_get_status") {
    sendResponse({ connected: state.connected, error: state.lastError });
    return true;
  }

  if (message?.type === "offscreen_get_artifacts") {
    sendResponse({ ok: true, artifacts });
    return true;
  }

  if (message?.type === "offscreen_clear_artifacts") {
    artifacts = [];
    postToBackground({ type: "artifacts_cleared" });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "offscreen_upload") {
    // Fire-and-forget; progress is streamed back to background/popup.
    runUploadJob(message.job).catch((e) => {
      postToBackground({ type: "upload_failed", error: String(e) });
    });
    sendResponse({ ok: true, started: true });
    return true;
  }

  return false;
});

// Start immediately with defaults; background will overwrite url/token.
connect();
