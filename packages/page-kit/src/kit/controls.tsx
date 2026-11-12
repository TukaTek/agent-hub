import { pageKitPalette } from "@cortexai-agent-hub/ui-tokens";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { openViaHost } from "./inline.js";
import { useWords } from "./labels.js";

/** The page asks the host to put text in the chat's composer; the reader still presses Send. */
const REPLY_MESSAGE = "cortexai-agent-hub-page:reply";
const REPLY_MAX_LENGTH = 300;

/** Only hosts with a composer beside the page mark the document; public pages have none. */
function replyAvailable(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-reply");
}

/** Whitespace collapsed; undefined when nothing is left or it is longer than a chat line. */
export function replyText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= REPLY_MAX_LENGTH ? text : undefined;
}

function sendReply(text: string) {
  window.parent?.postMessage({ type: REPLY_MESSAGE, text }, "*");
}

const COPY_MESSAGE = "cortexai-agent-hub-page:copy";
const COPIED_MESSAGE = "cortexai-agent-hub-page:copied";
/** The app copies no more than this for a page. */
const COPY_MAX_LENGTH = 20_000;
let copies = 0;

/**
 * Copies text for the reader and resolves whether it worked. Pages have no clipboard of their
 * own: the app copies, one copy per click in the page, and says whether it could.
 */
export function copyText(value: unknown): Promise<boolean> {
  const content = text(value);
  if (!content || content.length > COPY_MAX_LENGTH) return Promise.resolve(false);
  copies += 1;
  const id = `copy-${copies}`;
  return new Promise((resolve) => {
    function answer(event: MessageEvent) {
      const data = event.data as { type?: unknown; id?: unknown; ok?: unknown } | null;
      if (data?.type === COPIED_MESSAGE && data.id === id) finish(data.ok === true);
    }
    function finish(ok: boolean) {
      window.removeEventListener("message", answer);
      clearTimeout(timer);
      resolve(ok);
    }
    // A host that cannot copy for pages never answers.
    const timer = setTimeout(() => finish(false), 2000);
    window.addEventListener("message", answer);
    window.parent?.postMessage({ type: COPY_MESSAGE, id, text: content }, "*");
  });
}

/** A link the host may open: web and mail addresses only. */
export function linkUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

function ArrowIcon() {
  return (
    <svg className="cortexai-agent-hub-arrow" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4" />
    </svg>
  );
}

export function Button({
  label,
  onClick,
  variant = "quiet",
  disabled = false,
}: {
  label?: string;
  onClick?: () => void;
  variant?: "quiet" | "primary";
  disabled?: boolean;
}) {
  const name = text(label);
  if (!name) return null;
  return (
    <button
      type="button"
      className="cortexai-agent-hub-button"
      data-variant={variant === "primary" ? "primary" : undefined}
      disabled={disabled === true}
      onClick={() => onClick?.()}
    >
      {name}
    </button>
  );
}

/** Puts its text in the chat's composer for the reader to send; inert where there is no chat. */
export function ReplyButton({
  label,
  reply,
  variant = "quiet",
}: {
  label?: string;
  reply?: string;
  variant?: "quiet" | "primary";
}) {
  const name = text(label);
  if (!name) return null;
  const message = replyText(reply ?? name);
  return (
    <button
      type="button"
      className="cortexai-agent-hub-button"
      data-variant={variant === "primary" ? "primary" : undefined}
      disabled={!message || !replyAvailable()}
      onClick={() => message && sendReply(message)}
    >
      {name}
    </button>
  );
}

/** Copies its text, says so for a moment, and shows the text to select when copying is blocked. */
export function CopyButton({
  label,
  text: value,
  copiedLabel,
  variant = "quiet",
}: {
  label?: string;
  text?: string;
  copiedLabel?: string;
  variant?: "quiet" | "primary";
}) {
  const words = useWords();
  const [state, setState] = useState<"idle" | "copied" | "blocked">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  const name = text(label);
  if (!name) return null;
  const content = text(value) || name;
  return (
    <>
      <button
        type="button"
        className="cortexai-agent-hub-button"
        data-variant={variant === "primary" ? "primary" : undefined}
        onClick={() => void copyText(content).then((ok) => setState(ok ? "copied" : "blocked"))}
      >
        {state === "copied" ? text(copiedLabel) || words.t("copied") : name}
      </button>
      {state === "blocked" ? (
        <span className="cortexai-agent-hub-copy-fallback">{content}</span>
      ) : null}
    </>
  );
}

