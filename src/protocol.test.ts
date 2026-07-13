import { describe, expect, test, vi } from "vitest";
import { buildHelloPayload, buildPacketFilePath, createDefaultSettings, findAvailablePacketFilePath, normalizePacket, PROTOCOL_VERSION, type BridgeHost, type OstraconPacket } from "./contract";
import { WebSocket } from "ws";
import { OstraconWsBridge } from "./ws-bridge";

function createPacket(id: string): OstraconPacket {
  return {
    version: 1,
    id,
    status: "sent",
    transport: "ws",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    source: { platform: "MarginNote", title: "Example", url: "" },
    summary: "",
    tags: [],
    objects: [{ id: "same-card", kind: "Card", title: "Card", comment: "", sourceAnchor: "", hasImage: false, hasHandwriting: false }],
    relations: [],
    notes: "# Example",
    destination: { platform: "Obsidian", vault: "", folder: "Inbox" },
    format: "markdown",
  };
}

function createHost() {
  const record = {
    id: "packet-1",
    packet: createPacket("packet-1"),
    summary: {},
    filePath: "Marginnote/Example/packet-1.md",
    source: { platform: "MarginNote", title: "Example", url: "" },
    tags: [],
    receivedAt: "2026-07-13T00:00:00.000Z",
    transport: "ws",
    requestId: "request-1",
    clientId: "client-1",
    messageType: "command",
    version: 1,
  };
  return {
    settings: createDefaultSettings(),
    ingestPacket: vi.fn().mockResolvedValue(record),
    logLine: vi.fn(),
    getVaultName: vi.fn().mockReturnValue("Vault"),
    isDeviceApproved: vi.fn().mockReturnValue(true),
    approveDevice: vi.fn(),
    requestApproval: vi.fn(),
    getVaultBrowserState: vi.fn().mockReturnValue({ vaultName: "Vault" }),
    listVaultFolder: vi.fn().mockReturnValue({ folders: [], documents: [] }),
    listVaultTags: vi.fn().mockReturnValue({ tags: [] }),
    listVaultDocuments: vi.fn().mockReturnValue({ documents: [] }),
    searchVaultDocuments: vi.fn().mockResolvedValue({ documents: [] }),
    getVaultDocument: vi.fn().mockResolvedValue({ path: "Note.md" }),
    getVaultAsset: vi.fn().mockResolvedValue({ data: "" }),
  } as unknown as BridgeHost;
}

describe("Ostracon protocol", () => {
  test("advertises protocol 4 command responses", () => {
    const hello = buildHelloPayload(createDefaultSettings(), "Vault");
    expect(PROTOCOL_VERSION).toBe(4);
    expect(hello.capabilities).toContain("command_result");
    expect(hello.capabilities).not.toContain("sync" + "_request");
    expect(hello.capabilities).not.toContain("sync" + "_result");
  });

  test("accepts a plain submitPacket payload", async () => {
    const host = createHost();
    const bridge = new OstraconWsBridge(host);
    const frames: Array<Record<string, unknown>> = [];
    await bridge.handleCommand({} as never, {
      type: "command",
      command: "submitPacket",
      requestId: "request-1",
      clientId: "client-1",
      payload: createPacket("packet-1"),
    }, frame => frames.push(frame as Record<string, unknown>));

    expect(host.ingestPacket).toHaveBeenCalledWith(expect.objectContaining({ id: "packet-1" }), {
      transport: "ws",
      requestId: "request-1",
      clientId: "client-1",
      messageType: "command",
    });
    expect(frames.at(-1)?.type).toBe("command_result");
  });

  test("drops excerpt from legacy packet objects", () => {
    const packet = createPacket("legacy-packet") as OstraconPacket & {
      objects: Array<OstraconPacket["objects"][number] & { excerpt?: string }>;
    };
    packet.objects[0].excerpt = "legacy OCR";

    const normalized = normalizePacket(packet);

    expect(normalized.objects[0]).not.toHaveProperty("excerpt");
  });

  test("returns Vault browser data through command_result", async () => {
    const bridge = new OstraconWsBridge(createHost());
    const frames: Array<Record<string, unknown>> = [];
    await bridge.handleCommand({} as never, {
      type: "command",
      command: "getVaultBrowserState",
      requestId: "request-2",
    }, frame => frames.push(frame as Record<string, unknown>));

    expect(frames.at(-1)).toMatchObject({ type: "command_result", payload: { vaultName: "Vault" } });
  });

  test("routes quote insertion through command_result", async () => {
    const host = createHost();
    host.insertQuote = vi.fn().mockResolvedValue({ ok: true, filePath: "Notes/Quote.md" });
    const bridge = new OstraconWsBridge(host);
    const frames: Array<Record<string, unknown>> = [];
    await bridge.handleCommand({} as never, {
      type: "command",
      command: "insertQuote",
      requestId: "quote-1",
      payload: { target: "file", filePath: "Notes/Quote.md" },
    }, frame => frames.push(frame as Record<string, unknown>));

    expect(host.insertQuote).toHaveBeenCalledWith({ target: "file", filePath: "Notes/Quote.md" });
    expect(frames.at(-1)).toMatchObject({
      type: "command_result",
      requestId: "quote-1",
      payload: { ok: true, filePath: "Notes/Quote.md" },
    });
  });

  test("rejects every additional MN connection until the current socket closes", () => {
    const host = createHost();
    const bridge = new OstraconWsBridge(host);
    bridge.clients.add({ readyState: WebSocket.OPEN } as WebSocket);
    const candidate = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    expect(bridge.rejectAdditionalClient(candidate)).toBe(true);
    expect(candidate.send).toHaveBeenCalledWith(expect.stringContaining("single_client_only"));
    expect(candidate.close).toHaveBeenCalledWith(4009, "已有MarginNote设备连接，请先断开当前设备");
    expect(host.logLine).toHaveBeenCalledWith("warn", "rejected additional MarginNote connection");
  });

  test("creates readable files directly in the configured folder", () => {
    const settings = createDefaultSettings();
    const packet = createPacket("packet-1");
    packet.objects[0].title = "第一张卡片";
    expect(buildPacketFilePath(settings, packet)).toBe("Marginnote/第一张卡片.md");
    expect(buildPacketFilePath(settings, packet, 1)).toBe("Marginnote/第一张卡片 1.md");
    packet.fileName = "摘录回退标题";
    expect(buildPacketFilePath(settings, packet)).toBe("Marginnote/摘录回退标题.md");
    packet.fileName = "";
    packet.objects[0].title = "";
    packet.source.title = "";
    expect(buildPacketFilePath(settings, packet)).toBe("Marginnote/Untitled.md");
  });

  test("adds a numeric suffix when readable file names already exist", () => {
    const settings = createDefaultSettings();
    const packet = createPacket("packet-1");
    packet.fileName = "重复标题";
    const existing = new Set(["Marginnote/重复标题.md", "Marginnote/重复标题 1.md"]);
    expect(findAvailablePacketFilePath(settings, packet, path => existing.has(path))).toBe("Marginnote/重复标题 2.md");
  });
});
