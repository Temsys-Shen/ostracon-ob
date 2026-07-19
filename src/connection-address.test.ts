import { EventEmitter } from "node:events";
import type { Socket } from "node:dgram";
import { describe, expect, test, vi } from "vitest";
import {
  resolveConnectionUrl,
  resolveDefaultRouteIpv4,
  resolveDefaultRouteIpv6,
  type ConnectionAddressDependencies,
} from "./connection-address";

function createUdpSocket(address: string, error?: Error) {
  const socket = new EventEmitter() as Socket;
  socket.connect = vi.fn((_port: number, _target: string, callback: () => void) => {
    if (error) socket.emit("error", error);
    else callback();
  }) as unknown as Socket["connect"];
  socket.address = vi.fn().mockReturnValue({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 49152 });
  socket.close = vi.fn().mockReturnValue(socket);
  return socket;
}

describe("connection address resolver", () => {
  test("prefers the local IPv6 address selected by the system default route", async () => {
    const socket = createUdpSocket("2001:db8::10");
    const createSocket = vi.fn().mockReturnValue(socket) as unknown as NonNullable<ConnectionAddressDependencies["createSocket"]>;

    await expect(resolveConnectionUrl(27123, { createSocket })).resolves.toBe("ws://[2001:db8::10]:27123");
    expect(createSocket).toHaveBeenCalledWith("udp6");
    expect(socket.connect).toHaveBeenCalledWith(53, "2606:4700:4700::1111", expect.any(Function));
  });

  test("falls back to the local IPv4 address when IPv6 has no route", async () => {
    const ipv6Socket = createUdpSocket("::", new Error("connect ENETUNREACH"));
    const ipv4Socket = createUdpSocket("192.168.50.12");
    const createSocket = vi.fn()
      .mockReturnValueOnce(ipv6Socket)
      .mockReturnValueOnce(ipv4Socket) as unknown as NonNullable<ConnectionAddressDependencies["createSocket"]>;

    await expect(resolveConnectionUrl(28123, { createSocket })).resolves.toBe("ws://192.168.50.12:28123");
    expect(createSocket).toHaveBeenNthCalledWith(1, "udp6");
    expect(createSocket).toHaveBeenNthCalledWith(2, "udp4");
  });

  test("rejects IPv6 loopback", async () => {
    const socket = createUdpSocket("::1");
    const createSocket = vi.fn().mockReturnValue(socket) as unknown as NonNullable<ConnectionAddressDependencies["createSocket"]>;

    await expect(resolveDefaultRouteIpv6(createSocket)).rejects.toThrow("系统默认路由返回了IPv6回环地址");
  });

  test("rejects the entire IPv4 loopback range", async () => {
    const socket = createUdpSocket("127.12.34.56");
    const createSocket = vi.fn().mockReturnValue(socket) as unknown as NonNullable<ConnectionAddressDependencies["createSocket"]>;

    await expect(resolveDefaultRouteIpv4(createSocket)).rejects.toThrow("系统默认路由返回了IPv4回环地址");
  });

  test("reports both route failures", async () => {
    const ipv6Socket = createUdpSocket("::", new Error("IPv6 unavailable"));
    const ipv4Socket = createUdpSocket("0.0.0.0", new Error("IPv4 unavailable"));
    const createSocket = vi.fn()
      .mockReturnValueOnce(ipv6Socket)
      .mockReturnValueOnce(ipv4Socket) as unknown as NonNullable<ConnectionAddressDependencies["createSocket"]>;

    await expect(resolveConnectionUrl(27123, { createSocket })).rejects.toThrow(
      "默认路由IPv6: IPv6 unavailable；默认路由IPv4: IPv4 unavailable",
    );
  });
});
