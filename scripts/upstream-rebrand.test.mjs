import { describe, expect, it } from "vitest";
import { rebrand } from "./upstream-rebrand.mjs";

const old = ["ra", "kazo"].join("");
const Old = old[0].toUpperCase() + old.slice(1);
const OLD = old.toUpperCase();

describe("rebrand", () => {
  it.each([
    [`import { a } from "@${old}/core";`, 'import { a } from "@cortexai-agent-hub/core";'],
    [`headers["x-${old}-space-id"]`, 'headers["x-cortexai-agent-hub-space-id"]'],
    [`labels["${old}.botId"]`, 'labels["cortexai-agent-hub.botId"]'],
    [`labels["${old}.computerOwner"]`, 'labels["cortexai-agent-hub.computerOwner"]'],
    [`window.__${old}NativeKeys = true`, "window.__cortexAiAgentHubNativeKeys = true"],
    [`process.env.${OLD}_ALLOWED_HOSTS`, "process.env.CORTEXAI_AGENT_HUB_ALLOWED_HOSTS"],
    [`window.${old}ComputerKeyboard`, "window.cortexAiAgentHubComputerKeyboard"],
    [`class ${Old}NetworkCache {}`, "class CortexAiAgentHubNetworkCache {}"],
    [`appName: "${Old}"`, 'appName: "CortexAI Agent Hub"'],
    [`"${old}://"`, '"cortexai-agent-hub://"'],
    [`com.${old}.app`, "com.tukatek.cortexai.agenthub"],
    [`user@${old}.test`, "user@cortexai-agent-hub.test"],
    [`https://github.com/elie222/${old}/releases`, "https://github.com/TukaTek/agent-hub/releases"],
    ['className="rk-scroll max-h-25"', 'className="cortexai-agent-hub-scroll max-h-25"'],
    [".rk-chat-markdown-copy {", ".cortexai-agent-hub-chat-markdown-copy {"],
    ["width: var(--rk-diagram-width);", "width: var(--cortexai-agent-hub-diagram-width);"],
    ['markOnce("rk:renderer:shell-ready")', 'markOnce("cortexai-agent-hub:renderer:shell-ready")'],
    [
      'sessionStorage.getItem("rk:preload-recovery")',
      'sessionStorage.getItem("cortexai-agent-hub:preload-recovery")',
    ],
    ['mark("rk:main:window-shown")', 'mark("cortexai-agent-hub:main:window-shown")'],
    [
      `marker.replace("${old}", "[${old[0]}]${old.slice(1)}")`,
      'marker.replace("cortexai-agent-hub", "[c]ortexai-agent-hub")',
    ],
    [`  ${Old}: "${Old}",`, '  "CortexAI Agent Hub": "CortexAI Agent Hub",'],
    [`{ ${Old}: 1 }`, '{ "CortexAI Agent Hub": 1 }'],
  ])("maps %s", (input, output) => {
    expect(rebrand(input)).toEqual({ text: output, unresolved: [] });
  });

  it.each([
    "git work-tree",
    "fork-point",
    "className='dark:bg-muted'",
    "mark: done",
    "bookmark-icon",
    "--work-dir",
    "park:rk",
  ])("leaves %s alone", (input) => {
    expect(rebrand(input)).toEqual({ text: input, unresolved: [] });
  });

  it("leaves the old domain for a person to resolve", () => {
    expect(rebrand(`mailto:security@${old}.com`).unresolved).toEqual([`security@${old}.com`]);
  });
});
