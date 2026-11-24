import { describe, expect, it } from "vitest";
import { planTimeoutMs, quickTimeoutMs } from "@/server/lifeops-backend.server";
import { capToHostLimit } from "@/server/host-limit.server";
import { maxChatTurnMs } from "@/server/chat-turn.server";

describe("host request limit (LIFEOPS_MAX_REQUEST_MS)", () => {
  it("leaves windows alone when unset (Vercel)", () => {
    expect(capToHostLimit(240_000, {})).toBe(240_000);
    expect(capToHostLimit(240_000, { LIFEOPS_MAX_REQUEST_MS: "abc" })).toBe(240_000);
    expect(capToHostLimit(240_000, { LIFEOPS_MAX_REQUEST_MS: "0" })).toBe(240_000);
  });
  it("caps windows to the host's limit (GitHub Pages edition)", () => {
    expect(capToHostLimit(310_000, { LIFEOPS_MAX_REQUEST_MS: "160000" })).toBe(160_000);
    expect(capToHostLimit(90_000, { LIFEOPS_MAX_REQUEST_MS: "160000" })).toBe(90_000);
  });
  it("applies to the chat-turn window", () => {
    const pages = { LLM_TIMEOUT_MS: "40000", LLM_FALLBACK_MODEL: "fallback", LLM_BASE_URL: "https://x.test/v1" };
    expect(maxChatTurnMs(pages)).toBe(200_000);
    expect(maxChatTurnMs({ ...pages, LIFEOPS_MAX_REQUEST_MS: "160000" })).toBe(160_000);
  });
});

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
