let ws = null;
let state = {
  url: "ws://127.0.0.1:17321",
  connected: false,
  lastError: ""
};

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
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0;
    setStatus(true, "");
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "pong") return;

    if (msg.type === "vscode_push" && msg.kind === "text") {
      postToBackground({ type: "from_vscode", text: msg.text || "" });
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
    scheduleReconnect();
  };

  ws.onerror = () => {
    setStatus(false, "WebSocket error.");
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
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
    return false;
  }
}

function sendEventToVscode(event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
}

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
