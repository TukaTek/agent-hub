# CAAH-72: Office Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots and users can exchange `.xlsx`, `.docx`, `.pptx`, `.xls`, `.doc`, `.ppt` and `.zip` files in chat. Failed attaches never leave dead workspace links. Bots can build valid Office files on their computer.

**Architecture:** The allow-list stays in `@cortexai-agent-hub/contracts` as the single source of MIME types. `@cortexai-agent-hub/core` keeps the extension map, with a test that holds the two in step, and switches inference to extension-first. Downloads already happen client-side: web builds a Blob with `a.download`, mobile uses the share sheet, and nothing is served over an HTTP file route. Office types therefore stay download-only through the existing card, and the API adds `nosniff`. Dead links are handled on two layers. Runtime policy and `attach_file` error text tell the bot what to do, and web chat markdown renders unsafe or relative links as plain text. The computer image gets pinned, hash-checked `openpyxl`, `python-docx` and `python-pptx`, plus an image smoke test that CI runs.

**Tech Stack:** TypeScript (contracts, core, adapters, Hono API, React web, Expo mobile), Vitest, Playwright, the Debian computer image (Python 3.11 and `uv`), and GitHub Actions.

## Global Constraints

- One source of truth: MIME types live only in `packages/contracts/src/attachments.ts`. Extensions live only in `packages/core/src/attachments.ts`, and a test enforces that both lists match.
- New types: `.xlsx`, `.docx`, `.pptx`, `.xls`, `.doc`, `.ppt`, `.zip`. Macro-enabled and auto-run types stay out: `.xlsm`, `.docm`, `.pptm`, `.xlsb`, `.ppsx`/`.ppsm`, and the `.xltm`/`.dotm`/`.potm` templates.
- Office and zip files download as files and never render inline or in a preview on any surface.
- Tests are deterministic and offline. The image smoke test runs with `--network none`.
- Keep UI copy minimal. The only proposed new visible copy is the upload skip reason in Task 2, quoted there and justified in the PR.
- Public repo: no private paths, hostnames or real data in fixtures. Fixture files are generated or tiny.
- Do not run the desktop Playwright suite locally. CI runs it.

---

## What I found

1. **The allow-list is narrow, with no documented reason.** `ATTACHMENT_FILE_MIME_TYPES` holds only pdf, txt, md, csv, html and json. It gates user uploads (`artifacts.ts` → `validateAttachmentMimeType`), the bot's `attach_file` (`executor.ts:2690` and `thread-artifacts.ts:53`), and the web picker's `accept` (`Shell.tsx:312`). The commit that introduced it ("Allow attaching photos and files in chat") gives no reason, and I found no security argument for leaving out Office formats.
2. **There is no HTTP download route.** `artifacts.get` returns base64 inside the oRPC JSON response.
   - On web, `ArtifactFileCard` fetches the bytes and calls `downloadArtifactBytes`, which uses a Blob and `<a download>`. Non-previewable types never reach an iframe or object URL navigation.
   - Mobile writes a cache file named by `attachmentExtensionForMimeType` and opens the share sheet.
   - "Content-Disposition: attachment" therefore has no HTTP endpoint to apply to. The equivalent guarantees are that Office types (a) are not in `PREVIEWABLE_MIME_TYPES` and (b) always go through `<a download>` or the share sheet.
   - The API sends no `X-Content-Type-Options` header today. Only Electron's bundled renderer does.
3. **Inference prefers the browser-reported type.** `inferAttachmentMimeType` returns the reported MIME whenever it is on the allow-list. Windows reports `.csv` as `application/vnd.ms-excel`. Once `.xls` is allowed, a Windows CSV would therefore be stored as an Excel file, which is a regression. Windows also reports `.zip` as `application/x-zip-compressed`. Inference must switch to extension-first.
4. **Dead links come from the web markdown.** `ChatMarkdown` passes every URL through `sanitizeMarkdownUrl(url, true)`.
   - A bare `pilot_sample/x.xlsx` is dropped to `""`, which renders `<a href="" target="_blank">`. Clicking it opens the app again in a new tab.
   - `./x.xlsx` and `/home/...` pass as "relative" and open app routes.
   - Native already renders only http(s), mailto and tel links.
   - The system prompt never tells the bot how to deliver files, and the `attach_file` error is just `"unsupported attachment type"`.
