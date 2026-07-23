import { remote, shell } from "electron";

const MARGIN_NOTE_PROTOCOL = "marginnote4app:";
const OPEN_MARGIN_NOTE_URL_COMMAND = "openMarginNoteUrl";

type LocalProtocolState = "available" | "unavailable" | "unknown";
type MarginNoteUrlOpenResult = { target: "local" | "connected-mn"; url: string };

type MarginNoteUrlBridge = {
  requestClientCommand: (command: string, payload?: unknown, timeoutMs?: number) => Promise<unknown>;
};

type MarginNoteUrlRouterDependencies = {
  getApplicationNameForProtocol: (url: string) => string;
  openExternal: (url: string) => Promise<void>;
};

const DEFAULT_DEPENDENCIES: MarginNoteUrlRouterDependencies = {
  getApplicationNameForProtocol: url => remote.app.getApplicationNameForProtocol(url),
  openExternal: url => shell.openExternal(url),
};

function normalizeMarginNoteUrl(value: string): string {
  const url = String(value || "").trim();
  if (!url) throw new Error("MarginNote链接不能为空");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MarginNote链接格式无效");
  }
  if (parsed.protocol.toLowerCase() !== MARGIN_NOTE_PROTOCOL) {
    throw new Error("仅支持marginnote4app链接");
  }
  return parsed.href;
}

function findMarginNoteUrlFromClick(event: MouseEvent): string | null {
  if (event.button !== 0) return null;
  const target = event.target as (EventTarget & {
    closest?: (selector: string) => Element | null;
    parentElement?: Element | null;
  }) | null;
  const element = (typeof target?.closest === "function" ? target : target?.parentElement) as {
    closest: (selector: string) => Element | null;
  } | null | undefined;
  const anchor = element ? element.closest("a[href]") as HTMLAnchorElement | null : null;
  if (!anchor) return null;

  try {
    return normalizeMarginNoteUrl(anchor.href || anchor.getAttribute("href") || "");
  } catch {
    return null;
  }
}

class MarginNoteUrlRouter {
  private readonly inFlight = new Map<string, Promise<MarginNoteUrlOpenResult>>();

  constructor(
    private readonly bridge: MarginNoteUrlBridge,
    private readonly dependencies: MarginNoteUrlRouterDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  open(value: string): Promise<MarginNoteUrlOpenResult> {
    const url = normalizeMarginNoteUrl(value);
    const pending = this.inFlight.get(url);
    if (pending) return pending;

    const request = this.openOnce(url).finally(() => {
      this.inFlight.delete(url);
    });
    this.inFlight.set(url, request);
    return request;
  }

  private detectLocalProtocol(url: string): LocalProtocolState {
    try {
      const applicationName = this.dependencies.getApplicationNameForProtocol(url);
      if (typeof applicationName !== "string") return "unknown";
      return applicationName.trim() ? "available" : "unavailable";
    } catch {
      return "unknown";
    }
  }

  private async openOnce(url: string): Promise<MarginNoteUrlOpenResult> {
    if (this.detectLocalProtocol(url) === "available") {
      try {
        await this.dependencies.openExternal(url);
        return { target: "local", url };
      } catch {
        return this.openOnConnectedMn(url);
      }
    }
    return this.openOnConnectedMn(url);
  }

  private async openOnConnectedMn(url: string): Promise<MarginNoteUrlOpenResult> {
    const raw = await this.bridge.requestClientCommand(OPEN_MARGIN_NOTE_URL_COMMAND, { url }, 12000);
    if (!raw || typeof raw !== "object" || (raw as { opened?: unknown }).opened !== true) {
      throw new Error("MN没有确认链接已打开");
    }
    return { target: "connected-mn", url };
  }
}

export {
  MARGIN_NOTE_PROTOCOL,
  OPEN_MARGIN_NOTE_URL_COMMAND,
  MarginNoteUrlRouter,
  findMarginNoteUrlFromClick,
  normalizeMarginNoteUrl,
};
export type { LocalProtocolState, MarginNoteUrlOpenResult, MarginNoteUrlRouterDependencies };
