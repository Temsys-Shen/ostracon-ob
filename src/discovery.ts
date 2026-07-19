import os from "node:os";
import mDNS from "multicast-dns";

const SERVICE_TYPE = "_ostracon._tcp";
const SERVICE_DOMAIN = "local";

type MdnsFactory = typeof mDNS;
type DiscoveryErrorHandler = (error: Error) => void;

class OstraconDiscovery {
  private mdns: mDNS.MulticastDNS | null = null;

  constructor(
    private readonly port: number,
    vaultName: string,
    private readonly onError: DiscoveryErrorHandler,
    private readonly createMdns: MdnsFactory = mDNS,
  ) {
    this.instanceName = `Ostracon-${vaultName.replace(/\s+/g, "-")}`;
  }

  private readonly instanceName: string;
  private readonly hostname = os.hostname();

  get isRunning(): boolean {
    return this.mdns !== null;
  }

  start(): void {
    if (this.mdns) return;
    const mdns = this.createMdns();
    mdns.on("query", query => {
      if (!query.questions.some(question => question.name === `${SERVICE_TYPE}.${SERVICE_DOMAIN}`)) return;
      mdns.respond({
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
    });
    mdns.on("error", error => {
      if (this.mdns === mdns) this.mdns = null;
      this.onError(error);
    });
    this.mdns = mdns;
  }

  stop(): void {
    const mdns = this.mdns;
    this.mdns = null;
    if (mdns) mdns.destroy();
  }
}

export { OstraconDiscovery, SERVICE_TYPE };
