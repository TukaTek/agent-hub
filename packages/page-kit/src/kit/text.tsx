import type { MouseEvent, ReactNode } from "react";
import { Children, isValidElement, useEffect, useState } from "react";
import { Inline, openViaHost, webUrl } from "./inline.js";
import { useWords } from "./labels.js";

// Lists nest at most this deep; deeper items are dropped rather than overflowing the column.
const MAX_LIST_DEPTH = 24;
const TOC_FOLD_AT = 12;
const TOC_MIN_HIDDEN = 4;

type ListItem = string | number | { text?: ReactNode; items?: ListItem[]; bullets?: ListItem[] };
type Marker = "pro" | "con";

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scrolls the frame, and the host page around it, to an element on this page. */
function scrollToElement(element: Element | null) {
  element?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

/** 1. at the top, then a. and i., the way a written outline steps down. */
function ordinal(index: number, depth: number): string {
  const n = index + 1;
  if (depth % 3 === 0) return `${n}.`;
  if (depth % 3 === 1) {
    let out = "";
    for (let left = n; left > 0; left = Math.floor((left - 1) / 26)) {
      out = ALPHA[(left - 1) % 26] + out;
    }
    return `${out}.`;
  }
  let out = "";
  let left = n;
  for (const [value, numeral] of ROMAN) {
    while (left >= value) {
      out += numeral;
      left -= value;
    }
  }
  return `${out}.`;
}

function BulletMark({ depth }: { depth: number }) {
  return (
    <svg
      className="cortexai-agent-hub-li-mark"
      width="8"
      height="24"
      viewBox="0 0 8 24"
      aria-hidden="true"
    >
      {depth === 0 ? (
        <circle cx="4" cy="12" r="3" fill="currentColor" />
      ) : (
        <circle cx="4.5" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1" />
      )}
    </svg>
  );
}

function ToneMark({ marker }: { marker: Marker }) {
  return (
    <span className="cortexai-agent-hub-li-tone" data-marker={marker} aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path
          d={marker === "pro" ? "M3 6h6M6 3v6" : "M3 6h6"}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </span>
  );
}

function ListLevel({
  items,
  ordered,
  marker,
  depth,
}: {
  items: unknown;
  ordered: boolean;
  marker?: Marker;
  depth: number;
}) {
  if (!Array.isArray(items) || depth >= MAX_LIST_DEPTH) return null;
  const rows = items.filter(
    (item) =>
      text(item) !== undefined || (item && typeof item === "object" && !isValidElement(item)),
  ) as ListItem[];
  if (!rows.length) return null;
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className="cortexai-agent-hub-list" data-marker={marker} data-depth={depth || undefined}>
      {rows.map((item, index) => {
        const object = typeof item === "object" ? item : undefined;
        const label = object ? object.text : text(item);
        const children = object ? (object.items ?? object.bullets) : undefined;
        return (
          <li key={index} dir="auto">
            {marker ? (
              <ToneMark marker={marker} />
            ) : ordered ? (
              <span className="cortexai-agent-hub-li-number" dir="ltr">
                {ordinal(index, depth)}
              </span>
            ) : (
              <BulletMark depth={depth} />
            )}
            <span className="cortexai-agent-hub-li-text">
              <Inline>{typeof label === "number" ? String(label) : label}</Inline>
            </span>
            {children ? (
              <ListLevel items={children} ordered={ordered} marker={marker} depth={depth + 1} />
            ) : null}
          </li>
        );
      })}
    </Tag>
  );
}

export function BulletList({ items, marker }: { items: ListItem[]; marker?: Marker }) {
  return (
    <ListLevel
      items={items}
      ordered={false}
      marker={marker === "pro" || marker === "con" ? marker : undefined}
      depth={0}
    />
  );
}

export function NumberedList({ items }: { items: ListItem[] }) {
  return <ListLevel items={items} ordered depth={0} />;
}

