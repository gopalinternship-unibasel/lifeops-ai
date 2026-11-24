/**
 * What the dashboard and the plan grid show (src/lib/dashboard-view.ts, src/lib/plan-grid.ts,
 * src/lib/priorities.ts), audit of 24 Nov 2026:
 *  - 12: the AI badge read "Ollama · @cf/zai-org/glm-4.7-flash" on a site without AI; the planner
 *    badge said "offline" for every failure; the priorities subtitle blamed the model for every
 *    rule-based ranking;
 *  - 39: "Plan blocks approved" counted an append-only id list (3/3 after a removal, 4/3 after a
 *    re-approval);
 *  - 40: a failed first load showed a spinner forever;
 *  - 61: failed and interrupted banners stayed for weeks with a bare clock time;
 *  - 93: an odd server answer was taken as success (the text was cleared, no error);
 *  - 38: plan day cards placed busy events on their start day only.
 */
import { describe, expect, it } from "vitest";
import {
  aiStatus,
  dashboardViewState,
  executionProviderLabel,
  formatRequestTime,
  isActionRunAnswer,
  isDashboardAnswer,
  isPlanPollAnswer,
  isPlanRequestAnswer,
  isStaleOutcome,
  planApprovalCounts,
  plannerBadgeText,
} from "@/lib/dashboard-view";
import { busyForDay, rhythmSegment } from "@/lib/plan-grid";
import { planItemEventTitle } from "@/lib/plan-state";
import { prioritiesSubtitle } from "@/lib/priorities";
import { resolveLLMConfig } from "@/server/ai/llm.server";
import type { WeekPlan } from "@/types/plan";

// Local times, whatever zone the tests run in.
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

