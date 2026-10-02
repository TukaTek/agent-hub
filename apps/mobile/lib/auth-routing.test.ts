import { describe, expect, it } from "vitest";
import { explicitSignInRoute, initialAuthMode } from "./auth-routing.js";

describe("mobile authentication routing", () => {
  it("starts every logged-out visitor at sign-in, including legacy signup links (CAAH-43)", () => {
    for (const mode of [undefined, "up", ["up"], "", "anything"]) {
      expect(initialAuthMode(mode)).toBe("in");
    }
  });

  it("honors the explicit sign-in route used after logout", () => {
    expect(explicitSignInRoute).toEqual({ pathname: "/sign-in", params: { mode: "in" } });
    expect(initialAuthMode(explicitSignInRoute.params.mode)).toBe("in");
  });
});
