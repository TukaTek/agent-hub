import {
  buildPlaybookFromRecording,
  type SkillPlaybook,
  sanitizeTeachRecordingEvent,
  type TeachRecordingEvent,
  type TeachSnapshot,
} from "@cortexai-agent-hub/core";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { redactSecretText } from "@cortexai-agent-hub/logging";

// CAAH-71: Teach Me must never keep what the user typed. These helpers are the single
// server-side gate used at capture, on finalize, on updateDraft/save and by the legacy purge.

/** Core sanitization plus Agent Hub's secret redaction on any text a recording may keep. */
export function sanitizeStoredTeachEvent(event: TeachRecordingEvent): TeachRecordingEvent {
  const sanitized = sanitizeTeachRecordingEvent(event);
  let next = sanitized;
  for (const field of ["text", "fieldLabel", "summary"] as const) {
    const value = next[field];
    if (typeof value !== "string") continue;
    const redacted = redactTeachText(value);
    if (redacted !== value) next = { ...next, [field]: redacted };
  }
  return next;
}

const TEACH_PLACEHOLDER = /(\{\{(?:secret|input):[^{}]*\}\})/;

/**
 * Agent Hub's secret redaction, applied around Teach Me placeholders: `{{secret:password}}`
 * would otherwise read as a `secret: value` assignment and be mangled.
 */
export function redactTeachText(text: string): string {
  return text
    .split(TEACH_PLACEHOLDER)
    .map((part, index) => (index % 2 === 1 ? part : redactSecretText(part)))
    .join("");
}

/** Runs every playbook string through Agent Hub's secret redaction. */
export function redactPlaybook(playbook: SkillPlaybook): SkillPlaybook {
  return {
    whenToUse: redactTeachText(playbook.whenToUse),
    inputs: playbook.inputs.map(redactTeachText),
    steps: playbook.steps.map(redactTeachText),
    howToCheck: redactTeachText(playbook.howToCheck),
    whatToReturn: redactTeachText(playbook.whatToReturn),
    approvalBoundaries: redactTeachText(playbook.approvalBoundaries),
    failureHandling: redactTeachText(playbook.failureHandling),
  };
}

type StoredRecording = {
  events: TeachRecordingEvent[];
  snapshots: TeachSnapshot[];
  [key: string]: unknown;
};

function parseStoredRecording(value: unknown): StoredRecording {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...record,
    events: Array.isArray(record.events) ? (record.events as TeachRecordingEvent[]) : [],
    snapshots: Array.isArray(record.snapshots) ? (record.snapshots as TeachSnapshot[]) : [],
  };
}

function parseStoredPlaybook(value: unknown): SkillPlaybook {
  const record = (value && typeof value === "object" ? value : {}) as Partial<SkillPlaybook>;
  return {
    whenToUse: String(record.whenToUse ?? ""),
    inputs: Array.isArray(record.inputs) ? record.inputs.map(String) : [],
    steps: Array.isArray(record.steps) ? record.steps.map(String) : [],
    howToCheck: String(record.howToCheck ?? ""),
    whatToReturn: String(record.whatToReturn ?? ""),
    approvalBoundaries: String(record.approvalBoundaries ?? ""),
    failureHandling: String(record.failureHandling ?? ""),
  };
}

export type ScrubbedTaughtSkill = {
  recording: StoredRecording;
  playbook: SkillPlaybook;
  recordingChanged: boolean;
  playbookChanged: boolean;
};

/**
 * Removes typed and pasted values from a taught skill. When the recording still held raw
 * input (a pre-fix row), the steps are rebuilt from the sanitized events because the old
 * builder copied that input into them. A clean recording keeps the user's edited steps.
 * Either way every playbook string goes through secret redaction. Running it on its own
 * output changes nothing.
 *
 * `clientSteps` marks steps that came from a client (updateDraft). A client can hold a card
 * read before the purge, so a literal `Type "…".` or `Paste or type: ….` step is only kept
 * when the sanitized recording itself produces it (a keepLiteral event); any other literal
 * is replaced with a numbered placeholder.
 */
