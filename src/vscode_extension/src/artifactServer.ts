import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as crypto from "crypto";

export interface ArtifactInfo {
  id: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: number;
  /** Fully qualified URL (localhost) usable by the Chrome extension. */
  url: string;
}

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".md": return "text/markdown; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".zip": return "application/zip";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

type StoredArtifact = ArtifactInfo & { filePath: string };

/**
 * A tiny localhost HTTP server for serving "upload artifacts" to the Chrome
 * extension.
 *
 * Why this exists:
 * - MV3 message passing is not reliable for large binary payloads.
 * - A localhost URL lets content scripts fetch the artifact directly and then
 *   drag&drop it into ChatGPT.
 */
export class ArtifactServer {
  private readonly host = "127.0.0.1";
  private readonly port: number;
  private server?: http.Server;
  private artifacts = new Map<string, StoredArtifact>();

  constructor(port: number) {
    this.port = port;
  }

  public getPort() { return this.port; }

  public start() {
    if (this.server) return;

    this.server = http.createServer(async (req, res) => {
      try {
        if (!req.url) { res.writeHead(400).end(); return; }
        const u = new URL(req.url, `http://${this.host}:${this.port}`);

        if (u.pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const m = u.pathname.match(/^\/artifact\/([a-zA-Z0-9_-]+)$/);
        if (!m) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        const id = m[1];
        const art = this.artifacts.get(id);
        if (!art) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        // Stream file.
        res.writeHead(200, {
          "Content-Type": art.mime,
          // Keep filename for browser downloads / ChatGPT preview.
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(art.filename)}`,
          "Cache-Control": "no-store"
        });

        const stream = fs.createReadStream(art.filePath);
        stream.on("error", () => {
          try { res.writeHead(500).end(); } catch {}
        });
        stream.pipe(res);
      } catch (e) {
        try {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(String(e));
        } catch {}
      }
    });

    // Localhost only.
    this.server.listen(this.port, this.host);
  }

  public stop() {
    if (!this.server) return;
    try { this.server.close(); } catch {}
    this.server = undefined;
    this.artifacts.clear();
  }

  public async registerFile(filePath: string, filenameOverride?: string, mimeOverride?: string): Promise<ArtifactInfo> {
    const st = await fsp.stat(filePath);
    const filename = filenameOverride ?? path.basename(filePath);
    const mime = mimeOverride ?? guessMime(filename);
    const id = crypto.randomBytes(8).toString("hex");
    const createdAt = Date.now();
    const url = `http://${this.host}:${this.port}/artifact/${id}`;
    const info: StoredArtifact = {
      id,
      filename,
      mime,
      size: st.size,
      createdAt,
      url,
      filePath
    };
    this.artifacts.set(id, info);
    return { id, filename, mime, size: st.size, createdAt, url };
  }
}
