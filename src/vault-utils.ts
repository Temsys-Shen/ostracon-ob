import { normalizePath, type App } from "obsidian";

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function resolveAttachmentFolder(app: App, notePath: string): string {
  const raw = String(app.vault.getConfig("attachmentFolderPath") ?? "./assets");
  const noteDir = notePath.split("/").slice(0, -1).join("/") || "/";

  if (raw.startsWith("./")) {
    const suffix = raw.slice(2);
    return suffix ? normalizePath(`${noteDir}/${suffix}`) : noteDir;
  }

  return normalizePath(raw);
}

export { ensureFolder, resolveAttachmentFolder };
