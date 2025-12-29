import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isHiddenSegment(seg: string): boolean {
  return seg.startsWith(".");
}

function matchGlobSimple(filePosix: string, globs: string[]): boolean {
  // Minimal glob matcher:
  // - supports "**/X/**" directory contains patterns
  // - supports suffix patterns like "**/*.md"
  // It's intentionally conservative.
  for (const g of globs) {
    const gp = g.replace(/\\/g, "/");
    if (gp.startsWith("**/") && gp.endsWith("/**")) {
      const mid = gp.slice(3, -3);
      if (filePosix.includes(`/${mid}/`) || filePosix.startsWith(`${mid}/`)) return true;
    }
    if (gp.startsWith("**/*.") && filePosix.endsWith(gp.slice(4))) return true;
    if (gp.endsWith("/**") && (filePosix.startsWith(gp.slice(0, -3)) || filePosix.includes(`/${gp.slice(0, -3)}`))) return true;
  }
  return false;
}

async function readTextSafe(p: string): Promise<string> {
  const buf = await fs.readFile(p);
  return buf.toString("utf8");
}

export interface BundleResult {
  bundlePath: string;
  zipPath?: string;
  fileCount: number;
  totalChars: number;
}

type BundleMode = "workspace" | "openFiles" | "currentFile";

function langFromExt(ext: string): string {
  const e = ext.toLowerCase();
  return (
    e === ".cs" ? "csharp" :
    e === ".ts" ? "typescript" :
    e === ".tsx" ? "tsx" :
    e === ".js" ? "javascript" :
    e === ".jsx" ? "jsx" :
    e === ".json" ? "json" :
    e === ".md" ? "markdown" :
    e === ".shader" ? "hlsl" :
    e === ".cginc" ? "hlsl" :
    e === ".cpp" || e === ".c" ? "cpp" :
    e === ".hpp" || e === ".h" ? "cpp" :
    ""
  );
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

async function collectWorkspaceFiles(rootFs: string, excludeGlobs: string[], includeExts: Set<string>, maxBytes: number): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = toPosix(path.relative(rootFs, full));
      if (matchGlobSimple(rel, excludeGlobs)) continue;

      if (e.isDirectory()) {
        if (isHiddenSegment(e.name) && e.name !== ".chatgpt-bridge") continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;

      const ext = path.extname(e.name).toLowerCase();
      if (!includeExts.has(ext)) continue;

      try {
        const st = await fs.stat(full);
        if (st.size > maxBytes) continue;
      } catch { continue; }

      files.push(full);
    }
  }

  await walk(rootFs);
  return files;
}

async function collectOpenFiles(rootFs: string, excludeGlobs: string[], includeExts: Set<string>, maxBytes: number): Promise<string[]> {
  const docs = vscode.workspace.textDocuments;
  const files = docs
    .filter(d => d.uri.scheme === "file")
    .map(d => d.uri.fsPath)
    .filter(p => toPosix(p).startsWith(toPosix(rootFs) + "/"));

  const filtered: string[] = [];
  for (const full of uniq(files)) {
    const rel = toPosix(path.relative(rootFs, full));
    if (matchGlobSimple(rel, excludeGlobs)) continue;
    const ext = path.extname(full).toLowerCase();
    if (!includeExts.has(ext)) continue;
    try {
      const st = await fs.stat(full);
      if (st.size > maxBytes) continue;
    } catch { continue; }
    filtered.push(full);
  }
  return filtered;
}

async function collectCurrentFile(rootFs: string, excludeGlobs: string[], includeExts: Set<string>, maxBytes: number): Promise<string[]> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file") return [];
  const full = ed.document.uri.fsPath;
  if (!toPosix(full).startsWith(toPosix(rootFs) + "/")) return [];
  const rel = toPosix(path.relative(rootFs, full));
  if (matchGlobSimple(rel, excludeGlobs)) return [];
  const ext = path.extname(full).toLowerCase();
  if (!includeExts.has(ext)) return [];
  try {
    const st = await fs.stat(full);
    if (st.size > maxBytes) return [];
  } catch { return []; }
  return [full];
}

