# CAAH-87: Modern Computer Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone watches a bot's computer, it shows a modern dark desktop: a themed window manager, a compositor with soft shadows and rounded corners, a dock with app icons, a neutral wallpaper, and good UI fonts and icons. Everything bots rely on keeps working unchanged.

**Architecture:** One baked session launcher, `cortexai-agent-hub-desktop-session :N`, brings up the desktop on any X display. It sets the wallpaper (`hsetroot`), starts `xfwm4` with its built-in compositor off, `picom` (xrender backend), and a `tint2` dock styled from the shared dark tokens. `start.sh` calls it for display `:1`, and team desktops call it for `:N`. All static config lives read-only under `/usr/local/share/cortexai-agent-hub/desktop` and `/etc/xdg`. Per-display generated files live under `/tmp/cortexai-agent-hub/desktop-N`. Remote sandboxes (E2B, Box) that don't use our image keep their Fluxbox fallback.

**Tech Stack:** Debian bookworm packages (xfwm4, xfconf, picom, tint2, hsetroot, arc-theme, papirus-icon-theme trimmed, fonts-inter, fonts-jetbrains-mono), POSIX sh, Python 3 smoke script, TypeScript (core desktop runtime, supervisor), Vitest, GitHub Actions.

## Global Constraints

- Screen stays `Xvfb 1280x800x24`. Computer-control coordinates, `xcapture`, `xdotool` argv and `control.py` allowlists don't change.
- Read-only `x11vnc` view, noVNC `embed.html`, `clipboard-bridge.js`, `mobile-keyboard.js`, takeover, the xdg-desktop-portal file chooser over D-Bus, and team-desktop isolation keep working.
- The image stays non-root (uid 1000), with nothing installable at runtime. Egress rules don't change.
- Don't install `xfce4`, `xfdesktop4`, `xfce4-panel`, `xfce4-session` or `xfce4-settings`.
- Budget: image under +150 MB, idle RAM under +100 MB per computer, and no noticeable idle CPU increase under Xvfb. Report measured numbers on the PR.
- Chromium's look for web content must not change: no system-wide GTK dark theme, no fontconfig alias changes, no `Xft.*` resources. Pages keep today's `prefers-color-scheme` and default fonts.
- Desktop colors come from `darkTokens` in `@cortexai-agent-hub/ui-tokens`, enforced by a test. No new product hex values.
- No animations (fades, zoom, slide-in), so screenshots settle as fast as today.
- Tests are deterministic and offline. Don't run the desktop Playwright suite locally.
- Public repo: no machine names, paths or account data in commits, the PR or artifacts.

---

## What I found

