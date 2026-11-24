/**
 * Which busy events a plan day card shows, and where they sit on its rhythm bar, in the
 * browser's local time. The plan page fetches every event that overlaps the week, but the cards
 * used to test only the start date: an event that ran past midnight showed on its first day
 * only, one that started the Sunday before was on no card at all, and the bar drew a 20:00-02:00
 * event as nothing. Like the calendar page (minutesOnDay), an event now counts on every day it
 * overlaps, clipped at midnight.
 */
import { minutesOnDay } from "@/lib/calendar-grid";

interface Timed {
  starts_at: string;
  ends_at: string;
}

/** Local midnight at the start of a "YYYY-MM-DD" day. */
function localDayStart(ymd: string): Date {
  return new Date(`${ymd}T00:00:00`);
}

/** The events that overlap this local day. */
export function busyForDay<T extends Timed>(events: T[], ymd: string): T[] {
  const day = localDayStart(ymd);
  return events.filter((event) => minutesOnDay(event, day) !== null);
}

/**
 * The part of an event on this day inside the bar's window, as [start, end] minutes after local
 * midnight, or null when none of it falls there.
 */
export function rhythmSegment(
  event: Timed,
  ymd: string,
  windowStart: number = 7 * 60,
  windowEnd: number = 22 * 60,
): [number, number] | null {
  const span = minutesOnDay(event, localDayStart(ymd));
  if (!span) return null;
  const start = Math.max(windowStart, span.start);
  const end = Math.min(windowEnd, span.end);
  return end > start ? [start, end] : null;
}
