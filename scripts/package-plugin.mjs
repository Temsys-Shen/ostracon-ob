import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../manifest.json" with { type: "json" };

const pluginId = manifest.id;
const version = manifest.version;
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(rootDir, "dist");
const packageDir = join(distDir, pluginId);
const archivePath = join(distDir, `${pluginId}-${version}.zip`);
const requiredFiles = ["manifest.json", "main.js", "styles.css"];

rmSync(packageDir, { recursive: true, force: true });
rmSync(archivePath, { force: true });
mkdirSync(packageDir, { recursive: true });

for (const fileName of requiredFiles) {
  copyFileSync(join(rootDir, fileName), join(packageDir, fileName));
}

execFileSync("zip", ["-r", archivePath, pluginId], {
  cwd: distDir,
  stdio: "inherit",
});

console.log(`Packaged ${pluginId} ${version}`);
console.log(`Directory: ${packageDir}`);
console.log(`Archive: ${archivePath}`);
