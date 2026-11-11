import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

const resources = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "modules/cortexai-agent-hub-notifications/android/src/main/res",
);
const keys = [
  "cortexai_agent_hub_channel_live",
  "cortexai_agent_hub_channel_messages",
  "cortexai_agent_hub_channel_scheduled",
  "cortexai_agent_hub_channel_attention",
  "cortexai_agent_hub_live_one",
  "cortexai_agent_hub_live_many",
  "cortexai_agent_hub_live_working",
  "cortexai_agent_hub_scheduled_title",
  "cortexai_agent_hub_replied_group",
  "cortexai_agent_hub_replied",
  "cortexai_agent_hub_attention_failed",
  "cortexai_agent_hub_attention_takeover",
  "cortexai_agent_hub_attention_input",
];

const resourceDirectories = {
  en: "values",
  "zh-CN": "values-zh-rCN",
  "zh-TW": "values-zh-rTW",
  ru: "values-ru",
  de: "values-de",
  ja: "values-ja",
} as const satisfies Record<(typeof UI_LOCALES)[number], string>;

function strings(locale: (typeof UI_LOCALES)[number]) {
  return readFileSync(resolve(resources, resourceDirectories[locale], "strings.xml"), "utf8");
}

describe("Android notification resources", () => {
  it("provides every notification string in each shipped mobile locale", () => {
    for (const locale of UI_LOCALES) {
      const xml = strings(locale);
      for (const key of keys) expect(xml).toContain(`name="${key}"`);
    }
  });

  it("keeps positional format arguments in translated strings", () => {
    expect(strings("de")).toContain("%1$s und %2$d");
    expect(strings("ru")).toContain("%1$s и ещё %2$d");
    expect(strings("zh-CN")).toContain("%1$s 和另外 %2$d");
    expect(strings("ja")).toContain("%1$sとほか%2$d件");
  });
});
