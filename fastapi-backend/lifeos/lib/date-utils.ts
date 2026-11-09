const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type Locale = "zh" | "en";

export function todayISO(): string {
  return toISODate(new Date());
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function nextMondayFrom(dateISO: string): Date {
  const d = new Date(dateISO + "T00:00:00");
  const dow = d.getDay();
  const diff = dow === 0 ? 1 : (8 - dow) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

export function buildSevenDaysFrom(
  startISO: string,
  locale: Locale = "zh",
): { date: string; weekday: string }[] {
  const start = new Date(startISO + "T00:00:00");
  const arr = locale === "en" ? WEEKDAY_EN : WEEKDAY_CN;
  const out: { date: string; weekday: string }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push({ date: toISODate(d), weekday: arr[d.getDay()] });
  }
  return out;
}

export function weekdayOf(dateISO: string, locale: Locale = "zh"): string {
  const arr = locale === "en" ? WEEKDAY_EN : WEEKDAY_CN;
  return arr[new Date(dateISO + "T00:00:00").getDay()];
}

const MONTH_EN = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatHumanDate(dateISO: string, locale: Locale = "zh"): string {
  const d = new Date(dateISO + "T00:00:00");
  if (locale === "en") return `${MONTH_EN[d.getMonth()]} ${d.getDate()}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
