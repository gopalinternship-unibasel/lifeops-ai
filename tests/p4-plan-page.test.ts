/**
 * The plan page (src/routes/app.plan.tsx) rendered to HTML on the server, as a smoke test of its
 * first render: the test setup has no browser DOM, so effects (the week load) do not run here.
 * The state changes behind the page are tested on planWeekReducer in p4-plan-client.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/functions/plan.functions", () => ({
  fetchWeekPlan: vi.fn(),
  generateWeekPlan: vi.fn(),
  refineWeekPlan: vi.fn(),
  approveWeekPlan: vi.fn(),
  updatePlanItem: vi.fn(),
}));

import { Route } from "@/routes/app.plan";

describe("the plan page's first render (findings 64, 48)", () => {
  it("shows the loading state, no week actions yet, and an empty live region for replies", () => {
    const Page = Route.options.component as ComponentType;
    const html = renderToStaticMarkup(createElement(Page));
    // While the week loads, the plan is unknown: no "Approve entire week" and no grid.
    expect(html).not.toContain("Approve entire week");
    expect(html).not.toContain('data-testid="plan-day"');
    // The region that announces MONDAY's replies is there from the start, empty.
    expect(html).toMatch(/<div class="sr-only" role="status" aria-live="polite" aria-atomic="true"><\/div>/);
    // "Create plan" waits for the load.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Create plan<\/button>/s);
  });
});
