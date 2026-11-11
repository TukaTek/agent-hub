import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS, CORTEXAI_AGENT_HUB_DOCS_URLS } from "./builtin-skills.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);

describe("CortexAI Agent Hub skill", () => {
  it("links only to the fork's docs pages", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "CortexAI Agent Hub")!;
    const urls = [...skill.content.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
    expect(urls).toEqual(CORTEXAI_AGENT_HUB_DOCS_URLS);
    for (const url of urls) {
      const slug =
        /^https:\/\/raw\.githubusercontent\.com\/TukaTek\/agent-hub\/main\/docs\/([\w-]+)\.md$/.exec(
          url,
        )?.[1];
      expect(slug, url).toBeDefined();
      expect(existsSync(repoFile(`docs/${slug}.md`)), url).toBe(true);
    }
  });
});
