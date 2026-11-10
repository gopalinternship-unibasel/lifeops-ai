/**
 * QA round 4 (10 Nov 2026), week plan page: a draft must survive a reload (stored request with
 * a status), and a day with nothing to add must not offer Approve.
 */
import { describe, expect, it } from "vitest";
import { planDayStatus } from "@/lib/plan-state";
import { weekPlanRequestView } from "@/lib/week-plan-request";

// Local times, whatever zone the tests run in.
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 10, 10, 9, 0).getTime(); // Tuesday 10 Nov 2026, 09:00 local

describe("plan day cards", () => {
  it("a day that is over with no items reads Past, not Approve (QA: Monday after Approve entire week)", () => {
    expect(planDayStatus({ date: "2026-11-09", items: [] }, [], false, NOW)).toBe("over");
  });

  it("Approve only while an item is still to add; Added once they are in the calendar", () => {
    const items = [{ starts_at: local(2026, 11, 10, 8) }, { starts_at: local(2026, 11, 10, 18) }];
    expect(planDayStatus({ date: "2026-11-10", items }, [], false, NOW)).toBe("approve");
    expect(planDayStatus({ date: "2026-11-10", items }, [1], false, NOW)).toBe("added"); // the 08:00 one is past
    expect(planDayStatus({ date: "2026-11-10", items: [items[0]] }, [], false, NOW)).toBe("over"); // only a past item
    expect(planDayStatus({ date: "2026-11-12", items: [] }, [], false, NOW)).toBe("empty");
    expect(planDayStatus({ date: "2026-11-12", items: [{ starts_at: local(2026, 11, 12, 9) }] }, [0], true, NOW)).toBe("added");
  });
});

describe("stored plan requests", () => {
  const row = { id: "r1", kind: "create", status: "running", reply: null, error: null, created_at: new Date(NOW - 60_000).toISOString(), finished_at: null };

  it("a running draft is shown as running after a reload, a cut-off one as interrupted", () => {
    expect(weekPlanRequestView(row, NOW, 30 * 60_000)).toMatchObject({ status: "running", kind: "create", reply: null });
    expect(weekPlanRequestView(row, NOW + 40 * 60_000, 30 * 60_000)).toMatchObject({ status: "interrupted" });
  });

  it("done carries the model's reply, failed its error", () => {
    expect(weekPlanRequestView({ ...row, status: "done", reply: "Plan ready.", finished_at: new Date(NOW).toISOString() }, NOW, 1)).toMatchObject({
      status: "done",
      reply: "Plan ready.",
      error: null,
    });
    expect(weekPlanRequestView({ ...row, kind: "refine", status: "failed", error: "Ollama did not answer within 1800 s." }, NOW, 1)).toMatchObject({
      status: "failed",
      kind: "refine",
      error: "Ollama did not answer within 1800 s.",
      reply: null,
    });
  });
});
