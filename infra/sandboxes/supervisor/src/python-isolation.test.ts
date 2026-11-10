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

  it("runs action steps with the image's PATH, as the control server does", () => {
    const source = readFileSync(supervisorIndex, "utf8");
    const control = readFileSync(path.join(computerDir, "control.py"), "utf8");
    const childPath = control.match(/^CHILD_PATH = "([^"]+)"$/m)?.[1];
    expect(childPath).toBeTruthy();
    expect(source).toContain(`const COMPUTER_CHILD_PATH = "${childPath}";`);
    expect(source).toMatch(/subprocess\.run\(step\['argv'\], env=\{\*\*os\.environ, 'PATH': /);
  });
});

// The shared Linux desktop runtime and the providers that use it start Python in the computer
// too (extra screens' gateways, the terminal server, inline probes). They keep `python3` from
// PATH, since provider images differ, but always isolated.
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const RUNTIME_FILES = [
  "packages/core/src/node/desktop-runtime.ts",
  "packages/adapters/src/linux-desktop.ts",
  "packages/adapters/src/createos-sandbox.ts",
];

describe("Python the desktop runtime starts in the computer", () => {
  it.each(RUNTIME_FILES)("starts every python3 isolated in %s", (file) => {
    const text = readFileSync(path.join(repoRoot, file), "utf8").replace(/\s+/g, " ");
    // A python3 command in a shell string (`python3 …`) or an argv ("python3", …); not a
    // package name in a dependency check (`python3:python3`).
    const launches = [...text.matchAll(/(?<![:\w])python3(?=[ "'])/g)].map((match) =>
      text.slice(match.index, match.index + 24),
    );
    expect(launches.length).toBeGreaterThan(0);
    expect(launches.filter((launch) => !/^python3( -I |", "-I")/.test(launch))).toEqual([]);
  });

  it("starts the extra screens' gateway without the user site-packages", () => {
    const runtime = readFileSync(path.join(repoRoot, RUNTIME_FILES[0]!), "utf8");
    const launches = runtime.split("\n").filter((line) => line.includes('"$proxy" --'));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatch(/PYTHONNOUSERSITE=1 nohup "\$proxy" --/);
  });
});
