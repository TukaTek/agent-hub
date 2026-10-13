import { MarkdownLinkPromptProvider } from "@cortexai-agent-hub/chat-ui/web";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

export function MarkdownLinkPrompt({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <MarkdownLinkPromptProvider
      copy={{
        title: t`Open external link?`,
        cancel: t`Cancel`,
        open: t`Open`,
      }}
    >
      {children}
    </MarkdownLinkPromptProvider>
  );
}
