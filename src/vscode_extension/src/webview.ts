import * as vscode from "vscode";

export function buildBridgeHtml(ctx: vscode.ExtensionContext, webview: vscode.Webview): string {
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "panel.css"));
  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <header class="topHeader">
    <div class="title">ChatGPT Web Bridge</div>
    <div class="subtitle">Control + Chat tabs • Manual bridge + auto tab routing</div>
  </header>

  <div class="tabBar">
    <button id="tab_control" class="topTab active">Control</button>
    <div id="topSessionTabs" class="topTabs"></div>
    <button id="tab_plus" class="topTab plus" title="New chat tab">+</button>
  </div>

  <main>
    <!-- Control Tab -->
    <div id="viewControl" class="view">
    <section class="card">
      <h2>Bridge</h2>
      <div class="row">
        <div><span class="label">Port:</span> <span id="port">-</span></div>
        <div><span class="label">Clients:</span> <span id="clients">0</span></div>
      </div>
      <div class="row">
        <input id="pushText" placeholder="Send a message to Chrome (manual use)" />
        <button id="sendToChrome">Send</button>
      </div>
    </section>

    <section class="card">
        <h2>Sessions</h2>
      <div class="row">
          <button id="newSessionEmpty">+ New Chat Tab</button>
          <button id="newSession">New (paste URL)</button>
      </div>
      <div id="sessionMeta" class="muted"></div>
        <div id="sessionList" class="list"></div>
    </section>

    <section class="card">
      <h2>Tasks (State Machine)</h2>
      <div class="row">
        <input id="taskTitle" placeholder="New task title" />
        <input id="taskDesc" placeholder="Description (optional)" />
        <button id="addTask">Add</button>
      </div>
      <div id="taskList" class="list"></div>
      <div id="nextPrompt" class="prompt hidden">
        <div class="promptHeader">
          <div class="promptTitle">Next Prompt Template</div>
          <div class="promptActions">
            <button id="copyPrompt">Copy</button>
            <button id="sendPrompt">Send to Chrome</button>
            <button id="closePrompt">Close</button>
          </div>
        </div>
        <textarea id="promptText" rows="10"></textarea>
      </div>
    </section>

    <section class="card">
        <h2>Messages (All)</h2>
      <div class="row">
        <button id="clearMessages">Clear</button>
      </div>
      <div id="messages" class="list"></div>
    </section>
    </div>

    <!-- Chat Tab -->
    <div id="viewChat" class="view hidden">
      <section class="card">
        <div class="chatHeader">
          <div>
            <div id="chatTitle" class="chatTitle">Chat</div>
            <div id="chatSub" class="muted"></div>
          </div>
          <div class="chatHeaderActions">
            <button id="chatSetUrl" title="Set / update ChatGPT URL for this tab">Set URL</button>
            <button id="chatOpen" title="Open/Sync browser tab">Open</button>
            <button id="chatSendFilesChat" title="Upload files to Chat attachments">Files(Chat)</button>
            <button id="chatSendFilesProject" title="Upload files to Project">Files(Project)</button>
          </div>
        </div>
      </section>

      <div id="chatError" class="error hidden"></div>

      <section class="card chatCard">
        <div id="chatMessages" class="chatMessages"></div>
        <div class="chatComposer">
          <button id="chatAtFile" class="chatAt" title="Attach files (like ChatGPT +)">@</button>
          <div id="chatAttachments" class="chatAttachments"></div>
          <textarea id="chatInput" rows="3" placeholder="Type a message..."></textarea>
          <button id="chatSend">Send</button>
        </div>
      </section>
    </div>
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    const ui = {
      lastPrompt: "",
      activeSessionId: null,
      activeTab: "control", // "control" | sessionId
      sessions: [],
      messages: [],
      openedSessionIds: new Set(),
      chatThreads: {},
      pendingAttachments: []
    };

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function normalizeUrl(u) {
      try {
        const x = new URL(u);
        x.hash = "";
        x.search = "";
        return x.toString();
      } catch { return String(u || ""); }
    }

    function msgMatchesSession(m, session) {
      if (!session) return false;
      const sUrl = normalizeUrl(session.projectUrl || "");
      const sPid = String(session.projectId || "");
      const sCid = String(session.conversationId || "");

      const pageUrl = normalizeUrl(m?.page?.url || "");
      if (pageUrl) {
        if (sCid && pageUrl.includes('/c/' + sCid)) return true;
        if (sPid && pageUrl.includes(sPid)) return true;
        if (sUrl && (pageUrl.startsWith(sUrl) || sUrl.startsWith(pageUrl))) return true;
      }

      const data = String(m?.data || "");
      if (sPid && data.includes(sPid)) return true;
      if (sUrl && data.includes(sUrl)) return true;
      if (session.name && data.includes(session.name)) return true;
      return false;
    }

    function setActiveTab(tabId) {
      ui.activeTab = tabId || "control";
      document.getElementById('tab_control').classList.toggle('active', ui.activeTab === 'control');
      document.querySelectorAll('#topSessionTabs button[data-sid]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-sid') === ui.activeTab);
      });

      document.getElementById('viewControl').classList.toggle('hidden', ui.activeTab !== 'control');
      document.getElementById('viewChat').classList.toggle('hidden', ui.activeTab === 'control');

      if (ui.activeTab !== 'control') renderChat(ui.activeTab);
    }

    function renderTasks(tasks) {
      const el = document.getElementById('taskList');
      el.innerHTML = '';
      for (const t of tasks) {
        const row = document.createElement('div');
        row.className = 'item ' + t.status;
        row.innerHTML = \`
          <div class="itemMain">
            <div class="itemTitle">\${escapeHtml(t.title)}</div>
            \${t.description ? '<div class="itemDesc">' + escapeHtml(t.description) + '</div>' : ''}
          </div>
          <div class="itemMeta">
            <span class="badge">\${t.status}</span>
            \${t.status !== 'done' ? '<button data-done=\"' + t.id + '\">Done</button>' : ''}
          </div>
        \`;
        el.appendChild(row);
      }
      el.querySelectorAll('button[data-done]').forEach(btn => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'task_done', id: btn.getAttribute('data-done') });
        });
      });
    }

    function sessionStatusDot(s) {
      // Phase 3 will improve; for now:
      if (!s.projectUrl) return 'dot gray';
      if (!s.conversationId) return 'dot yellow';
      return 'dot green';
    }

    function renderTopTabs(sessions) {
      const el = document.getElementById('topSessionTabs');
      el.innerHTML = '';

      for (const s of sessions) {
        const btn = document.createElement('button');
        btn.className = 'topTab';
        btn.textContent = s.name || 'Chat';
        btn.title = s.projectUrl || '(no url yet)';
        btn.setAttribute('data-sid', s.id);

        const dot = document.createElement('span');
        dot.className = sessionStatusDot(s);
        btn.prepend(dot);

        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'session_activate', id: s.id });
          // Option 2: open browser tab on first click if url exists
          if (s.projectUrl && !ui.openedSessionIds.has(s.id)) {
            ui.openedSessionIds.add(s.id);
            vscode.postMessage({ type: 'session_open', id: s.id });
          }
          setActiveTab(s.id);
        });
        el.appendChild(btn);
      }
    }

    function renderSessionsControl(sessions, activeId, lastTargetUrl) {
      const meta = document.getElementById('sessionMeta');
      if (!Array.isArray(sessions) || sessions.length === 0) {
        meta.textContent = 'No sessions. Click + New Chat Tab to create one. ' + (lastTargetUrl ? ('Last URL: ' + lastTargetUrl) : '');
        document.getElementById('sessionList').innerHTML = '';
        return;
      }

      let active = null;
      for (const s of sessions) if (s.id === activeId) active = s;
      if (!active) active = sessions[0];

      const parts = [];
      parts.push('Active: ' + (active?.name || '')); 
      if (active?.projectId) parts.push('Project: ' + active.projectId);
      parts.push('Conversation: ' + (active?.conversationId || '(not bound yet)'));
      if (active?.projectUrl) parts.push('URL: ' + active.projectUrl);
      meta.textContent = parts.join(' • ');

      const list = document.getElementById('sessionList');
      list.innerHTML = '';
      for (const s of sessions) {
        const row = document.createElement('div');
        row.className = 'sessionRow' + (s.id === activeId ? ' active' : '');
        const dot = \`<span class="\${sessionStatusDot(s)}"></span>\`;
        const url = s.projectUrl ? escapeHtml(s.projectUrl) : '(no url)';
        row.innerHTML = \`
          <div class="sessionMain">
            <div class="sessionTitle">\${dot} \${escapeHtml(s.name || 'Chat')}</div>
            <div class="sessionDesc mono">\${url}</div>
          </div>
          <div class="sessionActions">
            <button data-act="open" data-id="\${s.id}">Open</button>
            <button data-act="chat" data-id="\${s.id}">Files(Chat)</button>
            <button data-act="project" data-id="\${s.id}">Files(Project)</button>
            <button data-act="close" data-id="\${s.id}">×</button>
          </div>
        \`;
        row.addEventListener('click', (ev) => {
          const btn = ev.target?.closest?.('button[data-act]');
          if (btn) return;
          vscode.postMessage({ type: 'session_activate', id: s.id });
          setActiveTab(s.id);
        });
        list.appendChild(row);
      }

      list.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const act = btn.getAttribute('data-act');
          const sid = btn.getAttribute('data-id');
          if (!sid) return;
          if (act === 'open') vscode.postMessage({ type: 'session_open', id: sid });
          else if (act === 'chat') vscode.postMessage({ type: 'session_send_files', id: sid, target: 'chat' });
          else if (act === 'project') vscode.postMessage({ type: 'session_send_files', id: sid, target: 'project' });
          else if (act === 'close') vscode.postMessage({ type: 'session_close', id: sid });
        });
      });
    }

    function renderMessages(messages) {
      const el = document.getElementById('messages');
      el.innerHTML = '';
      for (const m of messages.slice().reverse()) {
        const row = document.createElement('div');
        row.className = 'item';
        const meta = \`\${m.direction} • \${m.kind} • \${new Date(m.ts).toLocaleString()}\`;
        const page = m.page?.url ? \`<div class="itemDesc"><a href="\${m.page.url}" target="_blank">\${escapeHtml(m.page.url)}</a></div>\` : '';
        row.innerHTML = \`
          <div class="itemMain">
            <div class="itemTitle">\${escapeHtml(meta)}</div>
            <div class="itemDesc mono">\${escapeHtml(m.data).slice(0, 2000)}</div>
            \${page}
          </div>
        \`;
        el.appendChild(row);
      }
    }

    function renderChat(sessionId) {
      const session = (ui.sessions || []).find(s => s.id === sessionId);
      const title = document.getElementById('chatTitle');
      const sub = document.getElementById('chatSub');
      const err = document.getElementById('chatError');
      err.classList.add('hidden');
      err.textContent = '';

      if (!session) {
        title.textContent = 'Chat';
        sub.textContent = 'Session not found.';
        document.getElementById('chatMessages').innerHTML = '';
        return;
      }

      title.textContent = session.name || 'Chat';
      const parts = [];
      parts.push(session.projectUrl ? session.projectUrl : '(no url yet)');
      parts.push('Conversation: ' + (session.conversationId || '(not bound)'));
      sub.textContent = parts.join(' • ');

      // Last error for this session
      const errors = (ui.messages || []).filter(m => m.kind === 'event:error' && msgMatchesSession(m, session));
      if (errors.length > 0) {
        const last = errors[errors.length - 1];
        err.textContent = String(last.data || '');
        err.classList.remove('hidden');
      }

      const box = document.getElementById('chatMessages');
      box.innerHTML = '';
      const thread = (ui.chatThreads && ui.chatThreads[sessionId]) ? ui.chatThreads[sessionId] : [];
      for (const m of thread) {
        const wrap = document.createElement('div');
        const dir = m.role === 'user' ? 'to' : 'from';
        wrap.className = 'chatMsg ' + dir;
        wrap.innerHTML = \`
          <div class="bubble">\${escapeHtml(String(m.text || '')).slice(0, 20000)}</div>
        \`;
        box.appendChild(wrap);
      }
      box.scrollTop = box.scrollHeight;
    }

    function renderAttachmentChips() {
      const el = document.getElementById('chatAttachments');
      if (!el) return;
      const files = Array.isArray(ui.pendingAttachments) ? ui.pendingAttachments : [];
      el.innerHTML = '';
      for (const p of files) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const name = String(p).split('/').slice(-1)[0] || String(p);
        chip.textContent = name;
        chip.title = String(p);
        const x = document.createElement('button');
        x.className = 'chipX';
        x.textContent = '×';
        x.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          ui.pendingAttachments = (ui.pendingAttachments || []).filter(z => z !== p);
          renderAttachmentChips();
        });
        chip.appendChild(x);
        el.appendChild(chip);
      }
    }

    function showPrompt(text) {
      ui.lastPrompt = text;
      const box = document.getElementById('nextPrompt');
      box.classList.remove('hidden');
      document.getElementById('promptText').value = text;
    }

    function hidePrompt() {
      document.getElementById('nextPrompt').classList.add('hidden');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        ui.activeSessionId = msg.activeSessionId || null;
        ui.sessions = msg.sessions ?? [];
        ui.messages = msg.messages ?? [];
        ui.chatThreads = msg.chatThreads ?? {};
        document.getElementById('port').textContent = msg.port ?? '-';
        document.getElementById('clients').textContent = String(msg.clients ?? 0);
        renderTopTabs(msg.sessions ?? []);
        renderSessionsControl(msg.sessions ?? [], msg.activeSessionId, msg.lastTargetUrl);
        renderTasks(msg.tasks ?? []);
        renderMessages(msg.messages ?? []);

        // Keep active tab valid
        if (ui.activeTab !== 'control' && !ui.sessions.some(s => s.id === ui.activeTab)) {
          ui.activeTab = 'control';
        }
        setActiveTab(ui.activeTab);
      }
      if (msg.type === 'next_prompt') {
        showPrompt(msg.text);
      }
      if (msg.type === 'files_picked') {
        const sid = String(msg.id || '');
        if (!sid || sid !== ui.activeTab) return;
        const files = Array.isArray(msg.files) ? msg.files.map(String) : [];
        ui.pendingAttachments = [...(ui.pendingAttachments || []), ...files].slice(0, 20);
        renderAttachmentChips();
      }
    });

    document.getElementById('sendToChrome').addEventListener('click', () => {
      const text = document.getElementById('pushText').value || '';
      vscode.postMessage({ type: 'push_to_chrome', text });
      document.getElementById('pushText').value = '';
    });

    document.getElementById('newSession').addEventListener('click', () => vscode.postMessage({ type: 'session_new' }));
    document.getElementById('newSessionEmpty').addEventListener('click', () => vscode.postMessage({ type: 'session_new_empty' }));

    document.getElementById('addTask').addEventListener('click', () => {
      const title = document.getElementById('taskTitle').value || '';
      const description = document.getElementById('taskDesc').value || '';
      vscode.postMessage({ type: 'task_add', title, description });
      document.getElementById('taskTitle').value = '';
      document.getElementById('taskDesc').value = '';
    });

    document.getElementById('clearMessages').addEventListener('click', () => vscode.postMessage({ type: 'clear_messages' }));

    document.getElementById('copyPrompt').addEventListener('click', () => vscode.postMessage({ type: 'copy_prompt', text: document.getElementById('promptText').value }));
    document.getElementById('sendPrompt').addEventListener('click', () => vscode.postMessage({ type: 'push_to_chrome', text: document.getElementById('promptText').value }));
    document.getElementById('closePrompt').addEventListener('click', hidePrompt);

    document.getElementById('tab_control').addEventListener('click', () => setActiveTab('control'));
    document.getElementById('tab_plus').addEventListener('click', () => vscode.postMessage({ type: 'session_new_empty' }));

    document.getElementById('chatOpen').addEventListener('click', () => {
      if (!ui.activeTab || ui.activeTab === 'control') return;
      vscode.postMessage({ type: 'session_open', id: ui.activeTab });
    });
    document.getElementById('chatSendFilesChat').addEventListener('click', () => {
      if (!ui.activeTab || ui.activeTab === 'control') return;
      vscode.postMessage({ type: 'session_send_files', id: ui.activeTab, target: 'chat' });
    });
    document.getElementById('chatSendFilesProject').addEventListener('click', () => {
      if (!ui.activeTab || ui.activeTab === 'control') return;
      vscode.postMessage({ type: 'session_send_files', id: ui.activeTab, target: 'project' });
    });
    document.getElementById('chatSetUrl').addEventListener('click', () => {
      if (!ui.activeTab || ui.activeTab === 'control') return;
      const s = (ui.sessions || []).find(x => x.id === ui.activeTab);
      const current = s?.projectUrl || '';
      const url = window.prompt('Paste ChatGPT project URL for this tab:', current);
      if (!url) return;
      vscode.postMessage({ type: 'session_set_url', id: ui.activeTab, url: String(url).trim() });
    });

    document.getElementById('chatAtFile').addEventListener('click', () => {
      if (!ui.activeTab || ui.activeTab === 'control') return;
      vscode.postMessage({ type: 'pick_files', id: ui.activeTab });
    });

    document.getElementById('chatSend').addEventListener('click', () => {
      if (!ui.activeTab || ui.activeTab === 'control') return;
      const text = document.getElementById('chatInput').value || '';
      const attachments = Array.isArray(ui.pendingAttachments) ? ui.pendingAttachments.slice() : [];
      if (!text.trim() && attachments.length === 0) return;
      vscode.postMessage({ type: 'chat_send', id: ui.activeTab, text, attachments });
      document.getElementById('chatInput').value = '';
      ui.pendingAttachments = [];
      renderAttachmentChips();
    });

    vscode.postMessage({ type: 'ui_ready' });
  </script>
</body>
</html>
    `;
}

export class BridgePanel {
  private panel?: vscode.WebviewPanel;
  private ctx: vscode.ExtensionContext;
  private onMessageFromUI: (msg: any) => void;

  constructor(ctx: vscode.ExtensionContext, onMessageFromUI: (msg: any) => void) {
    this.ctx = ctx;
    this.onMessageFromUI = onMessageFromUI;
  }

  public show(title: string) {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "chatgptBridge.panel",
      title,
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")]
      }
    );

    this.panel.onDidDispose(() => this.panel = undefined);

    this.panel.webview.html = buildBridgeHtml(this.ctx, this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessageFromUI(msg));
  }

  public postMessage(msg: any) {
    if (!this.panel) return;
    this.panel.webview.postMessage(msg);
  }
}
