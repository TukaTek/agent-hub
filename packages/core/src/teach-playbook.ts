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
  sensitive?: boolean;
  fieldType?: string;
  autocomplete?: string;
  fieldLabel?: string;
  keepLiteral?: boolean;
};

function isPasswordField(event: TeachRecordingEvent): boolean {
  if (event.fieldType === "password") return true;
  if (event.autocomplete) {
    const lower = event.autocomplete.toLowerCase();
    if (lower.includes("password") || lower === "one-time-code") return true;
  }
  return false;
}

function isProtectedInput(event: TeachRecordingEvent): boolean {
  return event.sensitive === true && !isPasswordField(event);
}

function secretPlaceholder(event: TeachRecordingEvent): string {
  const label = event.fieldLabel || "field";
  return `{{secret:${label}}}`;
}

export function sanitizeTeachRecordingEvent(event: TeachRecordingEvent): TeachRecordingEvent {
  if (!event.sensitive && !isPasswordField(event)) return event;
  const sanitized = { ...event };
  delete sanitized.key;
  delete sanitized.text;
  sanitized.sensitive = true;
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
const SECRET_PLACEHOLDER_PREFIX = "{{secret:";

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /\bBearer\s+[^\s"',;&]+/gi;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|secret|token|authorization|apikey|api_key)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi;
const JSON_SECRET_FIELD =
  /"(password|passwd|secret|token|authorization|apikey|api_key|accesstoken|refreshtoken|email|cookie)"\s*:\s*"(?:\\.|[^"\\])*"/gi;
const BARE_SECRET =
  /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:ak_|ck_)[A-Za-z0-9]+)\b/g;

function redactSensitiveText(text: string): string {
  const REDACTED = "[Redacted]";
  return text
    .replace(EMAIL, REDACTED)
    .replace(JSON_SECRET_FIELD, `"$1":"${REDACTED}"`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(BARE_SECRET, REDACTED);
}

function redactTypedText(text: string): string {
  const trimmed = text.trim();
  if (/password|secret|token|api[_-]?key/i.test(trimmed)) return REDACTED_INPUT;
  const redacted = redactSensitiveText(trimmed);
  if (redacted !== trimmed) return REDACTED_INPUT;
  return trimmed;
}

function isTypedCharacter(key: string): boolean {
  return key.length === 1;
}

export function buildPlaybookFromRecording(
  goal: string,
  events: TeachRecordingEvent[],
  snapshots: TeachSnapshot[] = [],
): SkillPlaybook {
  const steps: string[] = [];
  let typed = "";
  let typedSensitive = false;
  let currentSecretEvent: TeachRecordingEvent | null = null;
  let drag: { button: string; fromX: number; fromY: number; toX: number; toY: number } | null =
    null;

  function flushTyped() {
    if (!typed) return;
    const text = redactTypedText(typed);
    if (text) steps.push(`Type ${JSON.stringify(text)}.`);
    typed = "";
  }

  function flushSensitiveTyped() {
    if (!typedSensitive) return;
    steps.push(`Type ${JSON.stringify(REDACTED_INPUT)}.`);
    typedSensitive = false;
  }

  function flushSecretField() {
    if (!currentSecretEvent) return;
    steps.push(`Type ${JSON.stringify(secretPlaceholder(currentSecretEvent))}.`);
    currentSecretEvent = null;
  }

  function flushPendingInput() {
    flushTyped();
    flushSensitiveTyped();
    flushSecretField();
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
      const key = event.key;
      flushDrag();

      if (isPasswordField(event)) {
        flushTyped();
        flushSensitiveTyped();
        if (!currentSecretEvent) currentSecretEvent = event;
        if (key && isTypedCharacter(key)) continue;
        flushSecretField();
        if (key) steps.push(`Press key: ${key}.`);
        continue;
      }

      if (isProtectedInput(event)) {
        flushTyped();
        flushSecretField();
        typedSensitive = true;
        continue;
      }

      if (!key) continue;

      if (isTypedCharacter(key)) {
        flushSensitiveTyped();
        flushSecretField();
        typed += key;
        continue;
      }

      flushPendingInput();
      steps.push(`Press key: ${key}.`);
      continue;
    }
    flushPendingInput();
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
      if (isPasswordField(event)) {
        steps.push(`Paste or type: ${secretPlaceholder(event)}.`);
      } else {
        const text = isProtectedInput(event)
          ? REDACTED_INPUT
          : event.text
            ? redactTypedText(event.text)
            : "";
        if (text) steps.push(`Paste or type: ${text}.`);
      }
    } else if (event.kind === "scroll") {
      flushDrag();
      steps.push(describeScroll(event));
    } else {
      flushDrag();
    }
  }
  flushPendingInput();
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
    `How to check: ${playbook.howToCheck}`,
    `Return: ${playbook.whatToReturn}`,
    `Approval boundaries: ${playbook.approvalBoundaries}`,
    `Failure handling: ${playbook.failureHandling}`,
  ]
    .filter(Boolean)
    .join("\n");
}
