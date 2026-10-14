# CAAH-92: Desktop Dock vs. Overlay Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot computer's OS dock and the web app's overlay toolbar (Browser, Terminal, Files) never overlap at any common viewport, on desktop and mobile web, and both stay clickable.

**Architecture:** Move the tint2 dock from bottom center to a vertical dock centered on the left edge of the 1280x800 X screen. The overlay stays at bottom center of the web panel. Because noVNC scales the screen with "contain" and centers it, a left-edge dock and a bottom-center overlay are geometrically disjoint for any panel wider than about 150 CSS px. No web, Electron or mobile code changes.

**Tech Stack:** tint2 config, Python desktop smoke (baked into the computer image), Vitest config test, Playwright web E2E.

## Global Constraints

- Maximized Chromium stays 1280x800 at (0,0). No strut and no xfwm4 margins. Bot coordinates, teach recordings and the `computer-replay` geometry assertions don't change (CAAH-87 constraint).
- The dock stays `panel_layer = bottom`, `strut_policy = none`, `autohide = 0`, with no animations.
- Colors come only from `darkTokens` (enforced by `desktop-config.test.ts`).
- No new user-facing copy. The dock tooltips stay "Browser" and "Terminal".
- Tests stay deterministic and offline. Don't run the desktop Playwright suite locally.

---

## Root cause

CAAH-87 put the dock where the overlay already was. Both are pinned to bottom center:

- **Dock** (`infra/sandboxes/computer/desktop/tint2rc.in`): `panel_position = bottom center horizontal`, height 64, `panel_margin = 0 10`, two 44 px launchers with 10 px padding and spacing. In framebuffer pixels that's about x 580–700, y 726–790 of 1280x800.
- **Overlay** (`ComputerWorkspace.tsx:110`): `absolute bottom-4 left-1/2 -translate-x-1/2`, three `size-9` buttons, `gap-1`, `p-1.5`, 1 px border. That's about 130x50 CSS px, 16 px above the panel bottom.
- **Scaling** (`embed.html:141`): `rfb.scaleViewport = true`, `clipViewport = false`. noVNC scales the framebuffer by `s = min(W/1280, H/800)` and centers it. `W` and `H` are the workspace size: the viewport minus the computer header, which is about 57 px.

## What the overlay covers in each layout

| Viewport | Panel shape | Scale | Dock on screen (CSS px) | Covered by the overlay? |
| --- | --- | --- | --- | --- |
| 1920x1080 | wider than 16:10, full height | 1.28 | 153x82, 13 px from bottom | Yes. Only the top ~18 px of the icons show (the reported screenshot) |
| 1440x900 | wider | 1.05 | 126x67, 10 px from bottom | Yes, almost entirely |
| 1366x768 | wider | 0.89 | 107x57, 9 px from bottom | Yes, entirely (the overlay is wider) |
| 1280x800 | wider | 0.93 | 111x59, 9 px from bottom | Yes, entirely |
| 1024x768 | taller than 16:10, 36 px bars | 0.80 | 96x51, 44 px from bottom | Partly. The lower ~22 px of the icons |
| 768x1024 (tablet portrait) | taller, 244 px bars | 0.60 | 72x38, mid-panel | No. The overlay sits in the black bar |
| 390x844 (phone portrait) | taller, 272 px bars | 0.30 | 37x20, mid-panel | No, but the dock is tiny |
| 844x390 (phone landscape) | wider | 0.42 | 50x27, 4 px from bottom | Yes, entirely |

The overlay isn't drawn while teaching (`dock={!recordingSkill}`) or for host desktops (`kind === "desktop"`, which has no screen). The native mobile app (`apps/mobile/app/computer.tsx`) has no overlay toolbar, so its dock is never covered. Electron hosts the web UI, so it behaves like the web rows above. Team desktops reuse `session.sh` and `tint2rc.in`, so they get the fix too. E2B and Box sandboxes run the Fluxbox fallback without a dock and aren't affected.

## Decision: a vertical dock centered on the left edge (recommended)

New framebuffer rectangle: about x 10–74, y 340–460. On screen, the dock's right edge sits `566·s` px left of the panel's horizontal center, and the overlay extends 65 px either side of that center. They're disjoint whenever `s > 0.115`, i.e. any panel at least ~150 px wide, in every layout above, including letterboxed ones. Unmaximized windows open centered (`placement_mode = center`), so a default xterm (about x 290–990) leaves the dock visible, as it does today.

### Rejected alternatives

