// Adapted from OpenMausBot src/components/ComposerQueuedMessages.tsx (Apache-2.0). Modified by TukaTek.
import { useLingui } from "@lingui/react/macro";
import { CornerDownRight } from "lucide-react";
import { useId } from "react";

/** Messages sent into the running turn that the run has not taken yet. */
export function ComposerQueued({ items }: { items: readonly { seq: number; text: string }[] }) {
  const { t } = useLingui();
  const labelId = useId();
  if (!items.length) return null;
  return (
    <section
      data-testid="composer-queued"
      aria-labelledby={labelId}
      aria-live="polite"
      className="mb-2 max-h-36 overflow-y-auto rounded-[14px] border border-border bg-muted px-3 py-2"
    >
      <h2 id={labelId} className="text-[12px] font-medium text-muted-foreground">
        {t`Queued`}
      </h2>
      <ul className="mt-1 space-y-0.5">
        {items.map((item) => (
          <li
            key={item.seq}
            className="flex min-w-0 items-center gap-2 text-[13.5px] text-foreground/80"
          >
            <CornerDownRight
              size={13}
              strokeWidth={1.8}
              aria-hidden="true"
              className="shrink-0 text-muted-foreground"
            />
            <span dir="auto" className="truncate" title={item.text}>
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
