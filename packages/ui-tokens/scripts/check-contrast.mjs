#!/usr/bin/env node
// Adapted from OpenMausBot scripts/check-skin-contrast.mjs (Apache-2.0). Modified by TukaTek.
// Measures every text/surface pair of the dark and light themes, parsed from the
// generated tokens.css. Runs as part of `pnpm --filter @cortexai-agent-hub/ui-tokens check`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/tokens.css", import.meta.url)), "utf8");

function declarations(body) {
  const tokens = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

function parseThemes(source) {
  const themes = new Map();
  for (const [, id, body] of source.matchAll(/\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
    themes.set(id, declarations(body));
  }
  return themes;
}

function parseHex(value) {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  const h = match[1];
  const full = h.length <= 4 ? Array.from(h, (c) => c + c).join("") : h;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

/** Foreground alpha composited over an opaque background. */
function flatten(fg, bg) {
  if (fg.a === 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fgHex, bgHex) {
  const bg = parseHex(bgHex);
  const parsedFg = parseHex(fgHex);
  if (!parsedFg || !bg || bg.a !== 1) return null;
  const fg = flatten(parsedFg, bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = [
  "--app",
  "--panel",
  "--raised",
  "--raised-hover",
  "--card",
  "--menu",
  "--inset",
  "--control",
];
const GROUNDS = ["--app", "--panel", "--card", "--menu"];
const PAIRS = [
  ...SURFACES.map((s) => ["--ink", s, 4.5]),
  ...SURFACES.map((s) => ["--ink-secondary", s, 4.5]),
  // Quiet text is body-size, so it is held to the same 4.5:1.
  ...SURFACES.map((s) => ["--ink-tertiary", s, 4.5]),
  ...GROUNDS.map((s) => ["--accent-text", s, 4.5]),
  ["--bubble-user-ink", "--bubble-user", 4.5],
  ["--accent-ink", "--accent-fill", 4.5],
  ["--danger-ink", "--danger", 4.5],
  ["--success-ink", "--success", 4.5],
  ["--warning-ink", "--warning", 4.5],
  ["--danger", "--card", 4.5],
  ["--success", "--card", 4.5],
  ["--warning", "--card", 4.5],
  // Borders are UI components, not text: WCAG 1.4.11 asks 3:1.
  ["--accent-border", "--app", 3],
  // The focus ring sits outside the control on whatever surface is behind it, and a
  // focused field paints its border in the ring colour.
  ...SURFACES.map((s) => ["--focus", s, 3]),
  // Surface against surface: two equal surfaces hide everything painted on one over the
  // other. A surface only has to be seen, so the bar is a just-perceptible step.
  ["--card", "--app", 1.04],
  ["--panel", "--app", 1.03],
  ["--control", "--card", 1.06],
  ["--raised-hover", "--raised", 1.04],
];

const themes = parseThemes(css);
let failed = themes.size !== 2;
if (failed) console.log(`✗ expected dark and light themes, found ${[...themes.keys()].join(", ")}`);

for (const [id, tokens] of themes) {
  const problems = [];
  let measured = 0;
  for (const [fg, bg, min] of PAIRS) {
    // A pair we cannot measure is a failure, never skipped.
    const ratio = contrast(tokens[fg] ?? "", tokens[bg] ?? "");
    if (ratio === null) {
      problems.push(`${fg} on ${bg}: cannot measure (${tokens[fg]} on ${tokens[bg]})`);
      continue;
    }
    measured++;
    if (ratio < min) problems.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
  }
  if (problems.length === 0) {
    console.log(`✓ ${id} — ${measured} pairs, none below target`);
    continue;
  }
  failed = true;
  console.log(`✗ ${id}`);
  for (const problem of problems) console.log(`    ${problem}`);
}

process.exit(failed ? 1 : 0);
