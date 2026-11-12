import type { CSSProperties } from "react";
import type { Words } from "./labels.js";
import { useWords } from "./labels.js";

type EventFlags = { title?: string; free?: boolean; selected?: boolean };
type MonthEvent = EventFlags & { date?: string };
type WeekEvent = EventFlags & { date?: string; start?: number; end?: number };
type DayEvent = EventFlags & { start?: number; end?: number };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// 2024-01-01 was a Monday, so its week names the days Monday first.
const WEEK = Array.from({ length: 7 }, (_, index) => Date.UTC(2024, 0, 1 + index));
/** Rows a month cell shows before the rest fold into "+N more". */
const MONTH_CELL_EVENTS = 2;
const HOUR_HEIGHT = 44;

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/** "YYYY-MM-DD" as a UTC date, so no time zone can move it to another day. */
export function parseDay(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = DAY.exec(value.trim());
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  // Date.UTC rolls a day, month or two-digit year it cannot hold into another date, so only a
  // date that reads back as the same text is real.
  return dayKey(date) === match[0] ? date : undefined;
}

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
/** Monday is the first day of the week. */
const weekday = (date: Date) => (date.getUTCDay() + 6) % 7;

function hourLabel(words: Words, hour: number): string {
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  return words.date(Date.UTC(1970, 0, 1, whole % 24, minutes), {
    hour: "numeric",
    minute: minutes ? "2-digit" : undefined,
    timeZone: "UTC",
  });
}

const weekdayNames = (words: Words) =>
  WEEK.map((time) => words.date(time, { weekday: "short", timeZone: "UTC" }));

const title = (event: EventFlags) =>
  typeof event.title === "string" || typeof event.title === "number" ? String(event.title) : "";

function kindOf(event: EventFlags) {
  if (event.selected === true) return "selected";
  if (event.free === true) return "free";
  return undefined;
}

function Chip({ event }: { event: MonthEvent }) {
  const name = title(event);
  return (
    <li className="cortexai-agent-hub-cal-chip" data-kind={kindOf(event)} title={name}>
      <span>{name}</span>
    </li>
  );
}

