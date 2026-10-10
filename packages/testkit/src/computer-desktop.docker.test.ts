import type { AdapterContext, ComputerRef, SandboxProvider } from "@cortexai-agent-hub/adapter-kit";
import { describe, expect, it } from "vitest";
import { withDockerComputer } from "./computer-docker-harness.js";

const FIXTURE_URL = "http://127.0.0.1:8766/";
const UPLOAD = "hello\n";
// The page reports its own geometry and state through document.title, which the
// observation's active window title carries back without any page tooling.
const PAGE = `<!doctype html><title>boot</title>
<style>
body { margin: 0; font: 16px sans-serif }
#f { position: absolute; left: 100px; top: 100px; width: 300px; height: 32px }
#s { position: absolute; left: 100px; top: 200px; width: 300px; height: 200px; overflow: auto }
#s div { height: 2000px }
#u { position: absolute; left: 100px; top: 450px }
</style>
<input id=f><div id=s><div>scroll</div></div><input id=u type=file>
<script>
setInterval(() => {
  document.title = JSON.stringify({
    w: outerWidth, h: outerHeight, x: screenX, y: screenY, top: outerHeight - innerHeight,
    typed: f.value, scrolled: s.scrollTop > 0,
    file: u.files[0] ? u.files[0].name + ":" + u.files[0].size : "",
  });
}, 100);
</script>`;

interface PageState {
  w: number;
  h: number;
  x: number;
  y: number;
  top: number;
  typed: string;
  scrolled: boolean;
  file: string;
}

async function exec(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  command: string,
) {
  let code: number | undefined;
  let stdout = "";
  let stderr = "";
  for await (const event of sandbox.execute(computer, { argv: ["bash", "-c", command] }, context)) {
    if (event.type === "exit") code = event.code;
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
  }
  return { code, stdout, stderr };
}

async function run(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  command: string,
) {
  const { code, stderr } = await exec(sandbox, computer, context, command);
  expect(code, stderr.slice(0, 1000)).toBe(0);
}

// CI runners can't be inspected after a failure, so a timed-out wait carries the desktop state.
const DIAGNOSE =
  "wmctrl -lx; ps -eo pid,etime,args --cols 200 | grep -E '[c]hrom|[c]ortexai-agent-hub-(browser|focus)' | head -20; " +
  "tail -n 40 /tmp/cortexai-agent-hub/control.log";

async function waitForTitle(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  matches: (title: string) => boolean,
) {
  let title = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    title = (await sandbox.observe(computer, context)).activeWindow?.title ?? "";
    if (matches(title)) return title;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const state = await exec(sandbox, computer, context, DIAGNOSE);
  throw new Error(
    `Active window never matched; last title: ${JSON.stringify(title)}\n${state.stdout}${state.stderr}`,
  );
}

async function waitForPage(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  matches: (state: PageState) => boolean,
) {
  let state: PageState | undefined;
  await waitForTitle(sandbox, computer, context, (title) => {
    const json = title.replace(/ - Chromium$/, "");
    if (!json.startsWith("{")) return false;
    state = JSON.parse(json) as PageState;
    return matches(state);
  });
  return state!;
}

describe.skipIf(process.env.RUN_COMPUTER_REPLAY_DOCKER !== "1")(
  "computer desktop with real Docker Chrome",
  () => {
    it("takes screenshots and clicks, types, scrolls and uploads through the file chooser", async () => {
      await withDockerComputer("desktop", async ({ sandbox, computer, context }) => {
        const encode = (text: string) => new TextEncoder().encode(text);
        await sandbox.writeFile(
          computer,
          { path: "Downloads/upload.txt", content: encode(UPLOAD) },
          context,
        );
        await sandbox.writeFile(
          computer,
          { path: ".desktop-fixture/index.html", content: encode(PAGE) },
          context,
        );
        await run(
          sandbox,
          computer,
          context,
          "cd ~/.desktop-fixture && setsid -f python3 -m http.server 8766 --bind 127.0.0.1 >/dev/null 2>&1 </dev/null; " +
            "for i in $(seq 1 40); do python3 -c 'import urllib.request; urllib.request.urlopen(\"" +
            FIXTURE_URL +
            "\", timeout=1)' 2>/dev/null && exit 0; sleep 0.25; done; exit 1",
        );

        const first = await sandbox.observe(computer, context);
        expect([first.width, first.height, first.mimeType]).toEqual([1280, 800, "image/png"]);
        // Preparing the desktop starts the bot's Chromium. A launch that lands before its window
        // maps starts a second Chromium on the same profile, which drops the URL.
        await waitForTitle(sandbox, computer, context, (title) => title.endsWith("Chromium"));

        await sandbox.act(
          computer,
          { actions: [{ kind: "launch", application: "chromium", uri: FIXTURE_URL }] },
          context,
        );
        const page = await waitForPage(sandbox, computer, context, (state) => state.w > 0);
        // Maximized Chromium covers the whole screen at the origin, so bots keep 1280x800.
        expect([page.w, page.h, page.x, page.y]).toEqual([1280, 800, 0, 0]);
        const at = (x: number, y: number) => ({ x: page.x + x, y: page.y + page.top + y });

        await sandbox.act(
          computer,
          {
            actions: [
              { kind: "pointer", type: "click", ...at(250, 116) },
              { kind: "clipboard", text: "typed by bot" },
            ],
          },
          context,
        );
        expect(
          (await waitForPage(sandbox, computer, context, (state) => state.typed !== "")).typed,
        ).toBe("typed by bot");

        await sandbox.act(
          computer,
          {
            actions: [
              { kind: "pointer", type: "move", ...at(250, 300) },
              { kind: "scroll", direction: "down", amount: 5 },
            ],
          },
          context,
        );
        expect(
          (await waitForPage(sandbox, computer, context, (state) => state.scrolled)).scrolled,
        ).toBe(true);

        await sandbox.act(
          computer,
          { actions: [{ kind: "pointer", type: "click", ...at(140, 462) }] },
          context,
        );
        // The xdg-desktop-portal file chooser takes focus away from Chromium.
        await waitForTitle(
          sandbox,
          computer,
          context,
          (title) => title !== "" && !title.endsWith("Chromium"),
        );
        await sandbox.act(
          computer,
          {
            actions: [
              // GTK drops keys typed while the location field opens or its autocompletion updates.
              { kind: "key", key: "l", modifiers: ["ctrl"] },
              { kind: "wait", ms: 750 },
              { kind: "clipboard", text: "/home/cortexai-agent-hub/Downloads/upload.txt" },
              { kind: "wait", ms: 750 },
              { kind: "key", key: "Return" },
            ],
            settleMs: 300,
          },
          context,
        );
        expect(
          (await waitForPage(sandbox, computer, context, (state) => state.file !== "")).file,
        ).toBe(`upload.txt:${UPLOAD.length}`);

        const last = await sandbox.observe(computer, context);
        expect(last.image.byteLength).toBeGreaterThan(10_000);
      });
    }, 300_000);
  },
);
