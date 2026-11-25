/**
 * Mock Gmail connector. Returns realistic seeded emails for users who have not connected Google
 * (demo mode). Replies to these emails can be drafted and saved as demo drafts; nothing is sent.
 */
import { demoSeedEvents } from "@/server/connectors/calendar.mock";
import { addDaysISO, localDateTime, normalizeTimeZone, zonedDateTimeToISO } from "@/server/timezone.server";

export interface MockEmail {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  extractedTask?: { title: string; deadline?: string; importance: "high" | "medium" | "low" };
}

/**
 * The demo inbox as it stands now in the user's time zone. Every weekday word in a subject or
 * snippet is worked out from the same date as the deadline next to it, and the interview and the
 * team sync are the ones in the demo calendar (calendar.mock.ts). Until the review of 24 Nov 2026
 * the texts named fixed weekdays ("due Friday", "interview Monday") while the deadlines were
 * "now + 2 to 4 days", so they agreed only on Wednesdays, and from Thursday on the interview
 * prep was due after the interview.
 */
export function fetchMockEmails(requestedTimeZone?: string, nowMs: number = Date.now()): MockEmail[] {
  const timeZone = normalizeTimeZone(requestedTimeZone);
  const today = localDateTime(nowMs, timeZone).date;
  const at = (date: string, hour: number) => zonedDateTimeToISO(date, { hour }, timeZone);
  const hoursAgo = (h: number) => new Date(nowMs - h * 3600000).toISOString();
  const weekdayOf = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });
  const monthDay = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

  // The paper is due in two days, at 5 PM.
  const paperDate = addDaysISO(today, 2);
  // The interview is the demo calendar's: Monday of next week at 10 AM. The prep is due the
  // evening before, or two hours before the interview once that evening is over.
  const interview = demoSeedEvents(today, timeZone).find((event) => event.seed_key === "acme-interview")!;
  const interviewDate = localDateTime(interview.starts_at, timeZone).date;
  const eveningBefore = at(addDaysISO(interviewDate, -1), 18);
  const prepDue =
    Date.parse(eveningBefore) > nowMs ? eveningBefore : new Date(Date.parse(interview.starts_at) - 2 * 3600000).toISOString();
  // Lunch on the next Saturday at 1 PM that is still ahead: today until 1 PM on a Saturday, then
  // the Saturday after, which the texts call "next Saturday" (reviewer of 24 Nov 2026: on a
  // Saturday evening the deadline was already over).
  let saturday = addDaysISO(today, (6 - new Date(`${today}T12:00:00Z`).getUTCDay() + 7) % 7);
  if (Date.parse(at(saturday, 13)) <= nowMs) saturday = addDaysISO(saturday, 7);
  const lunchDay = saturday >= addDaysISO(today, 7) ? "next Saturday" : "this Saturday";

  return [
    {
      id: "e1",
      from: "Prof. Marlow <marlow@university.edu>",
      subject: `Research paper — final draft due ${weekdayOf(paperDate)}`,
      snippet: `Reminder that the final draft of your research paper is due on ${weekdayOf(paperDate)} at 5 PM. Please ensure citations are complete…`,
      receivedAt: hoursAgo(3),
      unread: true,
      extractedTask: { title: "Write research paper final draft", deadline: at(paperDate, 17), importance: "high" },
    },
    {
      id: "e2",
      from: "Acme Recruiting <careers@acme.io>",
      subject: "Onsite interview — next steps",
      snippet: `We'd like to confirm your onsite interview on ${weekdayOf(interviewDate)}, ${monthDay(interviewDate)} at 10am. Please prepare a 20-minute system design…`,
      receivedAt: hoursAgo(7),
      unread: true,
      extractedTask: { title: "Prepare for Acme onsite interview", deadline: prepDue, importance: "high" },
    },
    {
      id: "e3",
      from: "Sam (friend)",
      subject: `Lunch ${lunchDay}?`,
      snippet: `Free for lunch ${lunchDay} around 1pm? Let me know!`,
      receivedAt: hoursAgo(11),
      unread: true,
      extractedTask: { title: "Lunch with Sam", deadline: at(saturday, 13), importance: "low" },
    },
    {
      id: "e4",
      from: "Stripe",
      subject: "Your monthly summary",
      snippet: "Here's your usage and invoice summary for the month.",
      receivedAt: hoursAgo(20),
      unread: false,
    },
    {
      id: "e5",
      from: "Alicia (manager)",
      subject: "Team sync moved to 7 PM today",
      snippet: "Heads up — team sync is moved to 7 PM today. Please come prepared to walk through your demo script.",
      receivedAt: hoursAgo(2),
      unread: true,
      // The team sync itself, as in the demo calendar (today at 7 PM).
      extractedTask: { title: "Team sync at 7 PM (revise demo script)", deadline: at(today, 19), importance: "high" },
    },
  ];
}

/**
 * Look up one demo email by id (e1…e5). The body is the snippet: demo emails are short. Like
 * fetchMockEmails, it is the inbox at `nowMs` (review of 25 Nov 2026: without it a test could not
 * fix the moment, and "Lunch this Saturday?" became "Lunch next Saturday?" on Saturday afternoons).
 */
export function getMockEmail(id: string, requestedTimeZone?: string, nowMs: number = Date.now()): MockEmail | null {
  return fetchMockEmails(requestedTimeZone, nowMs).find((email) => email.id === id) ?? null;
}