5. **The image does not match the ticket.** `infra/sandboxes/computer/Dockerfile` has `python3` and `uv` but no LibreOffice, `openpyxl`, `python-docx` or `python-pptx`. The ticket says `soffice` was present on the deployment, so that deployment probably used a custom or overridden image (`CORTEXAI_AGENT_HUB_COMPUTER_IMAGE`). The PR workflow already builds the computer image (`publish-server-image.yml` → `validate`), so a smoke step can run there.

## Decisions

**Dead links: policy plus UI hardening, without resolving workspace links into downloads.**

- *Runtime policy and tool error text (chosen).* Add one sentence to the workspace instruction, plus actionable `attach_file` errors that list the supported types and tell the bot to report the failure without linking the path. This fixes the cause on every surface: web, mobile, desktop, and messaging channels such as Slack and Teams, where a workspace link can never work.
- *Web renders unsafe or relative chat links as text (chosen, small).* A `<span>` replaces the dead `<a href="">`. This also makes web match native. It is defense-in-depth for when the model ignores the policy.
- *Resolving workspace links into downloads (rejected):*
  - `computer.downloadFile` only works while the computer is running ("binary transfer needs the live machine"). Links in history would break whenever the computer sleeps, or when the file moves or is deleted.
  - It bypasses the artifact record, so the file gets no Artifacts tab entry, no versioning and no mobile path. It does nothing for messaging channels.
  - It turns model-authored text into a file-read capability. On a Team Computer, a prompt-injected link could point at another bot's folder or browser profile state.

**Size and count caps: keep 10 MiB and 4 files in this ticket.**

- Typical bot-built xlsx and docx files are well under 1 MB, because OOXML is zip-compressed. Image-heavy pptx decks can go over 10 MiB, but the bots we are fixing generate text and table content.
- Raising the cap is not a one-constant change:
  - Artifacts travel as base64 in JSON, so 10 MiB is about 13.4 MB on the wire. That is already near `MAX_RPC_REQUEST_BYTES` (16 MiB), and the base64 validator comment in `core/src/attachments.ts` sizes its fix to this limit.
  - Mobile reads the whole file into memory.
- Recommendation: if decks hit the cap, add a streaming HTTP artifact route as a follow-up. That route would send `Content-Disposition: attachment` and `nosniff`. The bot already gets a clear error, `file exceeds the 10 MiB attachment limit`. Four files per message is enough for an xlsx, docx and pptx together.

**Security.**

- OOXML `.xlsx`, `.docx` and `.pptx` cannot run macros. Office refuses VBA in those extensions, and the macro-enabled variants stay off the list.
- Legacy `.xls`, `.doc` and `.ppt` *can* carry VBA. The ticket asks for them as interchange formats, so this plan includes them. Mitigations:
  - They are never previewed.
  - They download only as files.
  - The files come from the user's own bot or the user. Office opens downloaded files in Protected View.
  - Open question 1 offers to drop them.
- The server never opens `.zip` files. When a user uploads a zip, it is copied into the bot's sandboxed workspace (`attachments/<id>.zip`). Any extraction, zip bomb or zip-slip effect stays inside the sandbox. A zip can wrap macro files, but so can any download. The product never extracts it on the host or in the browser.
- No magic-byte sniffing. Content is never rendered, so a mislabeled file is harmless. YAGNI.
- New `X-Content-Type-Options: nosniff` on all API responses: one middleware line, covered by a test.

**Valid Office files: Python libraries in the image, not LibreOffice.**

- Install `openpyxl`, `python-docx` and `python-pptx` as pinned, hash-checked wheels (`uv pip install --system --break-system-packages --require-hashes`). This follows the Dockerfile's existing pin-and-sha256 discipline. Bookworm's apt `python3-docx` is old, and I could not confirm an apt `python3-pptx`.
- LibreOffice would add hundreds of MB to every computer, and these libraries cover authoring.
- One sentence in the Docker-computer instruction tells the bot to use the libraries, never hand-write OOXML, and reopen the file before attaching.

