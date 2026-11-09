/**
 * Rule-based first-visit briefing, used only when the AI model does not answer the automatic
 * "check my emails" request (a CPU-only local model under load can take longer than the
 * timeout). It lists the inbox and today's calendar exactly as the model is asked to, and ranks
 * priorities with the same rule the model gets: today's events by length (longer first, then
 * earlier), then the tasks found in emails by importance. Everything is labelled as rule-based.
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

export function buildRuleBasedBriefing(opts: {
  emails: BriefingEmail[];
  unreadCount: number;
  todayEvents: BriefingEvent[];
  timeZone?: string;
  reason: string;
  nowMs?: number;
  maxPriorities?: number;
}): { reply: string; priorities: PriorityRow[] } {
  const timeZone = normalizeTimeZone(opts.timeZone);
  const nowMs = opts.nowMs ?? Date.now();
  const time = (iso: string) => formatTimeInZone(iso, timeZone);
  const minutes = (event: BriefingEvent) =>
    Math.max(0, Math.round((Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60000));

  const unread = opts.emails.filter((email) => email.unread);
  const events = [...opts.todayEvents].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

  const lines: string[] = [
    `⚠️ The AI model did not answer (${oneLine(opts.reason, 160)}), so this briefing was put together by simple rules. Ask again later for the AI's own ranking.`,
    "",
    `**📬 Inbox (${opts.unreadCount} unread)**`,
  ];
  if (unread.length === 0) lines.push("No unread emails — inbox is clear.");
  for (const email of unread) {
    lines.push(`• **${oneLine(email.from, 60)}** — *${oneLine(email.subject, 90)}* — ${oneLine(email.snippet, 120)}`);
  }
  lines.push("", "**📅 Today**");
  if (events.length === 0) lines.push("Nothing scheduled today.");
  for (const event of events) lines.push(`• ${time(event.starts_at)} – ${time(event.ends_at)} ${oneLine(event.title, 90)}`);
  lines.push(
    "",
    "Priorities are on the right, ranked by rule: today's remaining events by length, then the tasks in your emails by importance.",
  );

  const candidates: { title: string; reason: string }[] = [];
  const upcomingToday = events
    .filter((event) => Date.parse(event.ends_at) > nowMs)
    .sort((a, b) => minutes(b) - minutes(a) || Date.parse(a.starts_at) - Date.parse(b.starts_at));
  for (const event of upcomingToday) {
    candidates.push({
      title: oneLine(event.title, 120),
      reason: `${minutes(event)} min block today (${time(event.starts_at)}–${time(event.ends_at)}) — fixed commitment`,
    });
  }
  const tasks = opts.emails
    .filter((email) => email.extractedTask)
    .sort((a, b) => IMPORTANCE_ORDER[a.extractedTask!.importance] - IMPORTANCE_ORDER[b.extractedTask!.importance]);
  for (const email of tasks) {
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
