import type { Root } from "chat";

export interface LarkTextPart {
  text: string;
  literal: boolean;
}

type LarkRootData = NonNullable<Root["data"]> & {
  cortexAiAgentHubLarkParts?: LarkTextPart[];
};

export function setLarkTextParts(root: Root, parts: LarkTextPart[]): void {
  const data: LarkRootData = { ...root.data, cortexAiAgentHubLarkParts: parts };
  root.data = data;
}

export function getLarkTextParts(root: Root): LarkTextPart[] | undefined {
  const data = root.data as { cortexAiAgentHubLarkParts?: unknown } | undefined;
  const parts = data?.cortexAiAgentHubLarkParts;
  if (
    Array.isArray(parts) &&
    parts.every(
      (part): part is LarkTextPart =>
        part != null &&
        typeof part === "object" &&
        typeof part.text === "string" &&
        typeof part.literal === "boolean",
    )
  ) {
    return parts;
  }
  return undefined;
}
