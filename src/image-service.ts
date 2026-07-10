import crypto from "crypto";
import { normalizePath, type App } from "obsidian";
import { ensureFolder, resolveAttachmentFolder } from "./vault-utils";

const DATA_URL_REGEX = /!\[([^\]]*)\]\(data:image\/([\w.+-]+);base64,([A-Za-z0-9+/=]+)\)/g;

const MIME_EXT_MAP: Record<string, string> = {
  png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif",
  webp: "webp", svg: "svg", "svg+xml": "svg",
};

function extFromMime(mime: string): string {
  return MIME_EXT_MAP[mime.toLowerCase()] ?? "png";
}

function decodeBase64(str: string): ArrayBuffer {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function md5Hex(data: ArrayBuffer): string {
  return crypto.createHash("md5").update(Buffer.from(data)).digest("hex");
}

async function processBase64InMarkdown(
  app: App,
  notePath: string,
  markdown: string,
  attachmentFolder?: string,
): Promise<string> {
  const attachDir = attachmentFolder ?? resolveAttachmentFolder(app, notePath);
  await ensureFolder(app, attachDir);

  let result = markdown;
  let offset = 0;
  const regex = new RegExp(DATA_URL_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const fullMatch = match[0];
    const alt = match[1] || "";
    const mime = match[2];
    const base64 = match[3];
    const ext = extFromMime(mime);

    const data = decodeBase64(base64);
    const hash = md5Hex(data);
    const fileName = `${hash}.${ext}`;
    const filePath = normalizePath(`${attachDir}/${fileName}`);

    const existing = app.vault.getAbstractFileByPath(filePath);
    if (!existing) {
      await app.vault.createBinary(filePath, data);
    }

    const relativePath = getRelativePath(notePath, filePath);
    const replacement = `![${alt}](${relativePath})`;
    const start = match.index + offset;
    const end = start + fullMatch.length;
    result = result.slice(0, start) + replacement + result.slice(end);
    offset += replacement.length - fullMatch.length;
  }

  return result;
}

function getRelativePath(fromPath: string, toPath: string): string {
  const fromParts = fromPath.split("/").slice(0, -1);
  const toParts = toPath.split("/");
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.length - i;
  const rel: string[] = [];
  for (let j = 0; j < up; j++) rel.push("..");
  rel.push(...toParts.slice(i));
  return normalizePath(rel.join("/"));
}

export { processBase64InMarkdown };
