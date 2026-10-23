// @vitest-environment jsdom

import type { ScratchpadItem } from "@cortexai-agent-hub/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { scratchpad: api } }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@cortexai-agent-hub/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => <button type="button" {...props} />,
  Checkbox: ({
    onCheckedChange: _onCheckedChange,
    checked: _checked,
    ...props
  }: ComponentProps<"input"> & { onCheckedChange?: unknown }) => (
    <input type="checkbox" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { ScratchpadSection } from "./ScratchpadSection";

function fixtureItems(count: number, botId = "bot-fixture"): ScratchpadItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    botId,
    title: `Task ${index + 1}`,
    status: "open",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderWith(items: ScratchpadItem[], botId = "bot-fixture") {
  api.list.mockResolvedValue(items);
  await act(async () => root.render(<ScratchpadSection botId={botId} />));
}

function header() {
  const button = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  if (!button) throw new Error("Missing Open work header");
  return button;
}

const renderedTitles = () =>
  [...container.querySelectorAll('[data-testid="bot-scratchpad-item"]')].map(
    (row) => row.textContent,
  );

it("starts collapsed with the count when there are more than five items", async () => {
  await renderWith(fixtureItems(12));
  expect(header().textContent).toContain("Open work");
  expect(header().textContent).toContain("12");
  expect(header().getAttribute("aria-expanded")).toBe("false");
  expect(renderedTitles()).toEqual([]);
  expect(container.querySelector('input[aria-label="New open-work item"]')).toBeNull();
});

it("starts expanded when there are five or fewer items", async () => {
  await renderWith(fixtureItems(5));
  expect(header().getAttribute("aria-expanded")).toBe("true");
  expect(header().textContent).toContain("5");
  expect(renderedTitles()).toHaveLength(5);
  const list = container.querySelector(`#${header().getAttribute("aria-controls")}`);
  expect(list).not.toBeNull();
});

it("hides the entire empty section", async () => {
  await renderWith([]);
  expect(container.querySelector('[data-testid="bot-scratchpad"]')).toBeNull();
});

it("renders work without status chrome, adds from the heading and removes an item", async () => {
  const [item] = fixtureItems(1);
  const parked = { ...item!, status: "parked" as const, notes: "Compare both themes" };
  api.remove.mockResolvedValue({ ok: true });
  api.list.mockResolvedValueOnce([parked]).mockResolvedValueOnce([]);
  await act(async () => root.render(<ScratchpadSection botId="bot-fixture" />));
  expect(container.textContent).toContain("Compare both themes");
  expect(container.textContent).not.toContain("parked");
  expect(container.querySelector('[aria-label="Park"]')).toBeNull();
  expect(container.querySelector('input[aria-label="New open-work item"]')).toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Add open work"]')!.click(),
  );
  expect(container.querySelector('input[aria-label="New open-work item"]')).not.toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!.click(),
  );
  expect(api.remove).toHaveBeenCalledWith({ itemId: parked.id });
  expect(renderedTitles()).toEqual([]);
});

it("expands a collapsed list when adding from the heading", async () => {
  await renderWith(fixtureItems(12));
  expect(header().getAttribute("aria-expanded")).toBe("false");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Add open work"]')!.click(),
  );
  expect(header().getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector('input[aria-label="New open-work item"]')).not.toBeNull();
});

it("toggles from the header and caps the expanded list so later settings stay reachable", async () => {
  await renderWith(fixtureItems(12));
  await act(async () => header().click());
  expect(header().getAttribute("aria-expanded")).toBe("true");
  expect(renderedTitles()).toHaveLength(12);
  const list = container.querySelector<HTMLElement>('[data-testid="bot-scratchpad-list"]');
  expect(list?.className).toContain("overflow-y-auto");
  expect(list?.className).toMatch(/max-h-/);
  await act(async () => header().click());
  expect(header().getAttribute("aria-expanded")).toBe("false");
  expect(renderedTitles()).toEqual([]);
});

it("remembers the chosen state for the bot across remounts", async () => {
  await renderWith(fixtureItems(12));
  await act(async () => header().click());
  await act(async () => root.unmount());
  root = createRoot(container);
  await renderWith(fixtureItems(12));
  expect(header().getAttribute("aria-expanded")).toBe("true");

  await act(async () => header().click());
  await act(async () => root.unmount());
  root = createRoot(container);
  await renderWith(fixtureItems(2));
  expect(header().getAttribute("aria-expanded")).toBe("false");
});

it("keeps each bot's default when another bot was toggled", async () => {
  await renderWith(fixtureItems(12, "bot-a"), "bot-a");
  await act(async () => header().click());
  await renderWith(fixtureItems(12, "bot-b"), "bot-b");
  expect(header().getAttribute("aria-expanded")).toBe("false");
});