export function ProsCons({
  pros,
  cons,
  prosHeading,
  consHeading,
}: {
  pros?: ListItem[];
  cons?: ListItem[];
  prosHeading?: string;
  consHeading?: string;
}) {
  const words = useWords();
  const columns = [
    { heading: text(prosHeading) || words.t("pros"), items: pros, marker: "pro" as const },
    { heading: text(consHeading) || words.t("cons"), items: cons, marker: "con" as const },
  ].filter((column) => Array.isArray(column.items) && column.items.length);
  if (!columns.length) return null;
  return (
    <div className="cortexai-agent-hub-proscons">
      {columns.map((column) => (
        <div className="cortexai-agent-hub-proscons-card" key={column.marker}>
          <p className="cortexai-agent-hub-proscons-heading" dir="auto">
            {column.heading}
          </p>
          <ListLevel items={column.items} ordered={false} marker={column.marker} depth={0} />
        </div>
      ))}
    </div>
  );
}

export function Quote({ cite, children }: { cite?: string; children?: ReactNode }) {
  if (children === undefined || children === null || children === "") return null;
  return (
    <blockquote className="cortexai-agent-hub-quote" dir="auto">
      <p className="cortexai-agent-hub-quote-text">
        <Inline>{children}</Inline>
      </p>
      {cite ? (
        <p className="cortexai-agent-hub-quote-cite">
          <Inline>{cite}</Inline>
        </p>
      ) : null}
    </blockquote>
  );
}

export function Divider() {
  return <hr className="cortexai-agent-hub-divider" />;
}

type LinkCard = { title?: string; href?: string; site?: string; date?: string };

const LINK_ICON =
  "M6.5 9.5l3-3M7.4 4.6l.9-.9a2.5 2.5 0 013.5 3.5l-.9.9M8.6 11.4l-.9.9a2.5 2.5 0 01-3.5-3.5l.9-.9";