---

## File map

| File | Change |
|---|---|
| `packages/contracts/src/attachments.ts` | Add `ATTACHMENT_OFFICE_MIME_TYPES` and the zip type to the file list |
| `packages/contracts/src/attachments.test.ts` | Allow-list membership, plus macro types stay out |
| `packages/core/src/attachments.ts` | Extension map, extension-first inference, `ATTACHMENT_ACCEPT`, `supportedAttachmentExtensions()` |
| `packages/core/src/attachments.test.ts` | Mappings, round trip, consistency, CSV and zip regressions |
| `apps/web/src/pages/Shell.tsx` | `accept` from core, plus a skip reason for unsupported types |
| `apps/web/src/locales/*/messages.po`, `apps/web/scripts/translations-*.json` | One new string |
| `apps/web/src/components/ArtifactFileCard.test.tsx` (new) | Office types are download-only and use `<a download>` |
| `apps/api/src/app.ts` | `nosniff` middleware |
| `apps/api/src/security-headers.test.ts` (new) | Header present on `/rpc/*` and `/api/*` |
| `packages/adapters/src/executor.ts` | `attach_file` error text and the workspace delivery sentence |
| `packages/adapters/src/attach-file-errors.ts` (new, small) | `unsupportedAttachmentError(path)`, unit-testable |
| `packages/adapters/src/attach-file-errors.test.ts` (new) | Error text |
| `packages/adapters/src/thread-artifacts.ts` | Reuse the same error |
| `packages/chat-ui/src/markdown.ts`, `markdown.web.tsx` | Unsafe or relative links render as text |
| `packages/chat-ui/src/markdown.test.ts`, `markdown.linkified.test.tsx` | Link tests |
| `infra/sandboxes/computer/office-requirements.txt` (new) | Pinned and hashed |
| `infra/sandboxes/computer/office_smoke.py` (new) | Builds and reopens xlsx, docx and pptx |
| `infra/sandboxes/computer/Dockerfile` | Install the libraries, copy the smoke script |
| `.github/workflows/publish-server-image.yml` | Run the smoke test in the computer `validate` job |
| `apps/web/e2e/artifact-preview.spec.ts`, `apps/web/e2e/office-attachments.spec.ts` (new) | Bot attach and user upload of Office files |
| `docs/computer-runtime.md` | One line: Office libraries are available |

---

### Task 1: Shared allow-list and extension-first inference

**Files:**
- Modify: `packages/contracts/src/attachments.ts`, `packages/core/src/attachments.ts`
- Test: `packages/contracts/src/attachments.test.ts`, `packages/core/src/attachments.test.ts`

**Interfaces:**
- Produces:
  - `ATTACHMENT_OFFICE_MIME_TYPES` (contracts)
  - `ATTACHMENT_ACCEPT: string`, the comma-joined MIME types and extensions (core)
  - `supportedAttachmentExtensions(): string[]` (core)
  - `inferAttachmentMimeType(name, reportedType?)`, unchanged signature but now extension-first

- [ ] **Step 1: Write the failing tests** (core)

