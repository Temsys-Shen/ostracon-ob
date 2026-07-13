import { TFile, type App } from "obsidian";
import { type OstraconPacketRecord } from "./contract";
import { buildPacketMarkdown } from "./markdown-builder";
import { ensureFolder } from "./vault-utils";
import { containsHandwritingSvgDataURL, processBase64InMarkdown } from "./image-service";
import { Mutex } from "./mutex";

class FileService {
  private app: App;
  private mutex: Mutex;
  private includeBacklinks: boolean;
  private autoConvertBase64: boolean;
  internalWritePaths: Set<string> = new Set();

  constructor(app: App, mutex: Mutex, includeBacklinks = true, autoConvertBase64 = true) {
    this.app = app;
    this.mutex = mutex;
    this.includeBacklinks = includeBacklinks;
    this.autoConvertBase64 = autoConvertBase64;
  }

  setIncludeBacklinks(value: boolean) {
    this.includeBacklinks = value;
  }

  setAutoConvertBase64(value: boolean) {
    this.autoConvertBase64 = value;
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
      let content = buildPacketMarkdown(packet, record, this.includeBacklinks);
      if (this.autoConvertBase64 || containsHandwritingSvgDataURL(content)) {
        content = await processBase64InMarkdown(this.app, record.filePath, content);
      }
      if (existing instanceof TFile) {
        await this.processInternalWrite(existing, () => content);
      } else {
        await this.createInternalFile(record.filePath, content);
      }
    } finally {
      unlock();
    }
  }

}

export { FileService };
