import { describe, expect, it } from "vitest";
import {
  displayBotWorkspacePath,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  stripWorkspaceRoot,
  teamBotWorkspaceDirectory,
} from "./computer-support.js";

describe("Team Computer bot folders", () => {
  it("uses the bot folder for relative paths and cwd", () => {
    expect(teamBotWorkspaceDirectory("bot-1")).toBe("bots/bot-1");
    expect(resolveBotWorkspacePath("team", "bot-1", "notes/result.txt")).toBe(
      "bots/bot-1/notes/result.txt",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "")).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", undefined)).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", "projects/site")).toBe(
      "bots/bot-1/projects/site",
    );
    expect(resolveBotWorkspaceCwd("team", "bot-1", "/Users/me/project")).toBe("/Users/me/project");
  });

  it("keeps shared, bot-root, and absolute paths at the Team root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "bots/bot-2/result.md")).toBe(
      "bots/bot-2/result.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/root-note.md")).toBe("root-note.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "/shared/brief.md")).toBe("shared/brief.md");
  });

  it("presents the current bot folder as its home without hiding Team paths", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "notes", "bots/bot-1/notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "shared", "shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "bots", "bots/bot-1")).toBe("bots/bot-1");
    expect(displayBotWorkspacePath("team", "bot-1", "/", "bots/bot-1")).toBe("bots/bot-1");
    expect(
      displayBotWorkspacePath("team", "bot-1", "bots/bot-1", "bots/bot-1/notes/result.txt"),
    ).toBe("bots/bot-1/notes/result.txt");
  });

  it("leaves Private Computer paths unchanged", () => {
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(resolveBotWorkspaceCwd("dedicated", "bot-1", undefined)).toBeUndefined();
    expect(displayBotWorkspacePath("dedicated", "bot-1", "notes", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
  });
});

describe("resolveBotUploadPath", () => {
  it("keeps team uploads in the controlling bot home or shared", () => {
    expect(resolveBotUploadPath("team", "bot-1", "notes.txt")).toBe("bots/bot-1/notes.txt");
    expect(resolveBotUploadPath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(() => resolveBotUploadPath("team", "bot-1", "bots/bot-2/secret.txt")).toThrow(
      /escapes the bot workspace/,
    );
  });
});

describe("provider workspace roots", () => {
  const root = "/home/cortexai-agent-hub";

  it("turns a real absolute workspace path into the virtual-root path file tools use", () => {
    expect(stripWorkspaceRoot(`${root}/.cortexai/tool-results/k/r/01-x.txt`, root)).toBe(
      "/.cortexai/tool-results/k/r/01-x.txt",
    );
    expect(stripWorkspaceRoot(root, `${root}/`)).toBe("/");
    expect(
      resolveBotWorkspacePath(
        "team",
        "bot-1",
        stripWorkspaceRoot(`${root}/bots/bot-1/.cortexai/tool-results/k/r/01-x.txt`, root),
      ),
    ).toBe("bots/bot-1/.cortexai/tool-results/k/r/01-x.txt");
  });

  it("leaves other paths alone", () => {
    expect(stripWorkspaceRoot("notes/a.txt", root)).toBe("notes/a.txt");
    expect(stripWorkspaceRoot(`${root}-other/a.txt`, root)).toBe(`${root}-other/a.txt`);
    expect(stripWorkspaceRoot(`${root}/a.txt`, undefined)).toBe(`${root}/a.txt`);
    expect(() =>
      resolveBotWorkspacePath("team", "bot-1", stripWorkspaceRoot(`${root}/../etc/passwd`, root)),
    ).toThrow("Path escapes the computer workspace");
  });
});
