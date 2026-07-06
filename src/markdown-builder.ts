import { DEFAULTS, PROTOCOL_VERSION, normalizeTags, type OstraconPacket, type OstraconPacketRecord } from "./contract";

function buildPacketMarkdown(packet: OstraconPacket, record: OstraconPacketRecord, includeBacklinks = true): string {
  if (packet.format === "canvas" && packet.notes) {
    return packet.notes.trimEnd();
  }

  if (packet.format === "markdown" && packet.notes) {
    const tags = normalizeTags(packet.tags);
    const lines: string[] = ["---"];
    lines.push(`ostracon_id: ${JSON.stringify(packet.id)}`);
    lines.push(`ostracon_format: markdown`);
    lines.push(`ostracon_received_at: ${JSON.stringify(record.receivedAt)}`);
    lines.push(`ostracon_source_title: ${JSON.stringify(packet.source?.title || "")}`);
    if (tags.length > 0) {
      lines.push("ostracon_tags:");
      for (const tag of tags) lines.push(`  - ${JSON.stringify(tag)}`);
    }
    lines.push("ostracon_note_ids:");
    for (const obj of packet.objects || []) {
      lines.push(`  - ${JSON.stringify(obj.id)}`);
    }
    lines.push("---", "");
    lines.push(packet.notes.trimEnd());
    if (includeBacklinks) appendObjectLinks(lines, packet);
    return lines.join("\n");
  }

  const lines: string[] = [];
  const tags = normalizeTags(packet.tags);
  lines.push("---");
  lines.push(`ostracon_id: ${JSON.stringify(packet.id)}`);
  lines.push(`ostracon_status: ${JSON.stringify(packet.status || DEFAULTS.status)}`);
  lines.push(`ostracon_version: ${packet.version || PROTOCOL_VERSION}`);
  lines.push(`ostracon_transport: ${JSON.stringify(packet.transport || DEFAULTS.transport)}`);
  lines.push(`ostracon_source_platform: ${JSON.stringify(packet.source?.platform || "")}`);
  lines.push(`ostracon_source_title: ${JSON.stringify(packet.source?.title || "")}`);
  lines.push(`ostracon_source_url: ${JSON.stringify(packet.source?.url || "")}`);
  lines.push(`ostracon_received_at: ${JSON.stringify(record.receivedAt)}`);
  lines.push(`ostracon_file_path: ${JSON.stringify(record.filePath)}`);
  lines.push(`ostracon_object_count: ${Array.isArray(packet.objects) ? packet.objects.length : 0}`);
  lines.push("ostracon_tags:");
  for (const tag of tags) lines.push(`  - ${JSON.stringify(tag)}`);
  lines.push("ostracon_note_ids:");
  for (const obj of packet.objects || []) {
    lines.push(`  - ${JSON.stringify(obj.id)}`);
  }
  lines.push("---", "");
  lines.push(`# ${packet.source?.title || packet.id}`, "");
  lines.push("## Summary", "");
  lines.push(packet.summary ? packet.summary : "未填写摘要", "");
  lines.push("", "## Objects");
  for (const object of packet.objects || []) {
    const title = object.title || "未命名卡片";
    const heading = includeBacklinks && object.sourceAnchor
      ? `[${title}](${object.sourceAnchor})`
      : title;
    lines.push(`### ${heading} <!-- ostracon_noteid:${object.id} -->`);
    lines.push(`- Title: ${object.title || ""}`, `- Excerpt: ${object.excerpt || ""}`, `- Comment: ${object.comment || ""}`);
    if (!includeBacklinks) lines.push(`- Source Anchor: ${object.sourceAnchor || ""}`);
    lines.push(`- Has Image: ${object.hasImage ? "yes" : "no"}`, `- Has Handwriting: ${object.hasHandwriting ? "yes" : "no"}`, "");
  }
  lines.push("## Raw Packet", "```json", JSON.stringify(packet, null, 2), "```", "");
  return lines.join("\n");
}

function appendObjectLinks(lines: string[], packet: OstraconPacket): void {
  const linkedObjects = (packet.objects || []).filter(object => object.sourceAnchor);
  if (linkedObjects.length === 0) return;
  lines.push("", "## MarginNote Links", "");
  for (const object of linkedObjects) {
    const label = object.title || object.excerpt || object.id || "MarginNote Card";
    lines.push(`- [${escapeMarkdownLinkText(label)}](${object.sourceAnchor})`);
  }
}

function escapeMarkdownLinkText(value: string): string {
  return String(value || "").replace(/[[\]\\]/g, "\\$&").replace(/\s+/g, " ").trim() || "MarginNote Card";
}

export { buildPacketMarkdown };
