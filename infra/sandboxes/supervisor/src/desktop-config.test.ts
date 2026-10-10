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
    expect(keys).toEqual(
      [
        "&lt;Alt&gt;F4=close_window_key",
        "&lt;Alt&gt;Tab=cycle_windows_key",
        "&lt;Alt&gt;&lt;Shift&gt;Tab=cycle_reverse_windows_key",
      ].sort(),
    );
    expect(xml).toContain('<property name="override" type="bool" value="true"/>');
  });

  it("composites cheaply and without animation under Xvfb", () => {
    const conf = read("picom.conf");
    for (const line of [
      'backend = "xrender";',
      "vsync = false;",
      "fading = false;",
      "use-damage = true;",
      "unredir-if-possible = true;",
    ])
      expect(conf).toContain(line);
    expect(conf).toMatch(/rounded-corners-exclude = \[[^\]]*_NET_WM_STATE_MAXIMIZED_VERT/s);
  });

  it("draws an icon-only launcher dock under maximized windows without reserving space", () => {
    const rc = read("tint2rc.in");
    for (const line of [
      "panel_items = L",
      "panel_position = bottom center horizontal",
      "panel_layer = bottom",
      "strut_policy = none",
      "autohide = 0",
      "startup_notifications = 0",
      "launcher_icon_theme = Papirus-Dark",
    ])
      expect(rc).toContain(line);
    expect(rc).toMatch(/^rounded = \d+$/m);
    expect(rc).toContain("launcher_item_app = @STATE@/applications/browser.desktop");
    expect(rc).toContain("launcher_item_app = @STATE@/applications/terminal.desktop");
  });

  it("styles xterm only, never Chromium-visible X settings", () => {
    const resources = read("Xresources");
    expect(resources).not.toMatch(/^Xft\./m);
    expect(
      resources
        .split("\n")
        .filter(Boolean)
        .every((line) => line.startsWith("XTerm*")),
    ).toBe(true);
    expect(resources).toContain("XTerm*selectToClipboard: true");
  });

  it("names the dock launchers Browser and Terminal and raises running windows", () => {
    const browser = read("browser.desktop.in");
    const terminal = read("terminal.desktop");
    expect(browser).toMatch(/^Name=Browser$/m);
    expect(browser).toMatch(/^Exec=cortexai-agent-hub-focus-or-launch @BROWSER@$/m);
    expect(terminal).toMatch(/^Name=Terminal$/m);
    // Arguments would make the helper start a second xterm instead of raising the first.
    expect(terminal).toMatch(/^Exec=cortexai-agent-hub-focus-or-launch xterm$/m);
    expect(read("session.sh")).toContain("BROWSER:-cortexai-agent-hub-browser}");
  });
});