```ts
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

it("maps Office and zip extensions", () => {
  expect(inferAttachmentMimeType("Report.XLSX")).toBe(XLSX);
  expect(inferAttachmentMimeType("brief.docx")).toBe(DOCX);
  expect(inferAttachmentMimeType("deck.pptx")).toBe(PPTX);
  expect(inferAttachmentMimeType("old.xls")).toBe("application/vnd.ms-excel");
  expect(inferAttachmentMimeType("old.doc")).toBe("application/msword");
  expect(inferAttachmentMimeType("old.ppt")).toBe("application/vnd.ms-powerpoint");
  expect(inferAttachmentMimeType("bundle.zip")).toBe("application/zip");
});

it("keeps macro-enabled Office files out", () => {
  for (const name of ["m.xlsm", "m.docm", "m.pptm", "m.xlsb", "s.ppsx", "s.ppsm"]) {
    expect(inferAttachmentMimeType(name)).toBeNull();
  }
});

it("trusts a known extension over the browser-reported type", () => {
  // Windows reports .csv as Excel and .zip as x-zip-compressed.
  expect(inferAttachmentMimeType("data.csv", "application/vnd.ms-excel")).toBe("text/csv");
  expect(inferAttachmentMimeType("b.zip", "application/x-zip-compressed")).toBe("application/zip");
  expect(inferAttachmentMimeType("notes.md", "text/plain")).toBe("text/markdown");
  expect(inferAttachmentMimeType("a.xlsx", "application/octet-stream")).toBe(XLSX);
});

it("falls back to an allowed reported type when the extension is unknown", () => {
  expect(inferAttachmentMimeType("scan", "application/pdf")).toBe("application/pdf");
  expect(inferAttachmentMimeType("scan", "application/vnd.ms-excel.sheet.macroEnabled.12")).toBeNull();
});

it("gives every allowed type an extension that round-trips", () => {
  for (const mime of ATTACHMENT_ALLOWED_MIME_TYPES) {
    const ext = attachmentExtensionForMimeType(mime);
    expect(ext).toMatch(/^\.[a-z]+$/);
    expect(inferAttachmentMimeType(`f${ext}`)).toBe(mime);
  }
  for (const ext of supportedAttachmentExtensions()) {
    expect(ATTACHMENT_ALLOWED_MIME_TYPES).toContain(inferAttachmentMimeType(`f${ext}`));
  }
});

it("lists types and extensions for file pickers", () => {
  expect(ATTACHMENT_ACCEPT.split(",")).toEqual(expect.arrayContaining([XLSX, ".xlsx", ".zip"]));
});
```

Replace the old cases `inferAttachmentMimeType("notes.md", "application/pdf")` → `application/pdf` and `archive.zip` → `null`. The first now returns `text/markdown`, and zip is allowed.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm vitest run packages/core/src/attachments.test.ts packages/contracts/src/attachments.test.ts`. Expected: FAIL, because the Office extensions map to `null`.

- [ ] **Step 3: Implement**

```ts
// contracts/src/attachments.ts
export const ATTACHMENT_OFFICE_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/msword",
  "application/vnd.ms-powerpoint",
] as const;

export const ATTACHMENT_FILE_MIME_TYPES = [
  "application/pdf", "text/plain", "text/markdown", "text/csv", "text/html", "application/json",
  ...ATTACHMENT_OFFICE_MIME_TYPES,
  "application/zip",
] as const;
```

```ts
// core/src/attachments.ts: add to EXTENSION_MIME_TYPES and MIME_TYPE_EXTENSIONS.
// MIME_TYPE_EXTENSIONS is Record<AttachmentMimeType, string>, so the compiler rejects a missing entry.
".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
".xls": "application/vnd.ms-excel",
".doc": "application/msword",
".ppt": "application/vnd.ms-powerpoint",
".zip": "application/zip",

export function inferAttachmentMimeType(name: string, reportedType?: string): AttachmentMimeType | null {
  const dot = name.lastIndexOf(".");
  const extensionType = dot < 0 ? undefined : EXTENSION_MIME_TYPES[name.slice(dot).toLowerCase()];
  // Pickers mislabel common files (Windows reports .csv as Excel), so a known extension wins.
  if (extensionType) return extensionType;
  return reportedType && isAllowedAttachmentMimeType(reportedType) ? reportedType : null;
}

export function supportedAttachmentExtensions(): string[] {
  return Object.keys(EXTENSION_MIME_TYPES);
}

