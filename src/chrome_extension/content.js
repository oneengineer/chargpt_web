function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getThreadRoot() {
  return document.querySelector('#thread') || document.querySelector('main') || document.body;
}

function findComposer() {
  const root = getThreadRoot();

  // ChatGPT current UI: unified composer is the most stable anchor.
  const form =
    root.querySelector('form[data-type="unified-composer"]') ||
    document.querySelector('form[data-type="unified-composer"]');

  if (form) {
    // Real input is a contenteditable div; textarea is often hidden (display:none).
    const ed = form.querySelector('div#prompt-textarea[contenteditable="true"]');
    if (ed && isVisible(ed)) return { type: 'contenteditable', el: ed };

    const ta = form.querySelector('textarea#prompt-textarea, textarea[name="prompt-textarea"]');
    if (ta && isVisible(ta)) return { type: 'textarea', el: ta };
  }

  // Conservative fallback: do NOT scan the entire page for random contenteditables.
  const prompt = document.querySelector('textarea#prompt-textarea');
  if (prompt && isVisible(prompt)) return { type: 'textarea', el: prompt };

  return null;
}

function findComposerFormEl() {
  return document.querySelector('form[data-type="unified-composer"]');
}

function findChatFileInput() {
  const form = document.querySelector('form[data-type="unified-composer"]');
  if (!form) return null;
  // In ChatGPT's unified composer, the file input is often in a hidden wrapper.
  const input = form.querySelector('input[type="file"]');
  return input || null;
}

function findSendButton() {
  return document.querySelector('#composer-submit-button') || document.querySelector('button[data-testid="send-button"]');
}

function detectLoginPage() {
  const path = location.pathname || '';
  if (path.includes('/auth/login') || path.includes('/login')) return true;
  if (document.querySelector('input[type="password"]')) return true;
  return false;
}

function getPageState() {
  const composer = !!document.querySelector('form[data-type="unified-composer"]');
  const fileInputs = document.querySelectorAll('form[data-type="unified-composer"] input[type="file"]').length;
  const sendBtns = document.querySelectorAll('#composer-submit-button, button[data-testid="send-button"]').length;
  return {
    url: location.href,
    title: document.title,
    host: location.hostname,
    composer,
    fileInputs,
    sendBtns,
    loginDetected: detectLoginPage()
  };
}

// --- Error backhaul (errors only, no message text/DOM) ---
let __bridgeErrWindowStart = Date.now();
let __bridgeErrCount = 0;
const __bridgeErrLast = new Map();

function __bridgeShouldSend(where, phase, message) {
  const now = Date.now();
  if (now - __bridgeErrWindowStart > 60000) {
    __bridgeErrWindowStart = now;
    __bridgeErrCount = 0;
  }
  if (__bridgeErrCount >= 20) return false;
  const key = `${where}|${phase}|${message}`;
  const last = __bridgeErrLast.get(key) || 0;
  if (now - last < 5000) return false;
  __bridgeErrLast.set(key, now);
  __bridgeErrCount++;
  return true;
}

function __bridgeEmitError(where, phase, err, extra) {
  try {
    const message = String(err?.message || err || "error");
    if (!__bridgeShouldSend(where, phase, message)) return;
    const stack = String(err?.stack || "").slice(0, 4000);
    const ps = getPageState();
    chrome.runtime.sendMessage({
      type: "bridge_error",
      where,
      phase,
      message,
      detail: {
        url: ps.url,
        tabUrl: ps.url,
        stack,
        pageState: { composer: ps.composer, fileInputs: ps.fileInputs, sendBtns: ps.sendBtns, loginDetected: ps.loginDetected },
        ...(extra && typeof extra === "object" ? extra : {})
      }
    }).catch(() => {});
  } catch {}
}

