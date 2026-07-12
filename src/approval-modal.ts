import { App, Modal, Setting } from "obsidian";

class OstraconApprovalModal extends Modal {
  private clientId: string;
  private clientName: string;
  private callbacks: { onApprove: () => void; onDeny: () => void };

  constructor(
    app: App,
    clientId: string,
    clientName: string,
    callbacks: { onApprove: () => void; onDeny: () => void },
  ) {
    super(app);
    this.clientId = clientId;
    this.clientName = clientName || clientId;
    this.callbacks = callbacks;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "新设备连接请求" });
    contentEl.createEl("p", {
      text: `设备 "${this.clientName}" 正在请求连接到 Ostracon。`,
    });
    contentEl.createEl("p", {
      text: "允许后，该设备可以发送MarginNote数据到此仓库。",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("允许")
          .setCta()
          .onClick(() => {
            this.callbacks.onApprove();
            this.close();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("拒绝").onClick(() => {
          this.callbacks.onDeny();
          this.close();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export { OstraconApprovalModal };
