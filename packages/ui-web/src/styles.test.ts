import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const tokensCss = readFileSync(
  createRequire(import.meta.url).resolve("@cortexai-agent-hub/ui-tokens/css"),
  "utf8",
);

function themeBlock(theme: "dark" | "light") {
  const body = tokensCss.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`))?.[1];
  return new Set([...(body ?? "").matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
}

describe("ui-web styles", () => {
  // A token removed from ui-tokens while a utility still reads it renders unstyled.
  it.each(["dark", "light"] as const)("only reads color tokens the %s theme defines", (theme) => {
    const defined = themeBlock(theme);
    const read = [...styles.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g)].map(
      ([, name]) => name,
    );
    expect(read.length).toBeGreaterThan(40);
    expect(read.filter((name) => !defined.has(name))).toEqual([]);
  });

  it("switches every motion token off under reduced motion", () => {
    const reduced = styles.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/,
    )?.[1];
    for (const name of [
      "panel-in",
      "pop-in",
      "pop-out",
      "msg-in",
      "shimmer",
      "status-pulse",
      "rise",
      "spot-in",
    ]) {
      expect(styles).toContain(`--animate-${name}: ${name} `);
      expect(reduced).toContain(`--animate-${name}: none;`);
    }
  });
});
