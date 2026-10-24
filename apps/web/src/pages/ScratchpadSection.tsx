import type { ScratchpadItem } from "@cortexai-agent-hub/contracts";
import { Button, Checkbox, Input } from "@cortexai-agent-hub/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { rpc } from "../lib/rpc";

const COLLAPSE_ABOVE = 5;
const expandedStorageKey = (botId: string) => `cortexai-agent-hub.openWorkExpanded.${botId}`;

function readExpanded(botId: string): boolean | null {
  try {
    const value = localStorage.getItem(expandedStorageKey(botId));
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

function persistExpanded(botId: string, expanded: boolean) {
  try {
    localStorage.setItem(expandedStorageKey(botId), String(expanded));
  } catch {
    // The in-memory choice still applies when local storage is unavailable or blocked.
  }
}

export function ScratchpadSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const listId = useId();
  const [items, setItems] = useState<ScratchpadItem[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ botId: string; expanded: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listGeneration = useRef(0);
  const loaded = loadedFor === botId;
  const expanded =
    (choice?.botId === botId ? choice.expanded : readExpanded(botId)) ??
    (loaded && items.length <= COLLAPSE_ABOVE);

  function setExpanded(next: boolean) {
    setChoice({ botId, expanded: next });
    persistExpanded(botId, next);
  }

  async function refresh() {
    const generation = ++listGeneration.current;
    const list = await rpc.scratchpad.list({ botId });
    if (generation !== listGeneration.current) return;
    setItems(list);
  }

  useEffect(() => {
    const generation = ++listGeneration.current;
    void rpc.scratchpad
      .list({ botId })
      .then((list) => {
        if (generation !== listGeneration.current) return;
        setItems(list);
        setLoadedFor(botId);
      })
      .catch(() => {
        if (generation !== listGeneration.current) return;
        setItems([]);
        setLoadedFor(botId);
      });
    return () => {
      listGeneration.current += 1;
    };
  }, [botId]);

  async function addItem() {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.scratchpad.create({ botId, title });
      setDraft("");
      setAdding(false);
      setItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not add`);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(item: ScratchpadItem, status: ScratchpadItem["status"]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.scratchpad.update({ itemId: item.id, status });
      setItems((current) => {
        const next = current.map((entry) => (entry.id === updated.id ? updated : entry));
        return status === "done" ? next.filter((entry) => entry.status !== "done") : next;
      });
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not update`);
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: ScratchpadItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.scratchpad.remove({ itemId: item.id });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      try {
        await refresh();
      } catch {
        setError(t`Removed, but list refresh failed`);
      }
    } catch {
      setError(t`Could not remove`);
    } finally {
      setBusy(false);
    }
  }

  if (!items.length && !error) return null;

  return (
    <div className="mt-6" data-testid="bot-scratchpad">
      <h3 className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground pe-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 rounded-md outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Trans>Open work</Trans>
          {items.length > 0 ? <span className="tabular-nums">({items.length})</span> : null}
          <ChevronDown
            aria-hidden="true"
            className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Add open work`}
          title={t`Add open work`}
          onClick={() => {
            if (!adding && !expanded) setExpanded(true);
            setAdding((value) => !value);
          }}
        >
          <Plus className="size-4" />
        </Button>
      </h3>
      {expanded ? (
        <div id={listId} className="rounded-xl bg-muted/50 p-4">
          <div data-testid="bot-scratchpad-list" className="max-h-80 overflow-y-auto">
            {items.map((item) => (
              <div
                key={item.id}
                data-testid="bot-scratchpad-item"
                className="group flex items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-accent/50"
              >
                <Checkbox
                  aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
                  checked={item.status === "done"}
                  disabled={busy}
                  onCheckedChange={(checked) => void setStatus(item, checked ? "done" : "open")}
                  className="mt-[3px]"
                />
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-start text-[14.5px] ${item.status === "done" ? "text-muted-foreground/80 line-through" : "text-foreground"}`}
                    dir="auto"
                  >
                    {item.title}
                  </div>
                  {item.notes ? (
                    <div className="mt-0.5 text-[12.5px] text-muted-foreground/80" dir="auto">
                      {item.notes}
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Remove`}
                  disabled={busy}
                  onClick={() => void removeItem(item)}
                  className="-mt-0.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
          {adding ? (
            <form
              className={`flex items-center gap-2 ${items.length ? "mt-2" : ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                void addItem();
              }}
            >
              <Input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t`Add item`}
                aria-label={t`New open-work item`}
                maxLength={200}
                className="min-w-0 flex-1"
              />
              <Button
                variant="secondary"
                className="rounded-full"
                disabled={busy || !draft.trim()}
                onClick={() => void addItem()}
              >
                <Trans>Add</Trans>
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {error ? <div className="mt-2 text-[13px] text-destructive">{error}</div> : null}
    </div>
  );
}
