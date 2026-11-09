const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

type DateParts = { year: number; month: number; day: number };
type DateTimeParts = DateParts & { hour: number; minute: number; second: number };

function parseDate(date: string): DateParts {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error("Expected a date in YYYY-MM-DD format");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error("Invalid calendar date");
  }
  return { year, month, day };
}

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function normalizeTimeZone(value?: string): string {
  const candidate = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "UTC";
  }
}

export function addDaysISO(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return formatUtcDate(result);
}

export function mondayOfISODate(date: string): string {
  const { year, month, day } = parseDate(date);
  const result = new Date(Date.UTC(year, month - 1, day));
  const dow = result.getUTCDay();
  result.setUTCDate(result.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return formatUtcDate(result);
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}

function partsAt(instantMs: number, timeZone: string): DateTimeParts {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function offsetAt(instantMs: number, timeZone: string): number {
  const rounded = Math.floor(instantMs / 1000) * 1000;
  const p = partsAt(rounded, timeZone);
  const representedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return representedAsUtc - rounded;
}

/** Convert a wall-clock time in an IANA zone to an absolute ISO timestamp. */
export function zonedDateTimeToISO(
  date: string,
  time: { hour: number; minute?: number; second?: number; millisecond?: number },
  requestedTimeZone?: string,
): string {
  const { year, month, day } = parseDate(date);
  const timeZone = normalizeTimeZone(requestedTimeZone);
  const targetWallClock = Date.UTC(
    year,
    month - 1,
    day,
    time.hour,
    time.minute ?? 0,
    time.second ?? 0,
    time.millisecond ?? 0,
  );

  let instant = targetWallClock;
  for (let i = 0; i < 3; i += 1) {
    const next = targetWallClock - offsetAt(instant, timeZone);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant).toISOString();
}

export function todayInTimeZone(requestedTimeZone?: string): string {
  const timeZone = normalizeTimeZone(requestedTimeZone);
  const p = partsAt(Date.now(), timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * The local wall-clock date and time of an instant in a zone: date "YYYY-MM-DD", minutes after
 * local midnight, "HH:MM" (24-hour) and the weekday (0 = Sunday).
 */
export function localDateTime(
  iso: string | number,
  requestedTimeZone?: string,
): { date: string; minutes: number; hhmm: string; weekday: number } {
  const ms = typeof iso === "number" ? iso : new Date(iso).getTime();
  const p = partsAt(ms, normalizeTimeZone(requestedTimeZone));
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return { date, minutes: p.hour * 60 + p.minute, hhmm, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}

export function formatTimeInZone(iso: string, requestedTimeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: normalizeTimeZone(requestedTimeZone),
    hour: "numeric",
    minute: "2-digit",
  });
}