// Global guards for uncaught exceptions / unhandled promise rejections.
try {
  window.addEventListener("error", (e) => {
    __bridgeEmitError("content", "unknown", e?.error || new Error(String(e?.message || "uncaught error")), {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e?.reason instanceof Error ? e.reason : new Error(String(e?.reason || "unhandledrejection"));
    __bridgeEmitError("content", "unknown", reason, { kind: "unhandledrejection" });
  });
} catch {}

function extractMessageText(msgEl) {
  if (!msgEl) return '';

  // If caller passed a large container (e.g. article), narrow to a message bubble.
  try {
    if (!msgEl.hasAttribute?.('data-message-author-role')) {
      const bubble = msgEl.querySelector?.('[data-message-author-role]');
      if (bubble) msgEl = bubble;
    }
  } catch {}

  // Prefer markdown/prose blocks; avoid capturing buttons/UI chrome.
  const md = msgEl.querySelector?.('div.markdown');
  if (md) return (md.innerText || md.textContent || '').trim();

  const prose = msgEl.querySelector?.('div.prose');
  if (prose) return (prose.innerText || prose.textContent || '').trim();

  return (msgEl.innerText || msgEl.textContent || '').trim();
}

function getConversationIdFromLocation() {
  const m = location.pathname.match(/\/c\/([^\/?#]+)/);
  return m ? m[1] : "";
}

function startChatMirror() {
  const root = getThreadRoot();
  if (!root) {
    __bridgeEmitError("content", "mirror", new Error("Thread root not found."), {});
    return;
  }

  const seen = new WeakSet();

  function scanAndEmit() {
    try {
      const nodes = Array.from(root.querySelectorAll('[data-message-author-role]')).filter(isVisible);
      for (const el of nodes) {
        if (seen.has(el)) continue;
        const role = el.getAttribute('data-message-author-role');
        if (role !== 'assistant' && role !== 'user') continue;
        const text = extractMessageText(el);
        seen.add(el);
        if (!text) continue;
        try {
          chrome.runtime.sendMessage({
            type: "chat_message",
            role,
            text,
            url: location.href,
            conversationId: getConversationIdFromLocation()
          }).catch(() => {});
        } catch {}
      }
    } catch (e) {
      __bridgeEmitError("content", "mirror", e, {});
    }
  }

  // Initial scan
  scanAndEmit();

  const obs = new MutationObserver(() => {
    try {
      clearTimeout(obs.__t);
      obs.__t = setTimeout(scanAndEmit, 120);
    } catch (e) {
      __bridgeEmitError("content", "mirror", e, {});
    }
  });
  try {
    obs.observe(root, { childList: true, subtree: true });
  } catch (e) {
    __bridgeEmitError("content", "mirror", e, {});
  }
}

try { startChatMirror(); } catch {}

function findLastAssistantText() {
  const root = getThreadRoot();

  const bubbles = Array.from(root.querySelectorAll('[data-message-author-role="assistant"]')).filter(isVisible);
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const t = extractMessageText(bubbles[i]);
    if (t) return t;
  }

  // Fallback: article -> assistant bubble
  const articles = Array.from(root.querySelectorAll('[role="article"]')).filter(isVisible);
  for (let i = articles.length - 1; i >= 0; i--) {
    const bubble = articles[i].querySelector?.('[data-message-author-role="assistant"]');
    if (!bubble) continue;
    const t = extractMessageText(bubble);
    if (t) return t;
  }

  return '';
}

let pickActive = false;
let pickCleanup = null;

function startPickMode(sendResponse) {
  if (pickActive) {
    sendResponse({ ok: false, error: 'Pick mode already active.' });
    return;
  }

  pickActive = true;

  const overlay = document.createElement('div');
  overlay.id = '__chatgpt_bridge_pick_overlay__';
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
    background: rgba(0,0,0,0.0);
  `;

  const badge = document.createElement('div');
  badge.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 2147483647;
    background: rgba(0,0,0,0.75);
    color: white;
    padding: 10px 12px;
    border-radius: 10px;
    font: 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    pointer-events: auto;
  `;
  badge.textContent = 'Pick mode: click a message bubble to capture (Esc to cancel)';

  overlay.appendChild(badge);
  document.documentElement.appendChild(overlay);

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      cleanup();
      sendResponse({ ok: false, error: 'Pick cancelled.' });
    }
  };

  const onClick = (ev) => {
    try {
      ev.preventDefault();
      ev.stopPropagation();
    } catch {}

    const target = ev.target;
    if (!target) return;

    // Ignore clicks on our own overlay UI.
    try {
      if (target.closest && target.closest('#__chatgpt_bridge_pick_overlay__')) return;
    } catch {}

    // Locate nearest message container first.
    const msgNode =
      target.closest?.('[data-message-author-role]') ||
      target.closest?.('[role="article"]') ||
      null;

    let text = '';
    if (msgNode) text = extractMessageText(msgNode);
    if (!text) text = (target.innerText || target.textContent || '').trim();

    cleanup();
    sendResponse({ ok: true, text });
  };

  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);

  const timer = setTimeout(() => {
    cleanup();
    try { sendResponse({ ok: false, error: 'Pick timed out.' }); } catch {}
  }, 30000);

  function cleanup() {
    if (!pickActive) return;
    pickActive = false;
    clearTimeout(timer);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    try { overlay.remove(); } catch {}
    pickCleanup = null;
  }

  pickCleanup = cleanup;
}

function insertIntoComposer(text, sendResponse) {
  const comp = findComposer();
  if (!comp) {
    sendResponse({ ok: false, error: 'Composer input not found.' });
    return;
  }

  try {
    if (comp.type === 'textarea') {
      const ta = comp.el;
      ta.focus();
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      sendResponse({ ok: true });
      return;
    }

    const ed = comp.el;
    ed.focus();

    // Prefer a more "real input" path for ProseMirror-like editors.
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges();
      sel.addRange(range);

      document.execCommand('insertText', false, text);
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }));
      sendResponse({ ok: true });
      return;
    } catch {
      // Fallback
      ed.textContent = text;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      sendResponse({ ok: true });
      return;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
}

