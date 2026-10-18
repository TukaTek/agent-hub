# CAAH-103 + CAAH-67: Expo EAS Setup and Mobile Dependency Drift — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Approved by Agent Hub PM. Decision 1 confirmed: the variable already exists in both EAS environments. Notes on what changed during implementation are marked "Implementation note".**

**Goal:** Link `apps/mobile` to the Expo project `@tukatek/agent-hub` so the first internal Android APK and iOS TestFlight builds can run on EAS, make the existing OTA and APK workflows runnable with the new `EXPO_TOKEN`, and turn the mobile Typecheck job green by aligning Expo patch versions with SDK 57.

**Architecture:** Configuration only, plus contract tests. `app.json` becomes the single source of truth for project identity: owner, slug, project ID and the updates URL derived from the ID. The API URL for internal builds lives in the EAS environments (`production`, `preview`) so builds and OTA updates read the same value. CAAH-101 can later change it without a commit. Contract tests in `apps/mobile/lib` pin the identity, channels and config guard. A CI step that runs only when `EXPO_TOKEN` is set resolves the `android-apk` profile with `eas config`.

**Tech stack:** Expo SDK 57, EAS CLI (>= 21.8.0), expo-updates, pnpm, Vitest (`pnpm --filter @cortexai-agent-hub/mobile test`), GitHub Actions.

## Global constraints

- Expo account `tukatek`, project `@tukatek/agent-hub`, project ID `c5ac54e3-8365-495d-a638-51b4e0deb329`, slug `agent-hub`.
- Keep: name `CortexAI Agent Hub`, iOS `bundleIdentifier` and Android `package` `com.tukatek.cortexai.agenthub`, scheme `cortexai-agent-hub` (required by `apps/mobile/lib/sso.ts`).
- Internal builds use `EXPO_PUBLIC_API_URL=https://tukatek.cortexaiagenthub.com` (HTTPS, required by `app.config.ts` for `production` and `android-apk`).
- No major SDK change. Patch bumps only, within Expo 57.
- Never print `EXPO_TOKEN`. No Apple or Google accounts, credentials, App Store Connect IDs or keystores in Git.
- No new user-facing copy. CI error text is operator-facing only.
- Out of scope: store submission (CAAH-105), mobile Microsoft sign-in (CAAH-102), email-first tenant discovery (CAAH-101), OTA publishing changes beyond making the existing job runnable (CAAH-104).

---

## Findings (verified on `main` at a5516949)

| Area | State today | Consequence |
| --- | --- | --- |
| `app.json` identity | `slug: cortexai-agent-hub`, no `owner`, no `extra.eas.projectId` | EAS can't link to `@tukatek/agent-hub`. `lib/push.ts` reads `extra.eas.projectId` for Expo push tokens, so push registration is a no-op today. |
| `updates.url` | Missing, although `expo-updates` is installed and `eas.json` sets channels | `eas update` and channel builds need `https://u.expo.dev/<projectId>`. A non-interactive CI run can't add it. |
| Runtime version | `{ "policy": "appVersion" }` (1.0.4) | Fine for builds and OTA. No change. |
| Channels | `preview` uses `preview`. `production` and `android-apk` (extends production) use `production`. CI OTA publishes to `production`. | Consistent. No change. |
| Old slug references | Only `app.json`. The `cortexai-agent-hub` scheme, the APK asset name `cortexai-agent-hub.apk` and the Maestro `appId`s are separate values. | Nothing else changes. (`.maestro/screenshots.yaml` still has a stale `appId: com.cortexai-agent-hub.app` from the rebrand. That's unrelated, so it's noted here and left alone.) |
| `EXPO_PUBLIC_API_URL` | Required by `app.config.ts` for `production` and `android-apk`. `lib/endpoint.ts` falls back to the local API when it's unset. | If it's only in the eas.json build `env`, `eas update` bundles would ship pointing at localhost. |
| CAAH-67 | `expo install --check` reports 7 packages behind: `@expo/metro-runtime` 57.0.16→57.0.17, `@expo/ui` 57.0.23→57.0.25, `expo` 57.0.28→57.0.30, `expo-linking` 57.0.12→57.0.13, `expo-modules-core` 57.0.22→57.0.23, `expo-notifications` 57.0.22→57.0.23, `expo-router` 57.0.26→57.0.28 | `pnpm --filter @cortexai-agent-hub/mobile check` fails, so Typecheck fails on every PR, including #50 and #51. `expo-constants` is excluded from the check in `package.json`. |
| Android keystore | Never generated for this project | `eas build --non-interactive` can't create a keystore, so the first APK build must be interactive once (manual step below). |

