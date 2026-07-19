import dgram from "node:dgram";
import { isIP } from "node:net";

const IPV6_ROUTE_TARGET = "2606:4700:4700::1111";
const IPV4_ROUTE_TARGET = "1.1.1.1";
const ROUTE_TARGET_PORT = 53;

type UdpSocketFactory = typeof dgram.createSocket;

type ConnectionAddressDependencies = {
  createSocket?: UdpSocketFactory;
};

function resolveDefaultRouteAddress(
  socketType: "udp4" | "udp6",
  target: string,
  expectedFamily: 4 | 6,
  createSocket: UdpSocketFactory,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(socketType);
    let settled = false;
    const finish = (error?: Error, address?: string) => {
      if (settled) return;
      settled = true;
      socket.close();
      if (error) reject(error);
      else resolve(address!);
    };

    socket.once("error", error => finish(error));
    socket.connect(ROUTE_TARGET_PORT, target, () => {
      const local = socket.address();
      if (typeof local === "string" || isIP(local.address) !== expectedFamily) {
        finish(new Error(`系统默认路由未提供有效的本机IPv${expectedFamily}地址`));
        return;
      }
      if (expectedFamily === 4 && local.address.startsWith("127.")) {
        finish(new Error("系统默认路由返回了IPv4回环地址"));
        return;
      }
      if (expectedFamily === 6 && local.address === "::1") {
        finish(new Error("系统默认路由返回了IPv6回环地址"));
        return;
      }
      finish(undefined, local.address);
    });
  });
}

function resolveDefaultRouteIpv6(createSocket: UdpSocketFactory = dgram.createSocket): Promise<string> {
  return resolveDefaultRouteAddress("udp6", IPV6_ROUTE_TARGET, 6, createSocket);
}

function resolveDefaultRouteIpv4(createSocket: UdpSocketFactory = dgram.createSocket): Promise<string> {
  return resolveDefaultRouteAddress("udp4", IPV4_ROUTE_TARGET, 4, createSocket);
}

async function resolveConnectionUrl(port: number, dependencies: ConnectionAddressDependencies = {}): Promise<string> {
  const createSocket = dependencies.createSocket ?? dgram.createSocket;
  try {
    const ipv6 = await resolveDefaultRouteIpv6(createSocket);
    return `ws://[${ipv6}]:${port}`;
  } catch (ipv6Error) {
    try {
      const ipv4 = await resolveDefaultRouteIpv4(createSocket);
      return `ws://${ipv4}:${port}`;
    } catch (ipv4Error) {
      const ipv6Message = ipv6Error instanceof Error ? ipv6Error.message : String(ipv6Error);
      const ipv4Message = ipv4Error instanceof Error ? ipv4Error.message : String(ipv4Error);
      throw new Error(`无法解析连接地址。默认路由IPv6: ${ipv6Message}；默认路由IPv4: ${ipv4Message}`);
    }
  }
}

export { resolveConnectionUrl, resolveDefaultRouteIpv4, resolveDefaultRouteIpv6 };
export type { ConnectionAddressDependencies };
