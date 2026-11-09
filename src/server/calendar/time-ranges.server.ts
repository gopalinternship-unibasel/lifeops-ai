/**
 * Pure time-range helpers shared by chat proposals, manual calendar saves and the weekly
 * planner. All comparisons use epoch milliseconds: ISO strings from Google ("+01:00"),
 * Postgres ("+00:00") and JavaScript (".000Z") do not compare correctly as text.
 */
import { formatTimeInZone, normalizeTimeZone, zonedDateTimeToISO } from "@/server/timezone.server";

export interface TimedEvent {
  id?: string;
  title: string;
  starts_at: string;
  ends_at: string;
  /** All-day or "show as free" events do not block time. Defaults to true. */
  busy?: boolean;
}

export interface TimeSlot {
  start: string;
  end: string;
}

export function toMs(iso: string): number {
  return new Date(iso).getTime();
}

/** Half-open overlap test: [aStart, aEnd) and [bStart, bEnd) share at least one instant. */
export function rangesOverlap(aStartMs: number, aEndMs: number, bStartMs: number, bEndMs: number): boolean {
  return aStartMs < bEndMs && aEndMs > bStartMs;
}

/** Existing busy events that overlap the candidate time range. */
export function findConflicts<T extends TimedEvent>(
  candidate: { starts_at: string; ends_at: string },
  events: T[],
  opts: { ignoreId?: string } = {},
): T[] {
  const start = toMs(candidate.starts_at);
  const end = toMs(candidate.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return events.filter((event) => {
    if (event.busy === false) return false;
    if (opts.ignoreId && event.id === opts.ignoreId) return false;
    const eventStart = toMs(event.starts_at);
    const eventEnd = toMs(event.ends_at);
    if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) return false;
    return rangesOverlap(start, end, eventStart, eventEnd);
  });
}

export function describeConflicts(conflicts: TimedEvent[], timeZone?: string): string {
  const zone = normalizeTimeZone(timeZone);
  const names = conflicts
    .slice(0, 3)
    .map((event) => `"${event.title}" (${formatTimeInZone(event.starts_at, zone)}–${formatTimeInZone(event.ends_at, zone)})`);
  const more = conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : "";
  return `This time overlaps ${names.join(", ")}${more}. Pick a free slot instead.`;
}

const NAIVE_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * Parse a model- or user-supplied date-time. A timestamp WITHOUT an offset is read as wall-clock
 * time in the user's time zone (small models often omit or invent offsets). Returns an ISO
 * string in UTC, or null when the value is not a date-time.
 */
export function parseUserDateTime(value: string, timeZone?: string): string | null {
  const trimmed = value.trim();
  const naive = NAIVE_DATE_TIME.exec(trimmed);
  if (naive) {
    try {
      return zonedDateTimeToISO(
        naive[1],
        { hour: Number(naive[2]), minute: Number(naive[3]), second: Number(naive[4] ?? 0) },
        normalizeTimeZone(timeZone),
      );
    } catch {
      return null;
    }
  }
  const ms = new Date(trimmed).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Convert "HH:MM" on a YYYY-MM-DD date in the user's time zone to an ISO instant. */
export function localTimeToISO(date: string, hhmm: string, timeZone?: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return null;
  try {
    return zonedDateTimeToISO(date, { hour, minute }, normalizeTimeZone(timeZone));
  } catch {
    return null;
  }
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;

/** The next quarter hour at or after `ms` (plan items start on the quarter hour). */
export function nextQuarterHourMs(ms: number): number {
  return Math.ceil(ms / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
}

/**
 * Free slots of at least `minMinutes` between `fromHour` and `toHour` local time.
 * `notBeforeMs` (usually "now") removes the part of the day that is already over: a plan made
 * at 15:08 offers today's time from 15:15 on, and a day that has passed has no free slots.
 */
export function computeFreeSlots(
  date: string,
  events: TimedEvent[],
  timeZone: string,
  opts: { fromHour?: number; toHour?: number; minMinutes?: number; notBeforeMs?: number } = {},
): TimeSlot[] {
  const fromHour = opts.fromHour ?? 7;
  const toHour = opts.toHour ?? 22;
  const minMs = (opts.minMinutes ?? 30) * 60 * 1000;
  const openingMs = toMs(zonedDateTimeToISO(date, { hour: fromHour }, timeZone));
  const dayStartMs =
    opts.notBeforeMs !== undefined && Number.isFinite(opts.notBeforeMs)
      ? Math.max(openingMs, nextQuarterHourMs(opts.notBeforeMs))
      : openingMs;
  const dayEndMs = toMs(zonedDateTimeToISO(date, { hour: toHour }, timeZone));
  if (dayStartMs >= dayEndMs) return [];

  const busy = events
    .filter((event) => event.busy !== false)
    .map((event) => ({ s: toMs(event.starts_at), e: toMs(event.ends_at) }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > dayStartMs && b.s < dayEndMs)
    .map((b) => ({ s: Math.max(b.s, dayStartMs), e: Math.min(b.e, dayEndMs) }))
    .sort((a, b) => a.s - b.s);

  const merged: { s: number; e: number }[] = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else merged.push({ ...b });
  }

  const free: TimeSlot[] = [];
  let cursor = dayStartMs;
  for (const b of merged) {
    if (b.s - cursor >= minMs) {
      free.push({ start: new Date(cursor).toISOString(), end: new Date(b.s).toISOString() });
    }
    cursor = Math.max(cursor, b.e);
  }
  if (dayEndMs - cursor >= minMs) {
    free.push({ start: new Date(cursor).toISOString(), end: new Date(dayEndMs).toISOString() });
  }
  return free;
}

/** True when [start, end) lies entirely inside one of the free slots. */
export function fitsInFreeSlot(startIso: string, endIso: string, free: TimeSlot[]): boolean {
  const start = toMs(startIso);
  const end = toMs(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  return free.some((slot) => start >= toMs(slot.start) && end <= toMs(slot.end));
}
