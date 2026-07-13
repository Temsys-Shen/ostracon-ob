import { expect, test } from "vitest";
import { type OstraconPacket, type OstraconPacketRecord } from "./contract";
import { buildPacketMarkdown } from "./markdown-builder";

function createPacket(): OstraconPacket {
  return {
    version: 1,
    id: "packet-1",
    status: "sent",
    transport: "ws",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    source: { platform: "MarginNote", title: "Example", url: "" },
    summary: "",
    tags: [],
    objects: [{
      id: "card-1",
      kind: "Card",
      title: "标题",
      comment: "正文一\n\n正文二",
      sourceAnchor: "marginnote4app://note/card-1",
      hasImage: true,
      hasHandwriting: true,
    }],
    relations: [],
    notes: "",
    destination: { platform: "Obsidian", vault: "", folder: "Inbox" },
  };
}

test("builds structured Markdown without excerpt fields", () => {
  const packet = createPacket();
  const record = {
    packet,
    receivedAt: "2026-07-13T00:00:00.000Z",
    filePath: "Marginnote/Example.md",
  } as OstraconPacketRecord;

  const markdown = buildPacketMarkdown(packet, record);

  expect(markdown).toContain("- Comment: 正文一\n\n正文二");
  expect(markdown).not.toContain("Excerpt");
  expect(markdown).not.toContain("excerpt");
  expect(markdown).not.toContain("---");
  expect(markdown).not.toContain("ostracon_id:");
  expect(markdown).not.toContain("MarginNote Links");
  expect(markdown).not.toContain("- [标题](marginnote4app://note/card-1)");
});

test("keeps structured card backlinks on headings", () => {
  const packet = createPacket();
  const record = {
    packet,
    receivedAt: "2026-07-13T00:00:00.000Z",
    filePath: "Marginnote/Example.md",
  } as OstraconPacketRecord;

  const linked = buildPacketMarkdown(packet, record, true);
  const plain = buildPacketMarkdown(packet, record, false);

  expect(linked).toContain("### [标题](marginnote4app://note/card-1) <!-- ostracon_noteid:card-1 -->");
  expect(linked).not.toContain("## MarginNote Links");
  expect(plain).toContain("### 标题 <!-- ostracon_noteid:card-1 -->");
});

test("keeps MN-rendered Markdown free of YAML properties", () => {
  const packet = createPacket();
  packet.format = "markdown";
  packet.notes = "## [标题](marginnote4app://note/card-1)\n\n正文\n";
  const record = {
    packet,
    receivedAt: "2026-07-13T00:00:00.000Z",
    filePath: "Marginnote/标题.md",
  } as OstraconPacketRecord;

  expect(buildPacketMarkdown(packet, record)).toBe("## [标题](marginnote4app://note/card-1)\n\n正文");
});
