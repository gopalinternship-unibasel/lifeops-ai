import { describe, expect, it } from "vitest";
import { planTimeoutMs, quickTimeoutMs } from "@/server/lifeops-backend.server";
import { capToHostLimit } from "@/server/host-limit.server";
import { maxChatTurnMs } from "@/server/chat-turn.server";

describe("host request limit (LIFEOPS_MAX_REQUEST_MS)", () => {
  it("leaves windows alone when unset on a local run", () => {
    expect(capToHostLimit(240_000, {})).toBe(240_000);
    expect(capToHostLimit(240_000, { LIFEOPS_MAX_REQUEST_MS: "abc" })).toBe(240_000);
    expect(capToHostLimit(240_000, { LIFEOPS_MAX_REQUEST_MS: "0" })).toBe(240_000);
  });
  it("caps windows to the host's limit (GitHub Pages edition)", () => {
    expect(capToHostLimit(310_000, { LIFEOPS_MAX_REQUEST_MS: "160000" })).toBe(160_000);
    expect(capToHostLimit(90_000, { LIFEOPS_MAX_REQUEST_MS: "160000" })).toBe(90_000);
  });
  it("caps windows at Vercel's 300 s function limit when unset there", () => {
    // Vercel sets VERCEL=1 for its functions; the documented Vercel settings.
    const vercel = {
      VERCEL: "1",
      LLM_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/x/ai/v1",
      LLM_MODEL: "@cf/zai-org/glm-4.7-flash",
      LLM_FALLBACK_MODEL: "@cf/google/gemma-4-26b-a4b-it",
      LLM_TIMEOUT_MS: "60000",
      LIFEOPS_BACKEND_TIMEOUT_MS: "60000",
    };
    // "Plan it": the planner, then a chat turn, plus a minute (dashboard.functions.ts) was 360 s.
    const planIt = capToHostLimit(planTimeoutMs(vercel) + maxChatTurnMs(vercel) + 60_000, vercel);
    expect(planIt).toBe(300_000);
    expect(maxChatTurnMs(vercel)).toBe(240_000);
    // An explicit setting still wins (a Vercel plan with a longer limit).
    expect(capToHostLimit(600_000, { ...vercel, LIFEOPS_MAX_REQUEST_MS: "800000" })).toBe(600_000);
    expect(capToHostLimit(600_000, { VERCEL: "0" })).toBe(600_000);
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
