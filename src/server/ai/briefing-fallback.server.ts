/**
 * Rule-based first-visit briefing, used only when the AI model does not answer the automatic
 * "check my emails" request (a CPU-only local model under load can take longer than the
 * timeout). It lists the inbox and today's calendar exactly as the model is asked to, and ranks
 * priorities with the same rule the model gets: today's events by length (longer first, then
 * earlier), then the tasks found in emails by importance. An email task about one of today's
 * remaining events (the demo's "Team sync at 7 PM" email and the 7 PM team sync) is the same
 * commitment: it is folded into that event's line instead of being ranked twice, and once that
 * event is over the email task is not ranked at all. Everything is labelled as rule-based.
 */
import { formatTimeInZone, normalizeTimeZone } from "@/server/timezone.server";
import { rangesOverlap } from "@/server/calendar/time-ranges.server";
import { removeSentences } from "@/server/ai/reply-guard.server";
import type { PriorityRow } from "@/types/panel";

export interface BriefingEmail {
  from: string;
  subject: string;
  snippet: string;
  unread?: boolean;
  extractedTask?: { title: string; importance: "high" | "medium" | "low"; deadline?: string };
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

/**
 * The sender's name from a From header: "Prof. Marlow <marlow@university.edu>" -> "Prof. Marlow".
 * The whole header made reasons such as "From Prof. Marlow <marlow@university.edu>'s email"
 * (review of 24 Nov 2026). A header that is only an address stays as it is.
 */
export function senderName(from: string): string {
  const name = (from ?? "").replace(/\s*<[^>]*>\s*$/, "").replace(/^"(.*)"$/, "$1").trim();
  return name || (from ?? "").replace(/^<(.*)>$/, "$1").trim();
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

  // The reason is a sentence for the reader (the caller makes sure it holds no developer detail
  // on a hosted site); with none, the header gives no empty brackets.
  const reason = oneLine(opts.reason, 160);
  const lines: string[] = [
    opts.header ??
      `⚠️ The AI model did not answer${reason ? ` (${reason})` : ""}, so this briefing was put together by simple rules. Ask again later for the AI's own ranking.`,
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
  // An email task about one of today's events that is already over is done with the event: it is
  // not ranked on its own (QA saw "Team sync at 7 PM" ranked at 21:33, after the 19:00 sync).
  for (const event of events.filter((e) => Date.parse(e.ends_at) <= nowMs)) {
    for (const email of tasks) if (isSameCommitment(event, email, timeZone)) folded.add(email);
  }
  for (const event of upcomingToday) {
    const about = tasks.filter((email) => !folded.has(email) && isSameCommitment(event, email, timeZone));
    for (const email of about) folded.add(email);
    const fromEmails = about
      .map((email) => `also in ${oneLine(senderName(email.from), 50)}'s email: ${oneLine(email.extractedTask!.title, 80)}`)
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
      reason: `From ${oneLine(senderName(email.from), 50)}'s email — ${email.extractedTask!.importance} importance`,
    });
  }
  // A real inbox has no extracted tasks: unread emails become "handle this" items.
  if (tasks.length === 0) {
    for (const email of unread) {
      candidates.push({ title: `Reply to: ${oneLine(email.subject, 100)}`, reason: `Unread email from ${oneLine(senderName(email.from), 50)}` });
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
 * emails, and "Nothing scheduled today" on a day with an event (9 Nov 2026). Its inbox block
 * must also match the inbox (see inboxSectionMatches).
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
  return subjectsCovered && eventsCovered && inboxSectionMatches(opts);
}

/** The lines of the briefing's inbox section: from the "Inbox (N unread)" heading to the next heading. */
function inboxSection(reply: string): { count: number | null; lines: string[] } | null {
  const lines = (reply ?? "").split("\n");
  const start = lines.findIndex((line) => /inbox\s*\(\s*\d+\s*unread\s*\)/i.test(line));
  if (start < 0) return null;
  const count = Number(/inbox\s*\(\s*(\d+)\s*unread\s*\)/i.exec(lines[start])?.[1]);
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // The next block: a bold heading, a markdown heading, or the "Today" heading.
    if (/^\s*(?:\*\*[^*]+\*\*\s*$|#{1,6}\s|[^\w\s]{0,3}\s*\**\s*📅|\**\s*today\b)/i.test(line)) break;
    section.push(line);
  }
  return { count: Number.isFinite(count) ? count : null, lines: section };
}

/**
 * The model's inbox section matches the inbox: its heading says the unread count, it has one
 * bullet per unread email and lists no email that is read. QA round 4 saw "Inbox (4 unread)"
 * followed by five bullets, the read Stripe summary among them.
 */
export function inboxSectionMatches(opts: { reply: string; emails: BriefingEmail[]; unreadCount: number }): boolean {
  const section = inboxSection(opts.reply);
  if (!section) return true; // no inbox block at all is judged by briefingCoversInbox
  if (section.count !== null && section.count !== opts.unreadCount) return false;
  const bullets = section.lines.filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line));
  const unread = opts.emails.filter((email) => email.unread);
  if (bullets.length > 0 && bullets.length !== unread.length) return false;
  const text = plain(section.lines.join(" "));
  const firstWords = (value: string) => plain(value).split(" ").slice(0, 3).join(" ");
  return !opts.emails.some((email) => !email.unread && firstWords(email.subject) && text.includes(firstWords(email.subject)));
}

export interface PriorityContext {
  /** Today's events. */
  todayEvents: BriefingEvent[];
  /** The next days' events (today's may be included). */
  upcomingEvents: BriefingEvent[];
  emails: BriefingEmail[];
  timeZone?: string;
}

function sharedWords(a: string, b: string): number {
  const words = significantWords(b);
  let shared = 0;
  for (const word of significantWords(a)) if (words.has(word)) shared++;
  return shared;
}

/** The event (or email task) a priority is about: two identifying words in common, the most wins. */
function bestMatch<T>(title: string, items: T[], text: (item: T) => string): T | undefined {
  let best: T | undefined;
  let bestShared = 1;
  for (const item of items) {
    const shared = sharedWords(title, text(item));
    if (shared > bestShared) {
      best = item;
      bestShared = shared;
    }
  }
  return best;
}

function dayLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
}

