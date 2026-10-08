// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const skills = vi.hoisted(() => ({
  updateDraft: vi.fn(),
  save: vi.fn(),
  testRun: vi.fn(),
  get: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { skills } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@cortexai-agent-hub/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: ({ htmlFor, children }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { SkillDraftCard } from "./SkillDraftCard";

const V1 = "2026-10-01T00:00:00.000Z";
const V2 = "2026-10-01T00:00:01.000Z";
const V3 = "2026-10-01T00:00:02.000Z";

const playbook = (steps: string[]) => ({
  whenToUse: "",
  inputs: [],
  steps,
  howToCheck: "",
  whatToReturn: "",
  approvalBoundaries: "",
  failureHandling: "",
});

function skill(updatedAt: string, steps: string[], status = "draft") {
  return {
    id: "skill-1",
    name: "Export",
    status,
    playbook: playbook(steps),
    updatedAt,
  };
}

function block(updatedAt?: string) {
  return {
    kind: "skill_draft" as const,
    skillId: "skill-1",
    name: "Export",
    goal: "Export weekly CRM list",
    playbook: playbook(['Type "Summer2026!".']),
    status: "draft" as const,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

async function render(updatedAt?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onRefresh = vi.fn(async () => {});
  await act(async () => {
    root.render(
      <SkillDraftCard block={block(updatedAt)} onRefresh={onRefresh} onAddRoutine={vi.fn()} />,
    );
  });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
  return { container, root, onRefresh, button };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(skills)) fn.mockReset();
  document.body.innerHTML = "";
});

it("sends the card's skill version with the edit and tracks the server's new version", async () => {
  skills.updateDraft.mockResolvedValue(skill(V2, ['Type "{{input:typed text 1}}".']));
  skills.save.mockResolvedValue(skill(V3, ['Type "{{input:typed text 1}}".'], "saved"));
  const { container, button, onRefresh, root } = await render(V1);
  await act(async () => button("Save").click());
  expect(skills.updateDraft).toHaveBeenCalledWith(
    expect.objectContaining({ skillId: "skill-1", expectedUpdatedAt: V1 }),
  );
  expect(onRefresh).toHaveBeenCalledTimes(1);
  // The card shows what the server kept, not the literal it sent.
  expect(container.querySelector<HTMLTextAreaElement>("#skill-draft-steps")?.value).toBe(
    'Type "{{input:typed text 1}}".',
  );
  skills.updateDraft.mockResolvedValue(skill("2026-10-01T00:00:03.000Z", ["x"]));
  await act(async () => button("Test").click());
  expect(skills.updateDraft).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedUpdatedAt: V3 }),
  );
  act(() => root.unmount());
});

it("reloads the draft and asks the user to review it when the server says it is stale", async () => {
  skills.updateDraft.mockRejectedValueOnce(
    Object.assign(new Error("stale"), { code: "CONFLICT", status: 409 }),
  );
  skills.get.mockResolvedValue(skill(V2, ['Type "{{input:typed text 1}}".']));
  // A card from an older build has no version at all.
  const { container, button, onRefresh, root } = await render(undefined);
  await act(async () => button("Save").click());
  expect(skills.updateDraft).toHaveBeenCalledWith(
    expect.objectContaining({ expectedUpdatedAt: undefined }),
  );
  expect(skills.save).not.toHaveBeenCalled();
  expect(onRefresh).not.toHaveBeenCalled();
  expect(skills.get).toHaveBeenCalledWith({ skillId: "skill-1" });
  expect(container.querySelector('[data-testid="skill-draft-stale"]')?.textContent).toBe(
    "This draft changed since you opened it. Review it and save again.",
  );
  expect(container.querySelector<HTMLTextAreaElement>("#skill-draft-steps")?.value).toBe(
    'Type "{{input:typed text 1}}".',
  );
  expect(container.textContent).not.toContain("Summer2026!");

  skills.updateDraft.mockResolvedValue(skill(V3, ['Type "{{input:typed text 1}}".']));
  skills.save.mockResolvedValue(skill(V3, ['Type "{{input:typed text 1}}".'], "saved"));
  await act(async () => button("Save").click());
  expect(skills.updateDraft).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedUpdatedAt: V2 }),
  );
  expect(container.querySelector('[data-testid="skill-draft-stale"]')).toBeNull();
  act(() => root.unmount());
});
