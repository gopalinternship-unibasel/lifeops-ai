/**
 * QA round 4 (10 Nov 2026), model output checks of the first-visit briefing: "Inbox (4 unread)"
 * followed by five bullets with the read Stripe email, and the priority reason "120 min block —
 * biggest commitment today" for the Acme interview, which is next Monday.
 */
import { describe, expect, it } from "vitest";
import { briefingCoversInbox, checkPriorityReasons, inboxSectionMatches } from "@/server/ai/briefing-fallback.server";
import { fetchMockEmails } from "@/server/connectors/gmail.mock";

const ZRH = "Europe/Zurich";
// The inbox of Tuesday 10 Nov 2026, 09:00 in Zurich, the day of the events below. Its texts depend
// on the day and the time ("Lunch next Saturday?" on a Saturday afternoon), so the test fixes the
// moment (review of 25 Nov 2026: on the real clock it failed every Saturday from 13:00 UTC).
const emails = fetchMockEmails(ZRH, Date.parse("2026-11-10T08:00:00Z"));
const todayEvents = [{ title: "Team sync — demo walkthrough", starts_at: "2026-11-10T18:00:00.000Z", ends_at: "2026-11-10T19:00:00.000Z" }];
const upcomingEvents = [
  ...todayEvents,
  { title: "Acme onsite interview", starts_at: "2026-11-16T09:00:00.000Z", ends_at: "2026-11-16T11:00:00.000Z" },
  { title: "Dentist appointment", starts_at: "2026-11-12T13:00:00.000Z", ends_at: "2026-11-12T14:30:00.000Z" },
];

const GOOD = [
  "**📬 Inbox (4 unread)**",
  "- **Prof. Marlow** — *Research paper — final draft due Thursday* — final draft due in 2 days",
  "- **Acme Recruiting** — *Onsite interview — next steps* — Monday at 10am",
  "- **Sam (friend)** — *Lunch this Saturday?* — around 1pm",
  "- **Alicia (manager)** — *Team sync moved to 7 PM today* — demo script",
  "",
  "**📅 Today**",
  "- 7:00 PM – 8:00 PM Team sync — demo walkthrough",
].join("\n");

describe("the briefing's inbox block matches the inbox", () => {
  it("accepts one bullet per unread email under the right count", () => {
    expect(inboxSectionMatches({ reply: GOOD, emails, unreadCount: 4 })).toBe(true);
    expect(briefingCoversInbox({ reply: GOOD, emails, unreadCount: 4, todayEvents })).toBe(true);
  });

  it("refuses QA's answer: a fifth bullet with the read Stripe email", () => {
    const withStripe = GOOD.replace("\n\n**📅 Today**", "\n- **Stripe** — *Your monthly summary* — usage and invoice\n\n**📅 Today**");
    expect(inboxSectionMatches({ reply: withStripe, emails, unreadCount: 4 })).toBe(false);
    expect(briefingCoversInbox({ reply: withStripe, emails, unreadCount: 4, todayEvents })).toBe(false);
  });

  it("refuses a wrong count in the heading", () => {
    expect(inboxSectionMatches({ reply: GOOD.replace("(4 unread)", "(5 unread)"), emails, unreadCount: 4 })).toBe(false);
  });
});

describe("priority reasons are checked against the calendar and the inbox", () => {
  it("'biggest commitment today' for next Monday's interview is rewritten from the calendar", () => {
    const { priorities, corrected } = checkPriorityReasons(
      [{ rank: 1, title: "Prepare for Acme onsite interview", reason: "120 min block — biggest commitment today" }],
      { todayEvents, upcomingEvents, emails, timeZone: ZRH },
    );
    expect(priorities[0].reason).toBe("120 min block on Mon, Nov 16 (10:00 AM–12:00 PM); from Acme Recruiting's email (high importance)");
    expect(corrected).toHaveLength(1);
  });

  it("an email task said to be 'today' gets the email's own reason and due day", () => {
    const { priorities } = checkPriorityReasons(
      [{ rank: 2, title: "Write research paper final draft", reason: "Due today, 90 min" }],
      { todayEvents, upcomingEvents, emails, timeZone: ZRH },
    );
    expect(priorities[0].reason).toMatch(/^From Prof\. Marlow's email \(high importance\), due \w{3}, \w{3} \d{1,2}$/);
  });

  it("today's event keeps 'today'; a wrong length is corrected; other reasons are left alone", () => {
    const { priorities, corrected } = checkPriorityReasons(
      [
        { rank: 1, title: "Team sync — demo walkthrough", reason: "90 min block today" },
        { rank: 2, title: "Revise demo script for team sync", reason: "60 min block tonight" },
        { rank: 3, title: "Lunch with Sam", reason: "Saturday, low importance" },
      ],
      { todayEvents, upcomingEvents, emails, timeZone: ZRH },
    );
    expect(priorities.map((p) => p.reason)).toEqual(["60 min block today", "60 min block tonight", "Saturday, low importance"]);
    expect(corrected).toHaveLength(1);
  });

  it("a 'today' claim about something the data does not know is dropped from the reason", () => {
    const { priorities } = checkPriorityReasons(
      [{ rank: 4, title: "Plan the week", reason: "30 min — best done today" }],
      { todayEvents, upcomingEvents, emails, timeZone: ZRH },
    );
    expect(priorities[0].reason).toBe("30 min");
  });
});
