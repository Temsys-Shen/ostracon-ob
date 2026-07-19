import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      electron: path.resolve(__dirname, "src/test/electron-runtime.ts"),
      obsidian: path.resolve(__dirname, "src/test/obsidian-runtime.ts"),
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"] },
});
