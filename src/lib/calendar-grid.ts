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

/**
 * Monday 00:00 (local time) of the week that contains `d`. Weeks start on Monday everywhere in
 * the app (Plan, dashboard, the chat's date words); the calendar used to start them on Sunday,
 * so a plan's Sunday showed up in the calendar's next week.
 */
export function startOfWeekMonday(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = x.getDay(); // 0 = Sunday
  x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow));
  return x;
}

/**
 * Label of an hour row in the locale's own clock: "19:00" where a 24-hour clock is used (with
 * the same options as the event times, so both read alike), "7 PM" and "12 AM" where a 12-hour
 * clock is. The labels used to be a hand-written "h AM/PM" that printed "0 AM" for midnight
 * and ignored the locale, while the event times on the same grid used it. The 12-hour form
 * leaves out ":00" so it fits the narrow hour column.
 */
export function hourLabel(hour: number, locale?: string | string[]): string {
  const at = new Date(2000, 0, 1, hour);
  const hourOnly = new Intl.DateTimeFormat(locale, { hour: "numeric" });
  const twelveHour = hourOnly.formatToParts(at).some((part) => part.type === "dayPeriod");
  return twelveHour ? hourOnly.format(at) : at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/**
 * An event box shorter than this (in px) cannot show a title line and a time line: 1 px borders,
 * 4 px padding top and bottom and two 11 px lines at leading-tight need about 38 px. A shorter
 * event (30 or 45 minutes at 48 px an hour) shows title and start time on one line instead, so
 * its time is not cut off.
 */
export const TWO_LINE_EVENT_MIN_PX = 38;

export function isCompactEvent(heightPx: number): boolean {
  return heightPx < TWO_LINE_EVENT_MIN_PX;
}

/**
 * From this height (in px) an event box has room for its time range to wrap onto a second line
 * (three lines in all). A shorter box keeps the time on one line, cut with an ellipsis if
 * needed, instead of showing the top half of a wrapped line.
 */
export const THREE_LINE_EVENT_MIN_PX = 52;

export function canWrapEventTime(heightPx: number): boolean {
  return heightPx >= THREE_LINE_EVENT_MIN_PX;
}

/**
 * Settle `promise` into the handlers unless the returned cancel function was called first. The
 * calendar starts one load per week it shows; when the user moves on before a load finishes,
 * the old week's late answer must not replace the week on screen (it used to: the grid went
 * empty and "No events this week" stayed hidden).
 */
export function settleUnlessCancelled<T>(
  promise: Promise<T>,
  handlers: { onResult: (value: T) => void; onError: (error: unknown) => void; onSettled?: () => void },
): () => void {
  let cancelled = false;
  promise
    .then((value) => {
      if (!cancelled) handlers.onResult(value);
    })
    .catch((error: unknown) => {
      if (!cancelled) handlers.onError(error);
    })
    .finally(() => {
      if (!cancelled) handlers.onSettled?.();
    });
  return () => {
    cancelled = true;
  };
}
