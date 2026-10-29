import { describe, expect, it } from "vitest";
import { isAppChallenge, isAppVerifier, nativeReturnTo } from "./hub-native-sso.js";

describe("native SSO returnTo allowlist", () => {
  it.each([
    ["desktop", "http://127.0.0.1:1024/hub-sso"],
    ["desktop", "http://127.0.0.1:53682/hub-sso"],
    ["desktop", "http://127.0.0.1:65535/hub-sso"],
    ["desktop", "http://[::1]:49152/hub-sso"],
    ["mobile", "cortexai-agent-hub://hub-sso"],
  ])("accepts %s %s", (client, returnTo) => {
    expect(nativeReturnTo(client, returnTo)).toBe(returnTo);
  });

  it.each([
    "http://localhost:5000/hub-sso",
    "http://127.0.0.2:5000/hub-sso",
    "http://0.0.0.0:5000/hub-sso",
    "http://127.1:5000/hub-sso",
    "http://2130706433:5000/hub-sso",
    "http://[::2]:5000/hub-sso",
    "http://[0:0:0:0:0:0:0:1]:5000/hub-sso",
    "http://[::ffff:127.0.0.1]:5000/hub-sso",
    "http://127.0.0.1/hub-sso",
    "http://127.0.0.1:0/hub-sso",
    "http://127.0.0.1:80/hub-sso",
    "http://127.0.0.1:1023/hub-sso",
    "http://127.0.0.1:65536/hub-sso",
    "http://127.0.0.1:099999/hub-sso",
    "http://127.0.0.1:05000/hub-sso",
    "http://127.0.0.1:/hub-sso",
    "http://user@127.0.0.1:5000/hub-sso",
    "http://user:pass@127.0.0.1:5000/hub-sso",
    "http://evil.example@127.0.0.1:5000/hub-sso",
    "http://127.0.0.1:5000@evil.example/hub-sso",
    "http://127.0.0.1:5000/hub-sso?x=1",
    "http://127.0.0.1:5000/hub-sso?",
    "http://127.0.0.1:5000/hub-sso#x",
    "http://127.0.0.1:5000/hub-sso#",
    "http://127.0.0.1:5000/hub-sso/",
    "http://127.0.0.1:5000/hub-ssox",
    "http://127.0.0.1:5000/HUB-SSO",
    "http://127.0.0.1:5000//hub-sso",
    "http://127.0.0.1:5000/./hub-sso",
    "http://127.0.0.1:5000/x/../hub-sso",
    "http://127.0.0.1:5000/hub%2Dsso",
    "http://127.0.0.1:5000\\hub-sso",
    "http:\\\\127.0.0.1:5000\\hub-sso",
    "http://127.0.0.1:5000\\@evil.example/hub-sso",
    "http:/127.0.0.1:5000/hub-sso",
    "http://127.0.0.1:5000/hub-sso ",
    " http://127.0.0.1:5000/hub-sso",
    "http://127.0.0.1:5000/hub-sso\n",
    "http://127.0.0.1:5000/hub-sso\u0000",
    "HTTP://127.0.0.1:5000/hub-sso",
    "https://127.0.0.1:5000/hub-sso",
    "http://127.0.0.1.:5000/hub-sso",
    "http://127.0.0.1:5000.evil.example/hub-sso",
    "cortexai-agent-hub://hub-sso",
    "",
  ])("rejects desktop %j", (returnTo) => {
    expect(nativeReturnTo("desktop", returnTo)).toBeUndefined();
  });

  it.each([
    "cortexai-agent-hub://hub-sso/",
    "cortexai-agent-hub://hub-sso?x=1",
    "cortexai-agent-hub://hub-sso#x",
    "cortexai-agent-hub:///hub-sso",
    "cortexai-agent-hub:hub-sso",
    "cortexai-agent-hub://user@hub-sso",
    "cortexai-agent-hub://HUB-SSO",
    "CORTEXAI-AGENT-HUB://hub-sso",
    "cortexai-agent-hub://hub-sso ",
    "cortexai-agent-hub://hub-sso\\",
    "exp+cortexai-agent-hub://hub-sso",
    "http://127.0.0.1:5000/hub-sso",
  ])("rejects mobile %j", (returnTo) => {
    expect(nativeReturnTo("mobile", returnTo)).toBeUndefined();
  });

  it.each([
    [undefined, "http://127.0.0.1:5000/hub-sso"],
    ["web", "http://127.0.0.1:5000/hub-sso"],
    ["desktop", undefined],
    ["desktop", 5000],
    ["mobile", ["cortexai-agent-hub://hub-sso"]],
    ["desktop", `http://127.0.0.1:5000/hub-sso${"x".repeat(10_000)}`],
  ])("rejects client %j with returnTo %j", (client, returnTo) => {
    expect(nativeReturnTo(client, returnTo)).toBeUndefined();
  });
});

describe("native SSO app PKCE", () => {
  it("accepts an S256 challenge of exactly 43 base64url characters", () => {
    expect(isAppChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
  });

  it.each([
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c",
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMx",
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c=",
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM",
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw/cM",
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw.cM",
    "",
    undefined,
    43,
  ])("rejects challenge %j", (challenge) => {
    expect(isAppChallenge(challenge)).toBe(false);
  });

  it.each([
    "a".repeat(43),
    "a".repeat(128),
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "Az09-._~".repeat(6),
  ])("accepts an RFC 7636 verifier %j", (verifier) => {
    expect(isAppVerifier(verifier)).toBe(true);
  });

  it.each(["a".repeat(42), "a".repeat(129), `${"a".repeat(42)}+`, `${"a".repeat(42)}=`, 1, null])(
    "rejects verifier %j",
    (verifier) => {
      expect(isAppVerifier(verifier)).toBe(false);
    },
  );
});
