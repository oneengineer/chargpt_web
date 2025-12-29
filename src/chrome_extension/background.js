let state = {
  url: "ws://127.0.0.1:17321",
  connected: false,
  lastFromVscode: "",
  lastError: "",
  artifacts: [],
  upload: { active: false, target: "", statusText: "" }
};

let creatingOffscreen = null;

async function load() {
  const saved = await chrome.storage.local.get(["url", "lastFromVscode"]);
  if (saved.url) state.url = saved.url;
  if (saved.lastFromVscode) state.lastFromVscode = saved.lastFromVscode;
}

function notifyStatus() {
  chrome.runtime.sendMessage({ type: "status", connected: state.connected, error: state.lastError }).catch(() => {});
}

function notifyArtifactsChanged() {
  chrome.runtime.sendMessage({ type: "artifacts_changed" }).catch(() => {});
}

function notifyUploadStatus() {
  chrome.runtime.sendMessage({ type: "upload_status", upload: state.upload }).catch(() => {});
}

function showNotification(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/erxB2YAAAAASUVORK5CYII=",
      title,
      message
    }).catch(() => {});
  } catch {}
}

function notifyArtifacts() {
  chrome.runtime.sendMessage({ type: "artifacts", artifacts: state.artifacts }).catch(() => {});
}

function notifyUpload(update) {
  state.upload = { ...state.upload, ...update };
  chrome.runtime.sendMessage({ type: "upload_status", upload: state.upload }).catch(() => {});
}

function toast(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/VE9i9QAAAAASUVORK5CYII=",
      title,
      message: message || ""
    });
  } catch {}
}

async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  if ("getContexts" in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    // Offscreen is used to keep the WebSocket alive across MV3 Service Worker suspends.
    // DOM_SCRAPING is semantically correct: we interact with ChatGPT page DOM via content script.
    reasons: ["DOM_SCRAPING"],
    justification: "Maintain WebSocket connection to VS Code for manual ChatGPT page content capture and message insertion."
  });

  await creatingOffscreen;
  creatingOffscreen = null;
}

async function offscreenConnect() {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: "offscreen_connect", url: state.url }).catch((e) => ({ ok: false, error: String(e) }));
  if (!resp?.ok) {
    state.connected = false;
    state.lastError = resp?.error || "Failed to connect offscreen.";
    notifyStatus();
  }
}

async function offscreenSend(kind, data, page) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: "offscreen_send", kind, data, page }).catch((e) => ({ ok: false, error: String(e) }));
  if (!resp?.ok) {
    return { ok: false, error: resp?.error || "Not connected." };
  }
  return { ok: true };
}

async function offscreenGetArtifacts() {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: "offscreen_get_artifacts" }).catch(() => ({ ok: false }));
  return resp;
}

async function offscreenClearArtifacts() {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: "offscreen_clear_artifacts" }).catch(() => ({ ok: false }));
  return resp;
}

async function offscreenStartUpload(job) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: "offscreen_upload", job }).catch((e) => ({ ok: false, error: String(e) }));
  return resp;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// --- Target-tab routing (Cursor-like sessions) ---
let _mappingsLoaded = false;
let _sessionToTab = {};
let _tabToSession = {};

async function ensureMappingsLoaded() {
  if (_mappingsLoaded) return;
  const stored = await chrome.storage.local.get(["sessionToTab", "tabToSession"]);
  _sessionToTab = stored.sessionToTab || {};
  _tabToSession = stored.tabToSession || {};
  _mappingsLoaded = true;
}

let _mappingFlushTimer = null;
function scheduleMappingFlush() {
  if (_mappingFlushTimer) return;
  _mappingFlushTimer = setTimeout(async () => {
    _mappingFlushTimer = null;
    try {
      await chrome.storage.local.set({ sessionToTab: _sessionToTab, tabToSession: _tabToSession });
    } catch {}
  }, 250);
}

function normalizeUrlForMatch(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return url || "";
  }
}