export function MonthView({
  month,
  events,
  today,
}: {
  month?: string;
  events?: MonthEvent[];
  today?: string;
}) {
  const words = useWords();
  const first = parseDay(`${typeof month === "string" ? month.trim().slice(0, 7) : ""}-01`);
  if (!first) return null;
  const byDay = new Map<string, MonthEvent[]>();
  for (const event of Array.isArray(events) ? events : []) {
    const date = parseDay(event?.date);
    if (!date || !title(event)) continue;
    const key = dayKey(date);
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(event);
  }
  const todayKey = parseDay(today) ? today!.trim() : undefined;
  const start = addDays(first, -weekday(first));
  const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  const weeks = Math.ceil((next.getTime() - start.getTime()) / (7 * 86_400_000));
  const label = words.date(first.getTime(), { month: "long", year: "numeric", timeZone: "UTC" });
  const weekdays = weekdayNames(words);
  return (
    <div className="cortexai-agent-hub-cal">
      <table className="cortexai-agent-hub-cal-month" aria-label={label}>
        <thead>
          <tr>
            {weekdays.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: weeks }, (_, week) => (
            <tr key={week}>
              {weekdays.map((_, column) => {
                const date = addDays(start, week * 7 + column);
                const inMonth = date.getUTCMonth() === first.getUTCMonth();
                const key = dayKey(date);
                const list = inMonth ? (byDay.get(key) ?? []) : [];
                const shown =
                  list.length > MONTH_CELL_EVENTS + 1 ? list.slice(0, MONTH_CELL_EVENTS) : list;
                const rest = list.slice(shown.length);
                return (
                  <td key={column} data-outside={!inMonth || undefined}>
                    {inMonth ? (
                      <div className="cortexai-agent-hub-cal-day">
                        <span
                          className="cortexai-agent-hub-cal-date"
                          data-today={key === todayKey || undefined}
                          aria-current={key === todayKey ? "date" : undefined}
                        >
                          {date.getUTCDate()}
                        </span>
                        {list.length ? (
                          <ul className="cortexai-agent-hub-cal-chips">
                            {shown.map((event, index) => (
                              <Chip key={index} event={event} />
                            ))}
                            {rest.length ? (
                              <li>
                                <details>
                                  <summary className="cortexai-agent-hub-cal-more">
                                    +{rest.length}
                                    <span className="cortexai-agent-hub-cal-more-word">
                                      {" "}
                                      {words.t("more", { count: rest.length })}
                                    </span>
                                  </summary>
                                  <ul className="cortexai-agent-hub-cal-chips">
                                    {rest.map((event, index) => (
                                      <Chip key={index} event={event} />
                                    ))}
                                  </ul>
                                </details>
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const hour = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(24, Math.max(0, value))
    : undefined;

/** An event without an end lasts an hour, everywhere it is drawn, fitted or marked done. */
const endOf = (event: { start?: unknown; end?: unknown }) => {
  const start = hour(event.start);
  return hour(event.end) ?? (start === undefined ? undefined : Math.min(24, start + 1));
};

function bounds(start: unknown, end: unknown, events: { start?: number; end?: number }[]) {
  const times = events
    .flatMap((event) => [hour(event.start), endOf(event)])
    .filter((value): value is number => value !== undefined);
  let from = hour(start) ?? (times.length ? Math.floor(Math.min(...times)) : 8);
  let to = hour(end) ?? (times.length ? Math.ceil(Math.max(...times)) : 18);
  if (to <= from) [from, to] = [Math.min(from, to), Math.max(from, to) + 1];
  return { from: Math.floor(from), to: Math.min(24, Math.ceil(to)) };
}

function eventLanes<T extends DayEvent>(events: T[], from: number, to: number) {
  const sorted = events
    .map((event, index) => ({
      event,
      index,
      start: Math.max(from, hour(event.start) ?? from),
      end: Math.min(to, hour(event.end) ?? (hour(event.start) ?? from) + 1),
      lane: 0,
      lanes: 1,
    }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start || a.index - b.index);
  let group: typeof sorted = [];
  let ends: number[] = [];
  let until = -Infinity;
  const finish = () => {
    for (const item of group) item.lanes = ends.length;
  };
  for (const item of sorted) {
    if (item.start >= until) {
      finish();
      group = [];
      ends = [];
    }
    const available = ends.findIndex((end) => end <= item.start);
    item.lane = available < 0 ? ends.length : available;
    ends[item.lane] = item.end;
    until = group.length ? Math.max(until, item.end) : item.end;
    group.push(item);
  }
  finish();
  return sorted;
}

function TimedEvent({
  event,
  from,
  to,
  done,
  times = false,
  lane = 0,
  lanes = 1,
}: {
  event: DayEvent;
  from: number;
  to: number;
  done?: boolean;
  /** A day column is wide enough to show each event's times. */
  times?: boolean;
  lane?: number;
  lanes?: number;
}) {
  const words = useWords();
  const originalStart = hour(event.start) ?? from;
  const originalEnd = hour(event.end) ?? originalStart + 1;
  if (originalEnd <= originalStart || originalEnd <= from || originalStart >= to) return null;
  const start = Math.max(from, originalStart);
  const end = Math.min(to, originalEnd);
  const name = title(event);
  const style = {
    top: (start - from) * HOUR_HEIGHT + 1,
    height: Math.max(2, (end - start) * HOUR_HEIGHT - 2),
    left: `calc(${(lane / lanes) * 100}% + 3px)`,
    right: `calc(${(1 - (lane + 1) / lanes) * 100}% + 3px)`,
  } as CSSProperties;
  return (
    <div
      className="cortexai-agent-hub-cal-event"
      data-kind={kindOf(event)}
      data-done={done || undefined}
      style={style}
      title={words.t("eventTime", {
        name,
        start: hourLabel(words, start),
        end: hourLabel(words, end),
      })}
    >
      <span className="cortexai-agent-hub-cal-event-title">{name}</span>
      {times && end - start >= 0.75 ? (
        <span className="cortexai-agent-hub-cal-event-time">
          {hourLabel(words, start)} – {hourLabel(words, end)}
        </span>
      ) : null}
    </div>
  );
}

function Hours({ from, to }: { from: number; to: number }) {
  const words = useWords();
  return (
    <div className="cortexai-agent-hub-cal-hours" aria-hidden="true">
      {Array.from({ length: to - from + 1 }, (_, index) => (
        <span key={index} style={{ top: index * HOUR_HEIGHT }}>
          {hourLabel(words, from + index)}
        </span>
      ))}
    </div>
  );
}

function NowLine({ at, from, to }: { at: number | undefined; from: number; to: number }) {
  if (at === undefined || at < from || at > to) return null;
  return (
    <span
      className="cortexai-agent-hub-cal-now"
      style={{ top: (at - from) * HOUR_HEIGHT }}
      aria-hidden="true"
    />
  );
}

export function WeekView({
  week,
  start,
  end,
  events,
  today,
  now,
}: {
  week?: string;
  start?: number;
  end?: number;
  events?: WeekEvent[];
  today?: string;
  now?: number;
}) {
  const words = useWords();
  const weekdays = weekdayNames(words);
  const first = parseDay(week);
  if (!first) return null;
  const list = (Array.isArray(events) ? events : []).filter(
    (event) => event && title(event) && parseDay(event.date),
  );
  const { from, to } = bounds(start, end, list);
  const todayKey = parseDay(today) ? today!.trim() : undefined;
  const days = Array.from({ length: 7 }, (_, index) => addDays(first, index));
  return (
    <section
      className="cortexai-agent-hub-cal cortexai-agent-hub-cal-timed"
      aria-label={words.t("weekOf", {
        date: words.date(first.getTime(), { month: "long", day: "numeric", timeZone: "UTC" }),
      })}
    >
      <div className="cortexai-agent-hub-cal-heads">
        {days.map((date) => {
          const key = dayKey(date);
          return (
            <span key={key} className="cortexai-agent-hub-cal-head">
              {weekdays[weekday(date)]}{" "}
              <span
                className="cortexai-agent-hub-cal-date"
                data-today={key === todayKey || undefined}
                aria-current={key === todayKey ? "date" : undefined}
              >
                {date.getUTCDate()}
              </span>
            </span>
          );
        })}
      </div>
      <div className="cortexai-agent-hub-cal-body" style={{ height: (to - from) * HOUR_HEIGHT }}>
        <Hours from={from} to={to} />
        <div className="cortexai-agent-hub-cal-columns">
          {days.map((date) => {
            const key = dayKey(date);
            return (
              <div
                className="cortexai-agent-hub-cal-column"
                key={key}
                data-today={key === todayKey || undefined}
              >
                {eventLanes(
                  list.filter((event) => event.date!.trim() === key),
                  from,
                  to,
                ).map(({ event, index, lane, lanes }) => (
                  <TimedEvent
                    key={index}
                    event={event}
                    from={from}
                    to={to}
                    lane={lane}
                    lanes={lanes}
                  />
                ))}
                {key === todayKey ? <NowLine at={hour(now)} from={from} to={to} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function DayView({
  start,
  end,
  events,
  mark,
}: {
  start?: number;
  end?: number;
  events?: DayEvent[];
  mark?: { at?: number };
}) {
  const words = useWords();
  const list = (Array.isArray(events) ? events : []).filter((event) => event && title(event));
  const { from, to } = bounds(start, end, list);
  const at = hour(mark?.at);
  return (
    <section
      className="cortexai-agent-hub-cal cortexai-agent-hub-cal-timed"
      aria-label={words.t("day")}
    >
      <div className="cortexai-agent-hub-cal-body" style={{ height: (to - from) * HOUR_HEIGHT }}>
        <Hours from={from} to={to} />
        <div className="cortexai-agent-hub-cal-columns">
          <div className="cortexai-agent-hub-cal-column">
            {eventLanes(list, from, to).map(({ event, index, lane, lanes }) => (
              <TimedEvent
                key={index}
                event={event}
                lane={lane}
                lanes={lanes}
                from={from}
                to={to}
                done={at !== undefined && (endOf(event) ?? Number.POSITIVE_INFINITY) <= at}
                times
              />
            ))}
            <NowLine at={at} from={from} to={to} />
          </div>
        </div>
      </div>
    </section>
  );
}

export const CALENDAR_CSS = `
.cortexai-agent-hub-cal{min-width:0;padding:16px 20px 20px;border:1px solid var(--cortexai-agent-hub-line);border-radius:16px;font-variant-numeric:tabular-nums;overflow-x:auto}
.cortexai-agent-hub-cal-month{width:100%;min-width:320px;table-layout:fixed;border-collapse:collapse}
.cortexai-agent-hub-cal-month th{padding:0 0 6px 8px;font-size:12px;line-height:16px;font-weight:400;text-align:left;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-cal-month td{height:68px;padding:0;vertical-align:top;border:1px solid var(--cortexai-agent-hub-hairline)}
.cortexai-agent-hub-cal-month td[data-outside]{background:color-mix(in srgb,var(--foreground) 2%,transparent)}
.cortexai-agent-hub-cal-day{display:flex;flex-direction:column;gap:4px;min-width:0;padding:6px 4px}
.cortexai-agent-hub-cal-date{display:inline-flex;align-items:center;justify-content:center;align-self:flex-start;min-width:22px;height:22px;padding:0 4px;border-radius:9999px;font-size:12px;line-height:16px}
.cortexai-agent-hub-cal-date[data-today]{background:var(--destructive-fill);color:var(--destructive-foreground);font-weight:600}
.cortexai-agent-hub-cal-chips{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;min-width:0}
.cortexai-agent-hub-cal-chip,.cortexai-agent-hub-cal-more{min-width:0;height:20px;padding:2px 6px;border-radius:6px;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cortexai-agent-hub-cal-chip{position:relative;height:auto;padding:2px 5px;white-space:normal;background:color-mix(in srgb,var(--cortexai-agent-hub-c1) 22%,transparent);color:color-mix(in srgb,var(--cortexai-agent-hub-c1) 55%,var(--foreground))}
.cortexai-agent-hub-cal-chip>span{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:break-word}
.cortexai-agent-hub-cal-chip[data-kind="selected"],.cortexai-agent-hub-cal-event[data-kind="selected"]{background:var(--cortexai-agent-hub-c1);color:var(--cortexai-agent-hub-on-c1)}
.cortexai-agent-hub-cal-event[data-kind="selected"] .cortexai-agent-hub-cal-event-time{opacity:1}
.cortexai-agent-hub-cal-chip[data-kind="free"],.cortexai-agent-hub-cal-event[data-kind="free"]{background:color-mix(in srgb,var(--foreground) 3%,transparent);color:var(--cortexai-agent-hub-secondary);outline:1px dashed var(--cortexai-agent-hub-line);outline-offset:-1px}
.cortexai-agent-hub-cal-more{padding:1px 7px;border:1px solid var(--cortexai-agent-hub-line);color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-cal-timed{padding-top:12px}
.cortexai-agent-hub-cal-heads{display:grid;grid-template-columns:repeat(7,minmax(64px,1fr));margin-left:60px;padding-bottom:6px}
.cortexai-agent-hub-cal-head{display:flex;align-items:center;gap:2px;padding-left:6px;font-size:12px;line-height:16px;color:var(--cortexai-agent-hub-secondary);white-space:nowrap}
.cortexai-agent-hub-cal-head .cortexai-agent-hub-cal-date{color:var(--foreground);font-weight:500}
.cortexai-agent-hub-cal-head .cortexai-agent-hub-cal-date[data-today]{color:var(--destructive-foreground)}
.cortexai-agent-hub-cal-body{position:relative;margin:9px 0;min-width:0}
.cortexai-agent-hub-cal-hours span{position:absolute;left:0;width:52px;transform:translateY(-50%);font-size:12px;line-height:16px;text-align:right;color:var(--cortexai-agent-hub-secondary);white-space:nowrap}
.cortexai-agent-hub-cal-columns{position:absolute;inset:0 0 0 60px;display:grid;grid-template-columns:repeat(auto-fit,minmax(64px,1fr));border-left:1px solid var(--cortexai-agent-hub-hairline);background:repeating-linear-gradient(to bottom,var(--cortexai-agent-hub-hairline) 0 1px,transparent 1px ${HOUR_HEIGHT}px)}
.cortexai-agent-hub-cal-columns::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--cortexai-agent-hub-hairline)}
.cortexai-agent-hub-cal-column{position:relative;min-width:0;border-right:1px solid var(--cortexai-agent-hub-hairline)}
.cortexai-agent-hub-cal-column[data-today]{background:color-mix(in srgb,var(--cortexai-agent-hub-c1) 4%,transparent)}
.cortexai-agent-hub-cal-event{position:absolute;left:3px;right:3px;display:flex;flex-direction:column;gap:1px;padding:3px 7px;overflow:hidden;border-radius:6px;background:color-mix(in srgb,var(--cortexai-agent-hub-c1) 22%,transparent);color:color-mix(in srgb,var(--cortexai-agent-hub-c1) 55%,var(--foreground));font-size:12px;line-height:16px}
.cortexai-agent-hub-cal-event-title{font-weight:500;overflow-wrap:break-word;hyphens:auto}
.cortexai-agent-hub-cal-event-time{font-size:11px;opacity:.8;white-space:nowrap}
.cortexai-agent-hub-cal-event:has(.cortexai-agent-hub-cal-event-time){flex-direction:row;align-items:baseline;gap:8px}
.cortexai-agent-hub-cal-event[data-done]{opacity:.72}
.cortexai-agent-hub-cal-event[data-done] .cortexai-agent-hub-cal-event-title{text-decoration:line-through}
.cortexai-agent-hub-cal-now{position:absolute;left:-4px;right:0;height:2px;margin-top:-1px;background:var(--cortexai-agent-hub-danger);z-index:1}
.cortexai-agent-hub-cal-now::before{content:"";position:absolute;left:-4px;top:-3px;width:8px;height:8px;border-radius:50%;background:var(--cortexai-agent-hub-danger)}
@media (max-width:640px){.cortexai-agent-hub-cal-more-word{display:none}.cortexai-agent-hub-cal{padding:12px}.cortexai-agent-hub-cal-month td{height:56px}.cortexai-agent-hub-cal-day{padding:4px 2px}.cortexai-agent-hub-cal-heads,.cortexai-agent-hub-cal-columns{min-width:448px}.cortexai-agent-hub-cal-timed .cortexai-agent-hub-cal-body{min-width:508px}.cortexai-agent-hub-cal-timed{overflow-x:auto}}
@media print{.cortexai-agent-hub-cal{break-inside:avoid;overflow:visible}}
`;