export function LinkCards({ links, numbered = false }: { links: LinkCard[]; numbered?: boolean }) {
  const cards = Array.isArray(links)
    ? links.filter(
        (link) => link && typeof link === "object" && (text(link.title) || webUrl(link.href)),
      )
    : [];
  if (!cards.length) return null;
  return (
    <ul className="cortexai-agent-hub-linkcards">
      {cards.map((link, index) => {
        const href = webUrl(link.href);
        const site =
          text(link.site) ?? (href ? new URL(href).hostname.replace(/^www\./, "") : undefined);
        const meta = [site, text(link.date)].filter(Boolean).join(" · ");
        const body = (
          <>
            <span className="cortexai-agent-hub-linkcard-badge" aria-hidden="true">
              {numbered ? (
                index + 1
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16">
                  <path
                    d={LINK_ICON}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </span>
            <span className="cortexai-agent-hub-linkcard-text">
              <span className="cortexai-agent-hub-linkcard-title" dir="auto">
                {text(link.title) ?? link.href}
              </span>
              {meta ? <span className="cortexai-agent-hub-linkcard-meta">{meta}</span> : null}
            </span>
            {href ? (
              <svg
                className="cortexai-agent-hub-linkcard-arrow"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M5.5 10.5l5-5M6.5 5.5h4v4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
          </>
        );
        return (
          <li key={index}>
            {href ? (
              <a
                className="cortexai-agent-hub-linkcard"
                href={href}
                rel="noopener noreferrer"
                title={text(link.title)}
                onClick={openViaHost}
              >
                {body}
              </a>
            ) : (
              <div className="cortexai-agent-hub-linkcard">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const SERIES = [
  "var(--cortexai-agent-hub-c1)",
  "var(--cortexai-agent-hub-c2)",
  "var(--cortexai-agent-hub-c3)",
  "var(--cortexai-agent-hub-c4)",
  "var(--cortexai-agent-hub-c5)",
];

export function Legend({
  names,
  comparison,
  dots = false,
}: {
  names: string[];
  /** Indexes into names drawn as dashed comparison lines. */
  comparison?: number[];
  dots?: boolean;
}) {
  const dashed = new Set(Array.isArray(comparison) ? comparison : []);
  const entries = (Array.isArray(names) ? names : [])
    .map((name, index) => ({
      name: text(name),
      color: dashed.has(index) ? "var(--cortexai-agent-hub-other)" : SERIES[index % SERIES.length]!,
      compare: dashed.has(index),
    }))
    .filter((entry) => entry.name);
  if (!entries.length) return null;
  return (
    <ul className="cortexai-agent-hub-legend-list">
      {entries.map((entry, index) => (
        <li key={index} style={{ color: entry.color }}>
          {dots ? (
            <span className="cortexai-agent-hub-legend-dot" aria-hidden="true" />
          ) : (
            <svg width="14" height="2" aria-hidden="true">
              <line
                x1="0"
                y1="1"
                x2="14"
                y2="1"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={entry.compare ? "3 2" : undefined}
              />
            </svg>
          )}
          <span className="cortexai-agent-hub-legend-name">{entry.name}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Art above the title. The eyebrow is kept for pages that pass one, but it reads as a caption
 * under the art rather than a label over the heading.
 */
export function PageHero({
  eyebrow,
  eyebrowMark,
  children,
}: {
  eyebrow?: string;
  eyebrowMark?: ReactNode;
  children?: ReactNode;
}) {
  const caption = text(eyebrow) ? (
    <figcaption className="cortexai-agent-hub-hero-caption" dir="auto">
      {eyebrowMark ? <span className="cortexai-agent-hub-hero-mark">{eyebrowMark}</span> : null}
      {text(eyebrow)}
    </figcaption>
  ) : null;
  if (!Children.count(children) && !caption) return null;
  return (
    <figure className="cortexai-agent-hub-hero">
      {children}
      {caption}
    </figure>
  );
}

export function PageMeta({ children }: { children?: ReactNode }) {
  if (children === undefined || children === null || children === "") return null;
  return (
    <p className="cortexai-agent-hub-meta" dir="auto">
      <Inline>{children}</Inline>
    </p>
  );
}

export function Footnote({ children }: { children?: ReactNode }) {
  if (children === undefined || children === null || children === "") return null;
  return (
    <p className="cortexai-agent-hub-footnote" dir="auto">
      <Inline>{children}</Inline>
    </p>
  );
}

const EDGES = new Set(["top", "bottom"]);
const ALIGNS = new Set(["start", "center", "end"]);

export function Floating({
  edge = "bottom",
  align = "end",
  bar = false,
  children,
}: {
  edge?: "top" | "bottom";
  align?: "start" | "center" | "end";
  bar?: boolean;
  children?: ReactNode;
}) {
  if (!Children.count(children)) return null;
  return (
    <div
      className="cortexai-agent-hub-floating"
      data-edge={EDGES.has(edge) ? edge : "bottom"}
      data-align={ALIGNS.has(align) ? align : "end"}
    >
      <div className="cortexai-agent-hub-floating-row" data-bar={bar || undefined}>
        {children}
      </div>
    </div>
  );
}

export function BackToTop({ label }: { label?: string }) {
  const words = useWords();
  return (
    <div className="cortexai-agent-hub-backtotop">
      <button
        type="button"
        onClick={() =>
          scrollToElement(document.querySelector(".cortexai-agent-hub-page") ?? document.body)
        }
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M7 11.5v-9M3 6.5l4-4 4 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {text(label) || words.t("backToTop")}
      </button>
    </div>
  );
}

type TocItem = { label?: string; id?: string; depth?: number };

/** Lowercase words joined by dashes: the anchor a Section gets from its heading. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The heading the reader is in: the last one scrolled past, or the first. */
function useActiveId(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  const key = ids.join("\n");
  useEffect(() => {
    const targets = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (!targets.length || typeof IntersectionObserver !== "function") return;
    const visible = new Set<Element>();
    const pick = () => {
      const top = targets.find((element) => visible.has(element));
      if (top) setActive(top.id);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        pick();
      },
      { rootMargin: "0px 0px -60% 0px" },
    );
    for (const element of targets) observer.observe(element);
    return () => observer.disconnect();
  }, [key]);
  return active;
}

export function TableOfContents({ items, title }: { items: TocItem[]; title?: string }) {
  const words = useWords();
  const entries = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object" && text(item.label))
    .map((item) => ({
      label: text(item.label)!,
      id: text(item.id) || slugify(text(item.label)!),
      depth: Math.max(0, Math.min(4, Math.round(Number(item.depth) || 0))),
    }));
  const [open, setOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const active = useActiveId(entries.map((entry) => entry.id));
  if (!entries.length) return null;
  const folds = entries.length > TOC_FOLD_AT && entries.length - TOC_FOLD_AT >= TOC_MIN_HIDDEN;
  const shown = folds && !open ? entries.slice(0, TOC_FOLD_AT) : entries;
  const go = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    event.preventDefault();
    setCompactOpen(false);
    scrollToElement(document.getElementById(id));
  };
  const current = entries.find((entry) => entry.id === active) ?? entries[0]!;
  return (
    <nav
      className="cortexai-agent-hub-toc"
      aria-label={text(title) || words.t("onThisPage")}
      data-compact-open={compactOpen || undefined}
    >
      <p className="cortexai-agent-hub-toc-title">{text(title) || words.t("onThisPage")}</p>
      <button
        type="button"
        className="cortexai-agent-hub-toc-compact"
        aria-expanded={compactOpen}
        onClick={() => setCompactOpen(!compactOpen)}
      >
        <span className="cortexai-agent-hub-toc-compact-label">
          {text(title) || words.t("onThisPage")}
        </span>
        <span className="cortexai-agent-hub-toc-compact-current">{current.label}</span>
        <svg width="16" height="16" viewBox="-2 -2 16 16" aria-hidden="true">
          <path
            d="M3 4.5l3 3 3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {shown.map((entry, index) => (
        <a
          key={index}
          href={`#${entry.id}`}
          title={entry.label}
          aria-current={entry.id === current.id ? "location" : undefined}
          style={entry.depth ? { paddingLeft: 6 + entry.depth * 16 } : undefined}
          onClick={(event) => go(event, entry.id)}
        >
          {entry.label}
        </a>
      ))}
      {folds ? (
        <button
          type="button"
          className="cortexai-agent-hub-toc-fold"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? words.t("showFewer") : words.t("showAll", { count: entries.length })}
        </button>
      ) : null}
    </nav>
  );
}

// Each loose string in an equation is its own term, so the gaps between terms stay even.
function Terms({ children }: { children?: ReactNode }) {
  return (
    <>
      {Children.map(children, (child) =>
        typeof child === "string" || typeof child === "number" ? (
          String(child).trim() ? (
            <span>{String(child).trim()}</span>
          ) : null
        ) : (
          child
        ),
      )}
    </>
  );
}

export function Equation({ label, children }: { label?: string; children?: ReactNode }) {
  if (!Children.count(children)) return null;
  return (
    <div className="cortexai-agent-hub-equation" role="math" aria-label={text(label)}>
      <div className="cortexai-agent-hub-equation-body">
        <Terms>{children}</Terms>
      </div>
      {text(label) ? (
        <span className="cortexai-agent-hub-equation-label" title={text(label)}>
          {text(label)}
        </span>
      ) : null}
    </div>
  );
}

export function Frac({ num, den }: { num?: ReactNode; den?: ReactNode }) {
  return (
    <span className="cortexai-agent-hub-frac">
      <span>{num}</span>
      <span className="cortexai-agent-hub-frac-bar" aria-hidden="true" />
      <span>{den}</span>
    </span>
  );
}

export function Pow({ base, exp }: { base?: ReactNode; exp?: ReactNode }) {
  return (
    <span className="cortexai-agent-hub-pow">
      <span>{base}</span>
      <sup>{exp}</sup>
    </span>
  );
}

export function Sqrt({ children }: { children?: ReactNode }) {
  return (
    <span className="cortexai-agent-hub-sqrt">
      <span aria-hidden="true">√</span>
      <span className="cortexai-agent-hub-sqrt-body">{children}</span>
    </span>
  );
}

export function Sum({
  from,
  to,
  sign = "∑",
  children,
}: {
  from?: ReactNode;
  to?: ReactNode;
  sign?: string;
  children?: ReactNode;
}) {
  return (
    <span className="cortexai-agent-hub-sum-term">
      <span className="cortexai-agent-hub-sum">
        <span className="cortexai-agent-hub-sum-limit">{to}</span>
        <span className="cortexai-agent-hub-sum-sign">{sign}</span>
        <span className="cortexai-agent-hub-sum-limit">{from}</span>
      </span>
      {Children.count(children) ? <span>{children}</span> : null}
    </span>
  );
}

export function Paren({
  open = "(",
  close = ")",
  children,
}: {
  open?: string;
  close?: string;
  children?: ReactNode;
}) {
  return (
    <span className="cortexai-agent-hub-paren">
      {open}
      {children}
      {close}
    </span>
  );
}

/** Block styles for this family, appended to the kit's sheet. */
export const TEXT_KIT_CSS = `
.cortexai-agent-hub-list{display:flex;flex-direction:column;gap:.5rem;margin:0;padding:0;list-style:none;font-size:1rem;line-height:1.5}
.cortexai-agent-hub-list .cortexai-agent-hub-list{margin-top:.5rem}
.cortexai-agent-hub-list>li{display:grid;grid-template-columns:1rem minmax(0,1fr);column-gap:.5rem;align-items:start;overflow-wrap:anywhere}
.cortexai-agent-hub-list>li>.cortexai-agent-hub-list{grid-column:2}
.cortexai-agent-hub-li-mark{display:block;margin-left:.5rem}
.cortexai-agent-hub-li-number{color:var(--cortexai-agent-hub-secondary);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;justify-self:center}
.cortexai-agent-hub-list[data-marker]{font-size:.875rem;line-height:1.25rem}
.cortexai-agent-hub-list[data-marker]>li{grid-template-columns:18px minmax(0,1fr)}
.cortexai-agent-hub-li-tone{display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px}
.cortexai-agent-hub-li-tone[data-marker="pro"]{color:var(--cortexai-agent-hub-success);background:color-mix(in srgb,var(--cortexai-agent-hub-success) 17%,transparent)}
.cortexai-agent-hub-li-tone[data-marker="con"]{color:var(--cortexai-agent-hub-danger);background:color-mix(in srgb,var(--cortexai-agent-hub-danger) 17%,transparent)}
.cortexai-agent-hub-proscons{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:1rem;align-items:start}
.cortexai-agent-hub-proscons-card{padding:.75rem 1rem 1rem;border:1px solid var(--cortexai-agent-hub-line);border-radius:12px}
.cortexai-agent-hub-proscons-heading{margin:0 0 .5rem;font-size:1rem;line-height:1.5;font-weight:600}
.cortexai-agent-hub-quote{position:relative;display:flex;flex-direction:column;gap:.25rem;margin:0;padding-left:18px}
.cortexai-agent-hub-quote::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:2px;background:color-mix(in srgb,var(--foreground) 22%,transparent)}
.cortexai-agent-hub-quote-text{margin:0;font-size:1rem;line-height:1.5}
.cortexai-agent-hub-quote-cite{margin:0;font-size:.875rem;line-height:1.25rem;color:var(--cortexai-agent-hub-secondary);overflow-wrap:anywhere}
.cortexai-agent-hub-divider{width:100%;height:0;margin:0;border:0;border-top:1px solid var(--cortexai-agent-hub-line)}
.cortexai-agent-hub-linkcards{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;border:1px solid var(--cortexai-agent-hub-line);border-radius:22px;overflow:hidden}
.cortexai-agent-hub-linkcards>li+li{position:relative}
.cortexai-agent-hub-linkcards>li+li::before{content:"";position:absolute;top:0;left:54px;right:0;height:1px;background:color-mix(in srgb,var(--foreground) 10%,transparent)}
.cortexai-agent-hub-linkcard{display:flex;align-items:center;gap:10px;padding:12px 16px;color:var(--cortexai-agent-hub-tertiary);text-decoration:none;transition:background-color .14s ease}
a.cortexai-agent-hub-linkcard:hover{background:var(--cortexai-agent-hub-fill)}
a.cortexai-agent-hub-linkcard:hover .cortexai-agent-hub-linkcard-arrow{color:var(--foreground);transform:translate(1px,-1px)}
a.cortexai-agent-hub-linkcard:focus-visible{outline:2px solid var(--ring);outline-offset:-2px;border-radius:21px}
.cortexai-agent-hub-linkcard-badge{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:1px solid color-mix(in srgb,var(--foreground) 5%,transparent);background:color-mix(in srgb,var(--cortexai-agent-hub-other) 17%,transparent);color:var(--cortexai-agent-hub-secondary);font-size:.8125rem;font-variant-numeric:tabular-nums}
.cortexai-agent-hub-linkcard-text{flex:1;min-width:0;display:flex;flex-direction:column}
.cortexai-agent-hub-linkcard-title{font-size:.875rem;line-height:1.25rem;color:var(--foreground);overflow-wrap:anywhere}
.cortexai-agent-hub-linkcard-meta{font-size:.75rem;line-height:1rem;color:var(--cortexai-agent-hub-secondary);overflow-wrap:anywhere}
.cortexai-agent-hub-linkcard-arrow{flex:none;transition:transform .14s ease,color .14s ease}
.cortexai-agent-hub-legend-list{display:flex;margin:0;padding:0;list-style:none;flex-wrap:wrap;align-items:center;gap:4px 16px;font-size:.75rem;line-height:1rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-legend-list>li{display:inline-flex;align-items:center;gap:6px}
.cortexai-agent-hub-legend-name{color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-legend-dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.cortexai-agent-hub-hero{display:flex;flex-direction:column;gap:.5rem;margin:0 0 .5rem}
.cortexai-agent-hub-hero-caption{display:flex;align-items:center;gap:.4rem;font-size:.8125rem;line-height:1.125rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-meta{margin:0;font-size:.875rem;line-height:1.25rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-header>.cortexai-agent-hub-meta{margin-top:-.5rem}
.cortexai-agent-hub-footnote{margin:.5rem 0 0;font-size:.8125rem;line-height:1.125rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-floating{position:sticky;z-index:2;display:flex;pointer-events:none}
.cortexai-agent-hub-floating[data-edge="bottom"]{bottom:calc(16px + var(--cortexai-agent-hub-bottom-inset,0px))}
.cortexai-agent-hub-floating[data-edge="top"]{top:16px}
.cortexai-agent-hub-floating[data-align="start"]{justify-content:flex-start}
.cortexai-agent-hub-floating[data-align="center"]{justify-content:center}
.cortexai-agent-hub-floating[data-align="end"]{justify-content:flex-end}
.cortexai-agent-hub-floating-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;pointer-events:auto}
.cortexai-agent-hub-floating-row[data-bar]{padding:8px;border:1px solid var(--cortexai-agent-hub-line);border-radius:12px;background:var(--card)}
.cortexai-agent-hub-backtotop{display:flex;justify-content:flex-end}
.cortexai-agent-hub-backtotop button{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 12px;border:0;border-radius:8px;background:color-mix(in srgb,var(--cortexai-agent-hub-other) 17%,transparent);color:var(--foreground);font:inherit;font-size:.8125rem;cursor:pointer;transition:background-color .14s ease}
.cortexai-agent-hub-backtotop button:hover{background:color-mix(in srgb,var(--cortexai-agent-hub-other) 28%,transparent)}
.cortexai-agent-hub-backtotop button:focus-visible,.cortexai-agent-hub-toc a:focus-visible,.cortexai-agent-hub-toc-fold:focus-visible,.cortexai-agent-hub-section-toggle:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.cortexai-agent-hub-toc{display:flex;flex-direction:column;gap:4px;padding:12px 16px;border:1px solid var(--cortexai-agent-hub-line);border-radius:12px}
.cortexai-agent-hub-toc-title{margin:0;font-size:.75rem;line-height:1rem;font-weight:500;letter-spacing:.01em;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-toc a{display:block;margin:-2px -6px;padding:2px 6px;border-radius:4px;font-size:.875rem;line-height:1.25rem;letter-spacing:.1px;color:var(--cortexai-agent-hub-secondary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background-color .14s ease,color .14s ease}
.cortexai-agent-hub-toc a:hover{background:var(--cortexai-agent-hub-fill);color:var(--foreground)}
.cortexai-agent-hub-toc a[aria-current]{color:var(--foreground);font-weight:500}
.cortexai-agent-hub-toc-fold{align-self:flex-start;margin:0;padding:0;border:0;background:none;font:inherit;font-size:.875rem;line-height:1.25rem;font-weight:500;color:var(--cortexai-agent-hub-secondary);cursor:pointer}
.cortexai-agent-hub-toc-fold:hover{color:var(--foreground)}
.cortexai-agent-hub-equation{display:grid;grid-template-columns:1fr auto 1fr;column-gap:10px;align-items:center;padding:16px 0;overflow-x:auto}
.cortexai-agent-hub-equation-body{grid-column:2;display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;max-width:100%;font-size:1rem;line-height:1.5}
.cortexai-agent-hub-equation-label{grid-column:3;justify-self:end;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.875rem;line-height:1.25rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-frac{display:inline-flex;flex-direction:column;align-items:center;gap:2px}
.cortexai-agent-hub-frac-bar{align-self:stretch;height:1px;background:currentColor}
.cortexai-agent-hub-pow{display:inline-flex;align-items:flex-start}
.cortexai-agent-hub-pow sup{font-size:.75rem;line-height:.75rem;vertical-align:baseline}
.cortexai-agent-hub-sqrt{display:inline-flex;align-items:center}
.cortexai-agent-hub-sqrt-body{padding-top:2px;border-top:1px solid currentColor}
.cortexai-agent-hub-sum-term{display:inline-flex;align-items:center;gap:4px}
.cortexai-agent-hub-sum{display:inline-flex;flex-direction:column;align-items:center;line-height:1}
.cortexai-agent-hub-sum-limit{font-size:.75rem;line-height:1rem}
.cortexai-agent-hub-sum-sign{font-size:1.25rem;line-height:1.25rem}
.cortexai-agent-hub-paren{white-space:nowrap}
.cortexai-agent-hub-section-toggle{display:flex;align-items:flex-start;gap:6px;width:100%;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;letter-spacing:inherit;text-align:start;cursor:pointer;-webkit-user-select:text;user-select:text}
.cortexai-agent-hub-section-toggle svg{flex:none;margin-top:calc((1lh - 16px)/2);color:var(--cortexai-agent-hub-tertiary);transition:transform .2s ease}
.cortexai-agent-hub-section-toggle[aria-expanded="false"] svg{transform:rotate(-90deg)}
.cortexai-agent-hub-section-fold{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .24s ease,opacity .2s ease}
.cortexai-agent-hub-section-fold[data-open]{grid-template-rows:1fr;opacity:1}
.cortexai-agent-hub-section-body{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;padding-left:22px}
.cortexai-agent-hub-section-fold[data-open]>.cortexai-agent-hub-section-body{overflow:visible}
.cortexai-agent-hub-section .cortexai-agent-hub-section h4.cortexai-agent-hub-heading{font-size:1rem;line-height:1.5;font-weight:600;letter-spacing:.1px}
.cortexai-agent-hub-section .cortexai-agent-hub-section h5.cortexai-agent-hub-heading{font-size:.875rem;line-height:1.25rem;font-weight:600}
.cortexai-agent-hub-section .cortexai-agent-hub-section h6.cortexai-agent-hub-heading{font-size:.75rem;line-height:1rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-page>.cortexai-agent-hub-header+.cortexai-agent-hub-toc{margin-top:calc(2rem - 3.9rem)}
@media (prefers-reduced-motion:reduce){.cortexai-agent-hub-section-fold,.cortexai-agent-hub-section-toggle svg,.cortexai-agent-hub-toc a,.cortexai-agent-hub-linkcard,.cortexai-agent-hub-backtotop button,.cortexai-agent-hub-linkcard-arrow{transition:none}}
.cortexai-agent-hub-toc-compact{display:none}
.cortexai-agent-hub-callout[data-tone]{display:grid;grid-template-columns:16px minmax(0,1fr);column-gap:.625rem}
.cortexai-agent-hub-callout-icon{margin-top:.25rem;fill:none;stroke:var(--cortexai-agent-hub-tone);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.cortexai-agent-hub-page ::selection{background:color-mix(in srgb,var(--cortexai-agent-hub-accent) 32%,transparent)}
@media (pointer:coarse){.cortexai-agent-hub-section-toggle{min-height:44px;align-items:center}.cortexai-agent-hub-section-toggle svg{margin-top:0}.cortexai-agent-hub-backtotop button{min-height:44px}.cortexai-agent-hub-toc>a{padding-block:8px}}
@media (max-width:640px){
.cortexai-agent-hub-toc{padding:0;gap:0}
.cortexai-agent-hub-toc>.cortexai-agent-hub-toc-title{display:none}
.cortexai-agent-hub-toc-compact{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;margin:0;padding:0 14px;border:0;background:none;color:var(--foreground);font:inherit;font-size:.875rem;text-align:start;cursor:pointer}
.cortexai-agent-hub-toc-compact-label{flex:none;color:var(--cortexai-agent-hub-secondary);font-size:.75rem;font-weight:500}
.cortexai-agent-hub-toc-compact-current{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.cortexai-agent-hub-toc-compact svg{flex:none;color:var(--cortexai-agent-hub-tertiary);transition:transform .2s ease}
@media (prefers-reduced-motion:reduce){.cortexai-agent-hub-toc-compact svg{transition:none}}
.cortexai-agent-hub-toc-compact[aria-expanded="true"] svg{transform:rotate(180deg)}
.cortexai-agent-hub-toc>a,.cortexai-agent-hub-toc>.cortexai-agent-hub-toc-fold{display:none}
.cortexai-agent-hub-toc[data-compact-open]{padding-bottom:12px}
.cortexai-agent-hub-toc[data-compact-open]>a{display:flex;align-items:center;min-height:36px;margin:0 8px;padding:0 6px}
.cortexai-agent-hub-toc[data-compact-open]>.cortexai-agent-hub-toc-fold{display:block;margin:4px 14px 0}
}
@media (max-width:720px){.cortexai-agent-hub-page>.cortexai-agent-hub-header+.cortexai-agent-hub-toc{margin-top:0}.cortexai-agent-hub-equation{grid-template-columns:minmax(0,1fr)}.cortexai-agent-hub-equation-body,.cortexai-agent-hub-equation-label{grid-column:1;justify-self:start}.cortexai-agent-hub-equation-body{flex-wrap:nowrap;white-space:nowrap}}
@media print{.cortexai-agent-hub-floating,.cortexai-agent-hub-backtotop,.cortexai-agent-hub-toc-fold{display:none}.cortexai-agent-hub-section-fold{grid-template-rows:1fr;opacity:1}.cortexai-agent-hub-section-body{overflow:visible}.cortexai-agent-hub-linkcards>li,.cortexai-agent-hub-proscons-card,.cortexai-agent-hub-equation,.cortexai-agent-hub-quote,.cortexai-agent-hub-toc{break-inside:avoid}}
`;
