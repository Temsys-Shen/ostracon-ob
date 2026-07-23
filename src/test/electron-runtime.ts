class BrowserWindow {}

const remote = {
  app: { getApplicationNameForProtocol: () => "" },
  BrowserWindow,
};
const shell = { openExternal: async () => {} };

export { remote, shell };
