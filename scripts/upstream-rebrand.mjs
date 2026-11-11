#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const old = ["ra", "kazo"].join("");
const Old = old[0].toUpperCase() + old.slice(1);
const OLD = old.toUpperCase();

const RULES = [
  [new RegExp(`com\\.${old}\\.app`, "g"), "com.tukatek.cortexai.agenthub"],
  // Native module packages (Kotlin `com.<old>.notifications`) live under the app's package.
  [new RegExp(`(?<=^|[/\\s"'\`])com/${old}/`, "gm"), "com/tukatek/cortexai/agenthub/"],
  [new RegExp(`com\\.${old}\\.(?=[a-z])`, "g"), "com.tukatek.cortexai.agenthub."],
  [new RegExp(`github\\.com/elie222/${old}`, "g"), "github.com/TukaTek/agent-hub"],
  [new RegExp(`ghcr\\.io/elie222/${old}`, "g"), "ghcr.io/tukatek/agent-hub"],
  [new RegExp(OLD, "g"), "CORTEXAI_AGENT_HUB"],
  [new RegExp(`(?<![A-Za-z0-9])${old}(?=[A-Z])`, "g"), "cortexAiAgentHub"],
  [new RegExp(`(?<![A-Za-z0-9])${Old}(?=[A-Z])`, "g"), "CortexAiAgentHub"],
  // The display name has spaces, so a bare object key needs quotes.
  [new RegExp(`(?<=(?:^|[{,])\\s*)${Old}(?=\\s*:\\s*["'\`\\d{[])`, "gm"), '"CortexAI Agent Hub"'],
  [new RegExp(Old, "g"), "CortexAI Agent Hub"],
  // pgrep/pkill patterns bracket the first letter so they never match themselves.
  [new RegExp(`\\[${old[0]}\\]${old.slice(1)}`, "g"), "[c]ortexai-agent-hub"],
  // Postgres role names are unquoted SQL identifiers, so they cannot take a hyphen.
  [new RegExp(`(?<![\\w-])${old}_app(?![a-z])`, "g"), "cortexai_agent_hub_app"],
  [new RegExp(`${old}(?!\\.com\\b)`, "g"), "cortexai-agent-hub"],
  // Upstream's short prefix for CSS classes and variables, performance marks and storage keys.
  [/(?<![\w-])rk([-:])(?=[\w$])/g, "cortexai-agent-hub$1"],
  [/--rk-(?=\w)/g, "--cortexai-agent-hub-"],
];
const UNRESOLVED = new RegExp(`[\\w.+-]*@?${old}\\.com\\b[\\w./-]*`, "g");
const KEEP = new Set(["LICENSE", "NOTICE"]);

// Android resource names and their Kotlin references only allow underscores.
const ANDROID = /(^|\/)android\/|\.kt$/;
const ANDROID_RULES = [
  [
    new RegExp(`(?<![\\w.-])${old}_|(?<=_)${old}(?![A-Za-z0-9-])`, "g"),
    (match) => match.replace(old, "cortexai_agent_hub"),
  ],
];

export function rebrand(input, path = "") {
  const unresolved = [...new Set(input.match(UNRESOLVED) ?? [])];
  const rules = ANDROID.test(path) ? [...ANDROID_RULES, ...RULES] : RULES;
  const text = rules.reduce((out, [pattern, value]) => out.replace(pattern, value), input);
  return { text, unresolved };
}

const PATH_RULES = [
  [new RegExp(`(?<=^|/)com/${old}/`, "g"), "com/tukatek/cortexai/agenthub/"],
  // Android resource names only allow underscores.
  [new RegExp(`(?<=_)${old}(?=_|\\.)|(?<=/|^)${old}(?=_)`, "g"), "cortexai_agent_hub"],
];

/** The fork's path for an upstream path that carries the old product name. */
export function rebrandPath(path) {
  return rebrand(PATH_RULES.reduce((out, [pattern, value]) => out.replace(pattern, value), path))
    .text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = false;
  for (const file of process.argv.slice(2).filter((path) => !KEEP.has(path))) {
    const source = readFileSync(file, "utf8");
    const { text, unresolved } = rebrand(source);
    if (text !== source) writeFileSync(file, text);
    for (const value of unresolved) {
      console.log(`${file}: resolve by hand: ${value}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