/**
 * The model's priority reasons checked against the data. A reason may call an item "today" or
 * "tonight" only when the item is one of today's events, and the minutes it gives for an event
 * must be that event's length. QA round 4 saw "120 min block — biggest commitment today" for the
 * Acme interview, which is next Monday (the prompt's own example, copied by the model). A wrong
 * reason is rewritten from the data: the event's day, time and length, or the email it came from.
 */
export function checkPriorityReasons(priorities: PriorityRow[], ctx: PriorityContext): { priorities: PriorityRow[]; corrected: string[] } {
  const timeZone = normalizeTimeZone(ctx.timeZone);
  const time = (iso: string) => formatTimeInZone(iso, timeZone);
  const minutesOf = (event: BriefingEvent) => Math.max(0, Math.round((Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60000));
  const todayKeys = new Set(ctx.todayEvents.map((event) => `${event.title}|${event.starts_at}`));
  const laterEvents = ctx.upcomingEvents.filter((event) => !todayKeys.has(`${event.title}|${event.starts_at}`));
  const tasks = ctx.emails.filter((email) => email.extractedTask);
  const corrected: string[] = [];

  const checked = priorities.map((priority) => {
    let reason = priority.reason;
    const todayEvent = bestMatch(priority.title, ctx.todayEvents, (event) => event.title);
    const laterEvent = todayEvent ? undefined : bestMatch(priority.title, laterEvents, (event) => event.title);
    const event = todayEvent ?? laterEvent;
    const claimsToday = /\b(today|tonight)\b/i.test(reason);
    if (!todayEvent && claimsToday) {
      const email = bestMatch(priority.title, tasks, (mail) => `${mail.extractedTask!.title} ${mail.subject}`);
      const sender = email ? oneLine(senderName(email.from), 50) : "";
      const fromEmail = email ? `from ${sender}'s email (${email.extractedTask!.importance} importance)` : "";
      if (laterEvent) {
        reason = `${minutesOf(laterEvent)} min block on ${dayLabel(laterEvent.starts_at, timeZone)} (${time(laterEvent.starts_at)}–${time(laterEvent.ends_at)})${fromEmail ? `; ${fromEmail}` : ""}`;
      } else if (email) {
        const due = email.extractedTask!.deadline ? `, due ${dayLabel(email.extractedTask!.deadline, timeZone)}` : "";
        reason = `${fromEmail.charAt(0).toUpperCase()}${fromEmail.slice(1)}${due}`;
      } else {
        const kept = reason
          .split(/\s*(?:[—–;()]|\s-\s|,)\s*/)
          .map((part) => part.trim())
          .filter((part) => part && !/\b(today|tonight)\b/i.test(part));
        reason = kept.join(" — ") || "Ranked by the AI model";
      }
    } else if (event) {
      const minutes = minutesOf(event);
      reason = reason.replace(/\b(\d{1,4})\s?-?\s?(?:min(?:ute)?s?)\b/i, (whole, value: string) => (Number(value) === minutes ? whole : `${minutes} min`));
    }
    if (reason !== priority.reason) corrected.push(`"${priority.title}": "${priority.reason}" -> "${reason}"`);
    return reason === priority.reason ? priority : { ...priority, reason };
  });
  return { priorities: checked, corrected };
}

/**
 * The model's priorities with one row per commitment: an email that announces one of today's
 * events (the demo's "Team sync moved to 7 PM today" and the 7 PM team sync) is that event, so
 * a row for the email's task and a row for the event are one priority, as in the rule-based
 * briefing. The higher-ranked row stays; the ranks are numbered 1, 2, 3 ... again. A live
 * briefing listed them as two priorities (review of 24 Nov 2026).
 */
export function foldSameCommitments(
  priorities: PriorityRow[],
  ctx: { todayEvents: BriefingEvent[]; emails: BriefingEmail[]; timeZone?: string },
): { priorities: PriorityRow[]; folded: string[] } {
  const timeZone = normalizeTimeZone(ctx.timeZone);
  const tasks = ctx.emails.filter((email) => email.extractedTask);
  const ordered = priorities.map((priority, index) => ({ priority, index })).sort((a, b) => a.priority.rank - b.priority.rank || a.index - b.index);
  const dropped = new Set<number>();
  const folded: string[] = [];
  for (const event of ctx.todayEvents) {
    const about = tasks.filter((email) => isSameCommitment(event, email, timeZone));
    if (about.length === 0) continue;
    const rows = ordered.filter(
      ({ priority, index }) =>
        !dropped.has(index) &&
        (sharedWords(priority.title, event.title) >= 2 ||
          about.some((email) => sharedWords(priority.title, `${email.extractedTask!.title} ${email.subject}`) >= 2)),
    );
    for (const row of rows.slice(1)) {
      dropped.add(row.index);
      folded.push(`"${row.priority.title}" is the same commitment as "${rows[0].priority.title}"`);
    }
  }
  if (dropped.size === 0) return { priorities, folded };
  const kept = ordered.filter(({ index }) => !dropped.has(index)).map(({ priority }, i) => ({ ...priority, rank: i + 1 }));
  return { priorities: kept, folded };
}

/** "overlaps", "conflicts with", "clash", "double-booked". */
const OVERLAP_WORDS = /\b(?:overlap\w*|conflict\w*|clash\w*|double[- ]?booked|collid\w*)\b/i;

/**
 * Sentences of a briefing that speak of an overlap or a conflict on a day where no two events
 * overlap. A live briefing said the team sync "now overlaps" with itself: Alicia's email about
 * it and the calendar event are one meeting (review of 24 Nov 2026). With two events that do
 * overlap, nothing is removed.
 */
export function removeFalseOverlapClaims(text: string, todayEvents: BriefingEvent[]): { text: string; removed: number } {
  const ranges = todayEvents
    .map((event) => [Date.parse(event.starts_at), Date.parse(event.ends_at)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end));
  const anyOverlap = ranges.some(([start, end], i) => ranges.some(([s2, e2], j) => j > i && rangesOverlap(start, end, s2, e2)));
  if (anyOverlap) return { text: text ?? "", removed: 0 };
  return removeSentences(text ?? "", (sentence) => OVERLAP_WORDS.test(sentence));
}
