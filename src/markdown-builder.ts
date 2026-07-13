import { type OstraconPacket, type OstraconPacketRecord } from "./contract";

function buildPacketMarkdown(packet: OstraconPacket, record: OstraconPacketRecord, includeBacklinks = true): string {
  if (packet.format === "canvas" && packet.notes) {
    return packet.notes.trimEnd();
  }

  if (packet.format === "markdown" && packet.notes) {
    return packet.notes.trimEnd();
  }

  const lines: string[] = [];
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
    lines.push(`- Title: ${object.title || ""}`, `- Comment: ${object.comment || ""}`);
    if (!includeBacklinks) lines.push(`- Source Anchor: ${object.sourceAnchor || ""}`);
    lines.push(`- Has Image: ${object.hasImage ? "yes" : "no"}`, `- Has Handwriting: ${object.hasHandwriting ? "yes" : "no"}`, "");
  }
  lines.push("## Raw Packet", "```json", JSON.stringify(packet, null, 2), "```", "");
  return lines.join("\n");
}

export { buildPacketMarkdown };
