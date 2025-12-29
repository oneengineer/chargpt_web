import { WebSocketServer, WebSocket, RawData } from "ws";
import { BridgeInbound, BridgeOutbound } from "./types";

export class BridgeServer {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();

  private port: number;
  private onInbound: (msg: BridgeInbound) => void;
  private onClientChange?: () => void;

  constructor(
    port: number,
    onInbound: (msg: BridgeInbound) => void,
    onClientChange?: () => void
  ) {
    this.port = port;
    this.onInbound = onInbound;
    this.onClientChange = onClientChange;
  }

  public getPort() { return this.port; }
  public getClientCount() { return this.clients.size; }

  public start() {
    if (this.wss) return;

    // Safety: localhost only.
    this.wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });

    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      this.onClientChange?.();

      ws.on("message", (raw: RawData) => {
        let msg: BridgeInbound | any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === "ping") {
          this.send(ws, { type: "pong" });
          return;
        }

        if (msg.type === "browser_payload" || msg.type === "browser_event") {
          this.onInbound(msg);
          return;
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        this.onClientChange?.();
      });
    });
  }

  public stop() {
    if (!this.wss) return;
    for (const c of this.clients) {
      try { c.close(); } catch {}
    }
    this.clients.clear();
    this.wss.close();
    this.wss = undefined;
  }

  public broadcast(out: BridgeOutbound) {
    for (const c of this.clients) {
      this.send(c, out);
    }
  }

  private send(ws: WebSocket, out: BridgeOutbound) {
    try { ws.send(JSON.stringify(out)); } catch {}
  }
}