export function LinkButton({
  label,
  href,
  variant = "button",
  description,
}: {
  label?: string;
  href?: string;
  variant?: "button" | "text";
  /** The full name for screen readers when the label is a short verb such as "View". */
  description?: string;
}) {
  const name = text(label);
  const url = linkUrl(href);
  if (!name) return null;
  const className =
    variant === "text" ? "cortexai-agent-hub-link-text" : "cortexai-agent-hub-link-button";
  if (!url) return <span className={className}>{name}</span>;
  return (
    <a
      className={className}
      href={url}
      rel="noopener noreferrer"
      aria-label={text(description) || undefined}
      onClick={openViaHost}
    >
      {name}
      <ArrowIcon />
    </a>
  );
}

export function TextLink({ href, children }: { href?: string; children?: ReactNode }) {
  const url = linkUrl(href);
  if (!url) return <>{children ?? null}</>;
  return (
    <a
      className="cortexai-agent-hub-text-link"
      href={url}
      rel="noopener noreferrer"
      onClick={openViaHost}
    >
      {children ?? href}
      <ArrowIcon />
    </a>
  );
}

export type SelectOption = string | { value: string; label?: ReactNode };

function optionsOf(options: unknown): { value: string; label: ReactNode }[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option === "string" || typeof option === "number") {
      return [{ value: String(option), label: String(option) }];
    }
    if (option && typeof option === "object" && "value" in option) {
      const value = String((option as { value: unknown }).value);
      const label = (option as { label?: ReactNode }).label;
      return [{ value, label: label ?? value }];
    }
    return [];
  });
}

