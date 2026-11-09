import { describe, expect, it } from "vitest";
import { buildRuleBasedBriefing, isSameCommitment, mentionedClockTimes } from "@/server/ai/briefing-fallback.server";
import { fetchMockEmails } from "@/server/connectors/gmail.mock";

const ZRH = "Europe/Zurich";

describe("rule-based first-visit briefing (the model did not answer)", () => {
  const now = Date.parse("2026-11-09T14:08:00Z"); // Monday 15:08 in Zurich
  const todayEvents = [
    { title: "Team sync — demo walkthrough", starts_at: "2026-11-09T18:00:00Z", ends_at: "2026-11-09T19:00:00Z" },
    { title: "Morning stand-up", starts_at: "2026-11-09T07:00:00Z", ends_at: "2026-11-09T07:15:00Z" }, // already over
    { title: "Deep work", starts_at: "2026-11-09T15:00:00Z", ends_at: "2026-11-09T17:00:00Z" },
  ];

  it("lists every unread demo email and today's events in local time, and says it is rule-based", () => {
    const emails = fetchMockEmails();
    const { reply } = buildRuleBasedBriefing({ emails, unreadCount: 4, todayEvents, timeZone: ZRH, reason: "Ollama did not answer within 900 s.", nowMs: now });
    expect(reply).toContain("The AI model did not answer (Ollama did not answer within 900 s.)");
    expect(reply).toContain("**📬 Inbox (4 unread)**");
    for (const email of emails.filter((e) => e.unread)) expect(reply).toContain(email.subject);
    expect(reply).not.toContain("Your monthly summary"); // read email
    expect(reply).toContain("7:00 PM – 8:00 PM Team sync — demo walkthrough");
    expect(reply).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no raw ISO timestamps
  });

  it("ranks today's remaining events by length, then email tasks by importance", () => {
    const { priorities } = buildRuleBasedBriefing({ emails: fetchMockEmails(), unreadCount: 4, todayEvents, timeZone: ZRH, reason: "timeout", nowMs: now });
    expect(priorities.map((p) => p.title)).toEqual([
      "Deep work", // 120 min
      "Team sync — demo walkthrough", // 60 min (Alicia's "Team sync at 7 PM" email is folded in)
      "Write research paper final draft", // high
      "Prepare for Acme onsite interview", // high
      "Lunch with Sam", // low
    ]);
    expect(priorities[0]).toMatchObject({ rank: 1, reason: expect.stringContaining("120 min block today") });
  });

  it("ranks the team sync once: the 7 PM event and Alicia's email about it are one commitment", () => {
    // The demo calendar's only event today is the team sync (QA round 2 saw it ranked twice).
    const demoToday = [todayEvents[0]];
    const { priorities } = buildRuleBasedBriefing({ emails: fetchMockEmails(), unreadCount: 4, todayEvents: demoToday, timeZone: ZRH, reason: "timeout", nowMs: now });
    expect(priorities.map((p) => p.title)).toEqual([
      "Team sync — demo walkthrough",
      "Write research paper final draft",
      "Prepare for Acme onsite interview",
      "Lunch with Sam",
    ]);
    expect(priorities.filter((p) => /team sync/i.test(p.title))).toHaveLength(1);
    expect(priorities[0].reason).toBe(
      "60 min block today (7:00 PM–8:00 PM) — fixed commitment; also in Alicia (manager)'s email: Team sync at 7 PM (revise demo script)",
    );
  });

  it("keeps an email task that only looks similar: another time, or one shared word", () => {
    const sync = todayEvents[0]; // 19:00 local
    const at = (title: string, subject: string) => ({
      from: "Alicia (manager)",
      subject,
      snippet: "",
      unread: true,
      extractedTask: { title, importance: "high" as const },
    });
    expect(isSameCommitment(sync, at("Team sync at 7 PM (revise demo script)", "Team sync moved to 7 PM today"), ZRH)).toBe(true);
    expect(isSameCommitment(sync, at("Team sync at 19:00", "Team sync"), ZRH)).toBe(true);
    expect(isSameCommitment(sync, at("Team sync at 9 AM", "Team sync tomorrow morning"), ZRH)).toBe(false); // other time
    expect(isSameCommitment(sync, at("Team lunch", "Lunch with the team"), ZRH)).toBe(false); // only "team"
    expect([...mentionedClockTimes("at 7 PM, or 7:30pm, else 19:45")].sort()).toEqual(["19:00", "19:30", "19:45"]);
    expect([...mentionedClockTimes("12 am, 12:15 PM, 9.30 a.m.")].sort()).toEqual(["00:00", "09:30", "12:15"]);
  });

  it("turns unread Gmail messages into reply tasks when no tasks were extracted", () => {
    const { priorities, reply } = buildRuleBasedBriefing({
      emails: [{ from: "Ana <ana@example.com>", subject: "Budget review", snippet: "Can you check the numbers?", unread: true }],
      unreadCount: 1,
      todayEvents: [],
      timeZone: ZRH,
      reason: "unreachable",
      nowMs: now,
    });
    expect(reply).toContain("Nothing scheduled today.");
    expect(priorities).toEqual([{ rank: 1, title: "Reply to: Budget review", reason: "Unread email from Ana <ana@example.com>" }]);
  });
});