async function insertAndSend(text, expectedConversationId) {
  const t = String(text || "");
  if (!t.trim()) throw new Error("Empty text.");

  const expected = String(expectedConversationId || "");
  if (expected) {
    const m = location.pathname.match(/\/c\/([^\/]+)/);
    const actual = m ? m[1] : "";
    if (actual && actual !== expected) {
      throw new Error(`Conversation mismatch. Expected ${expected} but page is ${actual}.`);
    }
  }

  const comp = findComposer();
  if (!comp) throw new Error("Composer input not found.");

  if (comp.type === 'textarea') {
    const ta = comp.el;
    ta.focus();
    ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const ed = comp.el;
    ed.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges();
      sel.addRange(range);

      document.execCommand('insertText', false, t);
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } catch {
      ed.textContent = t;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Wait briefly for send button to become enabled, then click it.
  let btn = null;
  for (let i = 0; i < 20; i++) {
    btn = findSendButton();
    if (btn && isVisible(btn)) {
      const disabled = !!btn.disabled || btn.getAttribute('aria-disabled') === 'true';
      if (!disabled) break;
    }
    await sleep(100);
  }
  btn = findSendButton();
  if (!btn || !isVisible(btn)) throw new Error("Send button not found.");
  if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') throw new Error("Send button is disabled.");

  btn.click();
  return true;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function dispatchDragEvent(target, type, dataTransfer) {
  let ev;
  try {
    ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
  } catch {
    ev = new Event(type, { bubbles: true, cancelable: true });
    try { Object.defineProperty(ev, "dataTransfer", { value: dataTransfer }); } catch {}
  }
  target.dispatchEvent(ev);
}

function dropFiles(target, files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  dispatchDragEvent(target, "dragenter", dt);
  dispatchDragEvent(target, "dragover", dt);
  dispatchDragEvent(target, "drop", dt);
}

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findChatDropTarget() {
  // Derived from the sample HTML snapshots: the composer is typically a form
  // around the prompt textarea/contenteditable.
  const form = document.querySelector('form[data-type="unified-composer"]');
  if (form && isVisible(form)) return form;

  const prompt = document.querySelector('#prompt-textarea') || document.querySelector('[data-testid="prompt-textarea"]');
  if (prompt && isVisible(prompt)) {
    const f = prompt.closest('form');
    return f && isVisible(f) ? f : prompt;
  }

  // Last resort: any visible form that contains a textarea or contenteditable.
  const forms = Array.from(document.querySelectorAll('form'));
  for (const ff of forms) {
    if (!isVisible(ff)) continue;
    if (ff.querySelector('textarea') || ff.querySelector('[contenteditable="true"]')) return ff;
  }
  return null;
}

function findProjectDialog() {
  const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isVisible);
  for (const d of dialogs) {
    if (d.querySelector('input[type="file"]')) return d;
  }
  return dialogs[0] || null;
}

function findProjectFileInput(dialog) {
  if (!dialog) return null;
  const input = dialog.querySelector('input[type="file"]');
  if (input) return input;
  // Fallback: sometimes the input is outside the dialog but anchored near it.
  const global = document.querySelector('input[type="file"]');
  if (global && isVisible(global)) return global;
  return null;
}

async function fetchAsFile(item) {
  if (item && item.b64) {
    // Base64 (no data: prefix): VS Code already read the bytes.
    const bin = atob(String(item.b64));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type = item.mime || "application/octet-stream";
    return new File([bytes], item.filename || "artifact", { type });
  }

  if (!item || !item.url) throw new Error("Missing file URL (or b64).");
  const resp = await fetch(item.url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.status}`);
  const blob = await resp.blob();
  const type = item.mime || blob.type || "application/octet-stream";
  return new File([blob], item.filename || "artifact", { type });
}

async function uploadBatchToChat(items) {
  const form = findComposerFormEl();
  const input = findChatFileInput();
  if (!form || !input) {
    const s = getPageState();
    throw new Error(
      "Chat file input not found. Ensure you're logged in and the composer is visible. " +
        `url=${s.url}, composer=${s.composer}, fileInputs=${s.fileInputs}, sendBtns=${s.sendBtns}, loginDetected=${s.loginDetected}`
    );
  }

  const files = [];
  for (const it of items) files.push(await fetchAsFile(it));

  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);

  try {
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    // Some builds treat input.files as read-only. As a last resort, try drag&drop.
    const target = findChatDropTarget();
    if (!target) throw new Error("Chat composer found, but cannot attach files (no drop target). " + String(e));
    dropFiles(target, files);
  }
  return files.length;
}

async function uploadBatchToProject(items) {
  const dialog = findProjectDialog();
  if (!dialog) throw new Error("Project upload dialog not found. Open the Project → Files panel (or upload dialog) first.");

  const files = [];
  for (const it of items) files.push(await fetchAsFile(it));

  const input = findProjectFileInput(dialog);
  if (input) {
    // Prefer file input change, because some dialogs ignore drag&drop.
    if (input.multiple || files.length === 1) {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      try {
        input.files = dt.files;
      } catch {
        // Read-only; fallback to drag&drop
        dropFiles(dialog, files);
        return files.length;
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return files.length;
    }

    // Non-multiple input: send sequentially.
    for (const f of files) {
      const dt = new DataTransfer();
      dt.items.add(f);
      try {
        input.files = dt.files;
      } catch {
        dropFiles(dialog, [f]);
        await sleep(400);
        continue;
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(400);
    }
    return files.length;
  }

  // Fallback: drag&drop onto the dialog.
  dropFiles(dialog, files);
  return files.length;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getSelection') {
    const text = window.getSelection ? String(window.getSelection().toString() || '') : '';
    sendResponse({ ok: true, text });
    return true;
  }

  if (msg.type === 'getLastAssistant') {
    const text = findLastAssistantText();
    sendResponse({ ok: true, text });
    return true;
  }

  if (msg.type === 'getOuterHtml') {
    const html = document.documentElement.outerHTML;
    sendResponse({ ok: true, html });
    return true;
  }

  if (msg.type === 'pickMessage') {
    startPickMode(sendResponse);
    return true;
  }

  if (msg.type === 'insertIntoComposer') {
    insertIntoComposer(String(msg.text || ''), sendResponse);
    return true;
  }

  if (msg.type === 'insertAndSend') {
    (async () => {
      try {
        const expected = String(msg.expectedConversationId || "");
        await insertAndSend(String(msg.text || ""), expected);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), debug: getPageState() });
      }
    })();
    return true;
  }

  if (msg.type === 'ping') {
    sendResponse({ ok: true, state: getPageState() });
    return true;
  }

  if (msg.type === 'uploadFilesBatch') {
    (async () => {
      try {
        const expected = String(msg.expectedConversationId || "");
        if (expected) {
          const m = location.pathname.match(/\/c\/([^\/]+)/);
          const actual = m ? m[1] : "";
          if (actual && actual !== expected) {
            sendResponse({ ok: false, error: `Conversation mismatch. Expected ${expected} but page is ${actual}.`, debug: getPageState() });
            return;
          }
        }

        const target = msg.target === "project" ? "project" : "chat";
        const items = Array.isArray(msg.items) ? msg.items : (Array.isArray(msg.files) ? msg.files : []);
        if (items.length === 0) {
          sendResponse({ ok: false, error: "No items.", debug: getPageState() });
          return;
        }

        let uploaded = 0;
        if (target === "chat") uploaded = await uploadBatchToChat(items);
        else uploaded = await uploadBatchToProject(items);

        sendResponse({ ok: true, uploaded });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), debug: getPageState() });
      }
    })();
    return true;
  }

  if (msg.type === 'uploadArtifactsBatch') {
    (async () => {
      try {
        const expected = String(msg.expectedConversationId || "");
        if (expected) {
          const m = location.pathname.match(/\/c\/([^\/]+)/);
          const actual = m ? m[1] : "";
          if (actual && actual !== expected) {
            sendResponse({ ok: false, error: `Conversation mismatch. Expected ${expected} but page is ${actual}.`, debug: getPageState() });
            return;
          }
        }

        const target = msg.target === "project" ? "project" : "chat";
        const items = Array.isArray(msg.items) ? msg.items : [];
        if (items.length === 0) {
          sendResponse({ ok: false, error: "No items." });
          return;
        }

        let uploaded = 0;
        if (target === "chat") uploaded = await uploadBatchToChat(items);
        else uploaded = await uploadBatchToProject(items);

        sendResponse({ ok: true, uploaded });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), debug: getPageState() });
      }
    })();
    return true;
  }

  sendResponse({ ok: false, error: 'unknown message' });
  return true;
});
