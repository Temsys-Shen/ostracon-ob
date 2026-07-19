import { describe, expect, test, vi } from "vitest";
import { OstraconDiscovery, SERVICE_TYPE } from "./discovery";

describe("Ostracon discovery", () => {
  test("responds to mDNS queries and stops deterministically", () => {
    const handlers = new Map<string, (value: never) => void>();
    const respond = vi.fn();
    const destroy = vi.fn();
    const mdns = {
      on: vi.fn((event: string, handler: (value: never) => void) => { handlers.set(event, handler); }),
      respond,
      destroy,
    };
    const onError = vi.fn();
    const discovery = new OstraconDiscovery(27123, "My Vault", onError, vi.fn(() => mdns) as never);

    discovery.start();
    handlers.get("query")?.({ questions: [{ name: `${SERVICE_TYPE}.local` }] } as never);

    expect(discovery.isRunning).toBe(true);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      answers: expect.arrayContaining([
        expect.objectContaining({ type: "PTR", data: "Ostracon-My-Vault._ostracon._tcp.local" }),
        expect.objectContaining({ type: "SRV", data: expect.objectContaining({ port: 27123 }) }),
      ]),
    }));
    discovery.stop();
    expect(destroy).toHaveBeenCalledOnce();
    expect(discovery.isRunning).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  test("reports asynchronous mDNS errors without starting another mechanism", () => {
    const handlers = new Map<string, (value: Error) => void>();
    const mdns = {
      on: vi.fn((event: string, handler: (value: Error) => void) => { handlers.set(event, handler); }),
      respond: vi.fn(),
      destroy: vi.fn(),
    };
    const onError = vi.fn();
    const discovery = new OstraconDiscovery(27123, "Vault", onError, vi.fn(() => mdns) as never);

    discovery.start();
    handlers.get("error")?.(new Error("socket failed"));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "socket failed" }));
    expect(discovery.isRunning).toBe(false);
  });
});
