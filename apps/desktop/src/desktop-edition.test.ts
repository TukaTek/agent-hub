import { describe, expect, it } from "vitest";
import { desktopDiscoveryDefine, desktopEditionDefine } from "../scripts/desktop-edition.mjs";

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

describe("org discovery build flag", () => {
  const baked = (url: string | null) => ({
    __CORTEXAI_AGENT_HUB_DISCOVERY_URL__: JSON.stringify(url),
  });

  it("bakes no discovery service when unset, so managed setup shows its retryable error", () => {
    expect(desktopDiscoveryDefine({})).toEqual(baked(null));
    expect(desktopDiscoveryDefine({ CORTEXAI_AGENT_HUB_DISCOVERY_URL: "  " })).toEqual(baked(null));
  });

  it("requires a discovery URL for managed builds", () => {
    expect(() => desktopDiscoveryDefine({ CORTEXAI_AGENT_HUB_DESKTOP_EDITION: "managed" })).toThrow(
      /required/,
    );
  });

  it("bakes the canonical HTTPS origin", () => {
    expect(
      desktopDiscoveryDefine({ CORTEXAI_AGENT_HUB_DISCOVERY_URL: "https://hub.cortexai.example" }),
    ).toEqual(baked("https://hub.cortexai.example"));
  });

  it.each([
    "http://hub.cortexai.example",
    "https://hub.cortexai.example/",
    "https://hub.cortexai.example/api",
    "https://user:pass@hub.cortexai.example",
    "https://hub.cortexai.example?x=1",
    "hub.cortexai.example",
    "javascript:alert(1)",
  ])("fails the build on %s instead of shipping a non-HTTPS or non-origin URL", (url) => {
    expect(() => desktopDiscoveryDefine({ CORTEXAI_AGENT_HUB_DISCOVERY_URL: url })).toThrow(
      /CORTEXAI_AGENT_HUB_DISCOVERY_URL/,
    );
  });
});
