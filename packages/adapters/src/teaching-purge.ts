import { buildPlaybookFromRecording, sanitizeTeachRecordingEvent, type TeachRecordingEvent } from "@cortexai-agent-hub/core";
import type { PrismaClient } from "@cortexai-agent-hub/db";
import { getLogger } from "@cortexai-agent-hub/logging";

type TeachRecording = {
  events: TeachRecordingEvent[];
  snapshots: Array<{ at: string; summary: string; hash?: string }>;
  controlLeaseId?: string;
};

function parseRecording(value: unknown): TeachRecording {
  if (!value || typeof value !== "object") return { events: [], snapshots: [] };
  const record = value as Partial<TeachRecording>;
  return {
    events: Array.isArray(record.events) ? (record.events as TeachRecordingEvent[]) : [],
    snapshots: Array.isArray(record.snapshots) ? record.snapshots : [],
    controlLeaseId: typeof record.controlLeaseId === "string" ? record.controlLeaseId : undefined,
  };
}

function legacySanitizeForPurge(event: TeachRecordingEvent, status: string): TeachRecordingEvent {
  // For saved skills (not recording), aggressively drop all input unless explicitly opted in
  if (status !== "recording" && status !== "drafting" && !event.keepLiteral) {
    if (event.kind === "key" || event.kind === "clipboard") {
      const sanitized = { ...event };
      delete sanitized.key;
      delete sanitized.text;
      if (event.kind === "key" || event.kind === "clipboard") {
        sanitized.sensitive = true;
      }
      return sanitized;
    }
  }
  // For recording/drafting, use standard sanitization (password fields + Protected input)
  return sanitizeTeachRecordingEvent(event);
}

export async function purgeTaughtSkillSecrets(prisma: PrismaClient): Promise<{ scanned: number; changed: number }> {
  const logger = getLogger();
  let scanned = 0;
  let changed = 0;
  const batchSize = 100;
  let lastId: string | undefined;

  while (true) {
    const batch = await prisma.taughtSkill.findMany({
      where: lastId ? { id: { gt: lastId } } : undefined,
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, goal: true, recording: true, playbook: true, status: true },
    });

    if (batch.length === 0) break;

    for (const skill of batch) {
      scanned++;
      let needsUpdate = false;
      const recording = parseRecording(skill.recording);
      const sanitizedEvents = recording.events.map((event) => 
        legacySanitizeForPurge(event, skill.status)
      );
      
      if (JSON.stringify(sanitizedEvents) !== JSON.stringify(recording.events)) {
        needsUpdate = true;
      }

      const rebuiltPlaybook = buildPlaybookFromRecording(skill.goal, sanitizedEvents, recording.snapshots);
      if (JSON.stringify(rebuiltPlaybook) !== JSON.stringify(skill.playbook)) {
        needsUpdate = true;
      }

      if (needsUpdate) {
        await prisma.taughtSkill.update({
          where: { id: skill.id },
          data: {
            recording: { ...recording, events: sanitizedEvents } as never,
            playbook: rebuiltPlaybook as never,
          },
        });
        changed++;
      }

      lastId = skill.id;
    }

    if (batch.length < batchSize) break;
  }

  logger.info("taught_skills secret purge complete", { scanned, changed });
  return { scanned, changed };
}