export const ATTACHMENT_ACCEPT = [...ATTACHMENT_ALLOWED_MIME_TYPES, ...Object.keys(EXTENSION_MIME_TYPES)].join(",");
```

- [ ] **Step 4: Run the tests, then the dependent suites.** Run `pnpm vitest run packages/core packages/contracts packages/adapters/src/bot-secrets.test.ts apps/mobile/lib`. Expected: PASS. `bot-secrets.ts:103` uses inference to pick download names, so check that its suite still passes.
- [ ] **Step 5: Commit** with `Allow Office and zip attachments with extension-first type inference (CAAH-72)`.

### Task 2: Upload surfaces (web and mobile)

**Files:**
- Modify: `apps/web/src/pages/Shell.tsx:312,2020-2023`, the web locale catalogs
- Test: the existing web e2e (Task 7). `apps/mobile/lib/pick-attachments.test.ts` covers mobile.

**Interfaces:** Consumes `ATTACHMENT_ACCEPT` and `inferAttachmentMimeType` from Task 1.

- [ ] **Step 1: Write the failing mobile test** in `apps/mobile/lib/pick-attachments.test.ts`. Run `filterPickedAttachments` with `report.xlsx` (reported `""`), `deck.pptx`, `bundle.zip` (reported `application/x-zip-compressed`) and `macro.xlsm`. Expect the first three to be accepted with Office or zip MIME types, and `macro.xlsm` to be skipped with reason `"unsupported type"`.
- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run apps/mobile/lib/pick-attachments.test.ts`.
- [ ] **Step 3: Implement.** Mobile needs no code change beyond Task 1; the test should already pass after rebasing on Task 1. On web:
  - Replace the local `ATTACHMENT_ACCEPT` with the core export. Windows pickers then offer `.xlsx` even when the OS MIME map differs.
  - Change the unsupported-type skip from `skipped.push(file.name)` to ``skipped.push(t`${file.name} (unsupported type)`)``.
  - Run `pnpm --filter @cortexai-agent-hub/web intl:extract` and add translations to the existing catalogs and `apps/web/scripts/translations-*.json`.
- [ ] **Step 4: Run** `pnpm vitest run apps/mobile/lib apps/web/src/lib`. Expected: PASS.
- [ ] **Step 5: Commit** with `Offer Office and zip files in the upload pickers (CAAH-72)`.

New visible copy: **"(unsupported type)"**, appended to the existing "Skipped report.xlsm" notice. Today an unsupported file is skipped with only its name shown, while the size case already says "(over 10 MiB)". The acceptance criteria ask for a clear message. Mobile already shows exactly this reason, and the text appears only when a file is rejected.

### Task 3: Download safety (download-only cards and `nosniff`)

**Files:**
- Create: `apps/web/src/components/ArtifactFileCard.test.tsx`, `apps/api/src/security-headers.test.ts`
- Modify: `apps/api/src/app.ts:528`

- [ ] **Step 1: Write the failing tests**

```tsx
// ArtifactFileCard.test.tsx (jsdom; mock ../lib/artifact-open)
it.each([XLSX, DOCX, PPTX, "application/vnd.ms-excel", "application/zip"])(
  "renders %s as a download-only card", async (mimeType) => {
    render(<ArtifactFileCard target={{ botId: "b" }} artifactId="a" name="f" mimeType={mimeType} size={10} />);
    expect(screen.queryByRole("button", { name: /Preview/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /f/ }));
    expect(downloadArtifact).toHaveBeenCalledWith({ botId: "b" }, "a", "f", mimeType);
  },
);
```

```ts
// artifact-open test: downloadArtifactBytes sets anchor.download and never navigates.
it("downloads through an anchor with a download name", () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  downloadArtifactBytes("r.xlsx", XLSX, new Uint8Array([80, 75]));
  const anchor = click.mock.contexts[0] as HTMLAnchorElement;
  expect(anchor.download).toBe("r.xlsx");
  expect(anchor.href).toMatch(/^blob:/);
});
```

```ts
// security-headers.test.ts: build a Hono app with the exported middleware
const app = new Hono().use("*", noSniff).get("/rpc/x", (c) => c.json({}));
it("forbids MIME sniffing on API responses", async () => {
  const res = await app.request("/rpc/x");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});
```

- [ ] **Step 2: Run them and confirm they fail.** The `nosniff` test fails. The card tests should pass already, which documents the guarantee. If they fail, fix the card.
- [ ] **Step 3: Implement.** In `app.ts`, add the following and register it next to `requestLogging`:

```ts
export const noSniff: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
};
```
- [ ] **Step 4: Run** `pnpm vitest run apps/api/src/security-headers.test.ts apps/web/src/components`. Expected: PASS.
- [ ] **Step 5: Commit** with `Keep Office artifacts download-only and send nosniff from the API (CAAH-72)`.

