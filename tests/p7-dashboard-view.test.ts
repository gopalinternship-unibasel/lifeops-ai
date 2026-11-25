/**
 * What the dashboard shows (src/lib/dashboard-view.ts, src/lib/priorities.ts), audit of
 * 24 Nov 2026:
 *  - 12: the AI badge read "Ollama · @cf/zai-org/glm-4.7-flash" on a site without AI; the planner
 *    badge said "offline" for every failure; the priorities subtitle blamed the model for every
 *    rule-based ranking;
 *  - 39: "Plan blocks approved" counted an append-only id list (3/3 after a removal, 4/3 after a
 *    re-approval);
 *  - 40: a failed first load showed a spinner forever;
 *  - 61: failed and interrupted banners stayed for weeks with a bare clock time;
 *  - 93: an odd server answer was taken as success (the text was cleared, no error).
 * (Finding 38, busy events on the plan day cards, is fixed in PlanWeekGrid by the plan package.)
 */
import { describe, expect, it } from "vitest";
import {
  aiStatus,
  cleanRecipientInput,
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
  recipientToSend,
} from "@/lib/dashboard-view";
import { planItemEventTitle } from "@/lib/plan-state";
import { prioritiesSubtitle } from "@/lib/priorities";
import { isLocalBaseUrl, resolveLLMConfig, type LLMConfig } from "@/server/ai/llm.server";
import type { WeekPlan } from "@/types/plan";

// Local times, whatever zone the tests run in.
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

describe("AI badge (12)", () => {
  // As fetchDashboard builds it: `local` from the server's isLocalBaseUrl.
  const badge = (config: LLMConfig) => aiStatus({ ...config, local: isLocalBaseUrl(config.baseUrl) });

  it("says plainly that AI is not set up, and never pairs 'Ollama' with the configured model", () => {
    const pages = badge(resolveLLMConfig("chat", { LLM_MODEL: "@cf/zai-org/glm-4.7-flash" }, true));
    expect(pages).toEqual({ configured: false, label: "AI not set up on this site", local: false });
    expect(pages.label).not.toMatch(/Ollama/);
  });

  it("names the hosted provider and model when one is set", () => {
    const vercel = badge(
      resolveLLMConfig(
        "chat",
        { LLM_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/x/ai/v1", LLM_MODEL: "@cf/zai-org/glm-4.7-flash" },
        true,
      ),
    );
    expect(vercel).toEqual({ configured: true, label: "Cloudflare Workers AI · @cf/zai-org/glm-4.7-flash", local: false });
  });

  it("a local Ollama is labelled as such and marked local (minutes-long waits)", () => {
    expect(badge(resolveLLMConfig("chat", {}, false))).toEqual({ configured: true, label: "Ollama · llama3.1:8b", local: true });
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

describe("the To field of a planner draft (44)", () => {
  it("turns any control character into a space as it is typed, not only line breaks", () => {
    expect(cleanRecipientInput("sam@uni.example\tx")).toBe("sam@uni.example x");
    expect(cleanRecipientInput("a@b.example\r\nBcc: x@y.example")).toBe("a@b.example Bcc: x@y.example");
    expect(cleanRecipientInput("sam@uni.example")).toBe("sam@uni.example");
  });

  it("sends nothing for an untouched field, and an empty value for a cleared one", () => {
    expect(recipientToSend(undefined)).toBeUndefined();
    expect(recipientToSend("")).toBe("");
    expect(recipientToSend("  sam@uni.example ")).toBe("sam@uni.example");
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

