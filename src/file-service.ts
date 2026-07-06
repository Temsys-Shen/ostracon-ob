import { TFile, type App } from "obsidian";
import { type OstraconPacketRecord } from "./contract";
import { buildPacketMarkdown } from "./markdown-builder";
import { ensureFolder } from "./vault-utils";
import { findCardSection, buildCardSection, updateCanvasNode } from "./card-content";
import { Mutex } from "./mutex";

class FileService {
  private app: App;
  private mutex: Mutex;
  private includeBacklinks: boolean;
  internalWritePaths: Set<string> = new Set();

  constructor(app: App, mutex: Mutex, includeBacklinks = true) {
    this.app = app;
    this.mutex = mutex;
    this.includeBacklinks = includeBacklinks;
  }

  setIncludeBacklinks(value: boolean) {
    this.includeBacklinks = value;
  }

  formatFromFilePath(filePath: string): string {
    return filePath.toLowerCase().endsWith(".canvas") ? "canvas" : "markdown";
  }

  async processInternalWrite(file: TFile, fn: (content: string) => string): Promise<void> {
    this.internalWritePaths.add(file.path);
    try {
      await this.app.vault.process(file, fn);
    } finally {
      this.internalWritePaths.delete(file.path);
    }
  }

  async createInternalFile(filePath: string, content: string): Promise<void> {
    this.internalWritePaths.add(filePath);
    try {
      await this.app.vault.create(filePath, content);
    } finally {
      this.internalWritePaths.delete(filePath);
    }
  }

  async writePacketToVault(record: OstraconPacketRecord): Promise<void> {
    const folderPath = record.filePath.split("/").slice(0, -1).join("/");
    await ensureFolder(this.app, folderPath);
    const existing = this.app.vault.getAbstractFileByPath(record.filePath);
    const packet = record.packet;

    const unlock = await this.mutex.acquire(record.filePath);
    try {
      if (packet.format === "canvas") {
        const content = buildPacketMarkdown(packet, record, this.includeBacklinks);
        if (existing instanceof TFile) {
          await this.processInternalWrite(existing, () => content);
        } else {
          await this.createInternalFile(record.filePath, content);
        }
      } else if (existing instanceof TFile && packet.format !== "markdown") {
        let content = await this.app.vault.read(existing);
        for (const object of packet.objects || []) {
          const section = findCardSection(content, object.id);
          const newSection = buildCardSection(object, section?.headingMark);
          if (section) {
            content = content.slice(0, section.start) + newSection + content.slice(section.end);
          } else {
            const rawIdx = content.lastIndexOf("## Raw Packet");
            const at = rawIdx >= 0 ? rawIdx : content.length;
            content = content.slice(0, at) + "\n" + newSection.trimEnd() + "\n\n" + content.slice(at);
          }
        }
        content = content.replace(/^ostracon_version:.*$/m, `ostracon_version: ${record.version}`);
        await this.processInternalWrite(existing, () => content);
      } else {
        const content = buildPacketMarkdown(packet, record, this.includeBacklinks);
        if (existing instanceof TFile) {
          await this.processInternalWrite(existing, () => content);
        } else {
          await this.createInternalFile(record.filePath, content);
        }
      }
    } finally {
      unlock();
    }
  }

  async readFileContent(filePath: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error(`文件不存在: ${filePath}`);
    return this.app.vault.read(file);
  }
}

export { FileService };
