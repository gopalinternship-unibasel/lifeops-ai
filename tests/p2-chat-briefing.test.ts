/**
 * The briefing helpers (src/server/ai/briefing-fallback.server.ts), findings of the review of
 * 24 Nov 2026: 16, 42, 102.
 */
import { describe, expect, it } from "vitest";
import {
  buildRuleBasedBriefing,
  checkPriorityReasons,
  foldSameCommitments,
  removeFalseOverlapClaims,
  senderName,
} from "@/server/ai/briefing-fallback.server";
import { fetchMockEmails } from "@/server/connectors/gmail.mock";
import { demoSeedEvents } from "@/server/connectors/calendar.mock";
import { addDaysISO, zonedDateTimeToISO } from "@/server/timezone.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-24";
const NOW = Date.parse("2026-11-24T09:00:00Z");
const emails = fetchMockEmails(ZRH, NOW);
const sync = demoSeedEvents(TODAY, ZRH).find((event) => event.seed_key === "team-sync")!;

describe("one commitment, one priority (16)", () => {
  it("the team sync and Alicia's email about it are folded into the higher-ranked row", () => {
    const { priorities, folded } = foldSameCommitments(
      [
        { rank: 1, title: "Team sync — demo walkthrough", reason: "60 min block today" },
        { rank: 2, title: "Write research paper final draft", reason: "Due Thursday" },
        { rank: 3, title: "Team sync at 7 PM (revise demo script)", reason: "From Alicia's email" },
        { rank: 4, title: "Lunch with Sam", reason: "Saturday" },
      ],
      { todayEvents: [sync], emails, timeZone: ZRH },
    );
    expect(priorities.map((p) => [p.rank, p.title])).toEqual([
      [1, "Team sync — demo walkthrough"],
      [2, "Write research paper final draft"],
      [3, "Lunch with Sam"],
    ]);
    expect(folded).toHaveLength(1);
  });

  it("rows about different commitments stay", () => {
    const rows = [
      { rank: 1, title: "Prepare for Acme onsite interview", reason: "Monday" },
      { rank: 2, title: "Write research paper final draft", reason: "Thursday" },
    ];
    expect(foldSameCommitments(rows, { todayEvents: [sync], emails, timeZone: ZRH }).priorities).toEqual(rows);
  });

  it("an overlap claim on a day without overlapping events is removed; a real overlap stays", () => {
    const claim = "Note: Alicia's message updates the team sync to 7 PM today, which now overlaps with your existing Team sync — demo walkthrough at 19:00–20:00. Have a good day.";
    expect(removeFalseOverlapClaims(claim, [sync])).toEqual({ text: "Have a good day.", removed: 1 });
    const clash = { title: "Dinner", starts_at: zonedDateTimeToISO(TODAY, { hour: 19, minute: 30 }, ZRH), ends_at: zonedDateTimeToISO(TODAY, { hour: 21 }, ZRH) };
    expect(removeFalseOverlapClaims(claim, [sync, clash]).removed).toBe(0);
  });
});

describe("the sender's name in reasons (102)", () => {
  it("never the whole From header in a possessive", () => {
    expect(senderName("Prof. Marlow <marlow@university.edu>")).toBe("Prof. Marlow");
    expect(senderName('"Ana B." <ana@example.com>')).toBe("Ana B.");
    expect(senderName("<ana@example.com>")).toBe("ana@example.com");
    expect(senderName("Sam (friend)")).toBe("Sam (friend)");
    const { priorities } = buildRuleBasedBriefing({ emails, unreadCount: 4, todayEvents: [], timeZone: ZRH, reason: "x", nowMs: NOW });
    expect(priorities.map((p) => p.reason).join("\n")).not.toMatch(/<[^>]+>'s email/);
    expect(priorities.find((p) => p.title === "Write research paper final draft")?.reason).toBe("From Prof. Marlow's email — high importance");
  });

  it("an empty reason gives no empty brackets", () => {
    const { reply } = buildRuleBasedBriefing({ emails, unreadCount: 4, todayEvents: [], timeZone: ZRH, reason: "", nowMs: NOW });
    expect(reply.split("\n")[0]).toBe("⚠️ The AI model did not answer, so this briefing was put together by simple rules. Ask again later for the AI's own ranking.");
  });
});

describe("a rewritten reason names the same day as the email (42)", () => {
  it("on every day of the week, 'due <day>' agrees with the paper's subject", () => {
    for (let i = 0; i < 7; i++) {
      const today = addDaysISO("2026-11-23", i);
      const now = Date.parse(zonedDateTimeToISO(today, { hour: 12 }, ZRH));
      const inbox = fetchMockEmails(ZRH, now);
      const paper = inbox.find((email) => email.id === "e1")!;
      const { priorities } = checkPriorityReasons([{ rank: 1, title: "Write research paper final draft", reason: "Due today" }], {
        todayEvents: [],
        upcomingEvents: [],
        emails: inbox,
        timeZone: ZRH,
      });
      const shortDay = /due (\w{3}),/.exec(priorities[0].reason)?.[1];
      expect(shortDay, today).toBeTruthy();
      expect(paper.subject.toLowerCase(), today).toContain(` ${shortDay!.toLowerCase()}`);
    }
  });
});
