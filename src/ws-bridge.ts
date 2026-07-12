import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEFAULTS, buildAckPayload,
  buildHelloPayload,
  buildConnectionUrl,
  PROTOCOL_VERSION,
  createId,
  normalizePacket,
  nowIso,
  type OstraconCardSummary,
  type OstraconMessage,
  type OstraconNotebookSummary,
  type OstraconPacket,
  type BridgeHost,
} from "./contract";

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

type PendingClientRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class OstraconWsBridge {
  plugin: BridgeHost;
  httpServer: http.Server | null;
  wss: WebSocketServer | null;
  clients: Set<WebSocket>;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  processedRequests: Map<string, CachedFrames>;
  clientState: Map<WebSocket, ClientState>;
  pendingClientRequests: Map<string, PendingClientRequest>;
  started: boolean;

  constructor(plugin: BridgeHost) {
    this.plugin = plugin;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
    this.heartbeatTimer = null;
    this.processedRequests = new Map();
    this.clientState = new Map();
    this.pendingClientRequests = new Map();
    this.started = false;
  }

  get isRunning(): boolean {
    return Boolean(this.started && this.httpServer && this.wss);
  }

  getConnectionUrl(): string {
    return buildConnectionUrl(this.plugin.settings);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // Discovery endpoint for MN to find OB instances on the LAN
        if (req.method === "GET" && req.url === "/ostracon/discover") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({
            name: "Ostracon",
            port: port,
            version: String(PROTOCOL_VERSION),
          }));
          return;
        }
        // Other HTTP requests: not found
        res.writeHead(404);
        res.end();
      });
      const port = Number(this.plugin.settings.port);
      const host = this.plugin.settings.host || DEFAULTS.host;

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
    this.clientState.clear();
    this.rejectPendingClientRequests(new Error("Ostracon server stopped"));

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
      let clientName = "";
      let clientId: string | null = null;

      try {
        // Build base URL safely: handle IPv6 hosts that may lack brackets in Host header
        let baseHost = request.headers.host || DEFAULTS.host;
        if (baseHost !== "::" && !baseHost.startsWith("[")) {
          // Only wrap if the host part itself contains a colon (IPv6), not just the port separator
          const lastColon = baseHost.lastIndexOf(":");
          if (lastColon > 0) {
            const hostPart = baseHost.substring(0, lastColon);
            if (hostPart.includes(":")) {
              const portPart = baseHost.substring(lastColon);
              baseHost = `[${hostPart}]${portPart}`;
            }
          }
        } else if (baseHost === "::") {
          baseHost = "[::1]";
        }
        const url = new URL(request.url ?? "", `http://${baseHost}`);
        clientName = url.searchParams.get("name") || "";
        clientId = url.searchParams.get("clientId") || null;
      } catch (err) {
        void err;
        ws.close(4000, "Invalid connection URL");
        return;
      }

      // Use client-provided ID, fallback to random
      const effectiveClientId = clientId || createClientId();

      const client: ClientState = {
        ws,
        clientId: effectiveClientId,
        connectedAt: nowIso(),
        lastSeenAt: nowIso(),
      };

      this.clients.add(ws);
      this.clientState.set(ws, client);

      const socket = ws as WebSocket & { isAlive?: boolean };
      socket.isAlive = true;
      ws.on("pong", () => {
        socket.isAlive = true;
        client.lastSeenAt = nowIso();
      });

      // Check if device needs approval before sending hello
      const approvalRequired = !this.plugin.isDeviceApproved(effectiveClientId);
      if (approvalRequired) {
        this.send(ws, {
          type: "pending_approval",
          requestId: `approval-${effectiveClientId}`,
          payload: { clientId: effectiveClientId, message: "等待 Obsidian 用户确认连接" },
        });

        this.plugin.requestApproval(effectiveClientId, clientName, {
          onApprove: () => {
            this.plugin.approveDevice(effectiveClientId, clientName);
            this.send(ws, {
              type: "approved",
              requestId: `approval-${effectiveClientId}`,
              payload: { ok: true, clientId: effectiveClientId },
            });
            this.sendHelloAndSetupMessageHandler(ws, client);
          },
          onDeny: () => {
            this.send(ws, {
              type: "error",
              requestId: `approval-${effectiveClientId}`,
              payload: { message: "用户拒绝了连接请求" },
            });
            ws.close(4003, "User denied connection");
          },
        });
        return;
      }

      // Already approved device, proceed normally
      this.sendHelloAndSetupMessageHandler(ws, client);
    });
  }

  private sendHelloAndSetupMessageHandler(ws: WebSocket, client: ClientState): void {
    this.send(ws, {
      type: "hello",
      requestId: `hello-${client.clientId}`,
      payload: buildHelloPayload(this.plugin.settings, this.plugin.getVaultName()),
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
      this.clientState.delete(ws);
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

    const isPendingClientResponse = Boolean(message.requestId && this.pendingClientRequests.has(message.requestId));

    if (!isPendingClientResponse && message.requestId && this.processedRequests.has(message.requestId)) {
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
        const payload = message.payload && typeof message.payload === "object"
          ? message.payload as { protocolVersion?: number; pluginId?: string }
          : {};
        if (payload.protocolVersion !== PROTOCOL_VERSION || payload.pluginId !== "ostracon-mn") {
          const errorMessage = "插件版本不一致，请同时更新MarginNote端和Obsidian端";
          enqueue({
            type: "error",
            requestId: message.requestId || "",
            payload: {
              message: errorMessage,
              expectedProtocolVersion: PROTOCOL_VERSION,
              expectedPluginId: "ostracon-mn",
            },
          });
          ws.close(4002, errorMessage);
          return;
        }
        enqueue({
          type: "hello",
          requestId: message.requestId || `hello-${client.clientId}`,
          payload: buildHelloPayload(this.plugin.settings),
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
      case "sync_result": {
        this.resolvePendingClientRequest(message);
        break;
      }
      case "error": {
        this.rejectPendingClientRequest(message);
        break;
      }
      default:
        throw new Error(`Unsupported message type: ${message.type}`);
    }

    if (!isPendingClientResponse && message.requestId && frames.length > 0) {
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
        const pkt = message.payload as Record<string, unknown>;
        const autoSynced = Boolean(pkt?.autoSynced);
        const targetFilePath = typeof pkt?.targetFilePath === "string" ? pkt.targetFilePath : "";
        const packetData = pkt?.packet || pkt;
        const packet = normalizePacket(packetData as OstraconPacket);
        const record = await this.plugin.ingestPacket(packet, {
          transport: "ws",
          requestId: message.requestId || "",
          clientId: message.clientId || "",
          messageType: "command",
          autoSynced,
          targetFilePath,
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
      case "cardUpdated": {
        await this.plugin.handleCardUpdated(message.payload as {
          noteId: string; title: string; excerpt: string; comment: string;
          sourceAnchor: string; version: number; filePath?: string; format?: string; markdownSection?: string; canvasText?: string; hasImage?: boolean; hasHandwriting?: boolean;
        });
        enqueue({
          type: "sync_result",
          requestId: message.requestId || "",
          payload: { ok: true, command: "cardUpdated", noteId: (message.payload as Record<string, unknown>)?.noteId || "" },
        });
        break;
      }
      case "getVaultBrowserState":
        enqueue({ type: "sync_result", requestId: message.requestId || "", payload: this.plugin.getVaultBrowserState() });
        break;
      case "listVaultFolder":
        enqueue({ type: "sync_result", requestId: message.requestId || "", payload: this.plugin.listVaultFolder((message.payload || {}) as Record<string, unknown>) });
        break;
      case "listVaultTags":
        enqueue({ type: "sync_result", requestId: message.requestId || "", payload: this.plugin.listVaultTags() });
        break;
      case "listVaultDocuments":
        enqueue({ type: "sync_result", requestId: message.requestId || "", payload: this.plugin.listVaultDocuments((message.payload || {}) as Record<string, unknown>) });
        break;
      case "searchVaultDocuments":
        enqueue({ type: "sync_result", requestId: message.requestId || "", payload: await this.plugin.searchVaultDocuments((message.payload || {}) as Record<string, unknown>) });
        break;
      case "getVaultDocument":
        enqueue({ type: "sync_result", requestId: message.requestId || "", payload: await this.plugin.getVaultDocument((message.payload || {}) as Record<string, unknown>) });
        break;
      case "getVaultAsset":
        enqueue({ type: "sync_result", requestId: message.requestId || "", payload: await this.plugin.getVaultAsset((message.payload || {}) as Record<string, unknown>) });
        break;
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

  broadcastEvent(event: string, payload: unknown): void {
    for (const client of this.getOpenClients()) {
      this.send(client, { type: "event", event, payload });
    }
  }

  getOpenClients(): WebSocket[] {
    return Array.from(this.clients).filter((client) => client.readyState === WebSocket.OPEN);
  }

  getActiveClient(): WebSocket {
    const client = this.getOpenClients()[0];
    if (!client) {
      throw new Error("没有已连接的MarginNote客户端");
    }
    return client;
  }

  requestClientCommand(command: string, payload: unknown = {}, timeoutMs = 12000): Promise<unknown> {
    const ws = this.getActiveClient();
    const state = this.clientState.get(ws);
    const requestId = createId(command);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClientRequests.delete(requestId);
        reject(new Error(`MN命令超时: ${command}`));
      }, timeoutMs);

      this.pendingClientRequests.set(requestId, {
        resolve,
        reject,
        timer,
      });

      this.send(ws, {
        type: "command",
        command,
        requestId,
        clientId: state ? state.clientId : "",
        payload,
      });
    });
  }

  async listNotebooks(): Promise<OstraconNotebookSummary[]> {
    const payload = await this.requestClientCommand("listNotebooks");
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { notebooks?: unknown }).notebooks)) {
      throw new Error("MN返回的学习集列表格式不正确");
    }
    return (payload as { notebooks: OstraconNotebookSummary[] }).notebooks;
  }

  async listCards(notebookId: string): Promise<OstraconCardSummary[]> {
    const payload = await this.requestClientCommand("listCards", { notebookId });
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { cards?: unknown }).cards)) {
      throw new Error("MN返回的卡片列表格式不正确");
    }
    return (payload as { cards: OstraconCardSummary[] }).cards;
  }

  resolvePendingClientRequest(message: OstraconMessage): void {
    if (!message.requestId) {
      return;
    }
    const pending = this.pendingClientRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingClientRequests.delete(message.requestId);
    pending.resolve(message.payload);
  }

  rejectPendingClientRequest(message: OstraconMessage): void {
    if (!message.requestId) {
      return;
    }
    const pending = this.pendingClientRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingClientRequests.delete(message.requestId);
    const payload = message.payload as { message?: string } | undefined;
    pending.reject(new Error(payload && payload.message ? payload.message : "MN返回错误"));
  }

  rejectPendingClientRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingClientRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingClientRequests.delete(requestId);
    }
  }
}

function createClientId(): string {
  return `client-${Math.random().toString(16).slice(2, 10)}`;
}

export {
  OstraconWsBridge,
};
