import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  buildAckPayload,
  buildHelloPayload,
  buildConnectionUrl,
  createSessionId,
  normalizePacket,
  nowIso,
  type OstraconMessage,
  type OstraconPacket,
  type OstraconPacketRecord,
} from "./contract";

type PluginLike = {
  settings: {
    host: string;
    port: number;
    token: string;
    outputFolder: string;
    autoStartServer: boolean;
  };
  getPacketSummaries: () => Array<{
    id: string;
    summary: unknown;
    filePath: string;
    receivedAt: string;
  }>;
  ingestPacket: (packet: OstraconPacket, meta?: Partial<OstraconPacketRecord>) => Promise<OstraconPacketRecord>;
  logLine: (level: string, message: string) => void;
};

type ClientState = {
  ws: WebSocket;
  clientId: string;
  connectedAt: string;
  lastSeenAt: string;
};

type CachedFrames = {
  frames: unknown[];
  receivedAt: string;
};

class OstraconWsBridge {
  plugin: PluginLike;
  httpServer: http.Server | null;
  wss: WebSocketServer | null;
  clients: Set<WebSocket>;
  sessionId: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  processedRequests: Map<string, CachedFrames>;
  started: boolean;

  constructor(plugin: PluginLike) {
    this.plugin = plugin;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
    this.sessionId = "";
    this.heartbeatTimer = null;
    this.processedRequests = new Map();
    this.started = false;
  }

  get isRunning(): boolean {
    return Boolean(this.started && this.httpServer && this.wss);
  }

