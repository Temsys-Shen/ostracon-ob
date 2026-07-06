let debugLogPath = "";

function setDebugLogPath(p: string) {
  debugLogPath = p;
}

function debugLog(msg: string) {
  if (!debugLogPath) return;
  try {
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {}
}

export { setDebugLogPath, debugLog };
