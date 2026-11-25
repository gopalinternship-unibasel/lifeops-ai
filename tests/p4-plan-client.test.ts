/**
 * The week plan page's own rules (src/lib/plan-state.ts, src/lib/week-plan-request.ts) and the
 * week grid as it renders (src/components/plan/PlanWeekGrid.tsx, rendered to HTML on the server,
 * since the test setup has no browser DOM). Times are built in the local zone, so the tests hold
 * in any zone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APPROVE_CLARIFY_REPLY,
  NO_PLAN_YET_REPLY,
  canEditPlanItem,
  draftingWaitText,
  editedItemTimes,
  initialPlanWeekView,
  localHM,
  parseApproveCommand,
  planCalendarState,
  planCreateInstructions,
  planWeekReducer,
  weekIsOver,
  type PlanWeekAction,
  type PlanWeekView,
} from "@/lib/plan-state";
import {
  formatRequestTime,
  planRequestBanner,
  refusalStoredNoRequest,
  type WeekPlanRequestView,
} from "@/lib/week-plan-request";
import { ItemTimeEditor, PlanWeekGrid } from "@/components/plan/PlanWeekGrid";
import type { WeekPlan, BusyEvent } from "@/types/plan";

const MONDAY = "2026-11-23";
const TODAY = "2026-11-24";
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();
const dates = Array.from({ length: 7 }, (_, i) => `2026-11-${23 + i}`);

describe("approve commands in the plan chat (finding 57)", () => {
  const parse = (text: string, monday = MONDAY) => parseApproveCommand(text, monday, TODAY);

  it("a day with punctuation or a possessive approves that day only", () => {
    expect(parse("Approve Saturday.")).toEqual({ kind: "days", dates: ["2026-11-28"] });
    expect(parse("approve saturday's plan")).toEqual({ kind: "days", dates: ["2026-11-28"] });
    expect(parse("approve Saturday’s items!")).toEqual({ kind: "days", dates: ["2026-11-28"] });
    expect(parse("approve only Monday")).toEqual({ kind: "days", dates: ["2026-11-23"] });
  });

  it("several days, weekdays and the weekend", () => {
    expect(parse("approve Saturday and Sunday")).toEqual({
      kind: "days",
      dates: ["2026-11-28", "2026-11-29"],
    });
    expect(parse("approve tue, mon")).toEqual({
      kind: "days",
      dates: ["2026-11-23", "2026-11-24"],
    });
    expect(parse("approve weekdays")).toEqual({ kind: "days", dates: dates.slice(0, 5) });
    expect(parse("approve the weekend")).toEqual({
      kind: "days",
      dates: ["2026-11-28", "2026-11-29"],
    });
  });

  it("text that names no day and is not a whole-week phrase approves nothing", () => {
    expect(parse("Approve, but move the hike to 4pm")).toEqual({
      kind: "unclear",
      reply: APPROVE_CLARIFY_REPLY,
    });
    expect(parse("approve the hike")).toEqual({ kind: "unclear", reply: APPROVE_CLARIFY_REPLY });
    expect(parse("approve saturday morning")).toEqual({
      kind: "unclear",
      reply: APPROVE_CLARIFY_REPLY,
    });
    // "this day" does not say which day, so it must not add the whole week.
    expect(parse("approve this day")).toEqual({ kind: "unclear", reply: APPROVE_CLARIFY_REPLY });
    expect(parse("approve all days")).toEqual({ kind: "week" });
  });

  it("today and tomorrow count only in the week shown", () => {
    expect(parse("approve today")).toEqual({ kind: "days", dates: [TODAY] });
    expect(parse("approve tomorrow")).toEqual({ kind: "days", dates: ["2026-11-25"] });
    const nextWeek = parse("approve today", "2026-11-30");
    expect(nextWeek.kind).toBe("unclear");
    expect(nextWeek).not.toEqual(expect.objectContaining({ dates: expect.anything() }));
  });

  it("keeps the forms that already worked", () => {
    expect(parse("approve")).toEqual({ kind: "week" });
    expect(parse("Approve all")).toEqual({ kind: "week" });
    expect(parse("approve the whole week")).toEqual({ kind: "week" });
    expect(parse("approve it")).toEqual({ kind: "week" });
    expect(parse("approve saturday")).toEqual({ kind: "days", dates: ["2026-11-28"] });
    expect(parse("approved")).toEqual({ kind: "not-approve" });
    expect(parse("Make weekday mornings deep work")).toEqual({ kind: "not-approve" });
  });
});

describe("create-plan messages keep their instructions (finding 59)", () => {
  it("the plain request adds nothing", () => {
    expect(planCreateInstructions("Please create this week's plan for me")).toBeUndefined();
    expect(planCreateInstructions("please create this week’s plan for me.")).toBeUndefined();
    expect(planCreateInstructions("Create a plan")).toBeUndefined();
    expect(planCreateInstructions("plan my week")).toBeUndefined();
  });

  it("anything more is passed on, within the server's 1,000 characters", () => {
    expect(planCreateInstructions("Create a plan with deep work every morning")).toBe(
      "Create a plan with deep work every morning",
    );
    expect(
      planCreateInstructions("Please create this week's plan for me, but keep Saturday free"),
    ).toContain("keep Saturday free");
    expect(planCreateInstructions(`${"x".repeat(3000)} create a plan`)?.length).toBe(1000);
  });
});

describe("weeks that are over and items that have started (findings 63, 60)", () => {
  it("a week is over from the next Monday 00:00 local time", () => {
    expect(weekIsOver("2026-11-16", new Date(2026, 10, 22, 23, 59).getTime())).toBe(false);
    expect(weekIsOver("2026-11-16", new Date(2026, 10, 23, 0, 0).getTime())).toBe(true);
    expect(weekIsOver(MONDAY, new Date(2026, 10, 24, 9).getTime())).toBe(false);
  });

  it("only items that have not started and are not in the calendar can be edited", () => {
    const nowMs = new Date(2026, 10, 24, 9).getTime();
    expect(
      canEditPlanItem({ starts_at: local(24, 8, 50) }, { added: false, dayApproved: false, nowMs }),
    ).toBe(false);
    expect(
      canEditPlanItem({ starts_at: local(24, 11) }, { added: false, dayApproved: false, nowMs }),
    ).toBe(true);
    expect(
      canEditPlanItem({ starts_at: local(24, 11) }, { added: true, dayApproved: false, nowMs }),
    ).toBe(false);
    expect(
      canEditPlanItem({ starts_at: local(24, 11) }, { added: false, dayApproved: true, nowMs }),
    ).toBe(false);
  });
});

describe("plan page texts (findings 107, 61)", () => {
  it("the no-plan reply has no Markdown (the page shows plain text)", () => {
    expect(NO_PLAN_YET_REPLY).toContain("There's no plan yet");
    expect(NO_PLAN_YET_REPLY).not.toMatch(/[*_`]/);
  });

  it("a request from another day shows its date, one from today only the time", () => {
    const now = new Date(2026, 10, 24, 15, 0);
    expect(formatRequestTime(new Date(2026, 10, 24, 13, 53).toISOString(), now)).toBe("1:53 PM");
    const older = formatRequestTime(new Date(2026, 10, 23, 13, 53).toISOString(), now);
    expect(older).toMatch(/Mon/);
    expect(older).toMatch(/Nov 23/);
    expect(older).toMatch(/1:53/);
    expect(formatRequestTime(new Date(2025, 10, 23, 13, 53).toISOString(), now)).toMatch(/2025/);
  });
});

describe("the request banners of the plan page (findings 61, 52)", () => {
  const request = (id: string, status: WeekPlanRequestView["status"]): WeekPlanRequestView => ({
    id,
    kind: "create",
    status,
    startedAt: new Date(2026, 10, 23, 13, 53).toISOString(),
    finishedAt: null,
    reply: null,
    error: status === "failed" ? "Drafting the plan failed. Please try again." : null,
  });
  // The page's clock: half an hour after the requests above started.
  const shown = { loading: false, waitingHere: false, hidden: new Set<string>(), nowMs: new Date(2026, 10, 23, 14, 23).getTime() };

  it("a failed or cut-off request shows until it is dismissed", () => {
    expect(planRequestBanner(request("r1", "failed"), shown)).toBe("failed");
    expect(planRequestBanner(request("r1", "interrupted"), shown)).toBe("interrupted");
    const dismissed = { ...shown, hidden: new Set(["r1"]) };
    expect(planRequestBanner(request("r1", "failed"), dismissed)).toBeNull();
    expect(planRequestBanner(request("r1", "interrupted"), dismissed)).toBeNull();
    // A dismissal is per request: a later failure shows again.
    expect(planRequestBanner(request("r2", "failed"), dismissed)).toBe("failed");
  });

  it("a later success replaces the failure, and nothing shows while loading or waiting here", () => {
    expect(planRequestBanner(request("r2", "done"), shown)).toBeNull();
    expect(planRequestBanner(request("r1", "failed"), { ...shown, loading: true })).toBeNull();
    // While this page waits for its own draft, the older failure is not shown as its outcome.
    expect(planRequestBanner(request("r1", "failed"), { ...shown, waitingHere: true })).toBeNull();
    // A draft running on the server always shows, also when it was dismissed earlier.
    expect(
      planRequestBanner(request("r3", "running"), { ...shown, hidden: new Set(["r3"]) }),
    ).toBe("running");
  });

  it("an outcome from more than a day ago is not shown, as on the dashboard", () => {
    // The request failed on Tue Nov 24 at 1:53 PM; the page is opened the next evening.
    const failed: WeekPlanRequestView = {
      ...request("r1", "failed"),
      startedAt: new Date(2026, 10, 24, 13, 53).toISOString(),
      finishedAt: new Date(2026, 10, 24, 13, 54).toISOString(),
    };
    const nextEvening = { ...shown, nowMs: new Date(2026, 10, 25, 21, 0).getTime() };
    expect(planRequestBanner(failed, nextEvening)).toBeNull();
    // Within the day it still shows (with its date, see formatRequestTime).
    expect(planRequestBanner(failed, { ...shown, nowMs: new Date(2026, 10, 25, 13, 0).getTime() })).toBe("failed");
    // A cut-off request ages the same way, from its start.
    const cutOff: WeekPlanRequestView = { ...request("r2", "interrupted"), startedAt: failed.startedAt };
    expect(planRequestBanner(cutOff, nextEvening)).toBeNull();
    expect(planRequestBanner(cutOff, { ...shown, nowMs: new Date(2026, 10, 24, 14, 30).getTime() })).toBe("interrupted");
    // A draft still running on the server is always shown, whatever its age.
    expect(planRequestBanner({ ...request("r3", "running"), startedAt: failed.startedAt }, nextEvening)).toBe("running");
  });

  it("a refusal that stored no request is told apart from a failure of a new request", () => {
    expect(refusalStoredNoRequest("r1", request("r1", "failed"))).toBe(true);
    expect(refusalStoredNoRequest(null, null)).toBe(true);
    expect(refusalStoredNoRequest("r1", request("r2", "failed"))).toBe(false);
  });

  it("the waiting text names a local model only on a local run", () => {
    expect(draftingWaitText(true)).toBe("This usually takes under a minute.");
    expect(draftingWaitText(true)).not.toMatch(/local/i);
    expect(draftingWaitText(false)).toMatch(/local AI model/);
  });
});

describe("the plan page's view of the week (findings 64, 108, 7)", () => {
  const NEXT_MONDAY = "2026-11-30";
  const planFor = (week: string, title: string): WeekPlan => ({
    week_start: week,
    days: [
      {
        date: week,
        headline: "",
        items: [{ emoji: "🎯", title, starts_at: local(23, 10), ends_at: local(23, 11) }],
      },
    ],
  });
  const loadedView = (): PlanWeekView =>
    [
      { type: "load-started", week: MONDAY, seq: 1 },
      {
        type: "loaded",
        seq: 1,
        state: {
          plan: planFor(MONDAY, "This week's focus"),
          busyEvents: [{ title: "Dentist", starts_at: local(24, 14), ends_at: local(24, 15) }],
          addedItems: { [MONDAY]: [0] },
          approvedDates: [MONDAY],
          calendarError: null,
          request: null,
        },
      },
    ].reduce<PlanWeekView>(
      (view, action) => planWeekReducer(view, action as PlanWeekAction),
      initialPlanWeekView(MONDAY),
    );

  it("switching weeks clears everything of the week shown before", () => {
    const switched = planWeekReducer(loadedView(), {
      type: "load-started",
      week: NEXT_MONDAY,
      seq: 2,
    });
    expect(switched).toMatchObject({
      week: NEXT_MONDAY,
      loading: true,
      plan: null,
      busyEvents: [],
      addedItems: {},
      request: null,
      loadError: null,
      calendarError: null,
    });
    expect(switched.approvedDates.size).toBe(0);
  });

  it("a late answer for the week left behind is ignored", () => {
    const switched = planWeekReducer(loadedView(), {
      type: "load-started",
      week: NEXT_MONDAY,
      seq: 2,
    });
    // The first load of the old week answers late, and a draft of the old week returns.
    const late = planWeekReducer(switched, {
      type: "loaded",
      seq: 1,
      state: { plan: planFor(MONDAY, "Old") },
    });
    expect(late).toBe(switched);
    const draft = planWeekReducer(switched, {
      type: "server-state",
      week: MONDAY,
      state: { plan: planFor(MONDAY, "Old draft") },
    });
    expect(draft.plan).toBeNull();
    // The answer of the new week's load counts.
    const loaded = planWeekReducer(switched, {
      type: "loaded",
      seq: 2,
      state: { plan: planFor(NEXT_MONDAY, "Next week") },
    });
    expect(loaded.plan?.days[0].items[0].title).toBe("Next week");
    expect(loaded.loading).toBe(false);
  });

  it("a failed load shows an error instead of the previous week's plan; a retry clears it", () => {
    const switched = planWeekReducer(loadedView(), {
      type: "load-started",
      week: NEXT_MONDAY,
      seq: 2,
    });
    const failed = planWeekReducer(switched, {
      type: "load-failed",
      seq: 2,
      message: "Could not load this week's plan. Please try again in a moment.",
    });
    expect(failed).toMatchObject({ loading: false, plan: null, loadError: expect.any(String) });
    // An older load failing late does not replace the newer state.
    expect(planWeekReducer(switched, { type: "load-failed", seq: 1, message: "x" })).toBe(switched);
    // Retry ("This week" on this week works the same way): a new load of the same week.
    const retry = planWeekReducer(failed, { type: "load-started", week: NEXT_MONDAY, seq: 3 });
    expect(retry).toMatchObject({ loading: true, loadError: null });
  });

  it("every plan from the server gets a new version; a local time edit does not (open editors restart only on the former)", () => {
    const view = loadedView();
    const edited = planWeekReducer(view, {
      type: "item-times",
      week: MONDAY,
      date: MONDAY,
      index: 0,
      starts_at: local(23, 12),
      ends_at: local(23, 13),
    });
    expect(edited.version).toBe(view.version);
    expect(edited.plan?.days[0].items[0].starts_at).toBe(local(23, 12));
    const refined = planWeekReducer(edited, {
      type: "server-state",
      week: MONDAY,
      state: { plan: planFor(MONDAY, "Refined") },
    });
    expect(refined.version).toBe(view.version + 1);
  });

  it("a refused time edit goes back to the plan from before, unless a newer plan came meanwhile", () => {
    const view = loadedView();
    const before = view.plan;
    const edited = planWeekReducer(view, {
      type: "item-times",
      week: MONDAY,
      date: MONDAY,
      index: 0,
      starts_at: local(23, 12),
      ends_at: local(23, 13),
    });
    const restored = planWeekReducer(edited, {
      type: "plan-restored",
      week: MONDAY,
      version: view.version,
      plan: before,
    });
    expect(restored.plan).toBe(before);
    const refined = planWeekReducer(edited, {
      type: "server-state",
      week: MONDAY,
      state: { plan: planFor(MONDAY, "Refined") },
    });
    const late = planWeekReducer(refined, {
      type: "plan-restored",
      week: MONDAY,
      version: view.version,
      plan: before,
    });
    expect(late.plan?.days[0].items[0].title).toBe("Refined");
  });

  it("a server answer that does not mention the request keeps the one shown", () => {
    const pending: WeekPlanRequestView = {
      id: "pending",
      kind: "refine",
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      reply: null,
      error: null,
    };
    const started = planWeekReducer(loadedView(), {
      type: "request-started",
      week: MONDAY,
      request: pending,
    });
    expect(started.request).toBe(pending);
    const after = planWeekReducer(started, {
      type: "server-state",
      week: MONDAY,
      state: { plan: planFor(MONDAY, "x") },
    });
    expect(after.request).toBe(pending);
    expect(
      planWeekReducer(started, { type: "server-state", week: MONDAY, state: { plan: null, request: null } })
        .request,
    ).toBeNull();
  });
});

describe("the event ids of the plan's items in the calendar (findings 39, 58)", () => {
  it("lists the ids of the events that are plan items, not of other events", () => {
    const plan: WeekPlan = {
      week_start: MONDAY,
      days: [
        {
          date: "2026-11-25",
          headline: "",
          items: [
            { emoji: "🎯", title: "Focus", starts_at: local(25, 10), ends_at: local(25, 11) },
          ],
        },
      ],
    };
    const state = planCalendarState(
      plan,
      [
        { id: "e1", title: "🎯 Focus", starts_at: local(25, 10), ends_at: local(25, 11) },
        { id: "e2", title: "Dentist", starts_at: local(25, 14), ends_at: local(25, 15) },
        { title: "🎯 Focus", starts_at: local(25, 10), ends_at: local(25, 11) },
      ],
      new Date(2026, 10, 24, 9).getTime(),
    );
    expect(state.addedEventIds).toEqual(["e1"]);
    expect(state.addedItems).toEqual({ "2026-11-25": [0] });
  });
});

describe("the week grid", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 24, 9, 0)); // Tuesday 09:00 local
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function plan(): WeekPlan {
    return {
      week_start: MONDAY,
      days: dates.map((date, i) => ({
        date,
        headline: "",
        items: [
          {
            emoji: "📖",
            title: `Read ${i + 1}`,
            starts_at: local(23 + i, 18),
            ends_at: local(23 + i, 19),
          },
        ],
      })),
    };
  }

  function render(props: Partial<Parameters<typeof PlanWeekGrid>[0]> = {}) {
    return renderToStaticMarkup(
      createElement(PlanWeekGrid, {
        plan: plan(),
        busyEvents: [],
        approvedDates: new Set<string>(),
        addedItems: {},
        onApproveDay: () => undefined,
        approving: null,
        onItemTimeChange: () => undefined,
        ...props,
      }),
    );
  }

  /** The HTML of one day card. */
  function card(html: string, date: string): string {
    const start = html.indexOf(`data-date="${date}"`);
    const next = html.indexOf('data-testid="plan-day"', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
  }

  const approveButton = (cardHtml: string) =>
    /<button[^>]*>(?:Approve|…)<\/button>/.exec(cardHtml)?.[0] ?? "";

  it("while the whole week is being approved, no day can start its own approval (finding 58)", () => {
    const html = render({ approving: "all" });
    expect(approveButton(card(html, "2026-11-29"))).toMatch(/ disabled=""/);
    expect(approveButton(card(html, "2026-11-25"))).toMatch(/ disabled=""/);
  });

  it("while one day is being approved, the others wait too, and only that day shows progress", () => {
    const html = render({ approving: "2026-11-25" });
    expect(approveButton(card(html, "2026-11-25"))).toMatch(/ disabled=""[^>]*>…</);
    expect(approveButton(card(html, "2026-11-26"))).toMatch(/ disabled=""[^>]*>Approve</);
  });

  it("approvals are paused when the page asks for it (calendar not loaded)", () => {
    expect(approveButton(card(render({ approveDisabled: true }), "2026-11-26"))).toMatch(
      / disabled=""/,
    );
    expect(approveButton(card(render(), "2026-11-26"))).not.toMatch(/ disabled=""/);
  });

  it("a busy event that runs past midnight shows on both days (finding 38)", () => {
    const late: BusyEvent = {
      title: "Night shift",
      starts_at: local(28, 22),
      ends_at: local(29, 2),
    };
    const early: BusyEvent = {
      title: "Sunday party",
      starts_at: local(22, 20),
      ends_at: local(23, 1),
    };
    const html = render({ busyEvents: [late, early] });
    expect(card(html, "2026-11-28")).toContain("Night shift");
    expect(card(html, "2026-11-28")).toMatch(/from 10:00\s?PM/);
    expect(card(html, "2026-11-29")).toContain("Night shift");
    expect(card(html, "2026-11-29")).toMatch(/until 2:00\s?AM/);
    // Started on the Sunday before the week: still blocks Monday morning.
    expect(card(html, "2026-11-23")).toContain("Sunday party");
  });

  it("the edit pencil has a name, is a plain button and shows under focus and on touch screens (findings 48, 55)", () => {
    const wednesday = card(render(), "2026-11-25");
    const pencil = /<button[^>]*aria-label="Edit time of Read 3"[^>]*>/.exec(wednesday)?.[0] ?? "";
    expect(pencil).not.toBe("");
    expect(pencil).toContain('type="button"');
    expect(pencil).toContain("focus-visible:opacity-100");
    expect(pencil).toContain("group-focus-within:opacity-100");
    // Hidden until hover only where the screen can hover; never plain "opacity-0" for everyone.
    expect(pencil).toContain("[@media(hover:hover)]:opacity-0");
    expect(pencil).not.toMatch(/class="opacity-0 /);
  });

  it("the time editor starts from the item it is opened for, and saving keeps the untouched time (finding 7)", () => {
    // The plan after a refinement moved the item from 14:15-16:00 to 15:15-17:00.
    const refined = { emoji: "🎯", title: "Focus", starts_at: local(25, 15, 15), ends_at: local(25, 17) };
    const html = renderToStaticMarkup(
      createElement(ItemTimeEditor, { item: refined, onSave: () => undefined, onClose: () => undefined }),
    );
    expect(html).toMatch(/aria-label="Start time of Focus"/);
    expect(html).toMatch(/value="15:15"/);
    expect(html).toMatch(/value="17:00"/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="Cancel editing"/);
    // Only the start changed: the end stays at the item's current 17:00, not an older value.
    expect(editedItemTimes(refined, "15:30", localHM(refined.ends_at))).toEqual({
      starts_at: local(25, 15, 30),
      ends_at: local(25, 17),
    });
    // The rows render no editor until it is opened.
    expect(render()).not.toMatch(/type="time"/);
  });

  it("items that have started offer no time editor (finding 60)", () => {
    const started = plan();
    started.days[1].items = [
      { emoji: "🎯", title: "Started", starts_at: local(24, 8, 50), ends_at: local(24, 9, 20) },
    ];
    const tuesday = card(render({ plan: started }), "2026-11-24");
    expect(tuesday).toContain("Started");
    expect(tuesday).not.toContain("Edit time");
    expect(card(render({ plan: started }), "2026-11-25")).toContain("Edit time of Read 3");
  });
});
