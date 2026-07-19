import "obsidian";

declare module "obsidian" {
  interface App {
    setting: {
      open(): void;
    };
  }

  interface Vault {
    getConfig(key: string): unknown;
  }
}