### Task 4: `attach_file` failures steer the bot

**Files:**
- Create: `packages/adapters/src/attach-file-errors.ts`, `attach-file-errors.test.ts`
- Modify: `packages/adapters/src/executor.ts:1737-1740,2691`, `packages/adapters/src/thread-artifacts.ts:54`, and the `attach_file` description in `builtin-tools.ts:268`

**Interfaces:** Produces `unsupportedAttachmentError(path: string): string` and `ATTACH_FAILURE_GUIDANCE: string`.

- [ ] **Step 1: Write the failing test**

```ts
it("names the type, lists what works, and forbids path links", () => {
  const message = unsupportedAttachmentError("out/macro.xlsm");
  expect(message).toContain('".xlsm"');
  expect(message).toContain(".xlsx");
  expect(message).toContain(".zip");
  expect(message).toMatch(/do not link the workspace path/i);
});
```

Also add an executor-level test. Use the existing `bot-secrets.test.ts` harness pattern: `attach_file` on `downloads/x.xlsm`. Assert that the tool result `error` equals `unsupportedAttachmentError("downloads/x.xlsm")`, and that `attach_file` on a `.xlsx` publishes a `file` block with the XLSX MIME type.

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**

```ts
import { supportedAttachmentExtensions } from "@cortexai-agent-hub/core";
import path from "node:path";

export const ATTACH_FAILURE_GUIDANCE =
  "Tell the user plainly that the file could not be attached; do not link the workspace path.";

export function unsupportedAttachmentError(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase() || "(none)";
  return `unsupported attachment type "${ext}". Supported: ${supportedAttachmentExtensions().join(" ")}. ${ATTACH_FAILURE_GUIDANCE}`;
}
```

In `executor.ts`:
- Use `failAttach(unsupportedAttachmentError(filePath))` for unsupported types.
- Append `ATTACH_FAILURE_GUIDANCE` to the too-large, missing-file and generic attach errors.
- Append to both branches of `workspaceInstruction`: `"Workspace paths are not links the user can open: share files with attach_file."`
- Add `Office documents (.xlsx, .docx, .pptx), zip` to the `attach_file` description.

`thread-artifacts.ts` throws `new Error(unsupportedAttachmentError(fileName))`.

- [ ] **Step 4: Run** `pnpm vitest run packages/adapters packages/testkit/src/attachments.test.ts packages/testkit/src/bot-secrets.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with `Tell bots to report failed attachments instead of linking workspace paths (CAAH-72)`.

### Task 5: Web chat stops rendering dead links

**Files:**
- Modify: `packages/chat-ui/src/markdown.web.tsx`
- Test: `packages/chat-ui/src/markdown.linkified.test.tsx`, plus a new web render case

- [ ] **Step 1: Write the failing test**

```tsx
it("renders workspace paths as text, not dead links", () => {
  render(<ChatMarkdown>{"[report](pilot_sample_2026-10-01/report.xlsx) [r](./r.xlsx) [ok](https://example.com)"}</ChatMarkdown>);
  expect(screen.queryByRole("link", { name: "report" })).toBeNull();
  expect(screen.getByText("report")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "r" })).toBeNull();
  expect(screen.getByRole("link", { name: "ok" })).toHaveAttribute("href", "https://example.com");
});
```

- [ ] **Step 2: Run it and confirm it fails.** Currently `report` is a link with `href=""`.
- [ ] **Step 3: Implement.** Use `sanitizeMarkdownUrl(url)` (http, https, mailto and tel only, the same rule as native), and keep in-page `#` anchors. In the `a` component, return `<span>{children}</span>` when `href` is empty. Open question 3 covers whether anything relies on relative links.
- [ ] **Step 4: Run** `pnpm vitest run packages/chat-ui`. Expected: PASS.
- [ ] **Step 5: Commit** with `Render non-web links in chat as text instead of dead anchors (CAAH-72)`.

### Task 6: The computer image builds valid Office files