  getConnectionUrl(): string {
    return buildConnectionUrl(this.plugin.settings, this.sessionId);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.sessionId = this.sessionId || createSessionId();

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer();
      const port = Number(this.plugin.settings.port);
      const host = this.plugin.settings.host || "127.0.0.1";

      server.once("error", (error) => {
        reject(error);
      });

      server.listen(port, host, () => {
        this.httpServer = server;
        this.wss = new WebSocketServer({ server });
        this.attachWebSocketHandlers();
        this.started = true;
        this.startHeartbeat();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const client of this.clients) {
      try {
        client.close(1000, "ostracon shutting down");
      } catch (error) {
        void error;
      }
    }
    this.clients.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = null;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (client.readyState !== WebSocket.OPEN) {
          continue;
        }
        try {
          const socket = client as WebSocket & { isAlive?: boolean };
          if (socket.isAlive === false) {
            client.terminate();
            continue;
          }
          socket.isAlive = false;
          client.ping();
        } catch (error) {
          void error;
          client.terminate();
        }
      }
    }, 30000);
  }

  attachWebSocketHandlers(): void {
    this.wss?.on("connection", (ws, request) => {
      const url = new URL(request.url ?? "", `http://${request.headers.host || "127.0.0.1"}`);
      const token = url.searchParams.get("token");
      if (!token || token !== this.plugin.settings.token) {
        ws.close(4001, "Unauthorized token");
        return;
      }

      const client: ClientState = {
        ws,
        clientId: createClientId(),
        connectedAt: nowIso(),
        lastSeenAt: nowIso(),
      };

      this.clients.add(ws);

      const socket = ws as WebSocket & { isAlive?: boolean };
      socket.isAlive = true;
      ws.on("pong", () => {
        socket.isAlive = true;
        client.lastSeenAt = nowIso();
      });

      this.send(ws, {
        type: "hello",
        requestId: `hello-${client.clientId}`,
        payload: buildHelloPayload(this.plugin.settings, this.sessionId),
      });

      ws.on("message", async (raw) => {
        let message: OstraconMessage;
        try {
          message = JSON.parse(raw.toString("utf8")) as OstraconMessage;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.send(ws, {
            type: "error",
            requestId: "",
            payload: {
              message: "Invalid JSON payload",
              detail,
            },
          });
          return;
        }

        try {
          await this.handleMessage(ws, client, message);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.send(ws, {
            type: "error",
            requestId: message && message.requestId ? message.requestId : "",
            payload: {
              message: detail,
              command: message && message.command ? message.command : "",
            },
          });
          this.plugin.logLine("error", detail);
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });
    });
  }

  async handleMessage(ws: WebSocket, client: ClientState, message: OstraconMessage): Promise<void> {
    if (!message || typeof message !== "object") {
      throw new Error("Message must be an object");
    }
    if (!message.type || typeof message.type !== "string") {
      throw new Error("Message missing type");
    }

    client.lastSeenAt = nowIso();

    if (message.requestId && this.processedRequests.has(message.requestId)) {
      const cached = this.processedRequests.get(message.requestId);
      if (cached) {
        for (const frame of cached.frames) {
          this.send(ws, frame);
        }
      }
      return;
    }

    const frames: unknown[] = [];
    const enqueue = (frame: unknown) => {
      frames.push(frame);
      this.send(ws, frame);
    };

    switch (message.type) {
      case "hello": {
        enqueue({
          type: "hello",
          requestId: message.requestId || `hello-${client.clientId}`,
          payload: buildHelloPayload(this.plugin.settings, this.sessionId),
        });
        enqueue({
          type: "ack",
          requestId: message.requestId || "",
          payload: buildAckPayload(message),
        });
        break;
      }
      case "ping": {
        enqueue({
          type: "pong",
          requestId: message.requestId || "",
          payload: {
            serverTime: nowIso(),
            sessionId: this.sessionId,
          },
        });
        break;
      }
      case "sync_request": {
        const packets = this.plugin.getPacketSummaries();
        enqueue({
          type: "ack",
          requestId: message.requestId || "",
          payload: buildAckPayload(message),
        });
        enqueue({
          type: "sync_result",
          requestId: message.requestId || "",
          payload: {
            sessionId: this.sessionId,
            packets,
          },
        });
        break;
      }
      case "event": {
        enqueue({
          type: "ack",
          requestId: message.requestId || "",
          payload: buildAckPayload(message),
        });
        this.plugin.logLine("info", `event:${message.event || "unknown"}`);
        break;
      }
      case "command": {
        await this.handleCommand(ws, message, enqueue);
        break;
      }
      case "ack":
      case "pong": {
        this.plugin.logLine("info", `client:${message.type}`);
        break;
      }
      default:
        throw new Error(`Unsupported message type: ${message.type}`);
    }

    if (message.requestId) {
      this.processedRequests.set(message.requestId, {
        frames,
        receivedAt: nowIso(),
      });
      if (this.processedRequests.size > 1000) {
        const firstKey = this.processedRequests.keys().next().value;
        if (firstKey) {
          this.processedRequests.delete(firstKey);
        }
      }
    }
  }

  async handleCommand(ws: WebSocket, message: OstraconMessage, enqueue: (frame: unknown) => void): Promise<void> {
    const command = String(message.command || "").trim();
    if (!command) {
      throw new Error("Command message missing command");
    }

    enqueue({
      type: "ack",
      requestId: message.requestId || "",
      payload: buildAckPayload(message),
    });

    switch (command) {
      case "submitPacket": {
        const packet = normalizePacket(message.payload as OstraconPacket);
        const record = await this.plugin.ingestPacket(packet, {
          transport: "ws",
          requestId: message.requestId || "",
          clientId: message.clientId || "",
          messageType: "command",
        });
        enqueue({
          type: "sync_result",
          requestId: message.requestId || "",
          payload: {
            ok: true,
            record: {
              id: record.id,
              filePath: record.filePath,
              summary: record.summary,
              receivedAt: record.receivedAt,
            },
          },
        });
        break;
      }
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  }

  send(ws: WebSocket, message: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(message));
  }
}

function createClientId(): string {
  return `client-${Math.random().toString(16).slice(2, 10)}`;
}

export {
  OstraconWsBridge,
};
