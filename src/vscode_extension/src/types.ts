export type BrowserPayloadKind =
  | "selection"
  | "url"
  | "text"
  | "last_assistant"
  | "picked_message"
  | "notice";

export type UploadTarget = "chat" | "project";

export interface UploadFileRef {
  filename: string;
  mime: string;
  size: number;
  /**
   * Recommended: a localhost artifact URL served by the VS Code extension.
   * Chrome will fetch bytes from this URL and construct a File.
   */
  url?: string;
  /**
   * Optional: base64 payload (not recommended for large files).
   * If provided, Chrome can construct a Blob without fetching.
   */
  b64?: string;
}

export interface TargetSpec {
  /** ChatGPT entry URL: Project URL (preferred) or a conversation URL. */
  url: string;
  /** Optional stable session key for per-session tab binding. */
  sessionId?: string;
  /** Optional project key (e.g. g-... / g-p-...). */
  projectId?: string;
  /** Optional conversation key (e.g. /c/<conversationId>). */
  conversationId?: string;
}

export type BrowserEventKind = "conversation_bound" | "tab_closed" | "error" | "chat_message" | "upload_done" | "upload_failed";

export type BridgeBrowserEvent =
  | { type: "browser_event"; kind: "conversation_bound"; sessionId: string; conversationId: string; url: string; ts?: number }
  | { type: "browser_event"; kind: "tab_closed"; sessionId?: string; url?: string; ts?: number }
  | { type: "browser_event"; kind: "error"; message: string; detail?: any; ts?: number }
  | { type: "browser_event"; kind: "chat_message"; sessionId?: string; role: "user" | "assistant"; text: string; url?: string; conversationId?: string; ts?: number }
  | { type: "browser_event"; kind: "upload_done"; sessionId?: string; target: UploadTarget; uploaded: number; url?: string; ts?: number }
  | { type: "browser_event"; kind: "upload_failed"; sessionId?: string; target: UploadTarget; error: string; url?: string; ts?: number };

export type BridgeInbound =
  | { type: "browser_payload"; kind: BrowserPayloadKind; data: string; page?: { url?: string; title?: string }; ts?: number }
  | BridgeBrowserEvent
  | { type: "ping" };

export type BridgeOutbound =
  | { type: "pong" }
  | { type: "vscode_push"; kind: "text"; text: string; ts: number }
  | { type: "vscode_push"; kind: "insert_and_send"; text: string; target: TargetSpec; ts: number }
  | { type: "vscode_push"; kind: "files"; files: UploadFileRef[]; uploadTarget?: UploadTarget; target?: TargetSpec; ts: number }
  | { type: "vscode_push"; kind: "session_open"; target: TargetSpec; ts: number }
  | { type: "vscode_push"; kind: "session_close"; target: TargetSpec; ts: number }
  | { type: "artifact_ready"; artifact: { id: string; filename: string; mime: string; size: number; createdAt: number; url: string }; ts: number }
  | { type: "vscode_notice"; message: string; ts: number };

export type TaskStatus = "todo" | "in_progress" | "done";

export interface TaskItem {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SessionInfo {
  /** Stable key used to bind a VS Code session tab to a browser tab. */
  id: string;
  /** User-visible name in the VS Code panel. */
  name: string;
  /** ChatGPT project entry URL (recommended). */
  projectUrl: string;
  /** Extracted id: g-... or g-p-... when present. */
  projectId?: string;
  /** Captured after first user message: /c/<conversationId>. */
  conversationId?: string;
  /** Timestamp bookkeeping. */
  createdAt: number;
  lastUsedAt: number;
}

export interface PersistedState {
  token: string;
  tasks: TaskItem[];
  sessions: SessionInfo[];
  activeSessionId?: string;
  lastTargetUrl?: string;
  messages: Array<{ direction: "from_browser" | "to_browser"; kind: string; data: string; ts: number; page?: { url?: string; title?: string } }>;
  /**
   * Per-session chat transcript mirrored from ChatGPT DOM (best-effort).
   * New versions append to this; older persisted states won't have it.
   */
  chatThreads?: Record<string, Array<{ role: "user" | "assistant"; text: string; ts: number; url?: string; conversationId?: string }>>;
  /**
   * If a chat_send included attachments, we wait for upload_done then send the text.
   */
  pendingSend?: Record<string, { text: string; createdAt: number }>;
}


