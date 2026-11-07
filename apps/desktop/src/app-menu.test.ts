import { describe, expect, it } from "vitest";
import { serverMenuItems } from "./app-menu.js";

describe("server menu items", () => {
  it("keeps the self-host change-server item and stop-stack switch", () => {
    expect(serverMenuItems("self-host")).toEqual({
      changeServer: {
        label: "Change CortexAI Agent Hub Server…",
        accelerator: "CmdOrCtrl+Shift+K",
        action: "change-server",
      },
      stopStackVisible: true,
    });
  });

  it("offers an explicit organization switch and hides stop-stack in managed builds", () => {
    expect(serverMenuItems("managed")).toEqual({
      changeServer: {
        label: "Switch organization",
        accelerator: "CmdOrCtrl+Shift+K",
        action: "switch-organization",
      },
      stopStackVisible: false,
    });
  });
});