function Chevron() {
  return (
    <svg className="cortexai-agent-hub-select-chevron" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

export function Select({
  label,
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
}: {
  label?: string;
  options?: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const items = optionsOf(options);
  const current = value === undefined || value === null ? "" : String(value);
  const chosen = items.some((item) => item.value === current);
  return (
    <div className="cortexai-agent-hub-field" data-inline="true">
      {label ? (
        <label className="cortexai-agent-hub-field-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <span className="cortexai-agent-hub-select">
        <select
          id={id}
          value={chosen ? current : ""}
          disabled={disabled === true}
          data-empty={!chosen || undefined}
          aria-label={label ? undefined : placeholder}
          onChange={(event) => onChange?.(event.target.value)}
        >
          {!chosen ? (
            <option value="" disabled>
              {placeholder ?? ""}
            </option>
          ) : null}
          {items.map((item) => (
            <option key={item.value} value={item.value}>
              {typeof item.label === "string" || typeof item.label === "number"
                ? item.label
                : item.value}
            </option>
          ))}
        </select>
        <Chevron />
      </span>
    </div>
  );
}

export function Input({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label?: string;
  value?: string | number;
  onChange?: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "search";
}) {
  const id = useId();
  return (
    <div className="cortexai-agent-hub-field">
      {label ? (
        <label className="cortexai-agent-hub-field-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <input
        id={id}
        className="cortexai-agent-hub-input"
        type={type}
        inputMode={type === "number" ? "decimal" : undefined}
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={placeholder}
        aria-label={label ? undefined : placeholder}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </div>
  );
}

export function Toggle({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label?: string;
  value?: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="cortexai-agent-hub-toggle" data-disabled={disabled === true || undefined}>
      <input
        type="checkbox"
        role="switch"
        checked={value === true}
        aria-checked={value === true}
        disabled={disabled === true}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span className="cortexai-agent-hub-toggle-track" aria-hidden="true">
        <span className="cortexai-agent-hub-toggle-thumb" />
      </span>
      {label ? <span className="cortexai-agent-hub-toggle-label">{label}</span> : null}
    </label>
  );
}

/** Shows a recorded yes or no; the reader cannot change it. */
export function Checkbox({ label, value }: { label?: string; value?: boolean }) {
  const checked = value === true;
  return (
    <label className="cortexai-agent-hub-checkbox">
      <input type="checkbox" checked={checked} disabled aria-readonly="true" />
      <span
        className="cortexai-agent-hub-checkbox-box"
        aria-hidden="true"
        data-checked={checked || undefined}
      >
        {checked ? (
          <svg viewBox="0 0 12 12">
            <path d="M2.5 6.5 5 9l4.5-6" />
          </svg>
        ) : null}
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

// Control sizes are in px: they stay the same size on every screen.
export const CONTROLS_CSS = `
:root{--cortexai-agent-hub-control:${pageKitPalette.dark.controlFill};--cortexai-agent-hub-control-hover:${pageKitPalette.dark.controlHoverFill};--cortexai-agent-hub-primary:${pageKitPalette.dark.buttonFill};--cortexai-agent-hub-primary-hover:${pageKitPalette.dark.buttonHoverFill};--cortexai-agent-hub-primary-ink:${pageKitPalette.dark.buttonInk};--cortexai-agent-hub-option:${pageKitPalette.dark.optionFill};--cortexai-agent-hub-checked:${pageKitPalette.dark.checkedFill}}
[data-theme="light"]{--cortexai-agent-hub-control:${pageKitPalette.light.controlFill};--cortexai-agent-hub-control-hover:${pageKitPalette.light.controlHoverFill};--cortexai-agent-hub-primary:${pageKitPalette.light.buttonFill};--cortexai-agent-hub-primary-hover:${pageKitPalette.light.buttonHoverFill};--cortexai-agent-hub-primary-ink:${pageKitPalette.light.buttonInk};--cortexai-agent-hub-option:${pageKitPalette.light.optionFill};--cortexai-agent-hub-checked:${pageKitPalette.light.checkedFill}}
.cortexai-agent-hub-button{appearance:none;transform-origin:center;display:inline-flex;align-items:center;justify-content:center;align-self:flex-start;justify-self:start;flex:none;max-width:100%;height:28px;margin:0;padding:4px 12px;border:0;border-radius:9999px;background:var(--cortexai-agent-hub-control);color:var(--foreground);font:inherit;font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background-color .14s,color .14s,transform .1s}
.cortexai-agent-hub-button:hover:not(:disabled){background:var(--cortexai-agent-hub-control-hover)}
.cortexai-agent-hub-button[data-variant="primary"]{background:var(--cortexai-agent-hub-primary);color:var(--cortexai-agent-hub-primary-ink)}
.cortexai-agent-hub-button[data-variant="primary"]:hover:not(:disabled){background:var(--cortexai-agent-hub-primary-hover)}
.cortexai-agent-hub-button:disabled{cursor:not-allowed;opacity:.5}
:is(.cortexai-agent-hub-section,.cortexai-agent-hub-grid,.cortexai-agent-hub-page)>.cortexai-agent-hub-button{height:24px;padding:4px 10px;font-size:12px;line-height:16px;letter-spacing:.12px}
.cortexai-agent-hub-button:focus-visible,.cortexai-agent-hub-link-button:focus-visible,.cortexai-agent-hub-link-text:focus-visible,.cortexai-agent-hub-text-link:focus-visible,.cortexai-agent-hub-select select:focus-visible,.cortexai-agent-hub-input:focus-visible,.cortexai-agent-hub-toggle input:focus-visible+.cortexai-agent-hub-toggle-track{outline:2px solid var(--ring);outline-offset:2px}
.cortexai-agent-hub-copy-fallback{display:block;max-height:8em;overflow:auto;padding:6px 8px;border-radius:8px;background:var(--cortexai-agent-hub-control);font-size:12px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-user-select:all;user-select:all}
.cortexai-agent-hub-arrow{flex:none;width:12px;height:12px;margin-left:3px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.cortexai-agent-hub-link-button{display:flex;align-items:center;justify-content:center;width:100%;min-height:40px;padding:0 16px;border-radius:9999px;background:var(--cortexai-agent-hub-control);color:var(--foreground);font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px;text-decoration:none;transition:background-color .14s}
a.cortexai-agent-hub-link-button:hover{background:var(--cortexai-agent-hub-control-hover)}
.cortexai-agent-hub-link-text{display:inline-flex;align-self:flex-start;align-items:center;color:var(--cortexai-agent-hub-accent);font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px;text-decoration:none}
.cortexai-agent-hub-text-link{color:var(--cortexai-agent-hub-accent);font-weight:500;text-decoration:none;overflow-wrap:anywhere}
.cortexai-agent-hub-text-link .cortexai-agent-hub-arrow{display:inline-block;vertical-align:-.05em}
a.cortexai-agent-hub-link-text:hover,.cortexai-agent-hub-text-link:hover{text-decoration:underline;text-underline-offset:2px}
.cortexai-agent-hub-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.cortexai-agent-hub-field[data-inline]{display:inline-flex;justify-self:start;max-width:100%}
.cortexai-agent-hub-field-label{font-size:12px;line-height:16px;letter-spacing:.12px;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-select{position:relative;display:flex;align-items:center;max-width:100%}
.cortexai-agent-hub-select select{appearance:none;-webkit-appearance:none;width:100%;max-width:100%;height:28px;margin:0;padding:4px 28px 4px 8px;border:0;border-radius:8px;background:var(--cortexai-agent-hub-control);color:var(--foreground);font:inherit;font-size:14px;line-height:20px;letter-spacing:.1px;text-overflow:ellipsis;cursor:pointer;transition:background-color .14s}
.cortexai-agent-hub-select select:hover:not(:disabled){background:var(--cortexai-agent-hub-control-hover)}
.cortexai-agent-hub-select select[data-empty]{color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-select select:disabled{cursor:not-allowed;opacity:.5}
.cortexai-agent-hub-select option{background:var(--cortexai-agent-hub-option);color:var(--foreground)}
.cortexai-agent-hub-select-chevron{position:absolute;right:8px;width:12px;height:12px;pointer-events:none;fill:none;stroke:var(--cortexai-agent-hub-secondary);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.cortexai-agent-hub-input{display:block;width:100%;height:28px;margin:0;padding:4px 8px;border:0;border-radius:8px;background:var(--cortexai-agent-hub-control);color:var(--foreground);font:inherit;font-size:14px;line-height:20px;letter-spacing:.1px}
.cortexai-agent-hub-input::placeholder{color:var(--cortexai-agent-hub-secondary);opacity:1}
.cortexai-agent-hub-input,.cortexai-agent-hub-select select{caret-color:var(--cortexai-agent-hub-accent);accent-color:var(--cortexai-agent-hub-accent)}
.cortexai-agent-hub-input::-webkit-search-cancel-button{-webkit-appearance:none}
.cortexai-agent-hub-toggle,.cortexai-agent-hub-checkbox{position:relative;display:inline-flex;align-items:center;gap:8px;font-size:14px;line-height:20px;letter-spacing:.1px}
.cortexai-agent-hub-toggle{cursor:pointer}
:is(.cortexai-agent-hub-page,.cortexai-agent-hub-section,.cortexai-agent-hub-section-body)>:is(.cortexai-agent-hub-field[data-inline],.cortexai-agent-hub-toggle,.cortexai-agent-hub-checkbox){align-self:flex-start}
.cortexai-agent-hub-toggle[data-disabled]{cursor:not-allowed;opacity:.5}
.cortexai-agent-hub-toggle input,.cortexai-agent-hub-checkbox input{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}
.cortexai-agent-hub-toggle input{inset:0;width:100%;height:100%;pointer-events:auto;cursor:inherit}
.cortexai-agent-hub-toggle-track{position:relative;flex:none;width:32px;height:18px;border-radius:9999px;background:color-mix(in srgb,var(--foreground) 30%,transparent);transition:background-color .14s}
.cortexai-agent-hub-toggle-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:9999px;background:var(--background);transition:transform .14s}
.cortexai-agent-hub-toggle input:checked+.cortexai-agent-hub-toggle-track{background:var(--cortexai-agent-hub-primary)}
.cortexai-agent-hub-toggle input:checked+.cortexai-agent-hub-toggle-track .cortexai-agent-hub-toggle-thumb{transform:translateX(14px)}
.cortexai-agent-hub-checkbox-box{display:flex;flex:none;align-items:center;justify-content:center;width:18px;height:18px;border:1px solid color-mix(in srgb,var(--foreground) 30%,transparent);border-radius:4.5px}
.cortexai-agent-hub-checkbox-box[data-checked]{background:var(--cortexai-agent-hub-checked);border-color:color-mix(in srgb,var(--foreground) 5%,transparent)}
.cortexai-agent-hub-checkbox-box svg{width:12px;height:12px;fill:none;stroke:var(--foreground);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.cortexai-agent-hub-button:active:not(:disabled){transform:scale(.97)}
.cortexai-agent-hub-link-button:active,.cortexai-agent-hub-segmented button:active{opacity:.75}
@media (pointer:coarse){.cortexai-agent-hub-button,:is(.cortexai-agent-hub-section,.cortexai-agent-hub-grid,.cortexai-agent-hub-page)>.cortexai-agent-hub-button,.cortexai-agent-hub-select select,.cortexai-agent-hub-input,.cortexai-agent-hub-link-button{height:44px;min-height:44px}.cortexai-agent-hub-button,:is(.cortexai-agent-hub-section,.cortexai-agent-hub-grid,.cortexai-agent-hub-page)>.cortexai-agent-hub-button{padding:10px 16px;font-size:15px;line-height:20px}.cortexai-agent-hub-select select,.cortexai-agent-hub-input{font-size:16px}.cortexai-agent-hub-toggle,.cortexai-agent-hub-checkbox{min-height:44px}.cortexai-agent-hub-segmented button{min-height:44px}}
@media (prefers-reduced-motion:reduce){.cortexai-agent-hub-button,.cortexai-agent-hub-link-button,.cortexai-agent-hub-select select,.cortexai-agent-hub-toggle-track,.cortexai-agent-hub-toggle-thumb{transition:none}}
@media print{:root,[data-theme]{--cortexai-agent-hub-control:${pageKitPalette.light.controlFill};--cortexai-agent-hub-primary:${pageKitPalette.light.buttonFill};--cortexai-agent-hub-primary-ink:${pageKitPalette.light.buttonInk};--cortexai-agent-hub-checked:${pageKitPalette.light.checkedFill}}.cortexai-agent-hub-button{display:none}}
`;
