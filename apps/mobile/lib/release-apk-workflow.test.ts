import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-android-apk.yml"),
  "utf8",
);
const easConfig = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../eas.json"), "utf8"),
) as { build: Record<string, { extends?: string; android?: { buildType?: string } }> };

describe("Android APK release workflow", () => {
  it("only runs on demand from main with release credentials", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("cache: pnpm");
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("builds a production-channel APK and never takes the desktop updater's latest release", () => {
    expect(easConfig.build["android-apk"]).toEqual({
      extends: "production",
      android: { buildType: "apk" },
    });
    expect(workflow).toContain("--profile android-apk");
    expect(workflow).toContain("--latest=false");
    expect(workflow).not.toContain("gh release delete");
    expect(readFileSync(path.resolve(import.meta.dirname, "../app.config.ts"), "utf8")).toContain(
      '"android-apk"',
    );
  });

  it("resolves the android-apk EAS config before spending a build", () => {
    const check = workflow.indexOf("eas config --platform android --profile android-apk");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(workflow.indexOf("eas build --platform android"));
  });
});

describe("CI mobile EAS jobs", () => {
  const ci = readFileSync(
    path.resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"),
    "utf8",
  );
  const job = (name: string) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const next = ci.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  };

  // eas-cli reads the project ID from app.config.ts before it loads the EAS environment, so
  // the release guard can only run inside `eas env:exec`, never via EAS_BUILD_PROFILE on eas.
  const releaseGuard = (environment: string, profile: string) =>
    `eas env:exec ${environment} 'EAS_BUILD_PROFILE=${profile} pnpm exec expo config --type public > /dev/null' --non-interactive`;

  it("checks the android-apk EAS config only when the Expo token is present", () => {
    const check = job("mobile-eas-config");
    expect(check).toContain("name: Mobile EAS config");
    expect(check).toContain("secrets.EXPO_TOKEN");
    expect(check).toContain("if: steps.token.outputs.present == 'true'");
    expect(check).toContain(
      "eas config --platform android --profile android-apk --non-interactive",
    );
    expect(check).toContain(releaseGuard("production", "android-apk"));
    expect(check).not.toContain("EAS_BUILD_PROFILE:");
  });

  it("refuses to publish an OTA update without the production API URL", () => {
    const publish = job("publish-mobile-update");
    expect(publish).toContain(releaseGuard("production", "production"));
    expect(publish.indexOf(releaseGuard("production", "production"))).toBeLessThan(
      publish.indexOf("eas update"),
    );
    expect(publish).toContain("--channel production --environment production");
    expect(publish).not.toContain("EAS_BUILD_PROFILE:");
  });
});