describe("AI badge (12)", () => {
  it("says plainly that AI is not set up, and never pairs 'Ollama' with the configured model", () => {
    const pages = aiStatus(resolveLLMConfig("chat", { LLM_MODEL: "@cf/zai-org/glm-4.7-flash" }, true));
    expect(pages).toEqual({ configured: false, label: "AI not set up on this site", local: false });
    expect(pages.label).not.toMatch(/Ollama/);
  });

  it("names the hosted provider and model when one is set", () => {
    const vercel = aiStatus(
      resolveLLMConfig(
        "chat",
        { LLM_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/x/ai/v1", LLM_MODEL: "@cf/zai-org/glm-4.7-flash" },
        true,
      ),
    );
    expect(vercel).toEqual({ configured: true, label: "Cloudflare Workers AI · @cf/zai-org/glm-4.7-flash", local: false });
  });

  it("a local Ollama is labelled as such and marked local (minutes-long waits)", () => {
    expect(aiStatus(resolveLLMConfig("chat", {}, false))).toEqual({ configured: true, label: "Ollama · llama3.1:8b", local: true });
  });
});

describe("planner badge (12)", () => {
  it("says 'offline' only when the planner could not be reached", () => {
    expect(plannerBadgeText({ online: true })).toBe("Planner service online");
    expect(plannerBadgeText({ online: false, reason: "unreachable" })).toBe("Planner service offline — in-app assistant");
    expect(plannerBadgeText({ online: false, reason: "rejected" })).toBe("Planner service unavailable — in-app assistant");
    expect(plannerBadgeText({ online: false, reason: "failed" })).toBe("Planner service unavailable — in-app assistant");
    expect(plannerBadgeText({ online: false, reason: "off" })).toBe("Planner service off — in-app assistant");
  });
});

describe("priorities subtitle (12)", () => {
  it("does not claim the model 'returned no ranking' when it may not have been reached", () => {
    const text = prioritiesSubtitle(["rules", "rules"]);
    expect(text).toMatch(/^Ranked by simple rules, because the AI model was not available or gave no ranking/);
    expect(text).not.toMatch(/returned no ranking/);
  });
});

describe("Plan blocks approved (39)", () => {
  const items = [
    { emoji: "🏃", title: "Run", starts_at: local(2026, 11, 25, 7), ends_at: local(2026, 11, 25, 8) },
    { emoji: "🎯", title: "Deep work", starts_at: local(2026, 11, 25, 14), ends_at: local(2026, 11, 25, 16) },
    { emoji: "📚", title: "Reading", starts_at: local(2026, 11, 26, 18), ends_at: local(2026, 11, 26, 19) },
  ];
  const plan: WeekPlan = {
    week_start: "2026-11-23",
    days: [
      { date: "2026-11-25", headline: "", items: items.slice(0, 2) },
      { date: "2026-11-26", headline: "", items: items.slice(2) },
    ],
  };
  const asEvent = (item: (typeof items)[number]) => ({ title: planItemEventTitle(item), starts_at: item.starts_at, ends_at: item.ends_at });
  const now = Date.parse(local(2026, 11, 24, 12));

  it("counts the plan items that are in the calendar", () => {
    expect(planApprovalCounts(plan, items.map(asEvent), now)).toEqual({ approved: 3, planned: 3 });
  });

  it("goes down when an approved event is removed (the id list kept saying 3/3)", () => {
    expect(planApprovalCounts(plan, items.slice(1).map(asEvent), now)).toEqual({ approved: 2, planned: 3 });
  });

  it("never exceeds the planned items, also with an extra event of the same title elsewhere", () => {
    const moved = { ...asEvent(items[0]), starts_at: local(2026, 11, 27, 7), ends_at: local(2026, 11, 27, 8) };
    const counts = planApprovalCounts(plan, [...items.map(asEvent), moved], now);
    expect(counts.approved).toBeLessThanOrEqual(counts.planned);
    expect(counts).toEqual({ approved: 3, planned: 3 });
  });

  it("is 0/0 without a plan", () => {
    expect(planApprovalCounts(null, [], now)).toEqual({ approved: 0, planned: 0 });
  });
});

describe("first load (40) and server answers (93)", () => {
  it("shows the error state, not the spinner, once loading ended without data", () => {
    expect(dashboardViewState(true, false)).toBe("loading");
    expect(dashboardViewState(false, false)).toBe("error");
    expect(dashboardViewState(false, true)).toBe("ready");
    expect(dashboardViewState(true, true)).toBe("ready");
  });

  it("does not take an error object for a stored request or a dashboard", () => {
    const unhandled = { status: 500, unhandled: true, message: "HTTPError" };
    expect(isPlanRequestAnswer(unhandled)).toBe(false);
    expect(isPlanRequestAnswer(undefined)).toBe(false);
    expect(isPlanRequestAnswer({ request: { id: "r1", status: "done", input: "x" } })).toBe(true);
    expect(isDashboardAnswer(unhandled)).toBe(false);
    expect(isDashboardAnswer({ workspace: { priorities: [] }, planner: { online: false } })).toBe(true);
    expect(isPlanPollAnswer(unhandled)).toBe(false);
    expect(isPlanPollAnswer({ request: null })).toBe(true);
    expect(isPlanPollAnswer({ request: { id: "r1", status: "running" } })).toBe(true);
    expect(isActionRunAnswer({ code: "WORKER_LIMIT" })).toBe(false);
    expect(isActionRunAnswer({ ok: true, message: "Added to your demo calendar." })).toBe(true);
  });
});

describe("failed and interrupted banners (61)", () => {
  const now = Date.parse("2026-11-24T10:00:00Z");

  it("hides an outcome older than a day", () => {
    const old = { status: "failed" as const, startedAt: "2026-11-10T12:53:00Z", finishedAt: "2026-11-10T12:54:00Z" };
    expect(isStaleOutcome(old, now)).toBe(true);
    expect(isStaleOutcome({ ...old, startedAt: "2026-11-24T08:59:00Z", finishedAt: "2026-11-24T09:00:00Z" }, now)).toBe(false);
    expect(isStaleOutcome({ status: "interrupted", startedAt: "2026-11-20T08:00:00Z", finishedAt: null }, now)).toBe(true);
    // A result is never hidden for its age.
    expect(isStaleOutcome({ status: "done", startedAt: "2026-11-10T12:53:00Z", finishedAt: "2026-11-10T12:54:00Z" }, now)).toBe(false);
  });

  it("dates a time that is not today", () => {
    const opts = { locale: "en-US", timeZone: "Europe/Zurich" };
    expect(formatRequestTime("2026-11-17T12:53:00Z", now, opts)).toBe("Tue, Nov 17, 1:53 PM");
    expect(formatRequestTime("2026-11-24T09:05:00Z", now, opts)).toBe("10:05 AM");
    expect(formatRequestTime("not a date", now, opts)).toBe("");
  });
});

describe("execution log (82)", () => {
  it("says where an action went in words, and that a noted task scheduled nothing", () => {
    expect(executionProviderLabel("monday")).toBe("noted (nothing scheduled)");
    expect(executionProviderLabel("demo_calendar")).toBe("demo calendar");
    expect(executionProviderLabel("gmail_draft")).toBe("Gmail draft (not sent)");
    expect(executionProviderLabel(null)).toBe("?");
  });
});

describe("plan day cards (38)", () => {
  it("shows an event that runs past midnight on both days", () => {
    const late = { title: "Late shift", starts_at: local(2026, 11, 24, 20), ends_at: local(2026, 11, 25, 2) };
    expect(busyForDay([late], "2026-11-24")).toEqual([late]);
    expect(busyForDay([late], "2026-11-25")).toEqual([late]);
    expect(busyForDay([late], "2026-11-26")).toEqual([]);
  });

  it("shows an event that started the Sunday before on Monday", () => {
    const overnight = { title: "Flight", starts_at: local(2026, 11, 22, 23), ends_at: local(2026, 11, 23, 3) };
    expect(busyForDay([overnight], "2026-11-23")).toEqual([overnight]);
  });

  it("draws each day's part of an event on the rhythm bar (07:00-22:00)", () => {
    const late = { starts_at: local(2026, 11, 24, 20), ends_at: local(2026, 11, 25, 2) };
    expect(rhythmSegment(late, "2026-11-24")).toEqual([1200, 1320]);
    expect(rhythmSegment(late, "2026-11-25")).toBeNull();
    const twoDays = { starts_at: local(2026, 11, 27, 9), ends_at: local(2026, 11, 28, 12) };
    expect(rhythmSegment(twoDays, "2026-11-27")).toEqual([540, 1320]);
    expect(rhythmSegment(twoDays, "2026-11-28")).toEqual([420, 720]);
  });
});