**Files:**
- Create: `infra/sandboxes/computer/office-requirements.txt`, `infra/sandboxes/computer/office_smoke.py`
- Modify: `infra/sandboxes/computer/Dockerfile`, `.github/workflows/publish-server-image.yml` (the `validate` job), `packages/adapters/src/executor.ts` (`dockerComputerToolInstruction`), `docs/computer-runtime.md`

- [ ] **Step 1: Write the smoke test first** (`office_smoke.py`, stdlib `unittest`):

```python
"""Builds Office files with the image's libraries and re-opens them offline."""
import tempfile, unittest, zipfile
from pathlib import Path
import openpyxl, docx, pptx

class OfficeSmoke(unittest.TestCase):
    def test_xlsx_with_filter_and_merged_cells_reopens(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "pilot.xlsx")
            wb = openpyxl.Workbook(); ws = wb.active
            ws.append(["Region", "Units"]); ws.append(["North", 3]); ws.append(["South", 5])
            ws.auto_filter.ref = "A1:B3"
            ws.merge_cells("D1:E1"); ws["D1"] = "Summary"
            ws["D2"].hyperlink = "https://example.com"
            wb.save(path)
            reopened = openpyxl.load_workbook(path)
            self.assertEqual(reopened.active.auto_filter.ref, "A1:B3")
            self.assertIn("D1:E1", [str(r) for r in reopened.active.merged_cells.ranges])
            sheet = zipfile.ZipFile(path).read("xl/worksheets/sheet1.xml").decode()
            # CT_Worksheet order: sheetData < autoFilter < mergeCells < hyperlinks.
            self.assertLess(sheet.index("<autoFilter"), sheet.index("<mergeCells"))
            self.assertLess(sheet.index("<mergeCells"), sheet.index("<hyperlinks"))

    def test_docx_reopens(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "brief.docx")
            d = docx.Document(); d.add_heading("Brief", 1); d.add_paragraph("Body"); d.save(path)
            self.assertEqual(docx.Document(path).paragraphs[0].text, "Brief")

    def test_pptx_reopens(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "deck.pptx")
            p = pptx.Presentation(); s = p.slides.add_slide(p.slide_layouts[0])
            s.shapes.title.text = "Deck"; p.save(path)
            self.assertEqual(pptx.Presentation(path).slides[0].shapes.title.text, "Deck")

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Confirm it fails against the current image.** Run `pnpm sandbox:build && docker run --rm --network none -v "$PWD/infra/sandboxes/computer/office_smoke.py:/tmp/s.py:ro" cortexai-agent-hub/computer:local python3 /tmp/s.py`. Expected: `ModuleNotFoundError: No module named 'openpyxl'`.
- [ ] **Step 3: Implement.**
  - Generate `office-requirements.txt` with `uv pip compile --generate-hashes --python-version 3.11 --python-platform linux` from `openpyxl`, `python-docx` and `python-pptx`, pinned to current releases. It must include binary wheels for amd64 and arm64 (lxml, Pillow).
  - In the Dockerfile, after the `uv` stage:
    ```dockerfile
    COPY --chmod=644 office-requirements.txt /tmp/office-requirements.txt
    RUN uv pip install --system --break-system-packages --require-hashes --no-cache -r /tmp/office-requirements.txt \
      && rm /tmp/office-requirements.txt
    COPY --chmod=644 office_smoke.py /usr/local/share/cortexai-agent-hub/office_smoke.py
    ```
  - In the workflow's `validate` job, set `load: ${{ matrix.name == 'computer' }}` and add a step:
    ```yaml
    - if: matrix.name == 'computer'
      run: docker run --rm --network none "${{ steps.meta.outputs.tags }}" python3 /usr/local/share/cortexai-agent-hub/office_smoke.py
    ```
  - Append to `dockerComputerToolInstruction`: `"Python has openpyxl, python-docx and python-pptx: build .xlsx/.docx/.pptx with them, never by hand-writing XML, and reopen the file to check it before attach_file."` Update the adapters test that pins this string, if one exists.
  - Add a line to `docs/computer-runtime.md`.
- [ ] **Step 4: Rebuild and rerun Step 2.** Expected: `OK (3 tests)`. Check the image size difference, which should be about 30 MB or less.
- [ ] **Step 5: Commit** with `Ship Office libraries and an Office smoke test in the computer image (CAAH-72)`.

### Task 7: End-to-end coverage

**Files:**
- Create: `apps/web/e2e/office-attachments.spec.ts`
- Modify: possibly `packages/adapters/src/scripted-runtime.ts`, if a prompt shape needs to be added

The scripted runtime's `write_file` is UTF-8 only, so the Playwright test proves type acceptance, the card and the download path. Workbook validity is proven by Task 6.

- [ ] **Step 1: Write the spec**
  - For each of `report.xlsx`, `brief.docx`, `deck.pptx`, send `write path notes/<name> and attach it to the thread says hi`. Expect a card button named `/<name> application\/vnd\.openxmlformats/`, with no Preview button. Click it, wait for the `download` event, and assert `suggestedFilename()`. Capture a screenshot for the PR.
  - Upload `report.xlsx`, `brief.docx`, `deck.pptx` and `bundle.zip` through `page.setInputFiles` on the composer file input, using tiny in-memory buffers. Send, and expect four file cards in the user bubble.
  - Upload `macro.xlsm`. Expect the notice `Skipped macro.xlsm (unsupported type)` and no link in the thread.
- [ ] **Step 2: Run it and confirm it fails before Tasks 1 and 2.** Run `pnpm --filter @cortexai-agent-hub/web exec playwright test e2e/office-attachments.spec.ts` (harness: `pnpm test:e2e`). If this cloud VM can run it, it is effectively run against main to show the failure first.
- [ ] **Step 3: Make it pass.** No new product code is expected. Adjust only the selectors.
- [ ] **Step 4: Run the spec and `artifact-preview.spec.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** with `Cover Office attachments in web e2e (CAAH-72)`.

