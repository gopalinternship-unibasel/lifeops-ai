import { describe, expect, it } from "vitest";
import { planTimeoutMs, quickTimeoutMs } from "@/server/lifeops-backend.server";

describe("planner call timeouts", () => {
  it("quick calls default to 10 s and read LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS", () => {
    expect(quickTimeoutMs({})).toBe(10_000);
    expect(quickTimeoutMs({ LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS: "25000" })).toBe(25_000);
  });

  it("ignores a value that is not a positive number", () => {
    expect(quickTimeoutMs({ LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS: "abc" })).toBe(10_000);
    expect(quickTimeoutMs({ LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS: "0" })).toBe(10_000);
    expect(quickTimeoutMs({ LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS: "-5" })).toBe(10_000);
  });

  it("plan calls keep their own setting", () => {
    expect(planTimeoutMs({ LIFEOPS_BACKEND_TIMEOUT_MS: "60000" })).toBe(60_000);
    expect(planTimeoutMs({ LLM_TIMEOUT_MS: "60000" })).toBe(90_000);
  });
});
