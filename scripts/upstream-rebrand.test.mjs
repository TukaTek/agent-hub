import { describe, expect, it } from "vitest";
import { rebrand, rebrandPath } from "./upstream-rebrand.mjs";

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
    [
      'className="cortexai-agent-hub-scroll max-h-25"',
      'className="cortexai-agent-hub-scroll max-h-25"',
    ],
    [".cortexai-agent-hub-chat-markdown-copy {", ".cortexai-agent-hub-chat-markdown-copy {"],
    [
      "width: var(--cortexai-agent-hub-diagram-width);",
      "width: var(--cortexai-agent-hub-diagram-width);",
    ],
    [
      'markOnce("cortexai-agent-hub:renderer:shell-ready")',
      'markOnce("cortexai-agent-hub:renderer:shell-ready")',
    ],
    [
      'sessionStorage.getItem("cortexai-agent-hub:preload-recovery")',
      'sessionStorage.getItem("cortexai-agent-hub:preload-recovery")',
    ],
    [
      'mark("cortexai-agent-hub:main:window-shown")',
      'mark("cortexai-agent-hub:main:window-shown")',
    ],
    [
      `marker.replace("${old}", "[${old[0]}]${old.slice(1)}")`,
      'marker.replace("cortexai-agent-hub", "[c]ortexai-agent-hub")',
    ],
    [`  ${Old}: "${Old}",`, '  "CortexAI Agent Hub": "CortexAI Agent Hub",'],
    [`{ ${Old}: 1 }`, '{ "CortexAI Agent Hub": 1 }'],
    [
      `GRANT USAGE ON SCHEMA public TO ${old}_app;`,
      "GRANT USAGE ON SCHEMA public TO cortexai_agent_hub_app;",
    ],
    [`"${old}_app_queue"`, '"cortexai_agent_hub_app_queue"'],
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

describe("rebrandPath", () => {
  it("maps upstream module, package and Android resource paths to the fork's", () => {
    expect(
      rebrandPath(`modules/${old}-notifications/java/com/${old}/notifications/${Old}Call.kt`),
    ).toBe(
      "modules/cortexai-agent-hub-notifications/java/com/tukatek/cortexai/agenthub/notifications/CortexAiAgentHubCall.kt",
    );
    expect(rebrandPath(`res/drawable/ic_${old}_notification.xml`)).toBe(
      "res/drawable/ic_cortexai_agent_hub_notification.xml",
    );
    expect(rebrandPath(`docs/${old}.md`)).toBe("docs/cortexai-agent-hub.md");
    expect(
      rebrand(`<string name="${old}_call">x</string>`, "m/android/res/values/strings.xml").text,
    ).toBe('<string name="cortexai_agent_hub_call">x</string>');
    expect(rebrand(`R.drawable.ic_${old}_notification`, "m/Service.kt").text).toBe(
      "R.drawable.ic_cortexai_agent_hub_notification",
    );
    expect(rebrand(`${old}_config`).text).toBe("cortexai-agent-hub_config");
    expect(rebrand(`metadata?.${old}_credit_cents`).text).toBe(
      "metadata?.cortexai_agent_hub_credit_cents",
    );
    expect(rebrand(`{ ${old}_credit_cents: x, ${old}: "computer" }`).text).toBe(
      '{ cortexai_agent_hub_credit_cents: x, "cortexai-agent-hub": "computer" }',
    );
    expect(rebrand(`package com.${old}.notifications`).text).toBe(
      "package com.tukatek.cortexai.agenthub.notifications",
    );
  });
});
