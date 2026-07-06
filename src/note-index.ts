type PacketFormat = "markdown" | "canvas";

class NoteIndex {
  private map = new Map<string, Map<PacketFormat, string>>();

  set(noteId: string, filePath: string, format: PacketFormat): void {
    const existing = this.map.get(noteId) || new Map();
    existing.set(format, filePath);
    this.map.set(noteId, existing);
  }

  get(noteId: string, format: PacketFormat): string {
    const paths = this.map.get(noteId);
    return paths?.get(format) || "";
  }

  rebuild(entries: Array<{ filePath: string; objects: Array<{ id: string }>; format?: string }>): void {
    this.map = new Map();
    for (const entry of entries) {
      for (const obj of entry.objects) {
        const fmt: PacketFormat = entry.format === "canvas" ? "canvas" : "markdown";
        this.set(obj.id, entry.filePath, fmt);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export { NoteIndex, type PacketFormat };