1. **The desktop is defined in five files.** `Dockerfile` installs `fluxbox` and adds an `fbsetbg` shim that paints `#111113`. `start.sh` copies `fluxbox.init`, `fluxbox.apps` and `fluxbox.menu` into `/tmp/fluxbox-home/.fluxbox` and starts Fluxbox with `HOME=/tmp/fluxbox-home`. The menu offers "Browser" and "Terminal".
2. **The window rules in `fluxbox.apps`** maximize `Chromium`, `chromium`, `Google-chrome` and `Firefox`, and leave `XTerm` unmaximized. `fluxbox.init` sets `fullMaximization: true`, and the toolbar is not on top. A maximized Chromium therefore covers the whole 1280x800 screen, toolbar included. Only Chromium ships in the image. Both Chromium launchers (`cortexai-agent-hub-browser` and the per-screen launcher in `desktop-runtime.ts:200`) already pass `--start-maximized`, which any EWMH window manager honors.
3. **Team desktops start their own Fluxbox.** `packages/core/src/node/desktop-runtime.ts` (`renderEnsureScreenCommand`, `renderStopExtraScreenCommand`, `resetDesktopRuntimeCommand`) writes `/tmp/fluxbox-home-N/.fluxbox/{init,apps,menu}`, starts `fluxbox -rc …` with `BROWSER=<per-display launcher>`, and stops it with `pkill -f "[f]luxbox -rc /tmp/fluxbox-home-N/…"`. If `/etc/cortexai-agent-hub/fluxbox/init` is missing (images that aren't ours), it hides the toolbar instead.
4. **Remote sandboxes install Fluxbox at runtime.** `PREPARE_LINUX_DESKTOP` in `packages/adapters/src/linux-desktop.ts:346` apt-installs `fluxbox` and other tools on E2B and Box sandboxes, which don't run our image.
5. **Screenshots** use `xcapture.c`: `XShmGetImage` on the root window, plus an XDamage object on the root for change metadata. `control.py` and the supervisor read the geometry and active window with `xdotool getdisplaygeometry`, `getactivewindow` and `getwindowname`. Focus uses `wmctrl -lxp` and `wmctrl -ia` (`cortexai-agent-hub-focus-or-launch`, `linux-desktop.ts:333`).
6. **The supervisor builds the image from an explicit file list** (`infra/sandboxes/supervisor/src/index.ts:1043-1061`), which names `fluxbox.init`, `fluxbox.apps` and `fluxbox.menu`. New context files must be added there.
7. **Tests that depend on Fluxbox:**
   - `computer-spec.test.ts:264-360` runs `fluxbox.menu` exec strings through `/bin/sh` and checks the generated screen menu.
   - `index.test.ts:785,796` checks the Fluxbox stop pattern.
   - `test_team_desktops.py:110` reads `/tmp/fluxbox-home-N/.fluxbox/menu`.
   - `desktop-runtime.test.ts` covers the generated commands.
8. **CI coverage of the image:**
   - `publish-server-image.yml` → "Validate computer image" builds and loads the image, then runs the Office smoke with `--network none`.
   - `computer-replay.yml` builds the image and runs `pnpm test:computer-replay`, which covers `computer-replay.docker.test.ts` (page actions and one real screenshot) and `computer-user.docker.test.ts`.
   - The team-desktop Docker test (`VERIFY_DOCKER_TEAM_SCREENS=1`) is opt-in and doesn't run in CI.
   - `computer-use.e2e.test.ts` needs a live model key.
   - Nothing in CI exercises a coordinate click, typing, scrolling or a portal file upload on the real image. Nothing captures a desktop screenshot as an artifact or reports size, RAM or CPU.
9. **GTK dark themes leak into web pages.** Chromium on Linux derives its dark mode, and so the page's `prefers-color-scheme`, from the GTK theme. A system-wide `/etc/gtk-3.0/settings.ini` with a dark theme would flip sites to dark mode for bots. Theme settings must reach only the desktop processes and the portal file chooser.

## Decisions

**Dock: `tint2` styled as a centered floating dock (recommended), not Plank.** Both meet "Plank or similar". Plank looks closest to the reference, but under our constraints it costs more and carries more risk:
- It needs `bamfdaemon` and GSettings/dconf for configuration. Plank's dock settings use a relocatable schema, so vendor overrides don't apply and we would need a keyfile or dconf backend.
- It is a unique D-Bus application per session. Team desktops reached through `docker exec` don't share the primary session bus, so a second display needs its own bus, which brings another `dbus-daemon` and `bamfdaemon`.
- It has zoom and hide animations by default.
- I estimate about 45–60 MB RSS per display, which on its own nearly uses up the +100 MB budget.

`tint2` is a single X11 client with one text config file, no D-Bus, about 8–12 MB RSS and about 4 MB installed. With the compositor it draws a translucent, rounded, centered panel with launcher icons, a separator and running-window icons. That looks like a dock and is easy to run once per display. If the PM wants Plank's look specifically, Task 3's config tests and Task 4's session script swap the dock binary, and the budget gets re-measured.

**Dock layer: under maximized windows, reserving no screen space (recommended).** This matches today exactly. A maximized Chromium still covers all 1280x800 (xfwm4 `borderless_maximize`, tint2 `panel_layer = bottom`, `strut_policy = none`), so page viewport sizes, scroll distances and every coordinate a bot learned stay the same. The dock shows on the idle desktop and around unmaximized windows such as the terminal. I rejected two alternatives:
- An always-visible dock that reserves about 64 px. It shrinks every bot's browser viewport.
- Auto-hide. Pointer moves to the bottom edge would pop the dock over page content between a screenshot and a click.

**Window manager: `xfwm4 --compositor=off`, plus `picom` for shadows and rounded corners.** xfwm4's own compositor does shadows but not rounded corners. Running both would fight over the `_NET_WM_CM_S0` selection, so xfwm4's is off. xfwm4 reads settings from `xfconfd` (D-Bus-activated). The defaults ship as `/etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml` and `xfce4-keyboard-shortcuts.xml`, so no files are written to the bot's home.

**picom backend: `xrender`, `vsync = false`, `fading = false`, `use-damage = true`, `unredir-if-possible = true`.** Xvfb has no GPU or vblank, so `glx` would use software GL. With damage tracking, xrender repaints only changed areas, so an idle screen costs nothing. `unredir-if-possible` takes the compositor out of the path whenever a window covers the full screen, which is the maximized Chromium bots use. Screenshots of a bot's browser are then pixel-identical to an uncomposited screen. I'm not adding a runtime toggle for the compositor (YAGNI). If the measured idle CPU or RAM misses budget, the fallback is to drop `picom` and turn on xfwm4's compositor, which keeps shadows but loses rounded corners. That's a two-line change in `cortexai-agent-hub-desktop-session`.

**Theme, icons and fonts:**
- xfwm4 decorations and the portal file chooser use **Arc-Dark** (`arc-theme`).
- Icons are **Papirus-Dark**, trimmed in a builder stage to the sizes we use.
- The UI font is **Inter** (titles, dock tooltips, file chooser).
- The terminal font is **JetBrains Mono**.

These apply only to desktop processes:
- the GTK theme through `XDG_CONFIG_DIRS` for xfwm4 and `xdg-desktop-portal-gtk`;
- xterm through `XTerm*` X resources;
- never system-wide.

Chromium keeps today's GTK defaults. Strict monochrome alternative: the GTK built-in `Adwaita:dark` plus xfwm4's `Default` theme, which follows GTK colors, costs 0 MB but looks plainer. Open question 2.

**Wallpaper:** a neutral vertical gradient from `darkTokens.card` (`#141518`) to `darkTokens.background` (`#0B0C0E`), drawn by `hsetroot -add … -gradient 0`. There's no image asset, it costs 0 bytes, and a test enforces the colors. A CortexAI-branded variant is open question 3.

**Terminal:** keep `xterm`. It is in `control.py`'s `KNOWN_LAUNCH` allowlist and in the bots' launch paths, and VTE-based terminals add about 10 MB and a new allowlist entry. `xrdb -merge` styles it per display: JetBrains Mono 11, token colors, 14 px padding, no scrollbar, `selectToClipboard: true`. Every xterm then looks the same, including the bare `xterm` bots launch, which today opens unstyled.

**No root-window menu.** xfwm4 has none, and the dock replaces Fluxbox's right-click "Browser"/"Terminal" menu. The dock uses the same two names as tooltips (see "User-facing copy").

**Team desktops and older images:** `desktop-runtime.ts` uses the session launcher when `/usr/local/bin/cortexai-agent-hub-desktop-session` exists. Otherwise it keeps today's Fluxbox commands unchanged. This covers E2B and Box sandboxes, which install Fluxbox at runtime and don't run our image, and a newer supervisor talking to an older computer image during an upgrade. The reason for the explicit degradation: those sandboxes don't use our image, and installing about 60 MB of desktop packages at runtime in each one would slow every desktop start.

## Package list and size estimate

`--no-install-recommends` on bookworm. GTK3, cairo, pango, Xft and most `libxcb-*` libraries are already in the image (Chromium, `xdg-desktop-portal-gtk`), so the estimates are increments. Task 1 records the real before and after numbers from `docker image inspect` and `dpkg-query -W -f '${Installed-Size}'`.

| Package | What it's for | Est. added |
| --- | --- | --- |
| `xfwm4` (+ `libxfce4ui-2-0`, `libxfce4util7`, `libxfconf-0-3`, `xfconf`, `libwnck-3-0`, `libstartup-notification0`) | Window manager and its settings daemon | ~10 MB |
| `picom` (+ `libconfig9`, `libev4`) | Compositor: shadows, rounded corners | ~2 MB |
| `tint2` (+ `libimlib2`) | Dock | ~4 MB |
| `hsetroot` | Wallpaper gradient | <0.2 MB |
| `arc-theme` | Arc-Dark GTK and xfwm4 theme | ~4 MB |
| `papirus-icon-theme` (builder stage, copy `Papirus` + `Papirus-Dark` at 16/22/24/32/48/64 + `symbolic` only) | Dock and file chooser icons | ≤30 MB (hard cap; if larger, keep only `apps` and `places`) |
| `fonts-inter` | UI font | ~8 MB |
| `fonts-jetbrains-mono` | Terminal font | ~3 MB |
| remove `fluxbox` | | −3 MB |
| **Total** | | **≈ +55 MB (range +40 to +75 MB), budget +150 MB** |

**RAM estimate (idle RSS):**
- Per display: `xfwm4` 18–25 MB, `picom` 8–15 MB, `tint2` 8–12 MB.
- Once per computer: `xfconfd` about 5 MB.
- Fluxbox today: about 7 MB.
- Net: about +35–50 MB for the primary display, and about +30–45 MB for each additional live team desktop.

The +100 MB budget is per computer at idle (primary display only). The PR also reports the per-team-desktop increment, since several live team desktops multiply it.

## How screenshots and budget figures are captured

Everything runs in CI on the existing "Validate computer image" job, offline (`--network none`), so the PR can link artifacts. Task 1 lands the harness while the image is still Fluxbox, so that commit's CI run produces the **before** set. The image switch produces the **after** set. I'll attach both sets inline on the PR.

- A new `infra/sandboxes/computer/desktop_smoke.py` is baked into the image as `/usr/local/share/cortexai-agent-hub-desktop-smoke.py`, like the Office smoke. It:
  1. starts the normal entrypoint (`/usr/local/bin/cortexai-agent-hub-computer`) as a child and waits for a window manager (`_NET_SUPPORTING_WM_CHECK`);
  2. captures `idle.png` through `libcortexai_agent_hub-xcapture.so`, the same library and call path `control.py` uses;
  3. launches `cortexai-agent-hub-browser file:///tmp/desktop-smoke/page.html`, waits for the window and captures `chromium.png`;
  4. closes Chromium, launches `xterm` (the `KNOWN_LAUNCH` form) running a short `ls`, and captures `terminal.png`;
  5. prints JSON metrics:
     - session-ready time;
     - RSS of the window manager, compositor and dock processes;
     - their CPU ticks over a 20-second idle window;
     - whether `_NET_WM_CM_S0` is owned;
     - the window manager's name.
- A new workflow step runs it with `-v "$RUNNER_TEMP/desktop:/out"` and uploads `/out` with the already-pinned `actions/upload-artifact`.
- A second step runs the image normally (`docker run -d --network none`, default CMD) and samples `docker stats --no-stream` ten times over 20 seconds after a 20-second warm-up. It writes the median memory and CPU and the `docker image inspect -f '{{.Size}}'` size to `$GITHUB_STEP_SUMMARY`.
- With `--expect modern` (Task 4), the smoke also fails if:
  - the window manager isn't xfwm4;
  - `_NET_WM_CM_S0` is unowned;
  - `tint2` isn't running;
  - `fc-match Inter` and `fc-match "JetBrains Mono"` don't resolve;
  - `xfconf-query -c xfwm4 -p /general/theme` isn't `Arc-Dark`;
  - the session created files in `$HOME`.

## Risks to bot clicking and screenshots

1. **The compositor and root capture.** `XShmGetImage` on the root reads the framebuffer, which includes picom's overlay window, so captures stay complete. XDamage on the root still reports changes, now as picom's repaints. With `unredir-if-possible`, a maximized Chromium bypasses picom entirely. The redirect/unredirect switch when a window maximizes or a menu opens can produce one stale frame. Mitigation: Task 2's Docker test captures after each action using the existing `settleMs`, and asserts the expected pixels and title. If flicker shows up, set `unredir-if-possible-delay = 150`.
2. **Window geometry.** Chromium must still be 1280x800 at (0,0) when maximized, with no title bar. Task 2 asserts this by having the page report `outerWidth`, `outerHeight`, `screenX` and `screenY`. It runs on Fluxbox first, then on xfwm4.
3. **Keyboard grabs.** xfwm4's default shortcuts would swallow keys bots send to apps, such as `Ctrl+F1–F12`, `Ctrl+Alt+D`, `Alt+F7`–`F11` and `Alt+Insert`. We ship `xfce4-keyboard-shortcuts.xml` limited to `Alt+Tab`, `Alt+Shift+Tab` and `Alt+F4`, matching Fluxbox's default grabs, and a test pins that list.
4. **Focus.** `wmctrl -ia` sends `_NET_ACTIVE_WINDOW` as a pager, which xfwm4 honors. `prevent_focus_stealing` is set to `false` so a newly launched Chromium or xterm takes focus as under Fluxbox. `getactivewindow` relies on `_NET_ACTIVE_WINDOW`, which xfwm4 maintains. The existing focus-or-launch tests and Task 2 cover this.
5. **Rounded corners on maximized and fullscreen windows** would clip page pixels at the screen corners. picom's `rounded-corners-exclude` covers the maximized, fullscreen, dock and desktop window types. With unredirect active this can't happen anyway.
6. **Shadows on menus and popups** could make Chromium's select popups look offset in screenshots, though not move them. `shadow-exclude` covers `_GTK_FRAME_EXTENTS`, popup and dropdown menus, tooltips and the dock.
7. **Web content changes.** Covered by the global constraint: no system GTK theme, no fontconfig aliases, no `Xft.*` resources. The theme reaches only xfwm4 and the portal backend, through `XDG_CONFIG_DIRS` on their own command lines. The `--expect modern` smoke asserts that `/etc/gtk-3.0/settings.ini` doesn't exist.
8. **picom rounded corners on the xrender backend** in bookworm's picom (v10.x) are expected to work. If the CI screenshot shows square corners, the options are `glx` with software GL (measure CPU) or accepting square corners with shadows.
9. **xfconfd on team desktops.** It is D-Bus-activated. Displays started through `docker exec` don't inherit the bus, so the session script sources `/tmp/cortexai-agent-hub/dbus-session`, like the browser launcher. Without a bus, xfwm4 falls back to its built-in default theme. The look degrades, but nothing breaks.
10. **Writes to the bot's home.** The session runs with the real `HOME`, so apps launched from the dock open in the bot's home. Today Fluxbox ran with `HOME=/tmp/fluxbox-home`, so a Terminal opened from the primary menu started in the wrong home. The smoke asserts that no new files appear in `$HOME`.
11. **Startup time.** The three clients start in parallel and `start.sh` doesn't wait for them, as with Fluxbox today. The smoke reports session-ready time, and the target is within 1 second of the baseline.

## User-facing copy

There are no new words. The dock's two launchers carry the tooltips "Browser" and "Terminal" (`Name=` in their `.desktop` files), the same labels as today's Fluxbox menu. They give the icon-only buttons accessible names. The PR description will quote them, as AGENTS.md requires.

## File Structure

| File | Change |
| --- | --- |
| `infra/sandboxes/computer/desktop/session.sh` (new) | `cortexai-agent-hub-desktop-session :N`: wallpaper, xrdb, xfwm4, picom, tint2 |
| `infra/sandboxes/computer/desktop/xfwm4.xml` (new) | xfwm4 defaults: Arc-Dark, Inter, compositor off, borderless maximize, one workspace |
| `infra/sandboxes/computer/desktop/xfce4-keyboard-shortcuts.xml` (new) | Only Alt+Tab, Alt+Shift+Tab, Alt+F4 |
| `infra/sandboxes/computer/desktop/picom.conf` (new) | xrender, shadows, 10 px corners, no fading, unredirect |
| `infra/sandboxes/computer/desktop/tint2rc.in` (new) | Dock template (`@STATE@` placeholder) |
| `infra/sandboxes/computer/desktop/Xresources` (new) | XTerm styling only |
| `infra/sandboxes/computer/desktop/gtk-3.0/settings.ini` (new) | Arc-Dark, Papirus-Dark, Inter 10. Reached only through `XDG_CONFIG_DIRS` for desktop processes |
| `infra/sandboxes/computer/desktop/browser.desktop.in`, `terminal.desktop` (new) | Dock launchers |
| `infra/sandboxes/computer/desktop_smoke.py` (new) | Screenshot, metrics and modern-desktop assertions |
| `infra/sandboxes/computer/Dockerfile` | Packages, icon builder stage, COPY lines, remove Fluxbox and the `fbsetbg` shim |
| `infra/sandboxes/computer/start.sh` | Replace the Fluxbox block with the session launcher; portal-gtk gets `XDG_CONFIG_DIRS` |
| `infra/sandboxes/computer/fluxbox.{init,apps,menu}` | Delete |
| `infra/sandboxes/computer/test_team_desktops.py` | Assert the session and dock instead of the Fluxbox menu |
| `infra/sandboxes/supervisor/src/index.ts` | Build-context file list |
| `infra/sandboxes/supervisor/src/desktop-config.test.ts` (new) | Config invariants and token colors |
| `infra/sandboxes/supervisor/src/computer-spec.test.ts`, `index.test.ts` | Replace the Fluxbox menu tests; stop patterns |
| `infra/sandboxes/supervisor/package.json` | devDependency `@cortexai-agent-hub/ui-tokens` (test only) |
| `packages/core/src/node/desktop-runtime.ts` (+ `.test.ts`) | Session launcher with Fluxbox fallback in ensure, stop and reset |
| `packages/testkit/src/computer-desktop.docker.test.ts` (new), `packages/testkit/src/cli/computer-replay.ts` | Real-image click, type, scroll and upload journey |
| `.github/workflows/publish-server-image.yml` | Desktop smoke, artifacts, size/RAM/CPU summary |
| `.gitattributes` | LF rule for `infra/sandboxes/computer/desktop/*` instead of `fluxbox.*` |
| `docs/computer-runtime.md` | One sentence on the desktop stack and the remote Fluxbox fallback |

---

### Task 1: Baseline harness on today's image (before screenshots and numbers)

**Files:**
- Create: `infra/sandboxes/computer/desktop_smoke.py`
- Modify: `infra/sandboxes/computer/Dockerfile` (COPY + CR strip), `infra/sandboxes/supervisor/src/index.ts:1046-1061` (add `desktop_smoke.py`), `.github/workflows/publish-server-image.yml` (validate job)
- Test: `infra/sandboxes/supervisor/src/computer-spec.test.ts`

**Interfaces:**
- Produces: `python3 /usr/local/share/cortexai-agent-hub-desktop-smoke.py [--out DIR] [--expect modern]`. Exit 0 on success. Prints one JSON line: `{"wm": str, "compositor": bool, "dock": bool, "ready_ms": int, "rss_kb": {name: int}, "cpu_ticks_idle": {name: int}}`. Writes `idle.png`, `chromium.png` and `terminal.png` when `--out` is given.

- [ ] **Step 1: Write the failing test.** Every file the Dockerfile COPYs from the build context must be in the supervisor's build list:

```ts
it("builds the computer image from every file the Dockerfile copies", () => {
  const root = path.resolve(import.meta.dirname, "../../computer");
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY (?:--chmod=\d+ )?(?!--from)(\S+) /gm)].map(
    (match) => match[1]!.split("/")[0]!,
  );
  const listed = readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8");
  for (const file of new Set(copied)) expect(listed).toContain(`"${file}"`);
  expect(copied).toContain("desktop_smoke.py");
});
```

- [ ] **Step 2: Run it and confirm it fails.** `pnpm vitest run infra/sandboxes/supervisor/src/computer-spec.test.ts -t "every file"`. Expected: FAIL, because `desktop_smoke.py` isn't copied yet.

- [ ] **Step 3: Implement `desktop_smoke.py`**

```python
#!/usr/bin/env python3
"""Offline desktop smoke: screenshots, idle cost and look invariants for the computer image."""
import argparse, ctypes, json, os, subprocess, sys, time
from pathlib import Path

DISPLAY = ":1"
DESKTOP = ("fluxbox", "xfwm4", "picom", "tint2", "xfconfd")
PAGE = "<title>Desktop smoke</title><body style='font:16px sans-serif;margin:40px'><h1>CortexAI Agent Hub</h1><p>Chromium on the bot computer.</p>"


def sh(*argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, timeout=10, **kw)


def wait(predicate, seconds, what):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


def wm_name():
    check = sh("xprop", "-root", "_NET_SUPPORTING_WM_CHECK").stdout.split()
    if not check or not check[-1].startswith("0x"):
        return ""
    out = sh("xprop", "-id", check[-1], "_NET_WM_NAME").stdout
    return out.split('"')[1] if '"' in out else ""


def pids():
    found = {}
    for proc in Path("/proc").iterdir():
        if proc.name.isdigit():
            try:
                name = (proc / "comm").read_text().strip()
            except OSError:
                continue
            if name in DESKTOP:
                found[name] = int(proc.name)
    return found


def rss_kb(pid):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    return 0


def cpu_ticks(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return int(fields[11]) + int(fields[12])


def compositor_owned():
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XGetSelectionOwner.restype = ctypes.c_ulong
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(DISPLAY.encode())
    assert display, "cannot open the X display"
    try:
        return x11.XGetSelectionOwner(display, x11.XInternAtom(display, b"_NET_WM_CM_S0", 0)) != 0
    finally:
        x11.XCloseDisplay(display)


class Capture:
    """The bots' screenshot path: control.py's NativeCapture bindings (control.py:49-75)."""

    def __init__(self):
        lib = ctypes.CDLL("/usr/local/lib/libcortexai_agent_hub-xcapture.so")
        lib.cortexai_agent_hub_xcapture_open.argtypes = [ctypes.c_char_p]
        lib.cortexai_agent_hub_xcapture_open.restype = ctypes.c_void_p
        lib.cortexai_agent_hub_xcapture_png.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        lib.cortexai_agent_hub_xcapture_png.restype = ctypes.c_int
        lib.cortexai_agent_hub_xcapture_close.argtypes = [ctypes.c_void_p]
        self.lib = lib
        self.context = lib.cortexai_agent_hub_xcapture_open(DISPLAY.encode())
        assert self.context, "MIT-SHM capture is unavailable"

    def png(self, path):
        # The PNG buffer belongs to the capture context and stays valid until the next call.
        data, size = ctypes.POINTER(ctypes.c_ubyte)(), ctypes.c_size_t()
        width, height = ctypes.c_int(), ctypes.c_int()
        failed = self.lib.cortexai_agent_hub_xcapture_png(
            self.context, ctypes.byref(data), ctypes.byref(size), ctypes.byref(width), ctypes.byref(height)
        )
        assert not failed, "screen capture failed"
        assert (width.value, height.value) == (1280, 800), (width.value, height.value)
        if path:
            path.write_bytes(ctypes.string_at(data, size.value))

    def close(self):
        self.lib.cortexai_agent_hub_xcapture_close(self.context)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path)
    parser.add_argument("--expect", choices=["modern"])
    args = parser.parse_args()
    home = Path(os.environ["HOME"])
    before = {p.relative_to(home) for p in home.rglob("*")}
    started = time.monotonic()
    computer = subprocess.Popen(["/usr/local/bin/cortexai-agent-hub-computer"])
    wait(lambda: wm_name() != "", 15, "a window manager")
    ready_ms = int((time.monotonic() - started) * 1000)
    time.sleep(2)
    capture = Capture()
    shot = lambda name: capture.png(args.out / name if args.out else None)
    shot("idle.png")
    found = pids()
    ticks = {name: cpu_ticks(pid) for name, pid in found.items()}
    time.sleep(20)
    ticks = {name: cpu_ticks(pid) - ticks[name] for name, pid in found.items()}
    page = Path("/tmp/desktop-smoke/page.html")
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(PAGE)
    browser = subprocess.Popen(["cortexai-agent-hub-browser", f"file://{page}"])
    wait(lambda: "Desktop smoke" in sh("wmctrl", "-l").stdout, 30, "Chromium")
    time.sleep(2)
    shot("chromium.png")
    sh("pkill", "-f", "[c]hromium")
    browser.wait(10)
    subprocess.Popen(["xterm", "-e", "sh", "-c", "cd ~ && ls -la && exec sh"])
    wait(lambda: "xterm" in sh("wmctrl", "-lx").stdout.lower(), 10, "xterm")
    time.sleep(1)
    shot("terminal.png")
    metrics = {
        "wm": wm_name(),
        "compositor": compositor_owned(),
        "dock": "tint2" in found,
        "ready_ms": ready_ms,
        "rss_kb": {name: rss_kb(pid) for name, pid in found.items()},
        "cpu_ticks_idle": ticks,
    }
    capture.close()
    print(json.dumps(metrics))
    if args.expect == "modern":
        modern_checks(metrics, home, before)
    computer.terminate()


def modern_checks(metrics, home, before):
    assert metrics["wm"] == "Xfwm4", metrics["wm"]
    assert metrics["dock"], "tint2 is not running"
    assert metrics["compositor"], "no compositor owns _NET_WM_CM_S0"
    for family in ("Inter", "JetBrains Mono"):
        assert family in sh("fc-match", family).stdout, f"{family} font missing"
    assert sh("xfconf-query", "-c", "xfwm4", "-p", "/general/theme").stdout.strip() == "Arc-Dark"
    assert not Path("/etc/gtk-3.0/settings.ini").exists(), "system GTK settings would theme Chromium pages"
    created = {p.relative_to(home) for p in home.rglob("*")} - before
    allowed = (".cache", ".browser-profiles", ".local/share/recently-used.xbel")
    assert all(str(p).startswith(allowed) for p in created), sorted(map(str, created))


if __name__ == "__main__":
    sys.exit(main())
```

  `wm_name()` reads `_NET_WM_NAME` from the window manager's check window. Fluxbox reports `Fluxbox` and xfwm4 reports `Xfwm4`. Confirm the exact xfwm4 string from the first Task 4 CI run, and adjust the assertion if xfwm4 reports it differently.

- [ ] **Step 4: Bake it in.** Add `COPY --chmod=644 desktop_smoke.py /usr/local/share/cortexai-agent-hub-desktop-smoke.py` next to the Office smoke, add the path to the CR-strip `sed`, and add `"desktop_smoke.py"` to the supervisor build list.

- [ ] **Step 5: Add the CI steps** to the `validate` job after "Office smoke test":

```yaml
      - name: Desktop smoke and screenshots
        if: matrix.name == 'computer'
        env:
          IMAGE: ${{ steps.meta.outputs.tags }}
        run: |
          mkdir -p "$RUNNER_TEMP/desktop" && chmod 777 "$RUNNER_TEMP/desktop"
          docker run --rm --network none -v "$RUNNER_TEMP/desktop:/out" "$IMAGE" \
            python3 /usr/local/share/cortexai-agent-hub-desktop-smoke.py --out /out \
            | tee "$RUNNER_TEMP/desktop/metrics.json"
      - name: Image size and idle cost
        if: matrix.name == 'computer'
        env:
          IMAGE: ${{ steps.meta.outputs.tags }}
        run: |
          size=$(docker image inspect -f '{{.Size}}' "$IMAGE")
          id=$(docker run -d --network none "$IMAGE")
          sleep 20
          for i in $(seq 1 10); do docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}' "$id"; sleep 2; done > "$RUNNER_TEMP/desktop/stats.txt"
          docker rm -f "$id" >/dev/null
          {
            echo "### Computer image"
            echo "- Size: $((size / 1048576)) MB"
            echo "- Idle samples (memory, CPU):"
            sed 's/^/  - /' "$RUNNER_TEMP/desktop/stats.txt"
            echo "- Desktop smoke: \`$(tail -n 1 "$RUNNER_TEMP/desktop/metrics.json")\`"
          } >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        if: matrix.name == 'computer'
        with:
          name: computer-desktop
          path: ${{ runner.temp }}/desktop
          retention-days: 14
```

- [ ] **Step 6: Run the unit test and confirm it passes.** Push. Confirm the Validate job is green on the **Fluxbox** image and that its artifact holds the three before screenshots. Save the job summary numbers as the baseline.

- [ ] **Step 7: Commit** `test(computer): desktop smoke with screenshots and idle cost on the current image (CAAH-87)`

### Task 2: Real-image computer-use journey (screenshot, click, type, scroll, upload)

**Files:**
- Create: `packages/testkit/src/computer-desktop.docker.test.ts`
- Modify: `packages/testkit/src/cli/computer-replay.ts:82` (add the file to the vitest list)

**Interfaces:**
- Consumes: `DockerSandboxProvider.observe`, `act`, `writeFile` and `execute` (adapter-kit), plus the supervisor bootstrap pattern of `computer-replay.docker.test.ts:38-79`.

- [ ] **Step 1: Write the test.** It must pass on the Fluxbox image first, as a characterization test. It reuses the replay test's supervisor and provision boilerplate, extracted into a shared `withReplayComputer(fn)` helper in `computer-replay.ts` so both tests use one copy. The fixture page is served inside the computer on `127.0.0.1:8766` by `python3 -m http.server`, started through `sandbox.execute`. It reports its state in `document.title`, which `observe().activeWindow.title` returns, so no CDP is needed:

```ts
const PAGE = `<!doctype html><title>boot</title>
<style>body{margin:0;font:16px sans-serif} #f{position:absolute;left:100px;top:100px;width:300px;height:32px}
#s{position:absolute;left:100px;top:200px;width:300px;height:200px;overflow:auto} #s div{height:2000px}
#u{position:absolute;left:100px;top:450px}</style>
<input id=f><div id=s><div>scroll</div></div><input id=u type=file>
<script>
const report = () => document.title = JSON.stringify({
  w: outerWidth, h: outerHeight, x: screenX, y: screenY, top: outerHeight - innerHeight,
  typed: f.value, scrolled: s.scrollTop > 0, file: u.files[0] ? u.files[0].name + ':' + u.files[0].size : ''});
setInterval(report, 100);
</script>`;

it("drives the real desktop: screenshot, click, type, scroll and portal upload", async () => {
  await withReplayComputer(async ({ sandbox, computer, context }) => {
    await sandbox.writeFile(computer, { path: "Downloads/upload.txt", content: new TextEncoder().encode("hello\n") }, context);
    await sandbox.writeFile(computer, { path: ".desktop-fixture/index.html", content: new TextEncoder().encode(PAGE) }, context);
    await sandbox.execute(computer, { command: "cd ~/.desktop-fixture && nohup python3 -m http.server 8766 --bind 127.0.0.1 >/dev/null 2>&1 &" }, context);

    const first = await sandbox.observe(computer, context);
    expect([first.width, first.height, first.mimeType]).toEqual([1280, 800, "image/png"]);

    await sandbox.act(computer, { actions: [{ kind: "launch", application: "cortexai-agent-hub-browser", uri: "http://127.0.0.1:8766/" }] }, context);
    const state = await waitForTitle(sandbox, computer, context, (s) => s.w > 0);
    // Maximized Chromium covers the whole screen at the origin, as under Fluxbox.
    expect([state.w, state.h, state.x, state.y]).toEqual([1280, 800, 0, 0]);
    const at = (x: number, y: number) => ({ x: state.x + x, y: state.y + state.top + y });

    await sandbox.act(computer, { actions: [
      { kind: "pointer", type: "click", ...at(250, 116) },
      { kind: "clipboard", text: "typed by bot" },
    ] }, context);
    expect((await waitForTitle(sandbox, computer, context, (s) => s.typed !== "")).typed).toBe("typed by bot");

    await sandbox.act(computer, { actions: [
      { kind: "pointer", type: "move", ...at(250, 300) },
      { kind: "scroll", direction: "down", amount: 5 },
    ] }, context);
    expect((await waitForTitle(sandbox, computer, context, (s) => s.scrolled)).scrolled).toBe(true);

    await sandbox.act(computer, { actions: [{ kind: "pointer", type: "click", ...at(140, 462) }] }, context);
    await waitForWindow(sandbox, computer, context, /open|upload|file/i); // portal-gtk chooser
    await sandbox.act(computer, { actions: [
      { kind: "key", key: "l", modifiers: ["ctrl"] },
      { kind: "clipboard", text: "/home/cortexai-agent-hub/Downloads/upload.txt" },
      { kind: "key", key: "Return" },
    ] }, context);
    expect((await waitForTitle(sandbox, computer, context, (s) => s.file !== "")).file).toBe("upload.txt:6");

    const last = await sandbox.observe(computer, context);
    expect(last.image.byteLength).toBeGreaterThan(10_000);
  });
});
```

  `waitForTitle` polls `observe()` every 250 ms for up to 15 s and parses `activeWindow.title`. Chromium suffixes the title with " - Chromium", so it strips that before parsing. `waitForWindow` polls the same field against a regex. Both live in this test file.

- [ ] **Step 2: Run it on the Fluxbox image.** `pnpm sandbox:build && pnpm test:computer-replay`. Expected: PASS. If the geometry assertion fails on Fluxbox because of its title bar, record Fluxbox's actual values in a comment, and assert the xfwm4 values (`1280, 800, 0, 0`) in Task 4, where borderless maximize applies.

- [ ] **Step 3: Commit** `test(computer): real-image click, type, scroll and portal upload journey (CAAH-87)`

### Task 3: Desktop config files, test-first

**Files:**
- Create: `infra/sandboxes/supervisor/src/desktop-config.test.ts`, and every file under `infra/sandboxes/computer/desktop/` listed in File Structure
- Modify: `infra/sandboxes/supervisor/package.json` (devDependency `"@cortexai-agent-hub/ui-tokens": "workspace:*"`), `pnpm-lock.yaml`

**Interfaces:**
- Produces: `/usr/local/share/cortexai-agent-hub/desktop/{session.sh,picom.conf,tint2rc.in,Xresources,browser.desktop.in,terminal.desktop,gtk-3.0/settings.ini}` and `/etc/xdg/xfce4/xfconf/xfce-perchannel-xml/{xfwm4.xml,xfce4-keyboard-shortcuts.xml}`. Task 4 copies these in. `session.sh` is installed as `/usr/local/bin/cortexai-agent-hub-desktop-session` and takes one argument, the display (`:N`). It reads optional `BROWSER` (the dock's browser command, default `cortexai-agent-hub-browser`).

- [ ] **Step 1: Write the failing tests**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { darkTokens } from "@cortexai-agent-hub/ui-tokens";
import { describe, expect, it } from "vitest";

const dir = path.resolve(import.meta.dirname, "../../computer/desktop");
const read = (name: string) => readFileSync(path.join(dir, name), "utf8");
const property = (xml: string, name: string) =>
  xml.match(new RegExp(`<property name="${name}" type="\\w+" value="([^"]*)"`))?.[1];

describe("computer desktop config", () => {
  it("uses only shared dark token colors", () => {
    const palette = new Set(Object.values(darkTokens).map((value) => value.toUpperCase()));
    for (const file of ["session.sh", "tint2rc.in", "Xresources", "picom.conf"])
      for (const hex of read(file).match(/#[0-9A-Fa-f]{6}\b/g) ?? [])
        expect(palette, `${file} ${hex}`).toContain(hex.toUpperCase());
  });

  it("keeps xfwm4 out of the bots' way", () => {
    const xml = read("xfwm4.xml");
    expect(property(xml, "use_compositing")).toBe("false");
    expect(property(xml, "borderless_maximize")).toBe("true");
    expect(property(xml, "workspace_count")).toBe("1");
    expect(property(xml, "prevent_focus_stealing")).toBe("false");
    expect(property(xml, "theme")).toBe("Arc-Dark");
    expect(property(xml, "title_font")).toMatch(/^Inter /);
  });

  it("grabs only Alt+Tab, Alt+Shift+Tab and Alt+F4", () => {
    const xml = read("xfce4-keyboard-shortcuts.xml");
    const keys = [...xml.matchAll(/<property name="([^"]+)" type="string" value="(\w+_key)"/g)]
      .map((m) => `${m[1]}=${m[2]}`)
      .sort();
    expect(keys).toEqual(["&lt;Alt&gt;F4=close_window_key", "&lt;Alt&gt;Tab=cycle_windows_key", "&lt;Alt&gt;&lt;Shift&gt;Tab=cycle_reverse_windows_key"].sort());
    expect(xml).toContain('<property name="override" type="bool" value="true"/>');
  });

  it("composites cheaply and without animation under Xvfb", () => {
    const conf = read("picom.conf");
    for (const line of ['backend = "xrender";', "vsync = false;", "fading = false;", "use-damage = true;", "unredir-if-possible = true;"])
      expect(conf).toContain(line);
    expect(conf).toMatch(/rounded-corners-exclude = \[[^\]]*_NET_WM_STATE_MAXIMIZED_VERT/s);
  });

  it("draws the dock under maximized windows without reserving space or animating", () => {
    const rc = read("tint2rc.in");
    for (const line of ["panel_layer = bottom", "strut_policy = none", "autohide = 0", "startup_notifications = 0", "mouse_right = none", "launcher_icon_theme = Papirus-Dark"])
      expect(rc).toContain(line);
    expect(rc).toContain("launcher_item_app = @STATE@/applications/browser.desktop");
    expect(rc).toContain("launcher_item_app = @STATE@/applications/terminal.desktop");
  });

  it("styles xterm only, never Chromium-visible X settings", () => {
    const resources = read("Xresources");
    expect(resources).not.toMatch(/^Xft\./m);
    expect(resources.split("\n").filter(Boolean).every((line) => line.startsWith("XTerm*"))).toBe(true);
    expect(resources).toContain("XTerm*selectToClipboard: true");
  });

  it("names the dock launchers Browser and Terminal", () => {
    expect(read("browser.desktop.in")).toMatch(/^Name=Browser$/m);
    expect(read("terminal.desktop")).toMatch(/^Name=Terminal$/m);
    expect(read("terminal.desktop")).toMatch(/^Exec=xterm -title Terminal$/m);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** `pnpm install && pnpm vitest run infra/sandboxes/supervisor/src/desktop-config.test.ts`. Expected: FAIL with ENOENT for `desktop/xfwm4.xml`.

- [ ] **Step 3: Write the config files.**

`desktop/session.sh`:

```sh
#!/bin/sh
# Wallpaper, window manager, compositor and dock for one X display.
# Every child is an X client, so all of them exit when the display stops.
set -eu
display="${1:?usage: cortexai-agent-hub-desktop-session :N}"
number="${display#:}"
case "$number" in '' | *[!0-9]*) echo "invalid display $display" >&2; exit 64 ;; esac
export DISPLAY="$display"
share=/usr/local/share/cortexai-agent-hub/desktop
state="/tmp/cortexai-agent-hub/desktop-$number"
# Displays started through docker exec do not inherit the primary session bus; xfconfd needs it.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -r /tmp/cortexai-agent-hub/dbus-session ]; then
  . /tmp/cortexai-agent-hub/dbus-session
fi
mkdir -p "$state/applications"
browser="${BROWSER:-cortexai-agent-hub-browser}"
sed "s|@BROWSER@|$browser|" "$share/browser.desktop.in" >"$state/applications/browser.desktop"
cp "$share/terminal.desktop" "$state/applications/terminal.desktop"
sed "s|@STATE@|$state|g" "$share/tint2rc.in" >"$state/tint2rc"
xrdb -merge "$share/Xresources"
hsetroot -add "#141518" -add "#0B0C0E" -gradient 0 >/dev/null
XDG_CONFIG_DIRS="$share:/etc/xdg" xfwm4 --compositor=off --sm-client-disable &
picom --config "$share/picom.conf" &
tint2 -c "$state/tint2rc" &
wait
```

`desktop/xfwm4.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="theme" type="string" value="Arc-Dark"/>
    <property name="title_font" type="string" value="Inter Semi-Bold 10"/>
    <property name="title_alignment" type="string" value="center"/>
    <property name="button_layout" type="string" value="|HMC"/>
    <property name="use_compositing" type="bool" value="false"/>
    <property name="borderless_maximize" type="bool" value="true"/>
    <property name="workspace_count" type="int" value="1"/>
    <property name="prevent_focus_stealing" type="bool" value="false"/>
    <property name="click_to_focus" type="bool" value="true"/>
    <property name="raise_on_click" type="bool" value="true"/>
    <property name="placement_mode" type="string" value="center"/>
    <property name="placement_ratio" type="int" value="100"/>
    <property name="tile_on_move" type="bool" value="false"/>
    <property name="snap_to_border" type="bool" value="true"/>
    <property name="wrap_windows" type="bool" value="false"/>
    <property name="wrap_workspaces" type="bool" value="false"/>
    <property name="scroll_workspaces" type="bool" value="false"/>
    <property name="mousewheel_rollup" type="bool" value="false"/>
    <property name="double_click_action" type="string" value="maximize"/>
  </property>
</channel>
```

`desktop/xfce4-keyboard-shortcuts.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-keyboard-shortcuts" version="1.0">
  <property name="xfwm4" type="empty">
    <property name="custom" type="empty">
      <property name="override" type="bool" value="true"/>
      <property name="&lt;Alt&gt;Tab" type="string" value="cycle_windows_key"/>
      <property name="&lt;Alt&gt;&lt;Shift&gt;Tab" type="string" value="cycle_reverse_windows_key"/>
      <property name="&lt;Alt&gt;F4" type="string" value="close_window_key"/>
    </property>
  </property>
</channel>
```

`desktop/picom.conf`:

```
backend = "xrender";
vsync = false;
use-damage = true;
unredir-if-possible = true;
fading = false;
shadow = true;
shadow-radius = 18;
shadow-opacity = 0.35;
shadow-offset-x = -18;
shadow-offset-y = -12;
shadow-exclude = [
  "_GTK_FRAME_EXTENTS@:c",
  "window_type = 'dock'",
  "window_type = 'desktop'",
  "window_type = 'menu'",
  "window_type = 'dropdown_menu'",
  "window_type = 'popup_menu'",
  "window_type = 'tooltip'",
  "_NET_WM_STATE@:32a *= '_NET_WM_STATE_MAXIMIZED_VERT'",
  "_NET_WM_STATE@:32a *= '_NET_WM_STATE_FULLSCREEN'"
];
corner-radius = 10;
rounded-corners-exclude = [
  "window_type = 'dock'",
  "window_type = 'desktop'",
  "window_type = 'menu'",
  "window_type = 'dropdown_menu'",
  "window_type = 'popup_menu'",
  "window_type = 'tooltip'",
  "_NET_WM_STATE@:32a *= '_NET_WM_STATE_MAXIMIZED_VERT'",
  "_NET_WM_STATE@:32a *= '_NET_WM_STATE_FULLSCREEN'"
];
detect-client-opacity = true;
detect-transient = true;
mark-wmwin-focused = true;
mark-ovredir-focused = true;
```

`desktop/tint2rc.in`:

```
# Backgrounds: 1 dock, 2 active task, 3 tooltip
rounded = 16
border_width = 1
border_sides = TBLR
background_color = #141518 88
border_color = #ECECEE 10

rounded = 8
border_width = 0
background_color = #ECECEE 14
border_color = #ECECEE 0

rounded = 6
border_width = 0
background_color = #141518 100
border_color = #ECECEE 0

panel_items = LST
panel_size = 0 60
panel_shrink = 1
panel_margin = 0 12
panel_padding = 12 8 8
panel_background_id = 1
panel_position = bottom center horizontal
panel_layer = bottom
panel_dock = 0
panel_window_name = cortexai-agent-hub-dock
wm_menu = 0
strut_policy = none
autohide = 0
disable_transparency = 0
mouse_effects = 1
mouse_hover_icon_asb = 100 0 12
mouse_pressed_icon_asb = 100 0 0

launcher_padding = 0 0 8
launcher_background_id = 0
launcher_icon_size = 40
launcher_icon_theme = Papirus-Dark
launcher_icon_theme_override = 1
launcher_tooltip = 1
startup_notifications = 0
launcher_item_app = @STATE@/applications/browser.desktop
launcher_item_app = @STATE@/applications/terminal.desktop

separator = new
separator_background_id = 0
separator_color = #ECECEE 16
separator_style = line
separator_size = 1
separator_padding = 6 10

taskbar_mode = single_desktop
taskbar_padding = 0 0 8
taskbar_background_id = 0
taskbar_active_background_id = 0
taskbar_name = 0
taskbar_hide_if_empty = 1
task_icon = 1
task_text = 0
task_centered = 1
task_maximum_size = 44 44
task_padding = 2 2 0
task_tooltip = 1
task_background_id = 0
task_active_background_id = 2
task_icon_asb = 100 0 0
mouse_left = toggle_iconify
mouse_middle = none
mouse_right = none
mouse_scroll_up = none
mouse_scroll_down = none

tooltip_show_timeout = 0.4
tooltip_hide_timeout = 0.1
tooltip_padding = 8 6
tooltip_background_id = 3
tooltip_font_color = #ECECEE 100
tooltip_font = Inter 10
```

`desktop/Xresources`:

```
XTerm*faceName: JetBrains Mono
XTerm*faceSize: 11
XTerm*background: #0B0C0E
XTerm*foreground: #ECECEE
XTerm*cursorColor: #ECECEE
XTerm*internalBorder: 14
XTerm*scrollBar: false
XTerm*selectToClipboard: true
XTerm*termName: xterm-256color
XTerm*geometry: 100x30
```

`desktop/gtk-3.0/settings.ini`:

```
[Settings]
gtk-theme-name=Arc-Dark
gtk-icon-theme-name=Papirus-Dark
gtk-font-name=Inter 10
gtk-application-prefer-dark-theme=1
gtk-enable-animations=0
```

`desktop/browser.desktop.in`:

```
[Desktop Entry]
Type=Application
Name=Browser
Icon=chromium
Exec=@BROWSER@
```

`desktop/terminal.desktop`:

```
[Desktop Entry]
Type=Application
Name=Terminal
Icon=utilities-terminal
Exec=xterm -title Terminal
```

- [ ] **Step 4: Run the tests and confirm they pass.** Also run `pnpm lint`.

- [ ] **Step 5: Commit** `feat(computer): modern desktop config for xfwm4, picom and a tint2 dock (CAAH-87)`

### Task 4: Switch the image to the new desktop

**Files:**
- Modify: `infra/sandboxes/computer/Dockerfile`, `infra/sandboxes/computer/start.sh`, `infra/sandboxes/supervisor/src/index.ts:1043-1061`, `.github/workflows/publish-server-image.yml` (add `--expect modern`), `.gitattributes`
- Delete: `infra/sandboxes/computer/fluxbox.init`, `fluxbox.apps`, `fluxbox.menu`
- Test: `infra/sandboxes/supervisor/src/computer-spec.test.ts`, `desktop_smoke.py --expect modern`, `computer-desktop.docker.test.ts`

- [ ] **Step 1: Write the failing test** in `computer-spec.test.ts`, replacing the two Fluxbox-menu tests at lines 264-360:

```ts
it("installs the modern desktop and no full XFCE or Fluxbox", () => {
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  for (const pkg of ["xfwm4", "xfconf", "picom", "tint2", "hsetroot", "arc-theme", "fonts-inter", "fonts-jetbrains-mono"])
    expect(dockerfile).toMatch(new RegExp(`^\\s+${pkg} \\\\$`, "m"));
  for (const pkg of ["fluxbox", "xfce4", "xfdesktop4", "xfce4-panel", "xfce4-session", "xfce4-settings", "plank"])
    expect(dockerfile).not.toMatch(new RegExp(`^\\s+${pkg} \\\\$`, "m"));
  expect(dockerfile).not.toContain("fbsetbg");
  expect(readFileSync(path.join(root, "start.sh"), "utf8")).toContain("cortexai-agent-hub-desktop-session :1");
});
```

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement.** In the Dockerfile:
  - Add an icon stage:

```dockerfile
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS icon-builder
RUN apt-get update && apt-get install -y --no-install-recommends papirus-icon-theme \
  && cd /usr/share/icons \
  && for theme in Papirus Papirus-Dark; do \
       find "$theme" -mindepth 1 -maxdepth 1 -type d \
         ! -name 16x16 ! -name 22x22 ! -name 24x24 ! -name 32x32 ! -name 48x48 ! -name 64x64 ! -name symbolic \
         -exec rm -rf {} +; \
     done \
  && du -sm Papirus Papirus-Dark
```

  - In the runtime stage, replace `fluxbox \` with `xfwm4 xfconf picom tint2 hsetroot arc-theme fonts-inter fonts-jetbrains-mono`, one per line.
  - Delete the `/etc/cortexai-agent-hub/fluxbox` mkdir and the `fbsetbg` shim. Keep the `xmessage` link.
  - Add `COPY --from=icon-builder /usr/share/icons/Papirus /usr/share/icons/Papirus` and the same for `Papirus-Dark`.
  - Add:

```dockerfile
COPY --chmod=755 desktop/session.sh /usr/local/bin/cortexai-agent-hub-desktop-session
COPY --chmod=644 desktop/xfwm4.xml desktop/xfce4-keyboard-shortcuts.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/
COPY --chmod=644 desktop/picom.conf desktop/tint2rc.in desktop/Xresources desktop/browser.desktop.in desktop/terminal.desktop /usr/local/share/cortexai-agent-hub/desktop/
COPY --chmod=644 desktop/gtk-3.0/settings.ini /usr/local/share/cortexai-agent-hub/desktop/gtk-3.0/settings.ini
```

  - Replace the three `fluxbox` paths in the CR-strip `sed` with the new files.

  In `start.sh`:
  - Replace lines 73-84 (the `xsetroot` line through the Fluxbox start) with:

```bash
/usr/local/bin/cortexai-agent-hub-desktop-session :1 >/tmp/cortexai-agent-hub/desktop.log 2>&1 &
```

  - Start the portal backend with `XDG_CONFIG_DIRS=/usr/local/share/cortexai-agent-hub/desktop:/etc/xdg`, so the file chooser is Arc-Dark without theming Chromium.
  - Drop `/tmp/fluxbox-home` from the `mkdir`.

  In `index.ts`, replace the three `fluxbox.*` entries with `"desktop"`; dockerode `src` accepts directories. In `.gitattributes`, replace `infra/sandboxes/computer/fluxbox.* text eol=lf` with `infra/sandboxes/computer/desktop/* text eol=lf`. In the workflow, append `--expect modern` to the desktop smoke command.

  In `computer-desktop.docker.test.ts`, assert the xfwm4 geometry `[1280, 800, 0, 0]` if Task 2 had to relax it.

- [ ] **Step 4: Verify.**
  - `pnpm vitest run infra/sandboxes/supervisor/src`
  - `pnpm sandbox:build`
  - `docker run --rm --network none -v "$PWD/.tmp-desktop:/out" cortexai-agent-hub/computer:local python3 /usr/local/share/cortexai-agent-hub-desktop-smoke.py --out /out --expect modern`
  - `pnpm test:computer-replay`
  - Look at the three PNGs. Confirm rounded corners and shadows on the terminal, the dock on the idle desktop, and a maximized Chromium with no frame.

- [ ] **Step 5: Commit** `feat(computer): replace Fluxbox with xfwm4, picom and a tint2 dock (CAAH-87)`

### Task 5: Team desktops use the same session

**Files:**
- Modify: `packages/core/src/node/desktop-runtime.ts` (`resetDesktopRuntimeCommand`, `renderStopExtraScreenCommand`, `renderEnsureScreenCommand`), `infra/sandboxes/computer/test_team_desktops.py:110-111`
- Test: `packages/core/src/node/desktop-runtime.test.ts`, `infra/sandboxes/supervisor/src/index.test.ts:785,796`

**Interfaces:**
- Produces: `export const DESKTOP_SESSION = "/usr/local/bin/cortexai-agent-hub-desktop-session"` in `desktop-runtime.ts`.

- [ ] **Step 1: Write the failing tests** in `desktop-runtime.test.ts`:

```ts
it("starts extra displays with the baked desktop session and keeps the Fluxbox fallback", () => {
  const ensure = ensureScreenCommand(1, "researcher", "view-token");
  expect(ensure).toContain(`if [ -x ${DESKTOP_SESSION} ]; then`);
  expect(ensure).toContain(`BROWSER=/tmp/cortexai-agent-hub/browser-launch-2 nohup ${DESKTOP_SESSION} :2`);
  expect(ensure).toContain("fluxbox -rc /tmp/fluxbox-home-2/.fluxbox/init");
});

it("stops both the desktop session and a fallback Fluxbox", () => {
  const stop = stopExtraScreenCommand(1, "researcher");
  expect(stop).toContain("[c]ortexai-agent-hub-desktop-session :2( |$)");
  expect(stop).toContain("[f]luxbox -rc /tmp/fluxbox-home-2/.fluxbox/init");
  expect(resetDesktopRuntimeCommand()).toContain('[c]ortexai-agent-hub-desktop-session :${desktop_display}( |$)');
});
```

  Check the exact `browserLauncherPath(2)` string in `desktop-runtime.ts` before pinning the literal. Keep `index.test.ts:785` and add `expect(extra).toContain("[c]ortexai-agent-hub-desktop-session :2")`. Line 796 becomes `expect(stop).not.toMatch(/fluxbox|desktop-session/)`.

- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run packages/core/src/node/desktop-runtime.test.ts infra/sandboxes/supervisor/src/index.test.ts`

- [ ] **Step 3: Implement.** In `renderEnsureScreenCommand`, inside the `if ! xdpyinfo` branch after Xvfb is ready, wrap the existing Fluxbox lines:

```ts
`  if [ -x ${DESKTOP_SESSION} ]; then`,
`    HOME=${shellQuote(env.homeDir)} CHROME_USER_DATA_DIR=${shellQuote(profile)} BROWSER=${browserLauncherPath(layout.displayNumber)} nohup ${DESKTOP_SESSION} ${layout.display} 8>&- 9>&- </dev/null >${log}-desktop.log 2>&1 &`,
"  else",
// existing fluxbox init/apps/menuFile/start lines, unchanged and indented
"  fi",
```

  The menu rewrite before the `if` stays as is for the fallback. The session regenerates its dock launchers on every start, and the browser launcher path per display is stable. In the two stop paths, add next to the Fluxbox `pkill`:

```ts
`pkill -f ${quoteLayout(`[c]ortexai-agent-hub-desktop-session ${layout.display}( |$)`)} || true`,
```

  In `resetDesktopRuntimeCommand`, add `'pkill -f "[c]ortexai-agent-hub-desktop-session :${desktop_display}( |$)" || true'` with the same `biome-ignore` comment as its neighbor. Fix the `TERMINAL_MENU_COMMAND` comment so it no longer points to the deleted `fluxbox.menu`. It now serves only the Fluxbox fallback.

  In `test_team_desktops.py`, replace the menu assertion:

```python
    dock = Path(f"/tmp/cortexai-agent-hub/desktop-{commands['displayb']}/applications")
    for _ in range(50):
        if (dock / "terminal.desktop").exists():
            break
        time.sleep(0.1)
    assert "Name=Terminal" in (dock / "terminal.desktop").read_text(), "screen dock is missing Terminal"
    assert f"browser-launch-{commands['displayb']}" in (dock / "browser.desktop").read_text()
    wm = subprocess.run(["xprop", "-display", f":{commands['displayb']}", "-root", "_NET_SUPPORTING_WM_CHECK"], capture_output=True, text=True)
    assert "window id" in wm.stdout, f"no window manager on screen b: {wm.stdout} {wm.stderr}"
```

- [ ] **Step 4: Run them and confirm they pass.**
  - `pnpm vitest run packages/core infra/sandboxes/supervisor/src`
  - `pnpm sandbox:build && VERIFY_DOCKER_TEAM_SCREENS=1 pnpm vitest run infra/sandboxes/supervisor/src/team-desktops.docker.test.ts`
  - Run that test locally or on a CI-like Linux host with Docker, never on a maintainer's macOS desktop. Report the result on the PR, since CI doesn't run it.

- [ ] **Step 5: Commit** `feat(computer): team desktops start the same modern session (CAAH-87)`

### Task 6: Docs, budget report and full verification

- [ ] **Step 1:** Add one sentence to `docs/computer-runtime.md` under the desktop paragraph: the computer image runs xfwm4 with picom and a tint2 dock, and E2B and Box sandboxes keep a Fluxbox desktop because they don't use the image. Commit `docs: computer desktop stack (CAAH-87)`.
- [ ] **Step 2:** Run `pnpm lint`, `pnpm check` and `pnpm test`, then `pnpm sandbox:build && pnpm test:computer-replay`, then the team-desktop Docker test from Task 5.
- [ ] **Step 3:** Push and wait for CI. Download the `computer-desktop` artifacts from the Task 1 run (before) and the latest run (after).
- [ ] **Step 4:** Update the PR description with the following, then re-check every figure against the budget:
  - before/after screenshots inline: idle, Chromium, terminal;
  - a table of image size, idle container memory and CPU (median of ten samples), desktop process RSS, the per-team-desktop increment, and session-ready time, before and after;
  - the quoted copy ("Browser", "Terminal") and why it stays.
- [ ] **Step 5:** Keep the PR a draft and poll CI, reviews and threads about every 60 seconds until no actionable feedback remains. Never merge.

## Acceptance mapping

| Criterion | Covered by |
| --- | --- |
| Modern WM, compositor, dock, wallpaper, fonts and icons | Tasks 3-4; `--expect modern` smoke in CI |
| Chromium launch and maximize rules | `--start-maximized` + borderless maximize; Task 2 geometry assertion |
| `xcapture`, 1280x800 coordinates | Smoke captures through `xcapture`; Task 2 clicks at computed coordinates |
| Clipboard bridge, mobile keyboard, `embed.html`, read-only `x11vnc`, takeover | Files and `x11vnc` flags unchanged; existing supervisor and clipboard tests; team-desktop Docker test opens view and control sockets |
| File chooser through the portal and D-Bus | Task 2 upload; team-desktop test's portal check |
| Team desktops | Task 5 unit tests + `VERIFY_DOCKER_TEAM_SCREENS` run |
| Non-root, nothing installable, egress unchanged | No `USER`, sudo or network changes; smoke runs with `--network none` as uid 1000 |
| Size, RAM and CPU budget reported | Task 1 baseline + Task 6 table |
| Before/after screenshots | Task 1 artifacts (Fluxbox) and Task 4 artifacts (xfwm4) |
| Existing tests and CI green | Task 6 |

## Open questions for the PM

1. **Dock:** is `tint2` styled as a dock acceptable, or is Plank's look required despite the estimated +45–60 MB per display and the D-Bus and bamf complexity?
2. **Theme:** Arc-Dark (modern, with a slight blue-grey tint), or strict monochrome Adwaita-dark with xfwm4's GTK-colored Default theme (0 MB, plainer)?
3. **Wallpaper:** neutral token gradient (default), or a subtle CortexAI mark? A mark needs a vector asset from the brand owner.
4. **Dock behind maximized windows:** I recommend keeping bots' browser at the full 1280x800, so the dock shows only on the idle desktop and around unmaximized windows. Is that acceptable, or should the dock stay visible at the cost of about 64 px of browser height for every bot?
5. **Chromium UI:** leave Chromium's own frame and tabs as today (default), or force a dark browser UI? Forcing it risks changing pages' `prefers-color-scheme`, so I'd only do it in a separate ticket.

## Decisions and implementation notes

The PM chose tint2 styled like Plank, Arc-Dark, the neutral token gradient, the dock under maximized windows, and no change to Chromium's own UI. Where the build departed from the tasks above:

- **The dock shows launchers only.** tint2 can't merge a launcher with its running window the way Plank does, so there is no taskbar. Each launcher runs through `cortexai-agent-hub-focus-or-launch`, which raises an open window instead of starting another copy. The terminal launcher takes no arguments, because the helper re-runs a launcher that has arguments; its title comes from `XTerm*title`.
- **xfconfd and xfwm4 keep state in `/tmp`.** Bus activation would start xfconfd with the bot's `HOME` and save channel files there. The session starts xfconfd itself and gives xfwm4 per-display XDG directories.
- **Papirus keeps only 16 px, 48 px and symbolic icons.** With every size up to 64 px, CI measured +123 MB; trimmed, it measures +49 MB.
- **The browser wrapper drops `libnss_wrapper` before exec.** On the CI runner, Chromium hangs at startup with it preloaded. That was hidden because `tee` swallowed the smoke's exit code; the step now uses `pipefail`.