## Decisions (please confirm)

1. **API URL in EAS environment variables, not eas.json `env`.** One value serves builds (`environment: production|preview` in `eas.json`) and `eas update --environment production`, and CAAH-101 can change it without a commit. eas.json `env` would only reach builds, so OTA bundles would silently use the local API. Cost: someone with Expo access has to create the variable once. I'll create it with the CI robot token only if PM asks. Otherwise it's a manual step for Sanjay (commands below). If PM prefers zero manual steps, the fallback is eas.json `env` on `production` and `preview`, plus the same value in the OTA step's `env:`. That duplicates the value in two places.
2. **The OTA step refuses to publish without the URL.** The `Publish production update` step sets `EAS_BUILD_PROFILE: production` in its `env:`, so the existing `app.config.ts` guard throws before publishing a bundle with no API URL. Nothing new to maintain.
   *Implementation note:* eas-cli evaluates `app.config.ts` to read the project ID before it loads the EAS environment, so setting `EAS_BUILD_PROFILE` on `eas update` or `eas config` fails every time. Both CI checks instead run the guard inside `eas env:exec production 'EAS_BUILD_PROFILE=<profile> pnpm exec expo config --type public > /dev/null'`, where the production variables are present.
3. **The `eas config` check runs only when `EXPO_TOKEN` is set.** It's a new CI job, `Mobile EAS config`, on every PR and push to `main` (*implementation note:* not path-filtered, to keep the job simple; it takes about a minute). It skips cleanly without the token (forks, self-hosters), so the core CI still needs no hosted vendor. The same check runs as the first step of `release-android-apk.yml`, before the 90-minute build.
4. **Exact pins.** `package.json` pins exact versions, so the bumped versions are written exactly (`57.0.30`, not `~57.0.30`).

## Files

- Modify: `apps/mobile/app.json` (slug, owner, `extra.eas.projectId`, `updates.url`)
- Modify: `apps/mobile/package.json`, `pnpm-lock.yaml` (7 patch bumps)
- Create: `apps/mobile/lib/eas-project.test.ts` (identity, updates, channels and config-guard contract)
- Modify: `.github/workflows/ci.yml` (`Mobile EAS config` job, URL guard in the OTA step)
- Modify: `.github/workflows/release-android-apk.yml` (`eas config` pre-check)
- Modify: `apps/mobile/lib/release-apk-workflow.test.ts` (assert the pre-check)
- Modify: `docs/mobile-release.md` (project is linked, first-build steps, keystore note)

---

### Task 1: CAAH-67, align Expo patch versions

