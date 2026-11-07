import { describe, expect, it } from "vitest";
import { desktopEditionDefine } from "../scripts/desktop-edition.mjs";

const baked = (edition: string) => ({
  __CORTEXAI_AGENT_HUB_DESKTOP_EDITION__: JSON.stringify(edition),
});

describe("desktop edition build flag", () => {
  it("bakes self-host when the flag is unset, so current builds are unchanged", () => {
    expect(desktopEditionDefine({})).toEqual(baked("self-host"));
    expect(desktopEditionDefine({ CORTEXAI_AGENT_HUB_DESKTOP_EDITION: "" })).toEqual(
      baked("self-host"),
    );
  });

  it("bakes each known edition", () => {
    expect(desktopEditionDefine({ CORTEXAI_AGENT_HUB_DESKTOP_EDITION: "self-host" })).toEqual(
      baked("self-host"),
    );
    expect(desktopEditionDefine({ CORTEXAI_AGENT_HUB_DESKTOP_EDITION: "managed" })).toEqual(
      baked("managed"),
    );
  });

  it("fails the build on an unknown edition instead of guessing", () => {
    expect(() => desktopEditionDefine({ CORTEXAI_AGENT_HUB_DESKTOP_EDITION: "Managed" })).toThrow(
      /CORTEXAI_AGENT_HUB_DESKTOP_EDITION/,
    );
  });
});
