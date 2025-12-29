import * as vscode from "vscode";
import * as crypto from "crypto";
import { BridgeServer } from "./bridgeServer";
import { BridgePanel } from "./webview";
import { BridgeInbound, PersistedState, SessionInfo, TargetSpec, UploadFileRef, UploadTarget } from "./types";
import { addTask, markDoneAndAdvance, promptTemplateFor } from "./taskMachine";
import { bundleWorkspace } from "./bundler";
import { downloadZipAndOpen, importLocalZipAndOpen } from "./zipTools";
import { ArtifactServer } from "./artifactServer";

let server: BridgeServer | undefined;
let panel: BridgePanel | undefined;
let artifactServer: ArtifactServer | undefined;

let output: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;

const PROJECT_CONFIG_FILE = ".chatgpt-bridge.json";

type LogLevel = "error" | "warn" | "info" | "debug";
const levelRank: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function getWorkspaceRootUri(): vscode.Uri | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri;
}

async function readProjectUrlFromConfigFile(): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const root = getWorkspaceRootUri();
  if (!root) return { ok: false, reason: "No workspace folder is open." };

  const uri = vscode.Uri.joinPath(root, PROJECT_CONFIG_FILE);
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(uri);
  } catch {
    return { ok: false, reason: `Missing ${PROJECT_CONFIG_FILE} at workspace root.` };
  }

  let obj: any;
  try {
    const text = Buffer.from(raw).toString("utf8");
    obj = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${PROJECT_CONFIG_FILE} is not valid JSON.` };
  }

  const url = String(obj?.projectUrl || "").trim();
  if (!url) return { ok: false, reason: `${PROJECT_CONFIG_FILE} is missing "projectUrl".` };
  return { ok: true, url };
}

function getCfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("chatgptBridge").get<T>(key, fallback);
}

function shouldNotify(): boolean {
  return getCfg<boolean>("showNotifications", true);
}

function getLogLevel(): LogLevel {
  return getCfg<LogLevel>("logLevel", "info");
}

function ensureOutput() {
  if (!output) output = vscode.window.createOutputChannel("ChatGPT Bridge");
  return output;
}

function log(level: LogLevel, message: string, detail?: any) {
  const current = getLogLevel();
  if (levelRank[level] > levelRank[current]) return;
  const ch = ensureOutput();
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  ch.appendLine(line);
  if (detail !== undefined) {
    try {
      ch.appendLine(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    } catch {
      ch.appendLine(String(detail));
    }
  }
}

function defaultState(): PersistedState {
  return {
    token: crypto.randomBytes(16).toString("hex"),
    tasks: [],
    sessions: [],
    messages: []
  };
}

function loadState(ctx: vscode.ExtensionContext): PersistedState {
  const s = ctx.globalState.get<PersistedState>("chatgptBridge.state");
  if (!s?.token) return defaultState();

  // Backward-compat for older versions.
  if (!Array.isArray((s as any).sessions)) (s as any).sessions = [];
  if (!Array.isArray((s as any).messages)) (s as any).messages = [];
  return s;
}

async function saveState(ctx: vscode.ExtensionContext, s: PersistedState) {
  await ctx.globalState.update("chatgptBridge.state", s);
}

function extractZipUrls(text: string): string[] {
  const urls: string[] = [];
  // Accept .zip and .zip?query patterns.
  const re = /(https?:\/\/[^\s'"<>]+?\.zip(?:\?[^\s'"<>]*)?)(\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) urls.push(m[1]);
  return urls;
}

function compactText(text: string, maxLen = 4000): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 64)) + `\n...[truncated ${text.length - (maxLen - 64)} chars]`;
}

function stripUrlNoise(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

function extractProjectId(url: string): string | undefined {
  // Covers ids like g-... and g-p-... found in /g/.../... URLs.
  const m = url.match(/\b(g-p-[A-Za-z0-9_-]+|g-[A-Za-z0-9_-]+)\b/);
  return m ? m[1] : undefined;
}

function extractConversationId(url: string): string | undefined {
  const m = url.match(/\/c\/([^\/?#]+)/);
  return m ? m[1] : undefined;
}

function defaultSessionName(projectUrl: string): string {
  const pid = extractProjectId(projectUrl);
  if (pid) return pid;
  try {
    const u = new URL(projectUrl);
    return u.pathname.split("/").filter(Boolean).slice(-2).join("/") || u.host;
  } catch {
    return projectUrl;
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  let state = loadState(ctx);

  // Output + Status bar are created eagerly so users have a clear debug surface.
  ensureOutput();
  if (!statusBar) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = "chatgptBridge.openPanel";
    statusBar.tooltip = "ChatGPT Bridge: Open panel";
    statusBar.show();
  }

  const getPort = () => vscode.workspace.getConfiguration("chatgptBridge").get<number>("port", 17321);
  const getArtifactPort = () => {
    const cfg = vscode.workspace.getConfiguration("chatgptBridge");
    const p = cfg.get<number>("artifactPort", getPort() + 1);
    return p;
  };

  const updateStatusBar = () => {
    if (!statusBar) return;
    const clients = server?.getClientCount?.() ?? 0;
    if (!server) {
      statusBar.text = "$(debug-disconnect) ChatGPT Bridge: stopped";
      return;
    }
    statusBar.text = clients > 0
      ? `$(debug-alt) ChatGPT Bridge: connected (${clients})`
      : "$(debug-disconnect) ChatGPT Bridge: waiting (0)";
  };

  const statusTimer = setInterval(updateStatusBar, 1000);
  ctx.subscriptions.push({ dispose: () => clearInterval(statusTimer) });
  updateStatusBar();

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("chatgptBridge.logLevel") || e.affectsConfiguration("chatgptBridge.showNotifications")) {
      log("info", `Configuration updated: logLevel=${getLogLevel()}, showNotifications=${shouldNotify()}`);
    }
  }));

  const ensureChromeClient = async (actionLabel: string): Promise<boolean> => {
    if (!server) {
      log("warn", `${actionLabel}: bridge server not started yet.`);
      return false;
    }
    const clients = server.getClientCount();
    if (clients > 0) return true;
    log("warn", `${actionLabel}: no Chrome clients connected (0).`);
    if (shouldNotify()) {
      vscode.window.showWarningMessage(
        "ChatGPT Bridge: Chrome extension is not connected yet. Open ChatGPT in Chrome, ensure the extension is enabled, then retry."
      );
    }
    return false;
  };

  const ensurePanel = () => {
    if (!panel) {
      panel = new BridgePanel(ctx, async (msg) => {
        if (msg?.type === "ui_ready") {
          pushStateToPanel();
          return;
        }
        if (msg?.type === "push_to_chrome") {
          const text = String(msg.text ?? "");
          if (!text.trim()) return;
          sendToChrome(text);
          return;
        }

        if (msg?.type === "session_select") {
          const sid = String(msg.id ?? "");
          await setActiveSession(sid || undefined);
          return;
        }

        if (msg?.type === "session_new") {
          const cfg = vscode.workspace.getConfiguration("chatgptBridge");
          const defaultUrl = cfg.get<string>("autoUploadTargetUrl", "") || state.lastTargetUrl || "";

          const projectUrl = await vscode.window.showInputBox({
            title: "ChatGPT Project URL",
            prompt: "Paste a chatgpt.com project entry URL (e.g. /g/.../project).",
            value: defaultUrl
          });
          if (!projectUrl?.trim()) return;

          // Remember default for future sessions.
          await cfg.update("autoUploadTargetUrl", projectUrl.trim(), vscode.ConfigurationTarget.Global);

          const name = await vscode.window.showInputBox({
            title: "Session Name (optional)",
            prompt: "Name shown in the Sessions bar (leave blank to use the project id).",
            value: ""
          });

          const s = await createSession(projectUrl.trim(), name || undefined);
          // Per spec: opening a new VS Code session should open a new browser tab (in background).
          await openSessionInBrowser(s);
          return;
        }

        if (msg?.type === "session_open") {
          const sid = String(msg.id ?? "");
          const s = getSession(sid) || getActiveSession();
          if (!s) {
            vscode.window.showErrorMessage("No session selected.");
            return;
          }
          await openSessionInBrowser(s);
          return;
        }

        if (msg?.type === "session_send_files") {
          const sid = String(msg.id ?? "");
          const target = String(msg.target ?? "chat") as UploadTarget;
          const s = getSession(sid) || getActiveSession();
          if (!s) {
            vscode.window.showErrorMessage("No session selected.");
            return;
          }
          await sendFilesToBrowser(s, target === "project" ? "project" : "chat");
          return;
        }

        if (msg?.type === "session_close") {
          const sid = String(msg.id ?? "");
          const s = getSession(sid);
          if (!s) return;

          await closeSessionInBrowser(s);

          state.sessions = state.sessions.filter((x) => x.id !== sid);
          if (state.activeSessionId === sid) {
            state.activeSessionId = state.sessions[0]?.id;
          }
          await saveState(ctx, state);
          pushStateToPanel();
          return;
        }
        if (msg?.type === "task_add") {
          const title = String(msg.title ?? "").trim();
          const desc = String(msg.description ?? "").trim();
          if (!title) return;
          const res = addTask(state.tasks, title, desc || undefined);
          state.tasks = res.tasks;
          await saveState(ctx, state);
          pushStateToPanel();

          // If this created the first in-progress task, show prompt
          const current = state.tasks.find(t => t.status === "in_progress");
          if (current && current.id === res.created.id) {
            const prompt = promptTemplateFor(current);
            panel?.postMessage({ type: "next_prompt", text: prompt });
            offerPromptActions(prompt);
          }
          return;
        }
        if (msg?.type === "task_done") {
          const id = String(msg.id ?? "");
          if (!id) return;
          const res = markDoneAndAdvance(state.tasks, id);
          state.tasks = res.tasks;
          await saveState(ctx, state);
          pushStateToPanel();

          if (res.next && res.next.status === "in_progress") {
            const prompt = promptTemplateFor(res.next);
            panel?.postMessage({ type: "next_prompt", text: prompt });
            offerPromptActions(prompt);
          } else {
            vscode.window.showInformationMessage("All tasks are done.");
          }
          return;
        }
        if (msg?.type === "copy_prompt") {
          const text = String(msg.text ?? "");
          if (!text) return;
          await vscode.env.clipboard.writeText(text);
          vscode.window.showInformationMessage("Prompt copied to clipboard.");
          return;
        }
        if (msg?.type === "clear_messages") {
          state.messages = [];
          await saveState(ctx, state);
          pushStateToPanel();
          return;
        }
      });
    }
    panel.show("ChatGPT Bridge");
  };

  const pushStateToPanel = () => {
    panel?.postMessage({
      type: "state",
      port: server?.getPort() ?? getPort(),
      clients: server?.getClientCount() ?? 0,
      token: "",
      tasks: state.tasks,
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      lastTargetUrl: state.lastTargetUrl,
      messages: state.messages
    });
  };

  const ensureHasSession = () => {
    if (!state.activeSessionId && state.sessions.length > 0) {
      state.activeSessionId = state.sessions[0].id;
    }
  };

  const setActiveSession = async (sessionId?: string) => {
    state.activeSessionId = sessionId;
    await saveState(ctx, state);
    pushStateToPanel();
  };

  const createSession = async (projectUrl: string, name?: string): Promise<SessionInfo> => {
    const now = Date.now();
    const url = stripUrlNoise(projectUrl);
    const s: SessionInfo = {
      id: crypto.randomBytes(8).toString("hex"),
      name: name?.trim() || defaultSessionName(url),
      projectUrl: url,
      projectId: extractProjectId(url),
      conversationId: extractConversationId(url),
      createdAt: now,
      lastUsedAt: now
    };
    state.sessions.unshift(s);
    state.activeSessionId = s.id;
    state.lastTargetUrl = url;
    await saveState(ctx, state);
    pushStateToPanel();
    return s;
  };

  const getSession = (sessionId?: string) => {
    if (!sessionId) return undefined;
    return state.sessions.find((s) => s.id === sessionId);
  };

  const getActiveSession = () => {
    ensureHasSession();
    return getSession(state.activeSessionId);
  };

  const openSessionInBrowser = async (session: SessionInfo) => {
    ensureServer();
    if (!(await ensureChromeClient("Open/Sync Browser Tab"))) return;
    const target: TargetSpec = {
      url: session.projectUrl,
      sessionId: session.id,
      projectId: session.projectId,
      conversationId: session.conversationId
    };
    server!.broadcast({ type: "vscode_push", kind: "session_open", target, ts: Date.now() });
    state.messages.push({ direction: "to_browser", kind: "session_open", data: `${session.name} -> ${session.projectUrl}`, ts: Date.now() });
    if (state.messages.length > 200) state.messages.shift();
    session.lastUsedAt = Date.now();
    await saveState(ctx, state);
    pushStateToPanel();
  };

  const closeSessionInBrowser = async (session: SessionInfo) => {
    ensureServer();
    if (!(await ensureChromeClient("Close Browser Tab"))) return;
    const target: TargetSpec = {
      url: session.projectUrl,
      sessionId: session.id,
      projectId: session.projectId,
      conversationId: session.conversationId
    };
    server!.broadcast({ type: "vscode_push", kind: "session_close", target, ts: Date.now() });
    state.messages.push({ direction: "to_browser", kind: "session_close", data: `${session.name}`, ts: Date.now() });
    if (state.messages.length > 200) state.messages.shift();
    await saveState(ctx, state);
    pushStateToPanel();
  };

  const registerFilesAsRefs = async (uris: vscode.Uri[]): Promise<UploadFileRef[]> => {
    ensureArtifactServer();
    const refs: UploadFileRef[] = [];
    for (const u of uris) {
      const info = await artifactServer!.registerFile(u.fsPath);
      refs.push({ filename: info.filename, mime: info.mime, size: info.size, url: info.url });
    }
    return refs;
  };

  const sendFilesToBrowser = async (session: SessionInfo, uploadTarget: UploadTarget) => {
    ensureServer();
    ensureArtifactServer();
    if (!(await ensureChromeClient(`Send Files (${uploadTarget})`))) return;

    const picks = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false });
    if (!picks || picks.length === 0) return;

    // Guard: per-file size < 10MB by default (ChatGPT UI may be higher, but keep safe).
    const MAX = 10 * 1024 * 1024;
    const tooBig = [] as string[];
    for (const p of picks) {
      const st = await vscode.workspace.fs.stat(p);
      if (st.size > MAX) tooBig.push(`${p.fsPath} (${st.size} bytes)`);
    }
    if (tooBig.length > 0) {
      vscode.window.showErrorMessage(`Some files exceed 10MB and were not sent:\n${tooBig.join("\n")}`);
      return;
    }

    const files = await registerFilesAsRefs(picks);
    const target: TargetSpec = {
      url: session.projectUrl,
      sessionId: session.id,
      projectId: session.projectId,
      conversationId: session.conversationId
    };

    server!.broadcast({ type: "vscode_push", kind: "files", files, uploadTarget, target, ts: Date.now() });

    // Log only filenames + sizes (no base64).
    const summary = files.map((f) => `${f.filename} (${f.size} bytes)`).join(", ");
    state.messages.push({ direction: "to_browser", kind: `files:${uploadTarget}`, data: summary, ts: Date.now() });
    if (state.messages.length > 200) state.messages.shift();

    session.lastUsedAt = Date.now();
    state.lastTargetUrl = session.projectUrl;
    await saveState(ctx, state);
    pushStateToPanel();
  };

  const ensureServer = () => {
    if (!server) {
      server = new BridgeServer(getPort(), async (msg: BridgeInbound) => {
        const now = Date.now();

        if (msg.type === "browser_payload") {
          const record = {
            direction: "from_browser" as const,
            kind: msg.kind,
            data: msg.kind === "text" ? compactText(String(msg.data)) : msg.data,
            ts: msg.ts ?? now,
            page: msg.page
          };
          state.messages.push(record);
          if (state.messages.length > 200) state.messages.shift();
          await saveState(ctx, state);
          pushStateToPanel();

          // Chrome "notice" messages are intended as status toasts (e.g. connect/disconnect).
          if (msg.kind === "notice") {
            const notice = String(msg.data || "");
            if (notice) {
              log("info", `Chrome notice: ${notice}`);
              if (shouldNotify()) {
                vscode.window.showInformationMessage(`ChatGPT Bridge (Chrome): ${notice}`);
              }
            }
            return;
          }

          // If incoming text contains zip URL, offer to download
          const cfg = vscode.workspace.getConfiguration("chatgptBridge");
          if (cfg.get<boolean>("autoOfferZipDownload", true) && msg.kind === "text") {
            const urls = extractZipUrls(msg.data);
            if (urls.length > 0) {
              const url = urls[0];
              const choice = await vscode.window.showInformationMessage(`Detected ZIP URL. Download and open?`, "Download", "Ignore");
              if (choice === "Download") {
                await downloadZipAndOpen(url);
              }
            }
          }
          return;
        }

        if (msg.type === "browser_event") {
          // Keep a compact log entry.
          state.messages.push({
            direction: "from_browser" as const,
            kind: `event:${msg.kind}`,
            data:
              msg.kind === "conversation_bound"
                ? `session=${msg.sessionId} conversation=${msg.conversationId}`
                : msg.kind === "error"
                  ? String((msg as any).message || "error")
                  : "tab_closed",
            ts: msg.ts ?? now
          });
          if (state.messages.length > 200) state.messages.shift();

          if (msg.kind === "conversation_bound") {
            const s = state.sessions.find((x) => x.id === msg.sessionId);
            if (s) {
              s.conversationId = msg.conversationId;
              s.lastUsedAt = now;
              // Prefer keeping the original projectUrl as the stable entry URL.
            }
          }

          if (msg.kind === "error") {
            log("error", "Chrome reported an error.", msg);
            if (shouldNotify()) {
              const m = String((msg as any).message || "Chrome error");
              vscode.window.showErrorMessage(`ChatGPT Bridge (Chrome): ${m}`);
            }
          } else if (msg.kind === "tab_closed") {
            log("warn", "Chrome reported: target tab closed.", msg);
          } else if (msg.kind === "conversation_bound") {
            log("info", "Conversation bound.", msg);
          }

          await saveState(ctx, state);
          pushStateToPanel();
          return;
        }
      }, () => {
        // Called when client connects or disconnects
        pushStateToPanel();
        updateStatusBar();
        log("info", `Client change: now ${server?.getClientCount() ?? 0} client(s)`);
      });
    }

    // Ensure the server is actually started; otherwise Chrome cannot connect.
    try {
      server.start();
      log("debug", "Bridge server start() invoked.");
    } catch (e) {
      log("error", "Failed to start bridge server.", e);
      vscode.window.showErrorMessage(`Failed to start bridge server: ${String(e)}`);
    }
  };

  const ensureArtifactServer = () => {
    if (!artifactServer) {
      artifactServer = new ArtifactServer(getArtifactPort());
    }
    try {
      artifactServer.start();
      log("debug", `Artifact HTTP server started on 127.0.0.1:${artifactServer!.getPort()}`);
    } catch (e) {
      log("error", "Failed to start artifact server.", e);
      vscode.window.showErrorMessage(`Failed to start artifact server: ${String(e)}`);
    }
  };

  const publishArtifact = async (filePath: string, filenameOverride?: string, mimeOverride?: string) => {
    ensureServer();
    ensureArtifactServer();
    const info = await artifactServer!.registerFile(filePath, filenameOverride, mimeOverride);
    const connected = await ensureChromeClient("Publish Artifact");
    server!.broadcast({ type: "artifact_ready", artifact: info, ts: Date.now() });
    if (!connected) {
      log("warn", "Artifact published, but Chrome is not connected (0 clients).", { filename: info.filename, url: info.url });
    } else {
      log("info", "Artifact published for Chrome upload.", { filename: info.filename, size: info.size, url: info.url });
    }
    state.messages.push({ direction: "to_browser", kind: "artifact_ready", data: `${info.filename} (${info.size} bytes)`, ts: Date.now() });
    if (state.messages.length > 200) state.messages.shift();
    await saveState(ctx, state);
    pushStateToPanel();
    return info;
  };

  const sendToChrome = async (text: string) => {
    ensureServer();
    if (!(await ensureChromeClient("Send Text"))) return;
    server!.broadcast({ type: "vscode_push", kind: "text", text, ts: Date.now() });
    state.messages.push({ direction: "to_browser", kind: "text", data: compactText(text), ts: Date.now() });
    if (state.messages.length > 200) state.messages.shift();
    await saveState(ctx, state);
    pushStateToPanel();
  };

  const offerPromptActions = async (prompt: string) => {
    const choice = await vscode.window.showInformationMessage("Next task prompt is ready.", "Copy Prompt", "Send to Chrome", "Dismiss");
    if (choice === "Copy Prompt") {
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage("Prompt copied.");
    } else if (choice === "Send to Chrome") {
      await sendToChrome(prompt);
      vscode.window.showInformationMessage("Sent to Chrome extension.");
    }
  };

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.startServer", () => {
    ensureServer();
    log("info", `Bridge server started on 127.0.0.1:${server!.getPort()}`);
    if (shouldNotify()) vscode.window.showInformationMessage(`Bridge server started on 127.0.0.1:${server!.getPort()}`);
    pushStateToPanel();
    updateStatusBar();
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.stopServer", () => {
    server?.stop();
    server = undefined;
    log("info", "Bridge server stopped.");
    if (shouldNotify()) vscode.window.showInformationMessage("Bridge server stopped.");
    pushStateToPanel();
    updateStatusBar();
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.openPanel", () => {
    ensurePanel();
    pushStateToPanel();
    ensureServer();
    updateStatusBar();
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.initConfig", async () => {
    const root = getWorkspaceRootUri();
    if (!root) {
      vscode.window.showErrorMessage("No workspace folder is open.");
      return;
    }

    const uri = vscode.Uri.joinPath(root, PROJECT_CONFIG_FILE);

    // If file exists, open it for editing.
    let existing: Uint8Array | null = null;
    try {
      existing = await vscode.workspace.fs.readFile(uri);
    } catch {
      existing = null;
    }
    if (existing) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }

    // Otherwise, prompt to create it.
    const projectUrl = await vscode.window.showInputBox({
      prompt: `Enter ChatGPT project/entry URL to write into ${PROJECT_CONFIG_FILE}`,
      placeHolder: "https://chatgpt.com/g/g-.../project",
      ignoreFocusOut: true
    });
    if (!projectUrl) return;

    const content = JSON.stringify({ projectUrl: projectUrl.trim() }, null, 2) + "\n";
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(`Created ${PROJECT_CONFIG_FILE} at workspace root.`);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.openLogs", () => {
    ensureOutput().show(true);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.sendFilesToChrome", async () => {
    const cfg = vscode.workspace.getConfiguration("chatgptBridge");
    const defaultUrl = cfg.get<string>("autoUploadTargetUrl", "") || state.lastTargetUrl || "";
    const targetUrl = await vscode.window.showInputBox({
      title: "Target ChatGPT Project URL",
      prompt: "Paste a chatgpt.com project entry URL (e.g. https://chatgpt.com/g/.../project).",
      value: defaultUrl
    });
    if (!targetUrl?.trim()) return;

    await cfg.update("autoUploadTargetUrl", targetUrl.trim(), vscode.ConfigurationTarget.Global);
    state.lastTargetUrl = targetUrl.trim();
    await saveState(ctx, state);
    pushStateToPanel();

    const uploadTargetPick = await vscode.window.showQuickPick(
      [
        { label: "Chat attachments (default)", value: "chat" as UploadTarget },
        { label: "Project files", value: "project" as UploadTarget }
      ],
      { placeHolder: "Where to upload these files?" }
    );
    const uploadTarget = uploadTargetPick?.value ?? "chat";

    let s = getActiveSession();
    if (!s || stripUrlNoise(s.projectUrl) !== stripUrlNoise(targetUrl.trim())) {
      s = await createSession(targetUrl.trim(), undefined);
      await openSessionInBrowser(s);
    }

    await sendFilesToBrowser(s, uploadTarget);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.bundleWorkspace", async () => {
    const cfg = vscode.workspace.getConfiguration("chatgptBridge");
    const defaultMode = cfg.get<string>("bundleMode", "workspace");

    const mode = await vscode.window.showQuickPick(
      [
        { label: "Workspace (default)", value: "workspace" },
        { label: "Open Files", value: "openFiles" },
        { label: "Current File", value: "currentFile" }
      ],
      { placeHolder: `Bundling mode (default: ${defaultMode})` }
    );

    const zip = await vscode.window.showQuickPick(["No ZIP (MD only)", "Create ZIP (bundle only)"], { placeHolder: "Bundle output" });
    const res = await bundleWorkspace(ctx, zip === "Create ZIP (bundle only)", (mode?.value as any) || (defaultMode as any));
    if (!res) return;

    const msg = res.zipPath
      ? `Bundle created (${res.fileCount} files, ~${res.totalChars.toLocaleString()} chars). MD + ZIP saved under .chatgpt-bridge/`
      : `Bundle created (${res.fileCount} files, ~${res.totalChars.toLocaleString()} chars). MD saved under .chatgpt-bridge/`;

    const actions: string[] = [
      "Copy Bundle Path",
      "Copy Bundle Contents",
      "Open Bundle",
      "Publish Bundle (bundle.md) as Upload Artifact (Chrome)"
    ];
    if (res.zipPath) actions.push("Publish ZIP as Upload Artifact (Chrome)");

    const action = await vscode.window.showInformationMessage(msg, ...actions);

    if (action === "Copy Bundle Path") {
      await vscode.env.clipboard.writeText(res.bundlePath);
      vscode.window.showInformationMessage("Bundle path copied.");
    } else if (action === "Copy Bundle Contents") {
      const content = await (await import("fs/promises")).readFile(res.bundlePath, "utf8");
      await vscode.env.clipboard.writeText(content);
      vscode.window.showInformationMessage("Bundle contents copied to clipboard. Paste into ChatGPT web manually.");
    } else if (action === "Open Bundle") {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(res.bundlePath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } else if (action === "Publish Bundle (bundle.md) as Upload Artifact (Chrome)") {
      const info = await publishArtifact(res.bundlePath);
      vscode.window.showInformationMessage(`Published upload artifact to Chrome: ${info.filename}`);
    } else if (action === "Publish ZIP as Upload Artifact (Chrome)") {
      if (!res.zipPath) return;
      const info = await publishArtifact(res.zipPath);
      vscode.window.showInformationMessage(`Published upload artifact to Chrome: ${info.filename}`);
    }
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.publishFileAsArtifact", async () => {
    const pick = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Select a file to publish as an upload artifact",
      filters: { "All Files": ["*"] }
    });
    if (!pick || pick.length === 0) return;
    const info = await publishArtifact(pick[0].fsPath);
    vscode.window.showInformationMessage(`Published upload artifact to Chrome: ${info.filename}`);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.downloadZipFromUrl", async () => {
    const url = await vscode.window.showInputBox({ prompt: "Enter a public .zip URL (http/https)" });
    if (!url) return;
    await downloadZipAndOpen(url);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("chatgptBridge.importLocalZip", async () => {
    await importLocalZipAndOpen();
  }));

  ctx.subscriptions.push({ dispose: () => server?.stop() });
  ctx.subscriptions.push({ dispose: () => artifactServer?.stop() });
  ctx.subscriptions.push({ dispose: () => { try { statusBar?.dispose(); } catch {} try { output?.dispose(); } catch {} } });
}

export function deactivate() {}


