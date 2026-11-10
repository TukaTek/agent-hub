import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The computer's user (and so the bot) can write its home. A .pth in the user site-packages, a
// python3 early in PATH or a PYTHON* variable would run code inside any Python started there,
// including the page browser while it holds a saved login. Every Python the image or the
// supervisor starts in the computer must be the system interpreter in isolated mode.
const computerDir = path.resolve(import.meta.dirname, "../../computer");
const supervisorIndex = path.resolve(import.meta.dirname, "index.ts");
const ISOLATED = "/usr/bin/python3 -I";

/** CI-only image checks, run as `python3 <file>` in a fresh image before any user content. */
const CI_ONLY = new Set(["office_smoke.py", "desktop_smoke.py"]);

function imageFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const relative = path.join(prefix, name);
    if (statSync(full).isDirectory()) return imageFiles(full, relative);
    // Tests are not copied into the image.
    if (name.startsWith("test_") || CI_ONLY.has(name)) return [];
    return [relative];
  });
}

describe("Python started in the computer", () => {
  const files = imageFiles(computerDir).map((file) => ({
    file,
    text: readFileSync(path.join(computerDir, file), "utf8"),
  }));

  it("uses the isolated system interpreter in every Python shebang", () => {
    const shebangs = files.flatMap(({ file, text }) => {
      const first = text.split("\n", 1)[0] ?? "";
      return first.startsWith("#!") && /python/.test(first) ? [{ file, first }] : [];
    });
    // control.py, the focus-or-launch and page-browser wrappers.
    expect(shebangs.length).toBeGreaterThanOrEqual(3);
    expect(shebangs.filter(({ first }) => first !== `#!${ISOLATED}`)).toEqual([]);
  });

  it("starts every inline Python in the image's shell scripts isolated", () => {
    // The Dockerfile's build-time checks run as root before any user content exists.
    const runtime = files
      .filter(({ file }) => !file.endsWith("Dockerfile"))
      .flatMap(({ file, text }) =>
        text
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          // A command that runs python3 (not a mention in a string or comment).
          .filter((line) => /(^|[\s;&|(])(\S*\/)?python3?(\s|$)/.test(line))
          .map((line) => ({ file, line: line.trim() })),
      );
    expect(runtime.length).toBeGreaterThan(0);
    expect(runtime.filter(({ line }) => !line.includes(ISOLATED))).toEqual([]);
  });

  it("starts the screen gateway by its full path without the user site-packages", () => {
    const start = files.find(({ file }) => file === "start.sh")!.text;
    const launch = start.split("\n").filter((line) => line.includes("websockify --"));
    expect(launch).toHaveLength(1);
    expect(launch[0]).toMatch(/^PYTHONNOUSERSITE=1 \/usr\/bin\/websockify /);
  });

  it("gives control-server children the image's PATH and no control token", () => {
    const control = files.find(({ file }) => file === "control.py")!.text;
    expect(control).toMatch(
      /^CHILD_PATH = "\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"$/m,
    );
    expect(control).not.toMatch(/\{\*\*os\.environ, "DISPLAY"/);
  });

  it("runs the supervisor's in-computer Python commands isolated", () => {
    const source = readFileSync(supervisorIndex, "utf8");
    // Each in-computer Python goes through the one isolated interpreter...
    const definition = 'const COMPUTER_PYTHON = ["/usr/bin/python3", "-I"] as const;';
    expect(source).toContain(definition);
    // ...and no other argv the supervisor hands to docker exec names a python.
    expect(source.replace(definition, "").match(/\[\s*"(\S*\/)?python3?"/g) ?? []).toEqual([]);
    expect(source.match(/\.\.\.COMPUTER_PYTHON,\s*"-c"/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