**Files:** `apps/mobile/package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Confirm the failing check.** Run `pnpm --filter @cortexai-agent-hub/mobile check`. Expected: FAIL, "Found outdated dependencies" listing the 7 packages above.
- [ ] **Step 2: Bump.** From `apps/mobile`, run `pnpm exec expo install --fix`, then change any `~x.y.z` it wrote back to exact `x.y.z` to match the file's style. Confirm `git diff apps/mobile/package.json` touches only the 7 packages and no `57.` major changes. *Implementation note:* `expo@57.0.30` depends on `expo-constants ~57.0.22`, so the pin moves from 57.0.21 to 57.0.22 as well. Otherwise two copies of the native module would be installed. Upstream has always bumped it together with `expo`.
- [ ] **Step 3: Verify.** Run `pnpm install --frozen-lockfile`, then `pnpm --filter @cortexai-agent-hub/mobile check` (PASS), `pnpm --filter @cortexai-agent-hub/mobile test`, `pnpm --filter @cortexai-agent-hub/adapters check`, `pnpm --filter @cortexai-agent-hub/adapters test`, `pnpm --filter @cortexai-agent-hub/web check` and `pnpm --filter @cortexai-agent-hub/web test`, then `pnpm check` (the full Typecheck job).
- [ ] **Step 4: Commit.** `CAAH-67: align Expo SDK 57 patch versions`

### Task 2: Link app.json to `@tukatek/agent-hub`

**Files:** Create `apps/mobile/lib/eas-project.test.ts`. Modify `apps/mobile/app.json`.

- [ ] **Step 1: Write the failing test.**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import appConfig from "../app.config";

const root = path.resolve(import.meta.dirname, "..");
const { expo } = JSON.parse(readFileSync(path.join(root, "app.json"), "utf8"));
const eas = JSON.parse(readFileSync(path.join(root, "eas.json"), "utf8"));
const PROJECT_ID = "c5ac54e3-8365-495d-a638-51b4e0deb329";

afterEach(() => vi.unstubAllEnvs());

describe("EAS project link", () => {
  it("links to @tukatek/agent-hub without changing app identity", () => {
    expect(expo).toMatchObject({
      name: "CortexAI Agent Hub",
      slug: "agent-hub",
      owner: "tukatek",
      scheme: "cortexai-agent-hub",
      ios: { bundleIdentifier: "com.tukatek.cortexai.agenthub" },
      android: { package: "com.tukatek.cortexai.agenthub" },
      extra: { eas: { projectId: PROJECT_ID } },
      runtimeVersion: { policy: "appVersion" },
    });
  });

  it("serves updates from the linked project on the build channels", () => {
    expect(expo.updates.url).toBe(`https://u.expo.dev/${expo.extra.eas.projectId}`);
    expect(eas.build.preview.channel).toBe("preview");
    expect(eas.build.production.channel).toBe("production");
    expect(eas.build["android-apk"].extends).toBe("production");
  });

  it.each(["production", "android-apk"])("requires an HTTPS API URL for %s", (profile) => {
    vi.stubEnv("EAS_BUILD_PROFILE", profile);
    vi.stubEnv("EXPO_PUBLIC_API_URL", "");
    expect(() => appConfig({ config: expo } as never)).toThrow(/must be set/);
    vi.stubEnv("EXPO_PUBLIC_API_URL", "http://tukatek.cortexaiagenthub.com");
    expect(() => appConfig({ config: expo } as never)).toThrow(/HTTPS/);
    vi.stubEnv("EXPO_PUBLIC_API_URL", "https://tukatek.cortexaiagenthub.com");
    expect(appConfig({ config: expo } as never).slug).toBe("agent-hub");
  });
});
```

- [ ] **Step 2: Run it.** `pnpm --filter @cortexai-agent-hub/mobile test -- eas-project`. Expected: FAIL on slug, owner, projectId and `updates.url`. The guard cases pass because the guard already exists.
- [ ] **Step 3: Edit `app.json`.** Set `"slug": "agent-hub"`, add `"owner": "tukatek"` after `slug`, add `"updates": { "url": "https://u.expo.dev/c5ac54e3-8365-495d-a638-51b4e0deb329" }` before `runtimeVersion`, and set `"extra": { "router": {}, "supportsRTL": true, "eas": { "projectId": "c5ac54e3-8365-495d-a638-51b4e0deb329" } }`.
- [ ] **Step 4: Run it.** Same command. Expected: PASS. Also run `pnpm exec expo config --type public` from `apps/mobile` and confirm `owner`, `slug`, `updates.url` and `extra.eas.projectId` resolve.
- [ ] **Step 5: Commit.** `CAAH-103: link the mobile app to the tukatek/agent-hub EAS project`

### Task 3: Make the OTA and APK workflows runnable, plus the `eas config` check

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release-android-apk.yml`, `apps/mobile/lib/release-apk-workflow.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `release-apk-workflow.test.ts`:

```ts
  it("resolves the android-apk EAS config before spending a build", () => {
    const check = workflow.indexOf("eas config --platform android --profile android-apk");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(workflow.indexOf("eas build --platform android"));
  });
