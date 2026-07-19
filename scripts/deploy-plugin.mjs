import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../manifest.json" with { type: "json" };
import { resolveActiveVault } from "./obsidian-vault.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const vaultPath = resolveActiveVault();
const pluginDir = join(vaultPath, ".obsidian", "plugins", manifest.id);
const requiredFiles = ["manifest.json", "main.js", "styles.css"];

mkdirSync(pluginDir, { recursive: true });
for (const fileName of requiredFiles) {
  copyFileSync(join(rootDir, fileName), join(pluginDir, fileName));
}

console.log(`Deployed ${manifest.id} ${manifest.version}`);
console.log(`Vault: ${vaultPath}`);
console.log(`Plugin: ${pluginDir}`);
