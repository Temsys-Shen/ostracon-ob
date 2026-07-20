declare module "electron" {
  export const remote: {
    BrowserWindow: new (options: {
      show: false;
      width: number;
      height: number;
      webPreferences: { offscreen: true };
    }) => {
      loadURL(url: string): Promise<void>;
      webContents: {
        executeJavaScript(code: string): Promise<unknown>;
        printToPDF(options: import("./pdf-print-settings").ElectronPdfOptions): Promise<Buffer>;
      };
      destroy(): void;
    };
  };
}
