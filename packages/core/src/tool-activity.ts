import type { MessageBlock } from "@cortexai-agent-hub/contracts";

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}