- **Top dock.** It's no better than the left edge geometrically. It sits behind every window's title bar, where people drag. The web Terminal and Files windows also open at y 24 and y 56, right over a top dock.
- **Right edge.** Equivalent geometry, but the web Files window opens on the right. Left matches the familiar Ubuntu dock.
- **Shrinking the dock.** At any usable size it's still under a 130 px overlay at bottom center. In the wide layouts the overlay is already larger than the whole dock.
- **A strut (work area) reserving the dock's strip.** Maximized windows wouldn't go under the dock, but the overlay would still cover it. It also shrinks every bot's browser to 1280x726 (bottom) or 1206x800 (left), which breaks the CAAH-87 geometry constraint, `computer-replay` assertions, recorded teach coordinates and page viewport sizes. See open question 1.
- **Moving the overlay.** Any other in-screen corner covers OS content instead: the top-right has the window buttons (`button_layout = |HMC`), the top-left has the Chromium tabs, the sides have page content. Moving the buttons into the computer header would clear the screen completely, but on a 390 px phone the header already holds the avatar, name, Stop/Take control, Teach, maintenance and Close. That's a larger UX change across web and Electron, so it should be its own issue if wanted.
- **Dropping the OS dock as a duplicate.** The buttons aren't duplicates. The overlay's Browser button hides the web windows, and its Terminal is a web shell over the API. The OS dock launches or raises Chromium and xterm on the X display that the bot sees. Without it, a user who closes Chromium can't reopen it on the desktop, and teach mode (where the overlay is hidden) loses its launchers.

## Files

- Modify: `infra/sandboxes/computer/desktop/tint2rc.in`, the panel position, size, margin and padding lines.
- Modify: `infra/sandboxes/supervisor/src/desktop-config.test.ts`, the dock test at lines 57–72.
- Modify: `infra/sandboxes/computer/desktop_smoke.py`, which records the dock's real geometry and asserts it under `--expect modern`.
- Create: `apps/web/e2e/computer-dock-clearance.spec.ts`, which checks the overlay against the dock at eight viewports and attaches the composite screenshots.
- Create: `apps/web/e2e/fixtures/computer-desktop-idle.png`, a copy of the CI desktop smoke's `idle.png` (the real screen) that the fake screen in the spec displays.

---

### Task 1: Reproduce the overlap in a web E2E test and capture the before set

