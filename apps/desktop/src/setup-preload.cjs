const { contextBridge, ipcRenderer } = require("electron");

/** Longest address the bridge forwards; main validates the rest. */
const MAX_EMAIL_LENGTH = 320;

contextBridge.exposeInMainWorld("cortexAiAgentHubSetup", {
  platform: process.platform,
  state: () => ipcRenderer.invoke("desktop.setup.state"),
  discover: (email) =>
    typeof email === "string" && email.length <= MAX_EMAIL_LENGTH
      ? ipcRenderer.invoke("desktop.setup.discover", email)
      : Promise.resolve({ ok: false, field: "email", error: "Enter a valid email address." }),
  test: (url) => ipcRenderer.invoke("desktop.setup.test", url),
  save: (setup) => ipcRenderer.invoke("desktop.setup.save", setup),
  quit: () => ipcRenderer.invoke("desktop.setup.quit"),
  openLink: (link) => ipcRenderer.invoke("desktop.setup.openLink", link),
  stack: {
    state: () => ipcRenderer.invoke("desktop.setup.stack.state"),
    start: () => ipcRenderer.invoke("desktop.setup.stack.start"),
    onChange: (listener) => {
      ipcRenderer.on("desktop.setup.stack.changed", (_event, state) => listener(state));
    },
  },
});
