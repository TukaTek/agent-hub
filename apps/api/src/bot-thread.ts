import type { Actor } from "@cortexai-agent-hub/contracts";
import type { PrismaClient, ThreadEvents } from "@cortexai-agent-hub/db";
import { IsolationError } from "@cortexai-agent-hub/db";

export type BotThreadDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
};

export async function requireBotThread(deps: BotThreadDeps, actor: Actor, botId: string) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId },
    include: { thread: true },
  });
  if (!bot?.thread) throw new IsolationError();
  return { bot, thread: bot.thread };
}