**Files:**
- Create: `apps/web/e2e/computer-dock-clearance.spec.ts`
- Create: `apps/web/e2e/fixtures/computer-desktop-idle.png` (`idle.png` from the latest `main` run's `computer-desktop` artifact: `gh run download <run-id> -n computer-desktop`)

**Interfaces:**
- Produces: `DOCK`, the framebuffer rectangle `{ x, y, width, height }` in 1280x800 pixels. Task 2 changes it.

- [ ] **Step 1: Write the test with today's bottom-center dock rectangle**

The boot, takeover and `openComputer` steps are copied from `computer-workspace.spec.ts:12-50`. The fake screen copies noVNC's `scaleViewport`: contain-scaled and centered.

```ts
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

// tint2rc.in's dock in framebuffer pixels; desktop_smoke.py asserts the real window matches.
const DOCK = { x: 580, y: 726, width: 120, height: 64 };
const VIEWPORTS = [
  [1920, 1080], [1440, 900], [1366, 768], [1280, 800],
  [1024, 768], [768, 1024], [390, 844], [844, 390],
] as const;

test("the computer overlay toolbar never covers the desktop dock", async ({ page }, testInfo) => {
  const desktop = await readFile(new URL("./fixtures/computer-desktop-idle.png", import.meta.url));
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Test desktop</title><body style="margin:0;height:100vh;background:#000"><img src="data:image/png;base64,${desktop.toString("base64")}" style="display:block;width:100%;height:100%;object-fit:contain">`,
    }),
  );
  // ... signup, completeOnboarding, computer/boot, takeover poll, screenUrl route and
  // opening the computer exactly as in computer-workspace.spec.ts ...
  const screen = page.getByTitle("Assistant screen");
  const toolbar = page.locator("nav").filter({ has: page.getByRole("button", { name: "Files", exact: true }) });
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    const frame = (await screen.boundingBox())!;
    const s = Math.min(frame.width / 1280, frame.height / 800);
    const dock = {
      x: frame.x + (frame.width - 1280 * s) / 2 + DOCK.x * s,
      y: frame.y + (frame.height - 800 * s) / 2 + DOCK.y * s,
      width: DOCK.width * s,
      height: DOCK.height * s,
    };
    const bar = (await toolbar.boundingBox())!;
    await captureScreenshot(page, testInfo, `computer-dock-${width}x${height}`);
    const overlaps =
      bar.x < dock.x + dock.width && dock.x < bar.x + bar.width &&
      bar.y < dock.y + dock.height && dock.y < bar.y + bar.height;
    expect.soft(overlaps, `${width}x${height}`).toBe(false);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @cortexai-agent-hub/web exec playwright test e2e/computer-dock-clearance.spec.ts`
Expected: FAIL at 1920x1080, 1440x900, 1366x768, 1280x800, 1024x768 and 844x390, and pass at 768x1024 and 390x844, matching the table above. Keep the attached `computer-dock-*.png` files as the **before** set for the PR. Don't commit them.

- [ ] **Step 3: Commit the test and fixture with the old rectangle marked as the known failure**

Wrap the test in `test.fail()` so CI stays green on this commit and the before set comes from CI too. Task 2 removes the wrapper.

```bash
git add apps/web/e2e/computer-dock-clearance.spec.ts apps/web/e2e/fixtures/computer-desktop-idle.png
git commit -m "CAAH-92: reproduce the desktop dock hiding behind the overlay toolbar"
```

### Task 2: Move the dock to the left edge

**Files:**
- Modify: `infra/sandboxes/supervisor/src/desktop-config.test.ts:57-72`
- Modify: `infra/sandboxes/computer/desktop/tint2rc.in`
- Modify: `infra/sandboxes/computer/desktop_smoke.py` (`smoke()` metrics and `modern_checks()`)
- Modify: `apps/web/e2e/computer-dock-clearance.spec.ts` (`DOCK`, drop `test.fail()`)
- Modify: `apps/web/e2e/fixtures/computer-desktop-idle.png` (replaced with this branch's CI `idle.png`)

**Interfaces:**
- Consumes: `DOCK` from Task 1.
- Produces: the `dock_geometry` key, `{x, y, width, height}`, in the smoke's metrics JSON.

- [ ] **Step 1: Change the config test first**

```ts
  it("draws an icon-only launcher dock on the left edge, clear of the app's bottom toolbar", () => {
    const rc = read("tint2rc.in");
    for (const line of [
      "panel_items = L",
      "panel_position = center left vertical",
      "panel_layer = bottom",
      "strut_policy = none",
      // ...the remaining lines unchanged...
```

- [ ] **Step 2: Run it and watch it fail**

Run (repo root): `pnpm exec vitest run infra/sandboxes/supervisor/src/desktop-config.test.ts`
Expected: FAIL. `tint2rc.in` doesn't contain `panel_position = center left vertical`.

- [ ] **Step 3: Change `tint2rc.in`**

```ini
panel_position = center left vertical
```

tint2 swaps the axes of `panel_size`, `panel_margin` and `panel_padding` for vertical panels, so `panel_size = 0 64`, `panel_margin = 0 10` and `panel_padding = 10 8 10` should give a 64 px thick, shrink-to-fit dock 10 px from the left edge. The smoke assertion in Step 5 decides. If the real window isn't at x ≈ 10, swap the margin to `10 0` and re-run.

Outcome: tint2 17 swaps the size and padding axes but not the margin, so the shipped config uses `panel_margin = 10 0`. The config test pins it, and the real window measures x 10, y 340, 64x120.

- [ ] **Step 4: Run the config test and watch it pass**

Same command. Expected: PASS.

- [ ] **Step 5: Make the smoke record and assert the real dock geometry**

In `smoke()`, before `capture.close()`:

```python
    geometry = dict(
        line.split("=", 1)
        for line in run("xdotool", "search", "--name", "cortexai-agent-hub-dock", "getwindowgeometry", "--shell")
        .stdout.split()
        if line.split("=", 1)[0] in ("X", "Y", "WIDTH", "HEIGHT")
    )
```

Add `"dock_geometry": {key.lower(): int(value) for key, value in geometry.items()}` to `metrics`, and add this to `modern_checks()`:

```python
    dock = metrics["dock_geometry"]
    # The web app's toolbar floats over the bottom center of the scaled screen.
    assert dock["x"] <= 16 and dock["width"] <= 80, dock
    assert abs(dock["y"] + dock["height"] / 2 - 400) <= 2, dock
```

Outcome: the shipped smoke asserts the exact rectangle, `{"x": 10, "y": 340, "width": 64, "height": 120}`, so it stays in lockstep with the web test's `DOCK`.

The image's "Desktop smoke and screenshots" step in `publish-server-image.yml` runs this on the PR. Its `computer-desktop` artifact gives the **after** `idle.png` and `terminal.png`, which show the dock next to an unmaximized xterm. The current `main` artifact gives the before pair.

- [ ] **Step 6: Point the web test at the new dock and the new screen**

Replace the fixture with the PR run's `idle.png`, drop `test.fail()`, and set:

```ts
const DOCK = { x: 10, y: 340, width: 64, height: 120 };
```

Use the exact numbers from the smoke's `dock_geometry`.

- [ ] **Step 7: Run the web test and watch it pass**

Run: `pnpm --filter @cortexai-agent-hub/web exec playwright test e2e/computer-dock-clearance.spec.ts`
Expected: PASS at all eight viewports. The attached screenshots are the **after** set. CI's Web E2E artifact holds the same files to link from the PR.

- [ ] **Step 8: Run the existing checks**

Run: `pnpm --filter @cortexai-agent-hub/sandbox-supervisor test`, `python3 -m pytest infra/sandboxes/computer -q` (focus-or-launch, page browser, team desktops) and `pnpm lint`.
Expected: all pass. CI runs the image desktop smoke, the Office smoke and `computer-replay`, which keeps checking maximized Chromium at 1280x800 (0,0).

- [ ] **Step 9: Commit**

```bash
git add infra/sandboxes/computer/desktop/tint2rc.in infra/sandboxes/supervisor/src/desktop-config.test.ts \
  infra/sandboxes/computer/desktop_smoke.py apps/web/e2e/computer-dock-clearance.spec.ts \
  apps/web/e2e/fixtures/computer-desktop-idle.png
git commit -m "CAAH-92: move the desktop dock to the left edge, clear of the overlay toolbar"
```

## Screenshots on the PR

- **Real desktop, 1280x800:** `idle.png` and `terminal.png` from the `computer-desktop` artifact. Before comes from `main`'s latest run, after from the PR run.
- **Composites at 1920x1080, 1440x900, 1366x768, 1280x800, 1024x768, 768x1024, 390x844 (phone portrait) and 844x390 (phone landscape):** the `computer-dock-*.png` attachments from the web test. Before comes from the Task 1 run against `main`'s screen, after from the Web E2E artifact. They're embedded inline in the PR, with the CI E2E artifact linked as AGENTS.md asks.
- **Native mobile:** no change. That screen has no overlay toolbar, and the PR says so rather than showing an unrelated screenshot.

## Risks

1. **tint2's vertical-axis semantics.** If the margin, size or padding axes don't swap as expected, the dock could end up full-height or hugging the corner. The smoke's geometry assertion catches this in CI. Step 3 names the one-line fallback.
2. **The test fixture goes stale.** The PNG is a snapshot of the desktop. If the desktop changes later, the composite looks old, but the geometry assertion still comes from the smoke on the real image. Size is about one compressed 1280x800 PNG, a few hundred KB at most.
3. **The web Terminal window covers the dock while it's open.** It opens at x 32, y 24, on the left. That's a window the user opened on purpose, and the Browser button tucks it away. The bottom dock had the same issue with nothing open.
4. **Muscle memory.** Users who just learned the bottom dock will find it on the left. It's a small change, and less disruptive than the dock they can't reach today.
5. **Very small dock on phones.** At 390 px wide the scaled dock is about 20x37 px. It's uncovered but hard to tap. That's out of scope; open question 2.

## Open questions

1. The Linear acceptance says "windows don't maximize underneath either one." This plan reads that as "no control hides window content": the dock stays beneath maximized windows, as in CAAH-87. Making the dock *always* clickable over a maximized Chromium needs a 74 px left strut (`strut_policy = follow_size`, `panel_layer = top`). That shrinks the bots' browser to about 1206x800 and changes the CAAH-87 geometry constraint and the `computer-replay` assertions. It's a two-line config delta on top of this plan if the PM wants it. Separately, the overlay already floats over the bottom center of a maximized window today. Fixing that means moving the overlay into the header (see the rejected alternatives).
2. Should phone layouts get a larger dock, or should the overlay offer a "relaunch browser" action instead? It's a separate issue either way.

## Self-review

- Spec coverage: the no-overlap requirement is covered by Task 2 and the eight-viewport web test. Before and after screenshots are covered in "Screenshots on the PR". Both control sets stay clickable because the projections are disjoint and the dock stays under maximized windows only (open question 1). Existing desktop smoke tests: Task 2, Step 8.
- No placeholders, apart from the copied login and boot steps, which name their exact source lines.
- Names are consistent: `DOCK`, `dock_geometry`, `computer-desktop-idle.png`, `computer-dock-<w>x<h>.png`.
