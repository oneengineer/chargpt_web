function $(id){ return document.getElementById(id); }

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "getState" });
  $("url").value = st.url || "";
  $("fromVscode").value = st.lastFromVscode || "";
  $("status").textContent = `Status: ${st.connected ? "Connected" : "Disconnected"}`;
  $("error").textContent = st.error || "";
  renderArtifacts(st.artifacts || []);
  $("uploadStatus").textContent = `Upload: ${st.upload?.statusText || "-"}`;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function renderArtifacts(artifacts) {
  const list = $("artifactList");
  if (!list) return;
  list.innerHTML = "";

  if (!artifacts || artifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No artifacts yet. In VS Code run: Bundle → Publish ... Artifact, or Publish a File as Artifact.";
    list.appendChild(empty);
    return;
  }

  for (const a of artifacts) {
    const row = document.createElement("div");
    row.className = "artifactRow";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.id = a.id;

    const name = document.createElement("div");
    name.className = "artifactName";
    name.textContent = a.filename || a.id;

    const meta = document.createElement("div");
    meta.className = "artifactMeta";
    meta.textContent = fmtBytes(a.size);

    row.appendChild(cb);
    row.appendChild(name);
    row.appendChild(meta);
    list.appendChild(row);
  }
}

function selectedArtifactIds() {
  return Array.from(document.querySelectorAll('#artifactList input[type="checkbox"]'))
    .filter((x) => x.checked)
    .map((x) => x.dataset.id)
    .filter(Boolean);
}

function parseConversationId(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/c\/([^\/]+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

$("save").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "saveConfig", url: $("url").value.trim() });
  setTimeout(refresh, 150);
});

$("connect").addEventListener("click", async () => {
  // Save URL first so offscreen connects to the right endpoint
  await chrome.runtime.sendMessage({ type: "saveConfig", url: $("url").value.trim() });
  await chrome.runtime.sendMessage({ type: "connect" });
  setTimeout(refresh, 150);
});

$("captureSelection").addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "captureSelection" });
  if (!resp?.ok) $("error").textContent = resp?.error || "Failed.";
  else $("error").textContent = `Sent selection (${resp.length} chars).`;
});

$("captureLastAssistant").addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "captureLastAssistant" });
  if (!resp?.ok) $("error").textContent = resp?.error || "Failed.";
  else $("error").textContent = `Sent last assistant (${resp.length} chars).`;
});

$("pickMessage").addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "pickMessage" });
  if (!resp?.ok) $("error").textContent = resp?.error || "Failed.";
  else $("error").textContent = `Sent picked message (${resp.length} chars).`;
});

$("sendUrl").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const resp = await chrome.runtime.sendMessage({ type: "sendUrl", url: tab?.url || "", title: tab?.title || "" });
  $("error").textContent = resp?.ok ? "Sent URL." : "Failed to send URL.";
});

$("copyPageHtml").addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "copyPageHtml" });
  if (!resp?.ok) {
    $("error").textContent = resp?.error || "Failed to get page HTML.";
    return;
  }
  try {
    await navigator.clipboard.writeText(resp.html);
    $("error").textContent = `Copied page HTML (${resp.html.length} chars).`;
  } catch (e) {
    $("error").textContent = "Clipboard write failed: " + String(e);
  }
});

$("sendTextBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const text = $("sendText").value || "";
  const resp = await chrome.runtime.sendMessage({ type: "sendText", text, page: { url: tab?.url, title: tab?.title } });
  $("error").textContent = resp?.ok ? "Sent text." : "Failed to send text.";
  if (resp?.ok) $("sendText").value = "";
});

$("copyFromVscode").addEventListener("click", async () => {
  const text = $("fromVscode").value || "";
  await navigator.clipboard.writeText(text);
  $("error").textContent = "Copied.";
});

$("insertToChat").addEventListener("click", async () => {
  const text = $("fromVscode").value || "";
  const resp = await chrome.runtime.sendMessage({ type: "insertToChat", text });
  $("error").textContent = resp?.ok ? "Inserted into composer (press Enter to send)." : (resp?.error || "Insert failed.");
});

$("refreshArtifacts")?.addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "getArtifacts" });
  if (!resp?.ok) $("error").textContent = resp?.error || "Failed to refresh artifacts.";
  else renderArtifacts(resp.artifacts || []);
});

$("clearArtifacts")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearArtifacts" });
  renderArtifacts([]);
});

async function startUpload(target) {
  const ids = selectedArtifactIds();
  if (ids.length === 0) {
    $("error").textContent = "Select at least one artifact.";
    return;
  }
  const tab = await getActiveTab();
  const expectedConversationId = parseConversationId(tab?.url || "");
  const resp = await chrome.runtime.sendMessage({ type: "startUpload", target, artifactIds: ids, expectedConversationId });
  if (!resp?.ok) $("error").textContent = resp?.error || "Failed to start upload.";
  else $("error").textContent = "Upload started. Check Upload status.";
}

$("uploadToChat")?.addEventListener("click", () => startUpload("chat"));
$("uploadToProject")?.addEventListener("click", () => startUpload("project"));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status" || msg.type === "from_vscode") refresh();
  if (msg.type === "artifacts") {
    renderArtifacts(msg.artifacts || []);
    return;
  }
  if (msg.type === "upload_status") {
    $("uploadStatus").textContent = `Upload: ${msg.upload?.statusText || "-"}`;
    return;
  }
});

refresh();