function extractStableIds(url) {
  const s = String(url || "");
  const ids = new Set();
  const re = /(g-p-[A-Za-z0-9_-]+|g-[A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    ids.add(m[1]);
  }
  return Array.from(ids);
}

function extractConversationId(url) {
  const s = String(url || "");
  const m = s.match(/\/c\/([^/?#]+)/);
  return m ? m[1] : null;
}

function stablePrefix(url) {
  const cleaned = normalizeUrlForMatch(url);
  // If redirected to /c/<conversationId>, keep only origin and any /g/... prefix if present.
  try {
    const u = new URL(cleaned);
    const p = u.pathname || "/";
    // Prefer keeping the /g/... prefix when available
    const gIdx = p.indexOf("/g/");
    if (gIdx >= 0) {
      // Keep '/g/<id>' plus maybe '/project'
      const parts = p.slice(gIdx).split("/").filter(Boolean);
      const keep = parts.slice(0, Math.min(parts.length, 3)).join("/");
      u.pathname = "/" + keep;
      return u.toString().replace(/\/$/, "");
    }
    // Otherwise just use origin
    u.pathname = "/";
    return u.toString();
  } catch {
    return cleaned;
  }
}

async function waitForTabComplete(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("Tab disappeared.");
    if (tab.status === "complete") return tab;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Timeout waiting for tab load (status!=complete).");
}

async function pingTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch (e) {
    // Receiving end might not exist yet; attempt to force-inject content script.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch {}
    return await chrome.tabs.sendMessage(tabId, { type: "ping" });
  }
}

async function waitForInjectable(tabId, timeoutMs) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await pingTab(tabId);
      if (resp?.ok) return resp;
      lastErr = resp?.error || null;
    } catch (e) {
      lastErr = String(e);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(lastErr || "Timeout waiting for content script ping.");
}

async function getOrCreateTargetTab(targetUrl, sessionId) {
  await ensureMappingsLoaded();

  const normalizedTarget = normalizeUrlForMatch(targetUrl);
  const targetIds = extractStableIds(normalizedTarget);
  const targetPrefix = stablePrefix(normalizedTarget);

  // 0) If sessionId mapping exists and tab still alive, use it.
  if (sessionId && _sessionToTab[sessionId]) {
    const existingId = Number(_sessionToTab[sessionId]);
    const tab = await chrome.tabs.get(existingId).catch(() => null);
    if (tab && tab.url && (tab.url.startsWith("https://chatgpt.com/") || tab.url.startsWith("https://chat.openai.com/"))) {
      return tab;
    }
    delete _sessionToTab[sessionId];
    scheduleMappingFlush();
  }

  // 1) Search existing ChatGPT tabs.
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  let best = null;
  let bestScore = -1;

  for (const t of tabs) {
    if (!t.url) continue;
    const u = normalizeUrlForMatch(t.url);
    let score = 0;
    if (u.startsWith(targetPrefix)) score += 800;
    for (const id of targetIds) {
      if (u.includes(id)) score += 500;
    }
    // Prefer tabs already mapped to this session
    if (sessionId && _tabToSession[String(t.id)] === sessionId) score += 2000;

    // Slight preference for same-origin and deeper paths when prefix matches
    if (u.startsWith(targetPrefix) && u.length > targetPrefix.length) score += 20;

    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }

  if (best && bestScore > 0) {
    if (sessionId && best.id != null) {
      _sessionToTab[sessionId] = best.id;
      _tabToSession[String(best.id)] = sessionId;
      scheduleMappingFlush();
    }
    return best;
  }

  // 2) Create a new background tab.
  const created = await chrome.tabs.create({ url: normalizedTarget, active: false });
  if (sessionId && created.id != null) {
    _sessionToTab[sessionId] = created.id;
    _tabToSession[String(created.id)] = sessionId;
    scheduleMappingFlush();
  }

  // 3) Wait for ready and ping.
  if (created.id == null) return created;
  await waitForTabComplete(created.id, 30000);
  await waitForInjectable(created.id, 30000);
  return await chrome.tabs.get(created.id);
}

async function closeSessionTab(target) {
  await ensureMappingsLoaded();
  const sid = target?.sessionId;
  const conv = target?.conversationId;
  const url = target?.url;

  // First: sessionId mapping.
  if (sid && _sessionToTab[sid]) {
    const tabId = Number(_sessionToTab[sid]);
    await chrome.tabs.remove(tabId).catch(() => {});
    delete _sessionToTab[sid];
    delete _tabToSession[String(tabId)];
    scheduleMappingFlush();
    return true;
  }

  // Second: look for conversationId.
  if (conv) {
    const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
    const hit = tabs.find((t) => t.url && t.url.includes(`/c/${conv}`));
    if (hit?.id != null) {
      await chrome.tabs.remove(hit.id).catch(() => {});
      return true;
    }
  }

  // Third: match by URL heuristics.
  if (url) {
    const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
    const pref = stablePrefix(url);
    const ids = extractStableIds(url);
    let best = null;
    let bestScore = -1;
    for (const t of tabs) {
      if (!t.url) continue;
      const u = normalizeUrlForMatch(t.url);
      let score = 0;
      if (u.startsWith(pref)) score += 800;
      for (const id of ids) if (u.includes(id)) score += 500;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (best?.id != null && bestScore > 0) {
      await chrome.tabs.remove(best.id).catch(() => {});
      return true;
    }
  }

  return false;
}

async function emitBrowserEvent(event) {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "offscreen_emit_event", event }).catch(() => {});
  } catch {}
}