export function scrubTaughtSkill(
  row: {
    goal: string;
    recording: unknown;
    playbook: unknown;
  },
  options: { clientSteps?: boolean } = {},
): ScrubbedTaughtSkill {
  const recording = parseStoredRecording(row.recording);
  const events = recording.events.map(sanitizeStoredTeachEvent);
  const recordingChanged = JSON.stringify(events) !== JSON.stringify(recording.events);
  const stored = parseStoredPlaybook(row.playbook);
  let steps: string[];
  if (recordingChanged) {
    steps = buildPlaybookFromRecording(row.goal, events, recording.snapshots).steps;
  } else if (options.clientSteps) {
    const recorded = buildPlaybookFromRecording(row.goal, events, recording.snapshots).steps;
    steps = scrubLiteralSteps(
      stored.steps,
      new Set(recorded.filter((step) => literalStepValue(step) !== undefined)),
    );
  } else {
    steps = stored.steps;
  }
  const playbook = redactPlaybook({ ...stored, steps });
  return {
    recording: { ...recording, events },
    playbook,
    recordingChanged,
    playbookChanged: JSON.stringify(playbook) !== JSON.stringify(stored),
  };
}

const LITERAL_TYPE_STEP = /^Type "(.*)"\.$/s;
const LITERAL_PASTE_STEP = /^Paste or type: (.*)\.$/s;
const PLACEHOLDER_ONLY = /^(?:\{\{(?:secret|input):[^}]*\}\}|\[redacted input\])$/;

type LiteralStep = { kind: "typed" | "pasted"; value: string };

function literalStepValue(step: string): LiteralStep | undefined {
  const typedMatch = LITERAL_TYPE_STEP.exec(step);
  if (typedMatch) {
    const raw = typedMatch[1] ?? "";
    try {
      return { kind: "typed", value: String(JSON.parse(`"${raw}"`)) };
    } catch {
      return { kind: "typed", value: raw };
    }
  }
  const pastedMatch = LITERAL_PASTE_STEP.exec(step);
  if (pastedMatch) return { kind: "pasted", value: pastedMatch[1] ?? "" };
  return undefined;
}

/**
 * Replaces literal Type/Paste steps with numbered placeholders, keeping placeholder-only
 * steps and any step in `allowed` (literals the recording itself produced).
 */
function scrubLiteralSteps(steps: string[], allowed: ReadonlySet<string> = new Set()): string[] {
  let typed = 0;
  let pasted = 0;
  return steps.map((step) => {
    const literal = literalStepValue(step);
    if (!literal) return step;
    if (PLACEHOLDER_ONLY.test(literal.value)) {
      if (literal.value.startsWith(`{{input:${literal.kind} text `)) {
        if (literal.kind === "typed") typed += 1;
        else pasted += 1;
      }
      return step;
    }
    if (allowed.has(step)) return step;
    if (literal.kind === "typed") {
      typed += 1;
      return `Type "{{input:typed text ${typed}}}".`;
    }
    pasted += 1;
    return `Paste or type: {{input:pasted text ${pasted}}}.`;
  });
}

/**
 * For a chat draft card whose skill no longer exists there is no recording to rebuild from,
 * so literal Type/Paste steps are replaced with placeholders in place.
 */
export function scrubDraftPlaybook(playbook: SkillPlaybook): SkillPlaybook {
  return redactPlaybook({ ...playbook, steps: scrubLiteralSteps(playbook.steps) });
}

export type PurgePrisma = Pick<PrismaClient, "taughtSkill" | "message">;

export type TaughtSkillPurgeCounts = {
  skillsScanned: number;
  skillsChanged: number;
  recordingsScrubbed: number;
  playbooksScrubbed: number;
  /** Rows another writer changed between read and write; the next start retries them. */
  skippedConcurrent: number;
  draftMessagesScanned: number;
  draftMessagesScrubbed: number;
  /** Draft cards another writer changed between read and write; the next start retries them. */
  draftMessagesSkippedConcurrent: number;
};

/** The purge stopped at a batch boundary because the API is shutting down. */
export class PurgeInterruptedError extends Error {
  override name = "PurgeInterruptedError";
  constructor() {
    super("taught_skills secret purge interrupted");
  }
}

type DraftBlock = { kind: "skill_draft"; skillId?: unknown; playbook?: unknown };