export async function bundleWorkspace(ctx: vscode.ExtensionContext, zip: boolean, modeOverride?: BundleMode): Promise<BundleResult | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder is open.");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("chatgptBridge");
  const excludeGlobs = (cfg.get<string[]>("bundleExcludeGlobs") ?? []) as string[];
  const includeExtList = (cfg.get<string[]>("bundleIncludeExts") ?? []) as string[];
  const includeExts = new Set(includeExtList.map((s: string) => s.toLowerCase()));
  const maxBytes = cfg.get<number>("bundleMaxFileBytes", 400000);

  const mode = modeOverride ?? (cfg.get<string>("bundleMode", "workspace") as BundleMode);

  const rootFs = folders[0].uri.fsPath;
  const outDir = path.join(rootFs, ".chatgpt-bridge");
  await fs.mkdir(outDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `bundle-${mode}-${ts}.md`);

  let files: string[] = [];
  if (mode === "workspace") {
    files = await collectWorkspaceFiles(rootFs, excludeGlobs, includeExts, maxBytes);
  } else if (mode === "openFiles") {
    files = await collectOpenFiles(rootFs, excludeGlobs, includeExts, maxBytes);
  } else {
    files = await collectCurrentFile(rootFs, excludeGlobs, includeExts, maxBytes);
  }

  if (files.length === 0) {
    vscode.window.showWarningMessage(`No files matched for bundling (mode=${mode}).`);
    return;
  }

  const lines: string[] = [];
  lines.push(`# ChatGPT Bundle (Manual Upload)`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Workspace: ${toPosix(rootFs)}`);
  lines.push(`Mode: ${mode}`);
  lines.push(``);
  lines.push(`## FILE INDEX`);
  for (const f of files) {
    const rel = toPosix(path.relative(rootFs, f));
    lines.push(`- ${rel}`);
  }
  lines.push(``);

  let totalChars = 0;

  for (const f of files) {
    const rel = toPosix(path.relative(rootFs, f));
    const ext = path.extname(f).toLowerCase();
    const lang = langFromExt(ext);

    lines.push(`## FILE: ${rel}`);
    lines.push("");
    lines.push("```" + lang);
    try {
      const content = await readTextSafe(f);
      const normalized = content.replace(/\r\n/g, "\n");
      totalChars += normalized.length;
      lines.push(normalized);
    } catch (e) {
      lines.push(`// ERROR: Failed to read file: ${String(e)}`);
    }
    lines.push("```");
    lines.push("");
  }

  await fs.writeFile(outPath, lines.join("\n"), "utf8");

  // Soft warning only (model/token limits vary).
  if (totalChars > 100_000) {
    vscode.window.showWarningMessage(`Bundle is large (~${totalChars.toLocaleString()} chars). Consider using openFiles/currentFile mode or splitting.`);
  }

  let zipPath: string | undefined;
  if (zip) {
    const Archiver = await import("archiver");
    zipPath = path.join(outDir, `bundle-${mode}-${ts}.zip`);
    const fsSync = await import("fs");
    const output = fsSync.createWriteStream(zipPath);
    const archive = Archiver.default("zip", { zlib: { level: 9 } });

    await new Promise<void>((resolve, reject) => {
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);

      // Include a human-readable bundle index/preview.
      archive.file(outPath, { name: "bundle.md" });

      // Include the actual source files so you can upload a single ZIP
      // to ChatGPT (or share it elsewhere) instead of pasting huge blocks.
      for (const f of files) {
        const rel = toPosix(path.relative(rootFs, f));
        archive.file(f, { name: rel });
      }
      archive.finalize();
    });
  }

  vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outPath));
  return { bundlePath: outPath, zipPath, fileCount: files.length, totalChars };
}