async function handleFromVscodeFiles(payload) {
  const files = payload?.files || [];
  const uploadTarget = payload?.uploadTarget || "chat";
  const target = payload?.target || null;

  const wantUrl = target?.url;
  const sessionId = target?.sessionId || null;

  let tab;
  try {
    tab = wantUrl ? await getOrCreateTargetTab(wantUrl, sessionId) : await getActiveTab();
  } catch (e) {
    await emitBrowserEvent({ type: "browser_event", kind: "error", message: "Failed to open/select target tab.", detail: { error: String(e), wantUrl, sessionId }, ts: Date.now() });
    return;
  }

  if (!tab?.id) {
    await emitBrowserEvent({ type: "browser_event", kind: "error", message: "Target tab not found.", detail: { wantUrl, sessionId }, ts: Date.now() });
    return;
  }

  let ping;
  try {
    ping = await waitForInjectable(tab.id, 30000);
  } catch (e) {
    await emitBrowserEvent({ type: "browser_event", kind: "error", message: "Target tab not injectable (content script not ready).", detail: { error: String(e), tabId: tab.id, url: tab.url }, ts: Date.now() });
    return;
  }

  if (ping?.loginDetected) {
    await emitBrowserEvent({ type: "browser_event", kind: "error", message: "Target tab looks like a login page. Please log in to ChatGPT in this Chrome profile.", detail: { url: ping.url || tab.url, pageState: ping }, ts: Date.now() });
    return;
  }

  const batchSize = uploadTarget === "project" ? 20 : 10;
  const batches = [];
  for (let i = 0; i < files.length; i += batchSize) batches.push(files.slice(i, i + batchSize));

  notifyUpload({ active: true, target: uploadTarget, statusText: `Auto-upload: ${files.length} file(s) to ${uploadTarget} (batches ${batches.length})` });

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    notifyUpload({ active: true, target: uploadTarget, statusText: `Auto-upload: batch ${i + 1}/${batches.length} (${batch.length} files)` });
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id, {
        type: "uploadFilesBatch",
        target: uploadTarget,
        items: batch,
        sessionId,
        expectedConversationId: target?.conversationId || null
      });
    } catch (e) {
      await emitBrowserEvent({ type: "browser_event", kind: "error", message: "Upload message failed.", detail: { error: String(e), tabId: tab.id, url: tab.url }, ts: Date.now() });
      notifyUpload({ active: false, statusText: "Auto-upload failed." });
      return;
    }

    if (!resp?.ok) {
      await emitBrowserEvent({ type: "browser_event", kind: "error", message: resp?.error || "Upload failed.", detail: { tabId: tab.id, url: tab.url, debug: resp?.debug }, ts: Date.now() });
      notifyUpload({ active: false, statusText: "Auto-upload failed." });
      return;
    }
  }

  notifyUpload({ active: false, statusText: `Auto-upload done (${files.length} files).` });
  showNotification("ChatGPT Bridge", `Auto-uploaded ${files.length} file(s) to ${uploadTarget}.`);
}

async function captureFromContent(tabId, msg) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, msg);
    return resp;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

