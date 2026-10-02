import { isNamedTeachKey } from "./teach-recording.js";

export type TeachRecordingEvent = {
  at: string;
  kind: "pointer" | "key" | "clipboard" | "snapshot" | "scroll";
  x?: number;
  y?: number;
  button?: string;
  type?: string;
  key?: string;
  text?: string;
  summary?: string;
  /** Protected input: the user typed this through the Protected input box. */
  sensitive?: boolean;
  /** Field metadata a client may report for the focused field. Never the field's value. */
  fieldType?: string;
  autocomplete?: string;
  fieldLabel?: string;
  /** Set only by an explicit user action that asks to keep this text in the skill. */
  keepLiteral?: boolean;
  /** The typed or pasted value was removed when the event was stored. */
  redacted?: boolean;
};

type TeachFieldInfo = Pick<
  TeachRecordingEvent,
  "sensitive" | "fieldType" | "autocomplete" | "fieldLabel"
>;

const SECRET_FIELD_LABEL =
  /\b(?:pass(?:word|code|phrase)?|pwd|pin|otp|one[- ]?time|2fa|mfa|totp|verification code|security code|secret|token|api[ _-]?key|cvv|cvc)\b/i;

function autocompleteTokens(event: TeachFieldInfo): string[] {
  return (event.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function isPasswordLikeField(event: TeachFieldInfo): boolean {
  if (event.fieldType?.toLowerCase() === "password") return true;
  if (
    autocompleteTokens(event).some(
      (token) => token.includes("password") || token === "one-time-code",
    )
  ) {
    return true;
  }
  return Boolean(event.fieldLabel && SECRET_FIELD_LABEL.test(event.fieldLabel));
}

/**
 * A field whose value must never be stored: Protected input, `type=password`, an
 * autocomplete of `*password*` or `one-time-code`, or a sensitive-looking label.
 */
export function isSecretTeachField(event: TeachFieldInfo): boolean {
  return event.sensitive === true || isPasswordLikeField(event);
}

function isTypedCharacter(key: string): boolean {
  return key.length === 1;
}

/**
 * What a recording may keep. Protected input loses its value exactly as before. Every other
 * typed character and paste loses its value too, unless the user explicitly asked to keep it
 * (`keepLiteral`) and the field is not a secret field. Named navigation keys are kept.
 */
export function sanitizeTeachRecordingEvent(event: TeachRecordingEvent): TeachRecordingEvent {
  if (event.kind !== "key" && event.kind !== "clipboard") return event;
  if (event.sensitive) {
    if (event.key === undefined && event.text === undefined && event.keepLiteral === undefined) {
      return event;
    }
    const sanitized = { ...event };
    delete sanitized.key;
    delete sanitized.text;
    delete sanitized.keepLiteral;
    return sanitized;
  }
  if (event.kind === "key" && event.key !== undefined && isNamedTeachKey(event.key)) return event;
  const value = event.kind === "key" ? event.key : event.text;
  if (value === undefined) return event;
  if (event.keepLiteral === true && !isPasswordLikeField(event)) return event;
  const sanitized = { ...event, redacted: true };
  delete sanitized.key;
  delete sanitized.text;
  delete sanitized.keepLiteral;
  return sanitized;
}

export type TeachSnapshot = {
  at: string;
  summary: string;
  hash?: string;
};

export type SkillPlaybook = {
  whenToUse: string;
  inputs: string[];
  steps: string[];
  howToCheck: string;
  whatToReturn: string;
  approvalBoundaries: string;
  failureHandling: string;
};

const DEFAULT_APPROVAL =
  "Do not send messages, spend money, publish content, or delete data without explicit user approval.";
const DEFAULT_FAILURE =
  "If a step fails or the expected screen is not visible, stop and ask the user before retrying.";

function describePointer(event: TeachRecordingEvent): string {
  const action = event.type ?? "click";
  const button = event.button ?? "left";
  if (action === "move") {
    return `Move pointer to (${event.x ?? 0}, ${event.y ?? 0}).`;
  }
  if (action === "down") {
    return `Press ${button} button at (${event.x ?? 0}, ${event.y ?? 0}).`;
  }
  if (action === "up") {
    return `Release ${button} button at (${event.x ?? 0}, ${event.y ?? 0}).`;
  }
  return `${action === "click" ? "Click" : action} ${button} button at (${event.x ?? 0}, ${event.y ?? 0}).`;
}

function describeScroll(event: TeachRecordingEvent): string {
  const direction = event.type === "up" ? "up" : "down";
  const amount = Number(event.text ?? 3);
  return Number.isFinite(amount) && amount > 1
    ? `Scroll ${direction} ${amount} times.`
    : `Scroll ${direction}.`;
}

const REDACTED_INPUT = "[redacted input]";
const PLACEHOLDER_LABEL_MAX = 40;

function redactLiteralText(text: string): string {
  const trimmed = text.trim();
  if (/password|secret|token|api[_-]?key/i.test(trimmed)) return REDACTED_INPUT;
  return trimmed;
}

function placeholderLabel(label: string | undefined): string | undefined {
  const cleaned = label
    ?.replace(/[{}"\\\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PLACEHOLDER_LABEL_MAX)
    .trim();
  return cleaned || undefined;
}

function secretPlaceholder(event: TeachFieldInfo): string {
  const fallback = autocompleteTokens(event).includes("one-time-code")
    ? "one-time code"
    : "password";
  return `{{secret:${placeholderLabel(event.fieldLabel) ?? fallback}}}`;
}

/** Is this event a typed value that the playbook may show literally? */
function literalKey(event: TeachRecordingEvent): string | undefined {
  if (event.keepLiteral !== true || event.redacted || !event.key) return undefined;
  return isTypedCharacter(event.key) ? event.key : undefined;
}

type TypedRun =
  | { kind: "literal"; text: string }
  | { kind: "input"; label: string | undefined }
  | { kind: "secret"; placeholder: string }
  | { kind: "protected" };

function sameRun(a: TypedRun, b: TypedRun): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "input" && b.kind === "input") return a.label === b.label;
  if (a.kind === "secret" && b.kind === "secret") return a.placeholder === b.placeholder;
  return true;
}

export function buildPlaybookFromRecording(
  goal: string,
  events: TeachRecordingEvent[],
  snapshots: TeachSnapshot[] = [],
): SkillPlaybook {
  const steps: string[] = [];
  let run: TypedRun | null = null;
  let typedCount = 0;
  let pastedCount = 0;
  let drag: { button: string; fromX: number; fromY: number; toX: number; toY: number } | null =
    null;

  function inputPlaceholder(label: string | undefined, source: "typed" | "pasted"): string {
    if (label) return `{{input:${label}}}`;
    if (source === "typed") {
      typedCount += 1;
      return `{{input:typed text ${typedCount}}}`;
    }
    pastedCount += 1;
    return `{{input:pasted text ${pastedCount}}}`;
  }

  function flushTyped() {
    if (!run) return;
    const current = run;
    run = null;
    if (current.kind === "literal") {
      const text = redactLiteralText(current.text);
      if (text) steps.push(`Type ${JSON.stringify(text)}.`);
      return;
    }
    const text =
      current.kind === "protected"
        ? REDACTED_INPUT
        : current.kind === "secret"
          ? current.placeholder
          : inputPlaceholder(current.label, "typed");
    steps.push(`Type ${JSON.stringify(text)}.`);
  }

  function addToRun(next: TypedRun) {
    if (run && sameRun(run, next)) {
      if (run.kind === "literal" && next.kind === "literal") run.text += next.text;
      return;
    }
    flushTyped();
    run = next;
  }

  function flushDrag() {
    if (!drag) return;
    const moved = Math.hypot(drag.toX - drag.fromX, drag.toY - drag.fromY) >= 8;
    steps.push(
      moved
        ? `Drag ${drag.button} button from (${drag.fromX}, ${drag.fromY}) to (${drag.toX}, ${drag.toY}).`
        : `Click ${drag.button} button at (${drag.fromX}, ${drag.fromY}).`,
    );
    drag = null;
  }

  for (const event of events) {
    if (event.kind === "key") {
      flushDrag();
      // Protected input keeps its exact previous behavior: one redacted step per run.
      if (event.sensitive && !isPasswordLikeField(event)) {
        addToRun({ kind: "protected" });
        continue;
      }
      const key = event.key;
      if (key !== undefined && isNamedTeachKey(key)) {
        flushTyped();
        steps.push(`Press key: ${key}.`);
        continue;
      }
      if (key === undefined && !event.redacted && !event.sensitive) continue;
      if (isSecretTeachField(event)) {
        addToRun({ kind: "secret", placeholder: secretPlaceholder(event) });
        continue;
      }
      const literal = literalKey(event);
      if (literal !== undefined) {
        addToRun({ kind: "literal", text: literal });
        continue;
      }
      addToRun({ kind: "input", label: placeholderLabel(event.fieldLabel) });
      continue;
    }
    flushTyped();
    if (event.kind === "pointer") {
      const action = event.type ?? "click";
      const button = event.button ?? "left";
      const x = event.x ?? 0;
      const y = event.y ?? 0;
      if (action === "down") {
        flushDrag();
        drag = { button, fromX: x, fromY: y, toX: x, toY: y };
        continue;
      }
      if (action === "move" && drag) {
        drag.toX = x;
        drag.toY = y;
        continue;
      }
      if (action === "up") {
        if (drag) {
          drag.toX = x;
          drag.toY = y;
          flushDrag();
        } else {
          steps.push(describePointer(event));
        }
        continue;
      }
      flushDrag();
      steps.push(describePointer(event));
    } else if (event.kind === "clipboard") {
      flushDrag();
      let text = "";
      if (event.sensitive && !isPasswordLikeField(event)) {
        text = REDACTED_INPUT;
      } else if (isSecretTeachField(event)) {
        text = secretPlaceholder(event);
      } else if (event.keepLiteral === true && !event.redacted && event.text) {
        text = redactLiteralText(event.text);
      } else if (event.text || event.redacted) {
        text = inputPlaceholder(placeholderLabel(event.fieldLabel), "pasted");
      }
      if (text) steps.push(`Paste or type: ${text}.`);
    } else if (event.kind === "scroll") {
      flushDrag();
      steps.push(describeScroll(event));
    } else {
      flushDrag();
    }
  }
  flushTyped();
  flushDrag();

  if (steps.length === 0) {
    steps.push("Repeat the demonstrated workflow using the same navigation pattern.");
  }

  return {
    whenToUse: goal.trim() || "When the user asks to repeat the demonstrated task.",
    inputs: goal.trim() ? [goal.trim()] : [],
    steps,
    howToCheck: snapshots.at(-1)?.summary
      ? `The final screen should match: ${snapshots.at(-1)?.summary}.`
      : "Confirm the outcome matches the user's goal before reporting success.",
    whatToReturn: "A short summary of what was completed and where outputs were saved.",
    approvalBoundaries: DEFAULT_APPROVAL,
    failureHandling: DEFAULT_FAILURE,
  };
}

const SKILL_RUN_PROMPT_PREFIX = "run taught skill:";
const SKILL_INVOCATION_VERB = /\b(run|use|do|repeat|perform|execute)\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A saved skill only takes over a task when the user actually asks for it: an invocation verb
 * plus the whole skill name. A bare substring match would hijack any request that happens to
 * mention a common word used as a skill name.
 */
export function promptInvokesSkill(prompt: string, name: string): boolean {
  const skill = name.trim().toLowerCase();
  const text = prompt.toLowerCase();
  if (skill.length < 3) return false;
  if (text.startsWith(SKILL_RUN_PROMPT_PREFIX)) return false;
  if (!SKILL_INVOCATION_VERB.test(text)) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(skill)}([^\\p{L}\\p{N}]|$)`, "u").test(text);
}

const PLACEHOLDER_GUIDANCE = [
  "Placeholders: the steps never contain what the user typed during the demo.",
  "- {{secret:<label>}} and [redacted input] stand for a password, one-time code or other secret. Use a saved login for this site when one exists (list_secrets, then browser_act fill_secret). Otherwise call request_secret so the user enters it in a protected card, or request_takeover for one-time codes and anything that needs the live screen. Never type the placeholder, never guess a value, and never ask for a secret in chat.",
  "- {{input:<label>}} stands for ordinary text typed or pasted during the demo. Use the matching value from the user's request; if it is not there, ask the user before typing it.",
].join("\n");

const PLACEHOLDER_PATTERN = /\{\{(?:secret|input):[^}]*\}\}|\[redacted input\]/;

export function playbookHasPlaceholders(playbook: SkillPlaybook): boolean {
  return playbook.steps.some((step) => PLACEHOLDER_PATTERN.test(step));
}

export function formatSkillRunPrompt(name: string, playbook: SkillPlaybook, test = false): string {
  const safety = test
    ? "This is a safe test run. Do not send, spend, delete, or publish anything."
    : "";
  return [
    `Run taught skill: ${name}`,
    safety,
    `When to use: ${playbook.whenToUse}`,
    playbook.inputs.length ? `Inputs: ${playbook.inputs.join("; ")}` : undefined,
    "Steps:",
    ...playbook.steps.map((step, index) => `${index + 1}. ${step}`),
    playbookHasPlaceholders(playbook) ? PLACEHOLDER_GUIDANCE : undefined,
    `How to check: ${playbook.howToCheck}`,
    `Return: ${playbook.whatToReturn}`,
    `Approval boundaries: ${playbook.approvalBoundaries}`,
    `Failure handling: ${playbook.failureHandling}`,
  ]
    .filter(Boolean)
    .join("\n");
}
