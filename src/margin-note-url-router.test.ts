import { describe, expect, test, vi } from "vitest";
import { MarginNoteUrlRouter, findMarginNoteUrlFromClick, normalizeMarginNoteUrl } from "./margin-note-url-router";

function createFixture(options: {
  handler?: string | (() => string);
  openExternal?: () => Promise<void>;
  remoteResult?: unknown;
  remoteError?: Error;
} = {}) {
  const requestClientCommand = options.remoteError
    ? vi.fn().mockRejectedValue(options.remoteError)
    : vi.fn().mockResolvedValue(options.remoteResult ?? { opened: true, url: "marginnote4app://note/n1" });
  const getApplicationNameForProtocol = typeof options.handler === "function"
    ? vi.fn(options.handler)
    : vi.fn().mockReturnValue(options.handler ?? "");
  const openExternal = vi.fn(options.openExternal ?? (async () => {}));
  const router = new MarginNoteUrlRouter(
    { requestClientCommand },
    { getApplicationNameForProtocol, openExternal },
  );
  return { router, requestClientCommand, getApplicationNameForProtocol, openExternal };
}

describe("MarginNote URL router", () => {
  test("opens locally when the current device has a protocol handler", async () => {
    const fixture = createFixture({ handler: "MarginNote 4" });

    await expect(fixture.router.open("marginnote4app://note/n1")).resolves.toEqual({
      target: "local",
      url: "marginnote4app://note/n1",
    });
    expect(fixture.openExternal).toHaveBeenCalledWith("marginnote4app://note/n1");
    expect(fixture.requestClientCommand).not.toHaveBeenCalled();
  });

  test.each([
    ["unavailable", ""],
    ["unknown", () => { throw new Error("protocol detector failed"); }],
  ])("routes to the connected MN when local state is %s", async (_name, handler) => {
    const fixture = createFixture({ handler });

    await expect(fixture.router.open("marginnote4app://note/n1")).resolves.toMatchObject({ target: "connected-mn" });
    expect(fixture.requestClientCommand).toHaveBeenCalledWith(
      "openMarginNoteUrl",
      { url: "marginnote4app://note/n1" },
      12000,
    );
  });

  test("routes to the connected MN when local opening fails", async () => {
    const fixture = createFixture({
      handler: "MarginNote 4",
      openExternal: async () => { throw new Error("open failed"); },
    });

    await expect(fixture.router.open("marginnote4app://note/n1")).resolves.toMatchObject({ target: "connected-mn" });
    expect(fixture.requestClientCommand).toHaveBeenCalledOnce();
  });

  test("surfaces the remote connection error", async () => {
    const fixture = createFixture({ remoteError: new Error("没有已连接的MarginNote客户端") });

    await expect(fixture.router.open("marginnote4app://note/n1")).rejects.toThrow("没有已连接的MarginNote客户端");
  });

  test("deduplicates the same URL while opening is in flight", async () => {
    let resolveRemote!: (value: unknown) => void;
    const requestClientCommand = vi.fn(() => new Promise(resolve => { resolveRemote = resolve; }));
    const router = new MarginNoteUrlRouter(
      { requestClientCommand },
      { getApplicationNameForProtocol: () => "", openExternal: async () => {} },
    );

    const first = router.open("marginnote4app://note/n1");
    const second = router.open("marginnote4app://note/n1");
    expect(first).toBe(second);
    expect(requestClientCommand).toHaveBeenCalledOnce();

    resolveRemote({ opened: true });
    await first;
  });

  test("recognizes nested clicks and ignores ordinary links", () => {
    const eventFor = (href: string) => ({
      button: 0,
      target: {
        closest: () => ({ href, getAttribute: () => href }),
      },
    } as unknown as MouseEvent);

    expect(findMarginNoteUrlFromClick(eventFor("marginnote4app://note/n1"))).toBe("marginnote4app://note/n1");
    expect(findMarginNoteUrlFromClick(eventFor("https://example.com"))).toBeNull();
    expect(() => normalizeMarginNoteUrl("https://example.com")).toThrow("仅支持marginnote4app链接");
  });
});
