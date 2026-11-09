/**
 * Layout of the week view (/app/calendar), in the browser's local time. The grid normally shows
 * 06:00-24:00, but it starts earlier when an event of the week starts earlier: an event at
 * 04:00-05:30 used to be dropped without a trace (QA round 3). Events are placed on every day
 * they overlap, so one that runs past midnight also shows on the next morning.
 */
export const DEFAULT_START_HOUR = 6;
/** The last hour row (23 = the 23:00-24:00 row). */
export const END_HOUR = 23;

export interface GridEvent {
  starts_at: string;
  ends_at: string;
}

/** Minutes after local midnight where the event starts and ends on this day, or null if it is not on it. */
export function minutesOnDay(event: GridEvent, dayStart: Date): { start: number; end: number } | null {
  const startOfDay = new Date(dayStart);
  startOfDay.setHours(0, 0, 0, 0);
  const nextDay = new Date(startOfDay);
  nextDay.setDate(nextDay.getDate() + 1);
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  if (end <= startOfDay || start >= nextDay || end <= start) return null;
  return {
    start: start < startOfDay ? 0 : start.getHours() * 60 + start.getMinutes(),
    end: end >= nextDay ? 24 * 60 : end.getHours() * 60 + end.getMinutes(),
  };
}

/** The first hour row: 6, or earlier when an event of these days starts earlier. */
export function firstHour(events: GridEvent[], days: Date[]): number {
  let first = DEFAULT_START_HOUR;
  for (const day of days) {
    for (const event of events) {
      const span = minutesOnDay(event, day);
      if (span) first = Math.min(first, Math.floor(span.start / 60));
    }
  }
  return first;
}

/** Top and height in pixels inside a day column whose first row is `startHour`. */
export function positionOnDay(
  event: GridEvent,
  day: Date,
  startHour: number,
  hourPx: number,
): { top: number; height: number } | null {
  const span = minutesOnDay(event, day);
  if (!span) return null;
  const gridStart = startHour * 60;
  const gridEnd = (END_HOUR + 1) * 60;
  const start = Math.max(span.start, gridStart);
  const end = Math.min(span.end, gridEnd);
  if (end <= start) return null;
  return { top: ((start - gridStart) / 60) * hourPx, height: Math.max(20, ((end - start) / 60) * hourPx - 2) };
}