function isDraftBlock(block: unknown): block is DraftBlock {
  return Boolean(
    block && typeof block === "object" && (block as DraftBlock).kind === "skill_draft",
  );
}

/**
 * Idempotent legacy purge for CAAH-71. Scrubs every taught_skills row and every chat
 * skill_draft card that copied a playbook. Returns counts only; it never logs or returns
 * a stored value. `updatedAt` is preserved and used as an optimistic guard, so a concurrent
 * edit is never overwritten and the purge does not reorder anyone's skill list. Draft cards
 * are guarded by comparing their blocks.
 */
export async function purgeTaughtSkillSecrets(
  prisma: PurgePrisma,
  options: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<TaughtSkillPurgeCounts> {
  const batchSize = options.batchSize ?? 100;
  // Checked between batches so an API shutdown is not held up by a long purge; the
  // interrupted purge simply runs again on the next start.
  const checkAborted = () => {
    if (options.signal?.aborted) throw new PurgeInterruptedError();
  };
  const counts: TaughtSkillPurgeCounts = {
    skillsScanned: 0,
    skillsChanged: 0,
    recordingsScrubbed: 0,
    playbooksScrubbed: 0,
    skippedConcurrent: 0,
    draftMessagesScanned: 0,
    draftMessagesScrubbed: 0,
    draftMessagesSkippedConcurrent: 0,
  };

  let lastSkillId: string | undefined;
  for (;;) {
    checkAborted();
    const batch = await prisma.taughtSkill.findMany({
      where: lastSkillId ? { id: { gt: lastSkillId } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, goal: true, recording: true, playbook: true, updatedAt: true },
    });
    for (const skill of batch) {
      counts.skillsScanned += 1;
      lastSkillId = skill.id;
      const scrubbed = scrubTaughtSkill(skill);
      if (!scrubbed.recordingChanged && !scrubbed.playbookChanged) continue;
      const written = await prisma.taughtSkill.updateMany({
        where: { id: skill.id, updatedAt: skill.updatedAt },
        data: {
          recording: scrubbed.recording as never,
          playbook: scrubbed.playbook as never,
          updatedAt: skill.updatedAt,
        },
      });
      if (written.count === 0) {
        counts.skippedConcurrent += 1;
        continue;
      }
      counts.skillsChanged += 1;
      if (scrubbed.recordingChanged) counts.recordingsScrubbed += 1;
      if (scrubbed.playbookChanged) counts.playbooksScrubbed += 1;
    }
    if (batch.length < batchSize) break;
  }

  let lastMessageId: string | undefined;
  for (;;) {
    checkAborted();
    const batch = await prisma.message.findMany({
      where: {
        ...(lastMessageId ? { id: { gt: lastMessageId } } : {}),
        blocks: { array_contains: [{ kind: "skill_draft" }] },
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, blocks: true },
    });
    for (const message of batch) {
      lastMessageId = message.id;
      if (!Array.isArray(message.blocks)) continue;
      counts.draftMessagesScanned += 1;
      const blocks: unknown[] = [];
      let changed = false;
      for (const block of message.blocks as unknown[]) {
        if (!isDraftBlock(block)) {
          blocks.push(block);
          continue;
        }
        const current = parseStoredPlaybook(block.playbook);
        const skill =
          typeof block.skillId === "string"
            ? await prisma.taughtSkill.findUnique({
                where: { id: block.skillId },
                select: { goal: true, recording: true, playbook: true },
              })
            : null;
        const playbook = skill ? scrubTaughtSkill(skill).playbook : scrubDraftPlaybook(current);
        if (JSON.stringify(playbook) === JSON.stringify(current)) {
          blocks.push(block);
          continue;
        }
        changed = true;
        blocks.push({ ...block, playbook });
      }
      if (!changed) continue;
      // Compare-and-swap on the blocks we read (messages have no updatedAt): a card-state
      // write that landed in between is never overwritten.
      const written = await prisma.message.updateMany({
        where: { id: message.id, blocks: { equals: message.blocks as never } },
        data: { blocks: blocks as never },
      });
      if (written.count === 0) {
        counts.draftMessagesSkippedConcurrent += 1;
        continue;
      }
      counts.draftMessagesScrubbed += 1;
    }
    if (batch.length < batchSize) break;
  }

  return counts;
}
