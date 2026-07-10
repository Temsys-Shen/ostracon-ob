import { spawn, ChildProcess } from "child_process";
import os from "os";
import mDNS = require("multicast-dns");

const SERVICE_TYPE = "_ostracon._tcp";
const SERVICE_DOMAIN = "local";

function getPlatformCmd(name: string, port: number): { cmd: string; args: string[] } | null {
  const platform = os.platform();
  const hostname = os.hostname();

  if (platform === "darwin") {
    // macOS: dns-sd -R <Name> <Type> <Domain> <Port> [Host] [TXT...]
    return {
      cmd: "dns-sd",
      args: [
        "-R", name, SERVICE_TYPE, SERVICE_DOMAIN,
        String(port), hostname,
        `instance=${name}`, "version=1",
      ],
    };
  }

  if (platform === "linux") {
    // Linux: avahi-publish -s <Name> <Type> <Port> [TXT...]
    return {
      cmd: "avahi-publish",
      args: [
        "-s", name, SERVICE_TYPE,
        String(port),
        `instance=${name}`, "version=1",
      ],
    };
  }

  return null;
}

class OstraconDiscovery {
  private process: ChildProcess | null = null;
  private mdns: mDNS.MulticastDNS | null = null;
  private port: number;
  private instanceName: string;
  private hostname: string;

  constructor(port: number, vaultName: string) {
    this.port = port;
    this.instanceName = `Ostracon-${vaultName.replace(/\s+/g, "-")}`;
    this.hostname = os.hostname();
  }

  get isRunning(): boolean {
    return (this.process !== null && !this.process.killed) || this.mdns !== null;
  }

  start(): void {
    const platformCmd = getPlatformCmd(this.instanceName, this.port);

    if (platformCmd) {
      this.startNative(platformCmd.cmd, platformCmd.args);
    } else {
      this.startMdns();
    }
  }

  private startNative(cmd: string, args: string[]): void {
    try {
      this.process = spawn(cmd, args, {
        stdio: ["ignore", "ignore", "ignore"],
      });

      this.process.on("error", (err: Error) => {
        void err;
        this.process = null;
        this.startMdns();
      });

      this.process.on("exit", (code: number | null) => {
        if (code !== 0 && code !== null) {
          this.process = null;
          this.startMdns();
        }
      });
    } catch (error) {
      void error;
      this.startMdns();
    }
  }

  private startMdns(): void {
    try {
      this.mdns = mDNS();
      this.mdns.on("query", (query) => {
        if (this.mdns && query.questions.some((q) => q.name === `${SERVICE_TYPE}.${SERVICE_DOMAIN}`)) {
          this.mdns.respond({
            answers: [
              {
                name: `${SERVICE_TYPE}.${SERVICE_DOMAIN}`,
                type: "PTR",
                data: `${this.instanceName}.${SERVICE_TYPE}.${SERVICE_DOMAIN}`,
              },
              {
                name: `${this.instanceName}.${SERVICE_TYPE}.${SERVICE_DOMAIN}`,
                type: "SRV",
                data: { port: this.port, target: this.hostname },
              },
              {
                name: `${this.instanceName}.${SERVICE_TYPE}.${SERVICE_DOMAIN}`,
                type: "TXT",
                data: [`instance=${this.instanceName}`, "version=1"],
              },
            ],
          });
        }
      });
    } catch (error) {
      void error;
      this.mdns = null;
    }
  }

  stop(): void {
    if (this.process && !this.process.killed) {
      try {
        this.process.kill();
      } catch {
        // ignore
      }
      this.process = null;
    }
    if (this.mdns) {
      try {
        this.mdns.destroy();
      } catch {
        // ignore
      }
      this.mdns = null;
    }
  }
}

export { OstraconDiscovery, SERVICE_TYPE };
