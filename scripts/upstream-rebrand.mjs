#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const old = ["ra", "kazo"].join("");
const Old = old[0].toUpperCase() + old.slice(1);
const OLD = old.toUpperCase();

const RULES = [
  [new RegExp(`com\\.${old}\\.app`, "g"), "com.tukatek.cortexai.agenthub"],
  [new RegExp(`github\\.com/elie222/${old}`, "g"), "github.com/TukaTek/agent-hub"],
  [new RegExp(OLD, "g"), "CORTEXAI_AGENT_HUB"],
  [new RegExp(`(?<![A-Za-z0-9])${old}(?=[A-Z])`, "g"), "cortexAiAgentHub"],
  [new RegExp(`(?<![A-Za-z0-9])${Old}(?=[A-Z])`, "g"), "CortexAiAgentHub"],
  // The display name has spaces, so a bare object key needs quotes.
  [new RegExp(`(?<=(?:^|[{,])\\s*)${Old}(?=\\s*:\\s*["'\`\\d{[])`, "gm"), '"CortexAI Agent Hub"'],
  [new RegExp(Old, "g"), "CortexAI Agent Hub"],
  // pgrep/pkill patterns bracket the first letter so they never match themselves.
  [new RegExp(`\\[${old[0]}\\]${old.slice(1)}`, "g"), "[c]ortexai-agent-hub"],
  [new RegExp(`${old}(?!\\.com\\b)`, "g"), "cortexai-agent-hub"],
  // Upstream's short prefix for CSS classes and variables, performance marks and storage keys.
  [/(?<![\w-])rk([-:])(?=[\w$])/g, "cortexai-agent-hub$1"],
  [/--rk-(?=\w)/g, "--cortexai-agent-hub-"],
];
const UNRESOLVED = new RegExp(`[\\w.+-]*@?${old}\\.com\\b[\\w./-]*`, "g");
const KEEP = new Set(["LICENSE", "NOTICE"]);

export function rebrand(input) {
  const unresolved = [...new Set(input.match(UNRESOLVED) ?? [])];
  const text = RULES.reduce((out, [pattern, value]) => out.replace(pattern, value), input);
  return { text, unresolved };
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
