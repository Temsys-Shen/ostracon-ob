import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getObsidianConfigPath, resolveActiveVault } from "./obsidian-vault.mjs";

const tempDirectories = [];

function createConfig(vaults) {
  const root = mkdtempSync(join(tmpdir(), "ostracon-vault-test-"));
  tempDirectories.push(root);
  const configPath = join(root, "obsidian.json");
  for (const vault of Object.values(vaults)) {
    if (vault.path) mkdirSync(join(vault.path, ".obsidian"), { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify({ vaults }));
  return configPath;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Obsidian active vault resolver", () => {
  test("resolves config paths on macOS, Windows, and Linux", () => {
    expect(getObsidianConfigPath("darwin", {}, "/Users/tester")).toBe("/Users/tester/Library/Application Support/obsidian/obsidian.json");
    expect(getObsidianConfigPath("win32", { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" }, "C:\\Users\\tester")).toBe(
      "C:\\Users\\tester\\AppData\\Roaming/obsidian/obsidian.json",
    );
    expect(getObsidianConfigPath("linux", { XDG_CONFIG_HOME: "/home/tester/config" }, "/home/tester")).toBe(
      "/home/tester/config/obsidian/obsidian.json",
    );
  });

  test("selects the most recently active open vault", () => {
    const root = mkdtempSync(join(tmpdir(), "ostracon-vaults-"));
    tempDirectories.push(root);
    const older = join(root, "older");
    const latest = join(root, "latest");
    const closed = join(root, "closed");
    const configPath = createConfig({
      older: { path: older, open: true, ts: 100 },
      latest: { path: latest, open: true, ts: 200 },
      closed: { path: closed, open: false, ts: 300 },
    });

    expect(resolveActiveVault(configPath)).toBe(latest);
  });

  test("fails when no vault is open", () => {
    const root = mkdtempSync(join(tmpdir(), "ostracon-closed-vault-"));
    tempDirectories.push(root);
    const configPath = createConfig({ only: { path: join(root, "vault"), open: false, ts: 100 } });

    expect(() => resolveActiveVault(configPath)).toThrow("没有处于打开状态的Obsidian Vault");
  });
});
