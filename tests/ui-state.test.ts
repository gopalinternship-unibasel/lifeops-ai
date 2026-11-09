import { describe, expect, it } from "vitest";
import { firstHour, minutesOnDay, positionOnDay } from "@/lib/calendar-grid";
import { planCalendarState } from "@/lib/plan-state";
import { prioritiesSubtitle } from "@/lib/priorities";
import { buildRuleBasedBriefing } from "@/server/ai/briefing-fallback.server";
import { fetchMockEmails } from "@/server/connectors/gmail.mock";
import type { WeekPlan } from "@/types/plan";

// Local times, whatever zone the tests run in.
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

describe("dashboard: who ranked the priorities", () => {
  it("does not say 'Ranked by the assistant' over rule-ranked rows", () => {
    expect(prioritiesSubtitle(["rules", "rules", "rules"])).toMatch(/^Ranked by simple rules, because the AI model returned no ranking/);
    expect(prioritiesSubtitle(["chat", "chat"])).toBe("Ranked by the AI assistant from your inbox, calendar and chat.");
    expect(prioritiesSubtitle(["chat", "rules"])).toContain("marked “rule”");
  });
});

describe("calendar week view", () => {
  const thursday = new Date(2026, 10, 12);
  const days = [new Date(2026, 10, 11), thursday, new Date(2026, 10, 13)];

  it("starts the grid early enough for an event before 06:00 (QA: dentist at 04:00-05:30 was hidden)", () => {
    const early = { starts_at: local(2026, 11, 12, 4), ends_at: local(2026, 11, 12, 5, 30) };
    const run = { starts_at: local(2026, 11, 12, 7), ends_at: local(2026, 11, 12, 8) };
    expect(firstHour([run], days)).toBe(6);
    expect(firstHour([run, early], days)).toBe(4);
    expect(positionOnDay(early, thursday, 4, 48)).toEqual({ top: 0, height: 70 });
  });

  it("shows an event that runs past midnight on both days", () => {
    const late = { starts_at: local(2026, 11, 11, 23), ends_at: local(2026, 11, 12, 1) };
    expect(minutesOnDay(late, days[0])).toEqual({ start: 23 * 60, end: 24 * 60 });
    expect(minutesOnDay(late, thursday)).toEqual({ start: 0, end: 60 });
    expect(firstHour([late], days)).toBe(0);
    expect(minutesOnDay(late, days[2])).toBeNull();
  });
});

describe("plan page after a reload", () => {
  const plan: WeekPlan = {
    week_start: "2026-11-09",
    days: [
      {
        date: "2026-11-10",
        headline: "",
        items: [
          { emoji: "🏃", title: "Morning run", starts_at: local(2026, 11, 10, 7), ends_at: local(2026, 11, 10, 8) },
          { emoji: "🎯", title: "Deep work", starts_at: local(2026, 11, 10, 14), ends_at: local(2026, 11, 10, 16) },
        ],
      },
      { date: "2026-11-11", headline: "", items: [{ emoji: "📚", title: "Reading", starts_at: local(2026, 11, 11, 18), ends_at: local(2026, 11, 11, 19) }] },
    ],
  };
  const lecture = { title: "Lecture — Distributed Systems", starts_at: local(2026, 11, 10, 10), ends_at: local(2026, 11, 10, 12) };
  const now = Date.parse(local(2026, 11, 9, 22));

  it("an approved item is listed once (as a plan item in the calendar), and its day is Added", () => {
    const events = [
      lecture,
      { title: "🏃 Morning run", starts_at: local(2026, 11, 10, 7), ends_at: local(2026, 11, 10, 8) },
      { title: "🎯 Deep work", starts_at: local(2026, 11, 10, 14), ends_at: local(2026, 11, 10, 16) },
    ];
    const state = planCalendarState(plan, events, now);
    expect(state.addedItems).toEqual({ "2026-11-10": [0, 1] });
    expect(state.approvedDates).toEqual(["2026-11-10"]);
    expect(state.otherEvents).toEqual([lecture]);
  });

  it("a day with an item not yet in the calendar is not Added", () => {
    const events = [lecture, { title: "🏃 Morning run", starts_at: local(2026, 11, 10, 7), ends_at: local(2026, 11, 10, 8) }];
    const state = planCalendarState(plan, events, now);
    expect(state.addedItems).toEqual({ "2026-11-10": [0] });
    expect(state.approvedDates).toEqual([]);
  });
});

describe("rule-based briefing in the evening", () => {
  it("does not rank the prep for a team sync that is already over (QA: ranked at 21:33 after the 19:00 sync)", () => {
    const sync = { title: "Team sync — demo walkthrough", starts_at: "2026-11-09T18:00:00Z", ends_at: "2026-11-09T19:00:00Z" };
    const { priorities } = buildRuleBasedBriefing({
      emails: fetchMockEmails(),
      unreadCount: 4,
      todayEvents: [sync],
      timeZone: "Europe/Zurich",
      reason: "timeout",
      nowMs: Date.parse("2026-11-09T20:33:00Z"),
    });
    expect(priorities.map((p) => p.title)).toEqual(["Write research paper final draft", "Prepare for Acme onsite interview", "Lunch with Sam"]);
  });
});
