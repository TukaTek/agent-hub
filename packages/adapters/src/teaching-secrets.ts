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
 */
export function scrubTaughtSkill(row: {
  goal: string;
  recording: unknown;
  playbook: unknown;
}): ScrubbedTaughtSkill {
  const recording = parseStoredRecording(row.recording);
  const events = recording.events.map(sanitizeStoredTeachEvent);
  const recordingChanged = JSON.stringify(events) !== JSON.stringify(recording.events);
  const stored = parseStoredPlaybook(row.playbook);
  const steps = recordingChanged
    ? buildPlaybookFromRecording(row.goal, events, recording.snapshots).steps
    : stored.steps;
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

/**
 * For a chat draft card whose skill no longer exists there is no recording to rebuild from,
 * so literal Type/Paste steps are replaced with placeholders in place.
 */
export function scrubDraftPlaybook(playbook: SkillPlaybook): SkillPlaybook {
  let typed = 0;
  let pasted = 0;
  const steps = playbook.steps.map((step) => {
    const typedMatch = LITERAL_TYPE_STEP.exec(step);
    if (typedMatch) {
      const inner = (() => {
        try {
          return String(JSON.parse(`"${typedMatch[1]}"`));
        } catch {
          return typedMatch[1] ?? "";
        }
      })();
      if (PLACEHOLDER_ONLY.test(inner)) {
        if (inner.startsWith("{{input:typed text ")) typed += 1;
        return step;
      }
      typed += 1;
      return `Type "{{input:typed text ${typed}}}".`;
    }
    const pastedMatch = LITERAL_PASTE_STEP.exec(step);
    if (pastedMatch) {
      if (PLACEHOLDER_ONLY.test(pastedMatch[1] ?? "")) {
        if (pastedMatch[1]?.startsWith("{{input:pasted text ")) pasted += 1;
        return step;
      }
      pasted += 1;
      return `Paste or type: {{input:pasted text ${pasted}}}.`;
    }
    return step;
  });
  return redactPlaybook({ ...playbook, steps });
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
};

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
 * edit is never overwritten and the purge does not reorder anyone's skill list.
 */
export async function purgeTaughtSkillSecrets(
  prisma: PurgePrisma,
  options: { batchSize?: number } = {},
): Promise<TaughtSkillPurgeCounts> {
  const batchSize = options.batchSize ?? 100;
  const counts: TaughtSkillPurgeCounts = {
    skillsScanned: 0,
    skillsChanged: 0,
    recordingsScrubbed: 0,
    playbooksScrubbed: 0,
    skippedConcurrent: 0,
    draftMessagesScanned: 0,
    draftMessagesScrubbed: 0,
  };

  let lastSkillId: string | undefined;
  for (;;) {
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
      await prisma.message.update({ where: { id: message.id }, data: { blocks: blocks as never } });
      counts.draftMessagesScrubbed += 1;
    }
    if (batch.length < batchSize) break;
  }

  return counts;
}
