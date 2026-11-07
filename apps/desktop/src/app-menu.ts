import type { DesktopEdition } from "./setup-config.js";

export type ServerMenuAction = "change-server" | "switch-organization";

export interface ServerMenuItems {
  changeServer: { label: string; accelerator: string; action: ServerMenuAction };
  stopStackVisible: boolean;
}

/** Managed builds connect only to their organization's server and run no local stack. */
export function serverMenuItems(edition: DesktopEdition): ServerMenuItems {
  if (edition === "managed") {
    return {
      changeServer: {
        label: "Switch organization",
        accelerator: "CmdOrCtrl+Shift+K",
        action: "switch-organization",
      },
      stopStackVisible: false,
    };
  }
  return {
    changeServer: {
      label: "Change CortexAI Agent Hub Server…",
      accelerator: "CmdOrCtrl+Shift+K",
      action: "change-server",
    },
    stopStackVisible: true,
  };
}