---

## Verification before calling it done

- `pnpm lint`, `pnpm check` (turbo typecheck) and `pnpm test` all green locally.
- The Task 7 web Playwright specs pass locally or in this VM. The desktop Electron e2e is left to CI, per AGENTS.md.
- The `publish-server-image` `validate` job passes on the PR, including the Office smoke step.
- Manual acceptance in this VM where possible: a bot builds an xlsx (with a filter and merged cells), a docx and a pptx on the Docker computer, then attaches each. Download them, then reopen each with the same libraries and with `unzip -t`. The PR links the CI E2E screenshots of the Office cards.
- The PR stays a draft. It quotes the one new string, "(unsupported type)", and the follow-up offer for a streaming download route.

## Risks and open questions for the PM

1. **Legacy `.xls`, `.doc` and `.ppt` can carry VBA macros.** They are included because the ticket asks for them, with the mitigations above. Approve, or drop them and keep only OOXML and zip?
2. **The deployment and the repo image differ.** The repo's computer image has no `soffice`. Is the affected deployment on a custom or overridden image? If so, it will not get the libraries until it moves to the published image or adds them itself. I propose *not* adding LibreOffice, because of its size.
3. **Relative links in chat markdown.** `allowRelative` came from an early large commit with no stated reason. Nothing I found depends on `/` or `./` links in bot messages or Markdown previews. Plan: keep `#` anchors and render the rest as text. Flag if an in-app link pattern relies on them.
4. **"Content-Disposition" requirement.** There is no HTTP artifact route to set it on. The plan meets the intent through download-only cards, `<a download>`, the mobile share sheet and API-wide `nosniff`. A streaming route that sends `Content-Disposition` is the recommended follow-up if the 10 MiB cap becomes a problem. Confirm this is acceptable.
5. **Electron downloads.** There is no `will-download` handler, so Electron's default save dialog handles Blob downloads. CI's desktop e2e confirms nothing regressed. I will not add a handler unless CI shows a problem.
6. **Extension-first inference** changes one existing test expectation (`notes.md` reported as PDF now stays Markdown). Browsers derive `file.type` from the extension anyway, so I expect no user-visible change.
7. **Wheel pins** need refreshing over time, like the existing `uv` and `gh` pins. The workflow fails closed on a hash mismatch.
