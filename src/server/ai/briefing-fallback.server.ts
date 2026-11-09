/**
 * Rule-based first-visit briefing, used only when the AI model does not answer the automatic
 * "check my emails" request (a CPU-only local model under load can take longer than the
 * timeout). It lists the inbox and today's calendar exactly as the model is asked to, and ranks
 * priorities with the same rule the model gets: today's events by length (longer first, then
 * earlier), then the tasks found in emails by importance. An email task about one of today's
 * remaining events (the demo's "Team sync at 7 PM" email and the 7 PM team sync) is the same
 * commitment: it is folded into that event's line instead of being ranked twice. Everything is
 * labelled as rule-based.
 */
import { formatTimeInZone, normalizeTimeZone } from "@/server/timezone.server";
import type { PriorityRow } from "@/types/panel";

export interface BriefingEmail {
  from: string;
  subject: string;
  snippet: string;
  unread?: boolean;
  extractedTask?: { title: string; importance: "high" | "medium" | "low" };
}

export interface BriefingEvent {
  title: string;
  starts_at: string;
  ends_at: string;
}

const IMPORTANCE_ORDER = { high: 0, medium: 1, low: 2 } as const;

function oneLine(text: string, max: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Words that say nothing about WHICH commitment an email or event is about.
const GENERIC_WORDS = new Set([
  "the", "and", "for", "with", "from", "your", "you", "our", "this", "that", "are", "was", "will",
  "today", "tonight", "tomorrow", "now", "moved", "move", "moving", "rescheduled", "reschedule",
  "meeting", "call", "event", "about", "please", "prepare", "prep", "revise", "reply", "update",
  "new", "time", "re", "fw", "fwd",
]);

/** The words that identify a commitment: lowercase, 3+ letters, generic words left out. */
export function significantWords(text: string): Set<string> {
  const words = (text ?? "").toLowerCase().normalize("NFKD").match(/[a-z][a-z0-9]{2,}/g) ?? [];
  return new Set(words.filter((word) => !GENERIC_WORDS.has(word)));
}

/** Clock times written in a text ("7 PM", "7:30pm", "19:00"), as "HH:MM" on a 24-hour clock. */
export function mentionedClockTimes(text: string): Set<string> {
  const times = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const m of (text ?? "").matchAll(/\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*([ap])\.?\s?m\b\.?/gi)) {
    const hour = (Number(m[1]) % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
    times.add(`${pad(hour)}:${m[2] ?? "00"}`);
  }
  for (const m of (text ?? "").matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) times.add(`${pad(Number(m[1]))}:${m[2]}`);
  return times;
}

function localClock(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

/**
 * True when an email (its extracted task, subject and snippet) is about this calendar event:
 * at least two identifying words in common and, if the email names a clock time, the event
 * starts at that time.
 */
export function isSameCommitment(event: BriefingEvent, email: BriefingEmail, timeZone: string): boolean {
  const emailText = [email.extractedTask?.title ?? "", email.subject, email.snippet].join(" ");
  const eventWords = significantWords(event.title);
  let shared = 0;
  for (const word of significantWords(`${email.extractedTask?.title ?? ""} ${email.subject}`)) {
    if (eventWords.has(word)) shared++;
  }
  if (shared < 2) return false;
  const times = mentionedClockTimes(emailText);
  return times.size === 0 || times.has(localClock(event.starts_at, timeZone));
}

export function buildRuleBasedBriefing(opts: {
  emails: BriefingEmail[];
  unreadCount: number;
  todayEvents: BriefingEvent[];
  timeZone?: string;
  reason: string;
  nowMs?: number;
  maxPriorities?: number;
  /** First line instead of "The AI model did not answer (reason) ..." */
  header?: string;
  /** Say that the priorities on the right are ranked by rule (default true). */
  prioritiesNote?: boolean;
}): { reply: string; priorities: PriorityRow[] } {
  const timeZone = normalizeTimeZone(opts.timeZone);
  const nowMs = opts.nowMs ?? Date.now();
  const time = (iso: string) => formatTimeInZone(iso, timeZone);
  const minutes = (event: BriefingEvent) =>
    Math.max(0, Math.round((Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60000));

  const unread = opts.emails.filter((email) => email.unread);
  const events = [...opts.todayEvents].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

  const lines: string[] = [
    opts.header ??
      `⚠️ The AI model did not answer (${oneLine(opts.reason, 160)}), so this briefing was put together by simple rules. Ask again later for the AI's own ranking.`,
    "",
    `**📬 Inbox (${opts.unreadCount} unread)**`,
  ];
  if (unread.length === 0) lines.push("No unread emails — inbox is clear.");
  for (const email of unread) {
    lines.push(`- **${oneLine(email.from, 60)}** — *${oneLine(email.subject, 90)}* — ${oneLine(email.snippet, 120)}`);
  }
  lines.push("", "**📅 Today**");
  if (events.length === 0) lines.push("Nothing scheduled today.");
  for (const event of events) lines.push(`- ${time(event.starts_at)} – ${time(event.ends_at)} ${oneLine(event.title, 90)}`);
  if (opts.prioritiesNote !== false) {
    lines.push(
      "",
      "Priorities are on the right, ranked by rule: today's remaining events by length, then the tasks in your emails by importance.",
    );
  }

  const candidates: { title: string; reason: string }[] = [];
  const upcomingToday = events
    .filter((event) => Date.parse(event.ends_at) > nowMs)
    .sort((a, b) => minutes(b) - minutes(a) || Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const tasks = opts.emails
    .filter((email) => email.extractedTask)
    .sort((a, b) => IMPORTANCE_ORDER[a.extractedTask!.importance] - IMPORTANCE_ORDER[b.extractedTask!.importance]);
  // An email task about one of these events is the same commitment: one line, with the email noted.
  const folded = new Set<BriefingEmail>();
  for (const event of upcomingToday) {
    const about = tasks.filter((email) => !folded.has(email) && isSameCommitment(event, email, timeZone));
    for (const email of about) folded.add(email);
    const fromEmails = about
      .map((email) => `also in ${oneLine(email.from, 50)}'s email: ${oneLine(email.extractedTask!.title, 80)}`)
      .join("; ");
    candidates.push({
      title: oneLine(event.title, 120),
      reason: `${minutes(event)} min block today (${time(event.starts_at)}–${time(event.ends_at)}) — fixed commitment${fromEmails ? `; ${fromEmails}` : ""}`,
    });
  }
  for (const email of tasks) {
    if (folded.has(email)) continue;
    candidates.push({
      title: oneLine(email.extractedTask!.title, 120),
      reason: `From ${oneLine(email.from, 50)}'s email — ${email.extractedTask!.importance} importance`,
    });
  }
  // A real inbox has no extracted tasks: unread emails become "handle this" items.
  if (tasks.length === 0) {
    for (const email of unread) {
      candidates.push({ title: `Reply to: ${oneLine(email.subject, 100)}`, reason: `Unread email from ${oneLine(email.from, 50)}` });
    }
  }

  const seen = new Set<string>();
  const priorities: PriorityRow[] = [];
  for (const candidate of candidates) {
    const key = candidate.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    priorities.push({ rank: priorities.length + 1, ...candidate });
    if (priorities.length >= (opts.maxPriorities ?? 6)) break;
  }
  return { reply: lines.join("\n"), priorities };
}

/** Lowercase letters and digits only, single spaces: "*Team sync — demo*" -> "team sync demo". */
function plain(text: string): string {
  return (text ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Does the model's briefing text cover the inbox and today's calendar? Every unread email's
 * subject (its first three words) and every event of today (the first two words of its title)
 * must appear, and it must not claim an empty inbox or an empty day when there is mail or
 * an event. A small local model wrote "No unread emails — inbox is clear" next to four unread
 * emails, and "Nothing scheduled today" on a day with an event (9 Nov 2026).
 */
export function briefingCoversInbox(opts: {
  reply: string;
  emails: BriefingEmail[];
  unreadCount: number;
  todayEvents: BriefingEvent[];
}): boolean {
  const text = plain(opts.reply);
  const unread = opts.emails.filter((email) => email.unread);
  if (opts.unreadCount > 0 && /no unread emails|inbox is clear/.test(text)) return false;
  if (opts.todayEvents.length > 0 && /nothing scheduled today/.test(text)) return false;
  const firstWords = (value: string, n: number) => plain(value).split(" ").slice(0, n).join(" ");
  const subjectsCovered = unread.every((email) => text.includes(firstWords(email.subject, 3)));
  const eventsCovered = opts.todayEvents.every((event) => text.includes(firstWords(event.title, 2)));
  return subjectsCovered && eventsCovered;
}
