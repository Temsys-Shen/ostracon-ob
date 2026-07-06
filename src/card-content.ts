import { type OstraconObject } from "./contract";

type CardSection = { start: number; end: number; headingMark: string };

function findCardSection(content: string, noteId: string): CardSection | null {
  const escaped = noteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^(#{1,6})\\s+.*<!--\\s*ostracon_noteid:${escaped}\\s*-->\\s*$`);
  const nextCardHeadingPattern = /^#{1,6}\s+.*<!--\s*ostracon_noteid:[^>]+-->\s*$/;
  const lines = content.match(/[^\n]*(?:\n|$)/g) || [];
  let offset = 0;
  let start = -1;
  let end = content.length;
  let headingMark = "###";

  for (const line of lines) {
    const text = line.replace(/\r?\n$/, "");
    const heading = text.match(headingPattern);
    if (start < 0 && heading) {
      start = offset;
      headingMark = heading[1];
    } else if (start >= 0 && nextCardHeadingPattern.test(text)) {
      end = offset;
      break;
    }
    offset += line.length;
  }

  return start >= 0 ? { start, end, headingMark } : null;
}

function replaceCardSection(content: string, section: CardSection, newSection: string): string {
  const before = content.slice(0, section.start);
  const after = content.slice(section.end).replace(/^\r?\n*/, "");
  return before + newSection + (after ? "\n\n" + after : "");
}

function parseCardSection(block: string): { title: string; excerpt: string; comment: string } {
  const structured = {
    title: block.match(/- Title:\s*(.*)/)?.[1]?.trim(),
    excerpt: block.match(/- Excerpt:\s*(.*)/)?.[1]?.trim(),
    comment: block.match(/- Comment:\s*(.*)/)?.[1]?.trim(),
  };
  if (structured.title !== undefined || structured.excerpt !== undefined || structured.comment !== undefined) {
    return {
      title: structured.title || "",
      excerpt: structured.excerpt || "",
      comment: structured.comment || "",
    };
  }

  const heading = block.match(/^#{1,6}\s+(.+?)\s*<!--\s*ostracon_noteid:[^>]+-->/);
  if (!heading) throw new Error("卡片段落缺少ostracon_noteid标题");

  const body = block.slice(heading[0].length).trim();
  const lines = body.split(/\r?\n/);
  const excerptLines: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index].startsWith(">")) {
    excerptLines.push(lines[index].replace(/^>\s?/, ""));
    index++;
  }
  while (index < lines.length && lines[index].trim() === "") index++;

  const comment = lines.slice(index)
    .filter(line => !isOstraconMetadataLine(line))
    .join("\n")
    .trim();

  return {
    title: heading[1].trim(),
    excerpt: excerptLines.join("\n").trim(),
    comment,
  };
}

function buildCardSection(object: OstraconObject, headingMark = "###"): string {
  const lines = [`${headingMark} ${object.title || "未命名卡片"} <!-- ostracon_noteid:${object.id} -->`, ""];
  if (object.excerpt) {
    lines.push(...object.excerpt.split(/\r?\n/).map(line => line ? `> ${line}` : ">"));
    lines.push("");
  }
  if (object.comment) {
    lines.push(object.comment);
  }
  return lines.join("\n").trimEnd();
}

function buildCanvasNodeText(object: OstraconObject): string {
  const lines = [`## ${object.title || "未命名卡片"}`, ""];
  if (object.excerpt) {
    lines.push(...object.excerpt.split(/\r?\n/).map(line => line ? `> ${line}` : ">"));
    lines.push("");
  }
  if (object.comment) {
    lines.push(object.comment);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function estimateCanvasNodeHeight(text: string): number {
  return Math.max(140, 60 + text.split(/\r?\n/).length * 18);
}

function updateCanvasNode(content: string, noteId: string, text: string): string {
  let canvas: { nodes?: Array<Record<string, unknown>>; edges?: unknown[] };
  try {
    canvas = JSON.parse(content) as { nodes?: Array<Record<string, unknown>>; edges?: unknown[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Canvas JSON解析失败: ${message}`);
  }

  if (!Array.isArray(canvas.nodes)) throw new Error("Canvas缺少nodes数组");
  const node = canvas.nodes.find(item => item.id === noteId);
  if (!node) throw new Error(`Canvas未包含noteId节点: ${noteId}`);

  node.type = "text";
  node.text = text;
  if (typeof node.width !== "number") node.width = 380;
  node.height = estimateCanvasNodeHeight(text);

  return JSON.stringify(canvas, null, 2);
}

function isOstraconMetadataLine(line: string): boolean {
  const text = line.trim();
  return /^!\[[^\]]*\]\(.+\)$/.test(text)
    || /^-?\s*(Source Anchor|MarginNote Link|Has Image|Has Handwriting|Comment):/i.test(text)
    || /^-?\s*marginnote4app:\/\/note\//i.test(text);
}

export {
  findCardSection, replaceCardSection, parseCardSection,
  buildCardSection, buildCanvasNodeText, estimateCanvasNodeHeight,
  updateCanvasNode, isOstraconMetadataLine,
  type CardSection,
};
