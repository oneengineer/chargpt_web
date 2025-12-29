import * as vscode from "vscode";

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
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "chatgptBridge.panel",
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")] }
    );

    this.panel.onDidDispose(() => this.panel = undefined);

    const styleUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "panel.css"));

    this.panel.webview.html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <header>
    <div class="title">ChatGPT Web Bridge (Manual)</div>
    <div class="subtitle">Manual fetch/push • Offscreen keepalive (Chrome) • Task state machine • Workspace bundler</div>
  </header>

  <main>
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
      <h2>Chat Sessions (Cursor-like)</h2>
      <div class="row">
        <div id="sessionTabs" class="tabs"></div>
        <button id="newSession">New</button>
      </div>
      <div id="sessionMeta" class="muted"></div>
      <div class="row">
        <button id="openSession">Open/Sync Browser Tab</button>
        <button id="sendFilesChat">Send Files (Chat)</button>
        <button id="sendFilesProject">Send Files (Project)</button>
      </div>
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
      <h2>Messages</h2>
      <div class="row">
        <button id="clearMessages">Clear</button>
      </div>
      <div id="messages" class="list"></div>
    </section>
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    const state = { lastPrompt: "", activeSessionId: null };

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

    function renderSessions(sessions, activeId, lastTargetUrl) {
      const el = document.getElementById('sessionTabs');
      const meta = document.getElementById('sessionMeta');
      el.innerHTML = '';

      if (!Array.isArray(sessions) || sessions.length === 0) {
        meta.textContent = 'No sessions. Click New to create one. ' + (lastTargetUrl ? ('Last URL: ' + lastTargetUrl) : '');
        return;
      }

      let active = null;
      for (const s of sessions) {
        if (s.id === activeId) active = s;

        const wrap = document.createElement('div');
        wrap.className = 'tabWrap';

        const btn = document.createElement('button');
        btn.className = 'tab' + (s.id === activeId ? ' active' : '');
        btn.textContent = s.name;
        btn.title = s.projectUrl || '';
        btn.addEventListener('click', () => vscode.postMessage({ type: 'session_select', id: s.id }));
        wrap.appendChild(btn);

        const close = document.createElement('button');
        close.className = 'tabClose';
        close.textContent = '×';
        close.title = 'Close session (also closes browser tab)';
        close.addEventListener('click', (ev) => {
          ev.stopPropagation();
          vscode.postMessage({ type: 'session_close', id: s.id });
        });
        wrap.appendChild(close);

        el.appendChild(wrap);
      }

      if (!active) active = sessions[0];

      const parts = [];
      parts.push('Active: ' + (active?.name || '')); 
      if (active?.projectId) parts.push('Project: ' + active.projectId);
      parts.push('Conversation: ' + (active?.conversationId || '(not bound yet)'));
      if (active?.projectUrl) parts.push('URL: ' + active.projectUrl);
      meta.textContent = parts.join(' • ');
    }

    function renderMessages(messages) {
      const el = document.getElementById('messages');
      el.innerHTML = '';
      for (const m of messages.slice().reverse()) {
        const row = document.createElement('div');
        row.className = 'item';
        const meta = \`\${m.direction} • \${m.kind} • \${new Date(m.ts).toLocaleString()}\`;
        const page = m.page?.url ? \`<div class=\"itemDesc\"><a href=\"\${m.page.url}\" target=\"_blank\">\${escapeHtml(m.page.url)}</a></div>\` : '';
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

    function showPrompt(text) {
      state.lastPrompt = text;
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
        state.activeSessionId = msg.activeSessionId || null;
        document.getElementById('port').textContent = msg.port ?? '-';
        document.getElementById('clients').textContent = String(msg.clients ?? 0);
        renderSessions(msg.sessions ?? [], msg.activeSessionId, msg.lastTargetUrl);
        renderTasks(msg.tasks ?? []);
        renderMessages(msg.messages ?? []);
      }
      if (msg.type === 'next_prompt') {
        showPrompt(msg.text);
      }
    });

    document.getElementById('sendToChrome').addEventListener('click', () => {
      const text = document.getElementById('pushText').value || '';
      vscode.postMessage({ type: 'push_to_chrome', text });
      document.getElementById('pushText').value = '';
    });

    document.getElementById('newSession').addEventListener('click', () => vscode.postMessage({ type: 'session_new' }));
    document.getElementById('openSession').addEventListener('click', () => vscode.postMessage({ type: 'session_open', id: state.activeSessionId }));
    document.getElementById('sendFilesChat').addEventListener('click', () => vscode.postMessage({ type: 'session_send_files', id: state.activeSessionId, target: 'chat' }));
    document.getElementById('sendFilesProject').addEventListener('click', () => vscode.postMessage({ type: 'session_send_files', id: state.activeSessionId, target: 'project' }));

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

    vscode.postMessage({ type: 'ui_ready' });
  </script>
</body>
</html>
    `;

    this.panel.webview.onDidReceiveMessage((msg) => this.onMessageFromUI(msg));
  }

  public postMessage(msg: any) {
    if (!this.panel) return;
    this.panel.webview.postMessage(msg);
  }
}


