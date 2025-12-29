import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import { URL } from "url";
import extract from "extract-zip";

async function downloadToFile(url: string, outPath: string): Promise<void> {
  const proto = url.startsWith("https:") ? https : http;

  await fs.mkdir(path.dirname(outPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const req = proto.get(url, (res: http.IncomingMessage) => {
      const code = res.statusCode ?? -1;

      if (code >= 300 && code < 400 && res.headers.location) {
        const loc = String(res.headers.location);
        const nextUrl = loc.startsWith("http") ? loc : new URL(loc, url).toString();
        res.resume();
        downloadToFile(nextUrl, outPath).then(resolve).catch(reject);
        return;
      }

      if (code !== 200) {
        res.resume();
        reject(new Error(`HTTP ${code}`));
        return;
      }

      const file = fsSync.createWriteStream(outPath);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });

    req.on("error", reject);
  });
}

export async function downloadZipAndOpen(url: string, workspaceRoot?: string): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const root =
    workspaceRoot ??
    folders?.[0]?.uri.fsPath ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-bridge-")));

  const baseDir = path.join(root, ".chatgpt-bridge", "imports");
  await fs.mkdir(baseDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const zipPath = path.join(baseDir, `import-${ts}.zip`);
  const extractDir = path.join(baseDir, `import-${ts}`);

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Downloading ZIP...", cancellable: false },
      async () => { await downloadToFile(url, zipPath); }
    );

    await fs.mkdir(extractDir, { recursive: true });
    await extract(zipPath, { dir: extractDir });

    const choice = await vscode.window.showInformationMessage(
      `ZIP extracted to ${extractDir}`,
      "Open Folder",
      "Reveal"
    );
    if (choice === "Open Folder") {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(extractDir), true);
    } else if (choice === "Reveal") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(extractDir));
    }
  } catch (e) {
    vscode.window.showErrorMessage(
      `ZIP download/extract failed (${String(e)}). If this URL requires login, download manually and use "Import Local ZIP and Open".`
    );
  }
}

export async function importLocalZipAndOpen(): Promise<void> {
  const pick = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Select ZIP",
    filters: { "ZIP": ["zip"] }
  });
  if (!pick || pick.length === 0) return;

  const zipFile = pick[0].fsPath;
  const folders = vscode.workspace.workspaceFolders;
  const root =
    folders?.[0]?.uri.fsPath ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-bridge-")));

  const baseDir = path.join(root, ".chatgpt-bridge", "imports");
  await fs.mkdir(baseDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const extractDir = path.join(baseDir, `local-${ts}`);

  try {
    await fs.mkdir(extractDir, { recursive: true });
    await extract(zipFile, { dir: extractDir });

    const choice = await vscode.window.showInformationMessage(
      `ZIP extracted to ${extractDir}`,
      "Open Folder",
      "Reveal"
    );
    if (choice === "Open Folder") {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(extractDir), true);
    } else if (choice === "Reveal") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(extractDir));
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to extract ZIP: ${String(e)}`);
  }
}


