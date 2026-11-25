/**
 * Finding 42, round 3: a demo reply draft is saved from the demo email as the visitor's inbox
 * list showed it, so the server functions that save one pass the visitor's time zone on to
 * saveReplyDraft (src/server/workspace.server.ts). createServerFn is replaced by a stand-in that
 * runs the validator and the handler; the workspace, card, Google and AI modules are fakes.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state: { context: Record<string, unknown> } = { context: {} };
  function createServerFn() {
    let validator: ((data: unknown) => unknown) | undefined;
    const builder = {
      middleware: () => builder,
      validator: (fn: (data: unknown) => unknown) => {
        validator = fn;
        return builder;
      },
      handler:
        (fn: (ctx: { data: unknown; context: unknown }) => unknown) =>
        async (opts: { data?: unknown } = {}) =>
          fn({ data: validator ? validator(opts.data) : opts.data, context: state.context }),
    };
    return builder;
  }
  /** Reads of the profile name: always no profile. */
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { state, createServerFn, client: { from: () => query } };
});

const mocks = vi.hoisted(() => ({
  saveReplyDraft: vi.fn(async () => ({ draftId: "d1", subject: "Re: x", to: "a@example.com", provider: "demo" as const })),
  callAI: vi.fn(async () => ({ choices: [{ message: { content: "Sounds good, see you then." } }] })),
}));

vi.mock("@tanstack/react-start", () => ({ createServerFn: harness.createServerFn }));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://monday.example.com/_serverFn/abc"),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: harness.client }));
vi.mock("@/server/workspace.server", () => ({
  isGoogleConnected: vi.fn(async () => false),
  assertNoCalendarConflict: vi.fn(async () => {}),
  createCalendarBlock: vi.fn(),
  saveReplyDraft: mocks.saveReplyDraft,
}));
vi.mock("@/server/chat-cards.server", () => ({
  claimCard: vi.fn(async () => ({ claimed: true })),
  recordCardResult: vi.fn(async () => {}),
  releaseCard: vi.fn(async () => {}),
}));
vi.mock("@/server/google/calendar.server", () => ({
  EVENT_GONE: "This event is no longer in your calendar (already cancelled?).",
  getCalendarEvent: vi.fn(),
  patchCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  listCalendarEvents: vi.fn(async () => []),
}));
vi.mock("@/server/google/gmail.server", () => ({
  getMessage: vi.fn(),
  listRecentMessages: vi.fn(async () => []),
}));
vi.mock("@/server/ai/llm.server", async () => {
  const actual = await vi.importActual<typeof import("@/server/ai/llm.server")>("@/server/ai/llm.server");
  return { AiNotConfiguredError: actual.AiNotConfiguredError, callAI: mocks.callAI, resolveLLMConfig: actual.resolveLLMConfig };
});
vi.mock("@/server/limits.server", async () => {
  const actual = await vi.importActual<typeof import("@/server/limits.server")>("@/server/limits.server");
  return { CapReachedError: actual.CapReachedError, enforceAiAllowance: vi.fn(async () => {}) };
});
vi.mock("@/server/google/callback.server", () => ({ completeGoogleConnection: vi.fn() }));

import { draftReplySuggestion, saveGmailDraft } from "@/functions/google.functions";

const USER = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  harness.state.context = { userId: USER, supabase: harness.client };
});

describe("the visitor's time zone reaches saveReplyDraft (42)", () => {
  it("saveGmailDraft passes it on", async () => {
    const result = await saveGmailDraft({
      data: { cardId: "draft-1", messageId: "e3", replyBody: "Sure!", timeZone: "Europe/Zurich" },
    });
    expect(result.ok).toBe(true);
    expect(mocks.saveReplyDraft).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "e3", replyBody: "Sure!", timeZone: "Europe/Zurich" }),
    );
  });

  it("saveGmailDraft still works without one (an older page)", async () => {
    const result = await saveGmailDraft({ data: { messageId: "e3", replyBody: "Sure!" } });
    expect(result.ok).toBe(true);
    expect(mocks.saveReplyDraft).toHaveBeenCalledWith(expect.objectContaining({ timeZone: undefined }));
  });

  it("saveGmailDraft refuses an over-long time zone like the other server functions", async () => {
    await expect(
      saveGmailDraft({ data: { messageId: "e3", replyBody: "Sure!", timeZone: "x".repeat(101) } }),
    ).rejects.toThrow();
    expect(mocks.saveReplyDraft).not.toHaveBeenCalled();
  });

  it("draftReplySuggestion with save passes the zone it read the email in", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "");
    const result = await draftReplySuggestion({ data: { messageId: "e3", save: true, timeZone: "Europe/Zurich" } });
    expect(result.ok).toBe(true);
    expect(mocks.saveReplyDraft).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "e3", timeZone: "Europe/Zurich" }),
    );
  });

  it("the reply card sends the browser's time zone when it saves a draft", () => {
    const source = readFileSync("src/components/workspace/ContextPanel.tsx", "utf8");
    expect(source).toMatch(/saveGmailDraft\(\{ data: \{[^}]*timeZone: getBrowserTimeZone\(\)/);
  });
});