```

  And in a new `describe` in the same file, read `ci.yml` and assert that the `Publish production update` step runs the `eas env:exec production` guard before `eas update` (see the implementation note under Decision 2), and that a job named `Mobile EAS config` runs `eas config --platform android --profile android-apk --non-interactive`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `release-android-apk.yml`: before `Build APK on EAS`, add a step `Resolve EAS build config` (`working-directory: apps/mobile`) that runs `eas config --platform android --profile android-apk --non-interactive > /dev/null`.
  - `ci.yml` OTA step: run the `eas env:exec production` guard right before `eas update`.
  - `ci.yml` new job `mobile-eas-config` (`name: Mobile EAS config`). It uses the same pinned actions as the OTA job. Its first step checks `EXPO_TOKEN` and, when the token is empty, writes "skipped: no EXPO_TOKEN" to the step summary and sets an output that skips the remaining steps. Then it runs `expo/expo-github-action` (token from the secret), `pnpm install --frozen-lockfile`, and `eas config --platform android --profile android-apk --non-interactive > /dev/null` in `apps/mobile`. No `needs:`, so it runs in parallel.
- [ ] **Step 4: Run it.** `pnpm --filter @cortexai-agent-hub/mobile test`. Expected: PASS. Then push and confirm `Mobile EAS config` is green. This depends on the `EXPO_PUBLIC_API_URL` EAS variable existing (Decision 1). Until then it fails with the `app.config.ts` message, which is the intended signal.
- [ ] **Step 5: Commit.** `CAAH-103: check the EAS build config in CI and guard OTA publishing`

### Task 4: Docs

**Files:** `docs/mobile-release.md`

- [ ] Replace `eas project:init` with a note that the TukaTek build is already linked (`@tukatek/agent-hub`), and that self-hosters relink with `eas init` and change `owner`, `slug`, `extra.eas.projectId` and `updates.url` together. Change the `eas env:create` example to cover both `production` and `preview`. Add a "First builds" section with the commands below, including the interactive-keystore note. Commit: `CAAH-103: document first EAS builds`.

---

## Triggering the first builds

All commands run from `apps/mobile`, with EAS CLI >= 21.8.0, logged in as a `tukatek` member (`eas login`).

**Once, before any build (if PM doesn't have me do it in Decision 1):**

```sh
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://tukatek.cortexaiagenthub.com --visibility plaintext
eas env:create --environment preview    --name EXPO_PUBLIC_API_URL --value https://tukatek.cortexaiagenthub.com --visibility plaintext
eas config --platform android --profile android-apk   # must print the resolved config without errors
```

**First Android APK (internal):**

1. Interactive, once: `eas build --platform android --profile android-apk`. When asked, let EAS generate and store the Android keystore. Non-interactive builds can't create one.
2. After that, every build: GitHub Actions → `release-android-apk` → Run workflow on `main`. It builds the same profile non-interactively and updates the rolling `android` release (`.../releases/download/android/cortexai-agent-hub.apk`).

**First iOS TestFlight (internal):**

1. `eas build --platform ios --profile production`. Sign in to the Apple Developer account when asked and let EAS create the distribution certificate and provisioning profile for `com.tukatek.cortexai.agenthub`.
2. `eas submit --platform ios --latest`. Choose the App Store Connect API key (EAS stores it). Let EAS create the App Store Connect app record if there isn't one. Keep `ascAppId` and team IDs out of Git, as `docs/mobile-release.md` requires.
3. In App Store Connect → TestFlight, add the build to an internal testing group once processing finishes.

Uploading to TestFlight for internal testing isn't store submission. Store review and public release stay in CAAH-105.

## Manual steps for Sanjay

1. Apple Developer Program membership for TukaTek (paid), with access to App Store Connect.
2. An App Store Connect API key (Users and Access → Integrations, App Manager role). Upload it to EAS when `eas submit` or `eas credentials -p ios` asks. Don't commit it.
3. Run the first iOS build interactively (above) so EAS can create the iOS signing credentials.
4. Run the first Android build interactively once (above) so EAS generates and stores the keystore. Back it up from `eas credentials -p android` → Download.
5. Create the `EXPO_PUBLIC_API_URL` EAS variable in `production` and `preview` (commands above), unless PM tells me to do it with the robot token.
6. Set the Actions variable `MOBILE_OTA_ENABLED=true` only when OTA should start (CAAH-104). The job stays skipped until then.

## Risks

- **Patch drift comes back.** `expo install --check` compares against the latest SDK 57 patches, so a new Expo patch release will turn Typecheck red on unrelated PRs again. This plan only fixes today's drift. A follow-up could move the online check to a scheduled job or to the release workflows only.
- **The EAS iOS image `macos-tahoe-26.5-xcode-26.6`** must still be offered by EAS when the first iOS build runs. If it's been retired, use the closest available image.
- **Remote versioning.** `appVersionSource: remote` with `autoIncrement` seeds the remote build numbers from `app.json` (`versionCode` 10, `buildNumber` 1) on the first build. Check the seed in the first build log.
- **Push tokens start working.** With `extra.eas.projectId` set, `lib/push.ts` starts registering Expo push tokens against this project. That's intended, but it's the first time this has happened in the fork.
- **The `Mobile EAS config` job talks to Expo.** Running it only when `EXPO_TOKEN` is set keeps forks and self-hosters offline. An Expo outage would only fail that job, not Typecheck.