load().then(() => offscreenConnect()).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  offscreenConnect().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  offscreenConnect().catch(() => {});
});

// Track /c/<conversationId> creation and keep session mappings in sync.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || !changeInfo.url) return;
  const url = changeInfo.url;
  const conv = extractConversationId(url);
  if (!conv) return;
  ensureMappingsLoaded().then(() => {
    const sid = _tabToSession[String(tabId)];
    if (!sid) return;
    emitBrowserEvent({ type: "browser_event", kind: "conversation_bound", sessionId: sid, conversationId: conv, url, ts: Date.now() });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureMappingsLoaded().then(() => {
    const sid = _tabToSession[String(tabId)];
    if (!sid) return;
    delete _tabToSession[String(tabId)];
    if (_sessionToTab[sid] === tabId) delete _sessionToTab[sid];
    scheduleMappingFlush();
    emitBrowserEvent({ type: "browser_event", kind: "tab_closed", sessionId: sid, tabId, ts: Date.now() });
  });
});

// Messages coming back from offscreen.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "offscreen_message") {
    const data = message.data || {};
    if (data.type === "offscreen_status") {
      state.connected = !!data.connected;
      state.lastError = data.error || "";
      notifyStatus();
      return;
    }
    if (data.type === "from_vscode") {
      state.lastFromVscode = String(data.text || "");
      chrome.storage.local.set({ lastFromVscode: state.lastFromVscode }).catch(() => {});
      chrome.runtime.sendMessage({ type: "from_vscode", text: state.lastFromVscode }).catch(() => {});
      return;
    }

    if (data.type === "from_vscode_files") {
      handleFromVscodeFiles(data.payload).catch((e) => {
        emitBrowserEvent({ type: "browser_event", kind: "error", message: "Unhandled error during auto-upload.", detail: { error: String(e) }, ts: Date.now() });
      });
      return;
    }

    if (data.type === "from_vscode_session_open") {
      const target = data.target || {};
      const url = target.url;
      const sessionId = target.sessionId || null;
      (async () => {
        try {
          const tab = await getOrCreateTargetTab(url, sessionId);
          if (tab?.id) {
            const ping = await waitForInjectable(tab.id, 30000);
            if (ping?.loginDetected) {
              await emitBrowserEvent({ type: "browser_event", kind: "error", message: "Target tab looks like a login page. Please log in to ChatGPT in this Chrome profile.", detail: { url: ping.url || tab.url, pageState: ping }, ts: Date.now() });
            }
          }
        } catch (e) {
          await emitBrowserEvent({ type: "browser_event", kind: "error", message: "Failed to open/sync session tab.", detail: { error: String(e), url, sessionId }, ts: Date.now() });
        }
      })();
      return;
    }

    if (data.type === "from_vscode_session_close") {
      closeSessionTab(data.target).catch(() => {});
      return;
    }

    if (data.type === "artifact_added" && data.artifact) {
      const a = data.artifact;
      // De-dupe by id and cap size.
      state.artifacts = [a, ...state.artifacts.filter((x) => x.id !== a.id)].slice(0, 200);
      notifyArtifacts();
      return;
    }

    if (data.type === "artifacts_cleared") {
      state.artifacts = [];
      notifyArtifacts();
      return;
    }

    if (data.type === "upload_started") {
      notifyUpload({ active: true, target: data.target || "", statusText: `Uploading (${data.target || ""})...` });
      return;
    }
    if (data.type === "upload_batch_started") {
      notifyUpload({ active: true, statusText: `Uploading ${data.target}: batch ${data.batchIndex}/${data.batchCount} (${data.count} files)` });
      return;
    }
    if (data.type === "upload_batch_done") {
      notifyUpload({ active: true, statusText: `Uploaded ${data.target}: batch ${data.batchIndex} done` });
      return;
    }
    if (data.type === "upload_done") {
      notifyUpload({ active: false, statusText: `Upload done (${data.target}): ${data.uploaded} files` });
      toast("ChatGPT Bridge", `Upload complete (${data.target}): ${data.uploaded} file(s).`);
      return;
    }
    if (data.type === "upload_failed") {
      notifyUpload({ active: false, statusText: `Upload failed: ${data.error || "unknown"}` });
      toast("ChatGPT Bridge", `Upload failed: ${data.error || "unknown"}`);
      return;
    }
    return;
  }

  // IMPORTANT:
  // Messages with type "offscreen_*" are intended for the offscreen document.
  // The background service worker must NOT reply to them, otherwise it will
  // short-circuit requests like offscreen_connect/offscreen_send.
  if (typeof message?.type === "string" && message.type.startsWith("offscreen_")) {
    return false;
  }

  // Popup asks
  (async () => {
    if (message?.type === "saveConfig") {
      state.url = message.url || state.url;
      await chrome.storage.local.set({ url: state.url });
      await offscreenConnect();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "connect") {
      await offscreenConnect();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "getState") {
      const saved = await chrome.storage.local.get(["url", "lastFromVscode"]);
      // Refresh connection status from offscreen to survive service worker restarts
      try {
        await ensureOffscreen();
        const statusResp = await chrome.runtime.sendMessage({ type: "offscreen_get_status" }).catch(() => null);
        if (statusResp) {
          state.connected = !!statusResp.connected;
          state.lastError = statusResp.error || "";
        }
      } catch {}
      sendResponse({
        url: saved.url || state.url,
        token: "",
        connected: state.connected,
        error: state.lastError,
        lastFromVscode: saved.lastFromVscode || state.lastFromVscode,
        artifacts: state.artifacts,
        upload: state.upload
      });
      return;
    }

    if (message?.type === "getArtifacts") {
      // Refresh from offscreen to survive background worker restarts.
      const resp = await offscreenGetArtifacts();
      if (resp?.ok) {
        state.artifacts = resp.artifacts || [];
      }
      sendResponse({ ok: true, artifacts: state.artifacts });
      return;
    }

    if (message?.type === "clearArtifacts") {
      await offscreenClearArtifacts();
      state.artifacts = [];
      notifyArtifacts();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "startUpload") {
      const tab = await getActiveTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab." });
        return;
      }

      const job = {
        target: message.target === "project" ? "project" : "chat",
        tabId: tab.id,
        expectedConversationId: String(message.expectedConversationId || ""),
        artifactIds: Array.isArray(message.artifactIds) ? message.artifactIds : []
      };

      const resp = await offscreenStartUpload(job);
      sendResponse(resp || { ok: false, error: "Failed to start upload." });
      return;
    }

    // Manual send text/url from popup
    if (message?.type === "sendText") {
      const page = message.page || {};
      const resp = await offscreenSend("text", message.text || "", page);
      sendResponse(resp);
      return;
    }

    if (message?.type === "sendUrl") {
      const resp = await offscreenSend("url", message.url || "", { url: message.url, title: message.title });
      sendResponse(resp);
      return;
    }

    // Manual capture from page (selection / last assistant / pick bubble)
    if (message?.type === "captureSelection" || message?.type === "captureLastAssistant" || message?.type === "pickMessage") {
      const tab = await getActiveTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: "no active tab" });
        return;
      }

      let capResp;
      let kind = "selection";

      if (message.type === "captureSelection") {
        capResp = await captureFromContent(tab.id, { type: "getSelection" });
        kind = "selection";
      } else if (message.type === "captureLastAssistant") {
        capResp = await captureFromContent(tab.id, { type: "getLastAssistant" });
        kind = "last_assistant";
      } else {
        capResp = await captureFromContent(tab.id, { type: "pickMessage" });
        kind = "picked_message";
      }

      if (!capResp?.ok) {
        sendResponse({ ok: false, error: capResp?.error || "capture failed" });
        return;
      }

      const text = capResp.text || "";
      const page = { url: tab.url, title: tab.title };
      const resp = await offscreenSend(kind, text, page);
      sendResponse({ ok: resp.ok, length: text.length, error: resp.error });
      return;
    }

    // Insert into composer (manual push)
    if (message?.type === "insertToChat") {
      const tab = await getActiveTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: "no active tab" });
        return;
      }
      const resp = await captureFromContent(tab.id, { type: "insertIntoComposer", text: message.text || "" });
      sendResponse(resp || { ok: false });
      return;
    }

    sendResponse({ ok: false, error: "unknown msg" });
  })();

  return true;
});
