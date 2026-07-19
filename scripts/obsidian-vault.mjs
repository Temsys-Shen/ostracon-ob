import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function getObsidianConfigPath(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  if (platform === "win32") {
    if (!env.APPDATA) throw new Error("无法定位Obsidian配置：APPDATA未设置");
    return join(env.APPDATA, "obsidian", "obsidian.json");
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "obsidian", "obsidian.json");
}

function resolveActiveVault(configPath = getObsidianConfigPath()) {
  if (!existsSync(configPath)) throw new Error(`未找到Obsidian配置：${configPath}`);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object" || !config.vaults || typeof config.vaults !== "object") {
    throw new Error(`Obsidian配置缺少vaults：${configPath}`);
  }

  const active = Object.values(config.vaults)
    .filter(vault => vault && typeof vault === "object" && vault.open === true && typeof vault.path === "string" && vault.path.trim())
    .sort((left, right) => Number(right.ts || 0) - Number(left.ts || 0));
  if (active.length === 0) throw new Error("没有处于打开状态的Obsidian Vault");

  const vaultPath = active[0].path;
  if (!existsSync(join(vaultPath, ".obsidian"))) {
    throw new Error(`活跃Vault缺少.obsidian目录：${vaultPath}`);
  }
  return vaultPath;
}

export { getObsidianConfigPath, resolveActiveVault };
