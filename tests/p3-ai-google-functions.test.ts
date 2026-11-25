/**
 * The Google server functions (src/functions/google.functions.ts), run offline: createServerFn is
 * replaced by a stand-in that runs the validator and the handler with a fixed context, and the
 * database, calendar, AI and limit modules are fakes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const harness = vi.hoisted(() => {
  const state: { context: Record<string, unknown> } = { context: {} };

  /** Stand-in for TanStack Start's builder: calling the function runs validator then handler. */
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

  /** A tiny in-memory Supabase client: select/eq/maybeSingle/upsert, with an optional forced error. */
  function fakeClient() {
    const tables = new Map<string, Row[]>();
    const errors = new Map<string, unknown>();
    const queries: string[] = [];
    function from(table: string) {
      const filters: [string, unknown][] = [];
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return builder;
        },
        in: () => builder,
        maybeSingle: async () => {
          queries.push(table);
          if (errors.has(table)) return { data: null, error: errors.get(table) };
          const row = (tables.get(table) ?? []).find((r) => filters.every(([c, v]) => r[c] === v));
          return { data: row ?? null, error: null };
        },
        upsert: async () => ({ error: errors.get(table) ?? null }),
      };
      return builder;
    }
    return { tables, errors, queries, client: { from } };
  }

  return { state, createServerFn, admin: fakeClient(), user: fakeClient() };
});

const mocks = vi.hoisted(() => ({
  isGoogleConnected: vi.fn(async () => false),
  assertNoCalendarConflict: vi.fn(async () => {}),
  createCalendarBlock: vi.fn(),
  saveReplyDraft: vi.fn(),
  claimCard: vi.fn(async () => ({ claimed: true })),
  recordCardResult: vi.fn(async () => {}),
  releaseCard: vi.fn(async () => {}),
  updateMockEvent: vi.fn(),
  deleteMockEvent: vi.fn(async () => {}),
  getCalendarEvent: vi.fn(),
  patchCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(async () => {}),
  listCalendarEvents: vi.fn(async () => []),
  callAI: vi.fn(),
  enforceAiAllowance: vi.fn(async () => {}),
  getMessage: vi.fn(),
  completeGoogleConnection: vi.fn(async () => ({ email: "me@example.com" })),
}));

vi.mock("@tanstack/react-start", () => ({ createServerFn: harness.createServerFn }));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://monday.example.com/_serverFn/abc"),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: harness.admin.client }));
vi.mock("@/server/workspace.server", () => ({
  isGoogleConnected: mocks.isGoogleConnected,
  assertNoCalendarConflict: mocks.assertNoCalendarConflict,
  createCalendarBlock: mocks.createCalendarBlock,
  saveReplyDraft: mocks.saveReplyDraft,
}));
vi.mock("@/server/chat-cards.server", () => ({
  claimCard: mocks.claimCard,
  recordCardResult: mocks.recordCardResult,
  releaseCard: mocks.releaseCard,
}));
vi.mock("@/server/connectors/calendar.mock", async (importOriginal) => ({
  // The demo inbox (gmail.mock) reads demoSeedEvents from this module, so keep the real exports.
  ...(await importOriginal<typeof import("@/server/connectors/calendar.mock")>()),
  updateEvent: mocks.updateMockEvent,
  deleteEvent: mocks.deleteMockEvent,
}));
vi.mock("@/server/google/calendar.server", () => ({
  EVENT_GONE: "This event is no longer in your calendar (already cancelled?).",
  getCalendarEvent: mocks.getCalendarEvent,
  patchCalendarEvent: mocks.patchCalendarEvent,
  deleteCalendarEvent: mocks.deleteCalendarEvent,
  listCalendarEvents: mocks.listCalendarEvents,
}));
vi.mock("@/server/google/gmail.server", () => ({
  getMessage: mocks.getMessage,
  listRecentMessages: vi.fn(async () => []),
}));
vi.mock("@/server/ai/llm.server", () => ({ callAI: mocks.callAI }));
vi.mock("@/server/limits.server", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/limits.server")>("@/server/limits.server");
  return { CapReachedError: actual.CapReachedError, enforceAiAllowance: mocks.enforceAiAllowance };
});
vi.mock("@/server/google/callback.server", () => ({
  completeGoogleConnection: mocks.completeGoogleConnection,
}));

import {
  completeGoogleOAuth,
  draftReplySuggestion,
  getGoogleConnectionStatus,
  getGoogleOAuthUrl,
  listMyCalendar,
  removeCalendarEvent,
  saveGmailDraft,
  updateCalendarEvent,
} from "@/functions/google.functions";
import { browserKeyHash, verifySignedOAuthState } from "@/server/google/oauth.server";
import { CapReachedError } from "@/server/limits.server";

const USER = "11111111-2222-3333-4444-555555555555";
const EVENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EVENT_GONE = "This event is no longer in your calendar (already cancelled?).";
/** A PostgREST error object as supabase-js returns it (a plain object, not an Error). */
const PG_ERROR = {
  code: "42501",
  message: "permission denied for table x",
  details: "secret detail",
  hint: "h",
};

/** The demo event as it is in the database: today 19:00-20:00 Zurich. */
const AT_19 = { starts_at: "2026-11-24T18:00:00+00:00", ends_at: "2026-11-24T19:00:00+00:00" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  harness.admin.tables.clear();
  harness.admin.errors.clear();
  harness.user.tables.clear();
  harness.user.errors.clear();
  harness.user.queries.length = 0;
  harness.state.context = { userId: USER, supabase: harness.user.client };
  harness.user.tables.set("calendar_events", [
    { id: EVENT, user_id: USER, title: "Team sync", ...AT_19 },
  ]);
  mocks.isGoogleConnected.mockResolvedValue(false);
  // The demo calendar's update writes the new times, as the real one does.
  mocks.updateMockEvent.mockImplementation(
    async (_s: unknown, _u: string, id: string, patch: Row) => {
      const row = harness.user.tables.get("calendar_events")?.find((r) => r.id === id);
      if (row)
        Object.assign(
          row,
          Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        );
      return row;
    },
  );
});

describe("a move card made for an older version of the event (finding 26)", () => {
  const card = (id: string, next: { starts_at: string; ends_at: string }) => ({
    cardId: id,
    eventId: EVENT,
    ...next,
    originalStartsAt: AT_19.starts_at,
    originalEndsAt: AT_19.ends_at,
  });

  it("applies the first card and refuses a second card for the same original time", async () => {
    const first = await updateCalendarEvent({
      data: card("change-a", {
        starts_at: "2026-11-25T08:00:00.000Z",
        ends_at: "2026-11-25T09:00:00.000Z",
      }),
    });
    expect(first).toMatchObject({ ok: true });

    const second = await updateCalendarEvent({
      data: card("change-b", {
        starts_at: "2026-11-24T14:00:00.000Z",
        ends_at: "2026-11-24T15:00:00.000Z",
      }),
    });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/This event has changed since this suggestion was made/);
    expect(mocks.updateMockEvent).toHaveBeenCalledTimes(1);
    expect(harness.user.tables.get("calendar_events")?.[0]?.starts_at).toBe(
      "2026-11-25T08:00:00.000Z",
    );
    // The refused card's claim is released, so the user can dismiss it.
    expect(mocks.releaseCard).toHaveBeenCalledWith(harness.user.client, USER, "change-b");
  });

  it("accepts a retry of the same card when the move went through but recording it failed", async () => {
    const tomorrow = { starts_at: "2026-11-25T08:00:00.000Z", ends_at: "2026-11-25T09:00:00.000Z" };
    mocks.recordCardResult.mockRejectedValueOnce(new Error("The card could not be updated."));
    const failed = await updateCalendarEvent({ data: card("change-r", tomorrow) });
    expect(failed.ok).toBe(false);
    // The event did move, and the claim was released, so the user can click the card again.
    expect(harness.user.tables.get("calendar_events")?.[0]?.starts_at).toBe(tomorrow.starts_at);
    expect(mocks.releaseCard).toHaveBeenCalledWith(harness.user.client, USER, "change-r");

    const retry = await updateCalendarEvent({ data: card("change-r", tomorrow) });
    expect(retry).toMatchObject({ ok: true });
    expect(retry.error).toBeNull();
    expect(mocks.recordCardResult).toHaveBeenLastCalledWith(
      harness.user.client,
      USER,
      "change-r",
      EVENT,
    );

    // A card that would move it somewhere else is still refused.
    const other = await updateCalendarEvent({
      data: card("change-s", {
        starts_at: "2026-11-24T14:00:00.000Z",
        ends_at: "2026-11-24T15:00:00.000Z",
      }),
    });
    expect(other.error).toMatch(/has changed since/);
  });

  it("compares instants, not spellings of the same time", async () => {
    const result = await updateCalendarEvent({
      data: {
        ...card("change-c", {
          starts_at: "2026-11-25T08:00:00.000Z",
          ends_at: "2026-11-25T09:00:00.000Z",
        }),
        originalStartsAt: "2026-11-24T19:00:00+01:00",
        originalEndsAt: "2026-11-24T19:00:00.000Z",
      },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("refuses a stale cancel card too, and cancels with a current one", async () => {
    const stale = await removeCalendarEvent({
      data: {
        eventId: EVENT,
        cardId: "c1",
        originalStartsAt: "2026-11-24T10:00:00Z",
        originalEndsAt: "2026-11-24T11:00:00Z",
      },
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/has changed since this suggestion/);
    expect(mocks.deleteMockEvent).not.toHaveBeenCalled();

    const current = await removeCalendarEvent({
      data: {
        eventId: EVENT,
        cardId: "c2",
        originalStartsAt: AT_19.starts_at,
        originalEndsAt: AT_19.ends_at,
      },
    });
    expect(current).toMatchObject({ ok: true });
    expect(mocks.deleteMockEvent).toHaveBeenCalledTimes(1);
  });

  it("checks Google Calendar's current times when Google is connected", async () => {
    mocks.isGoogleConnected.mockResolvedValue(true);
    mocks.getCalendarEvent.mockResolvedValueOnce({
      id: "g1",
      title: "x",
      starts_at: "2026-11-25T08:00:00Z",
      ends_at: "2026-11-25T09:00:00Z",
    });
    const moved = await updateCalendarEvent({
      data: {
        ...card("g-a", { starts_at: "2026-11-24T14:00:00Z", ends_at: "2026-11-24T15:00:00Z" }),
        eventId: "g1",
      },
    });
    expect(moved.error).toMatch(/has changed since/);
    expect(mocks.patchCalendarEvent).not.toHaveBeenCalled();

    mocks.getCalendarEvent.mockResolvedValueOnce(null);
    const gone = await updateCalendarEvent({
      data: {
        ...card("g-b", { starts_at: "2026-11-24T14:00:00Z", ends_at: "2026-11-24T15:00:00Z" }),
        eventId: "g1",
      },
    });
    expect(gone.error).toBe(EVENT_GONE);
  });

  it("still accepts a request without original times (a page from before this change)", async () => {
    const result = await updateCalendarEvent({
      data: {
        cardId: "old",
        eventId: EVENT,
        starts_at: "2026-11-25T08:00:00Z",
        ends_at: "2026-11-25T09:00:00Z",
      },
    });
    expect(result).toMatchObject({ ok: true });
  });
});

describe("event ids and dates are checked before they reach the database (finding 104)", () => {
  it("a demo-calendar id that is not a uuid reads 'no longer in your calendar', without a query", async () => {
    for (const call of [
      () =>
        updateCalendarEvent({
          data: {
            eventId: "not-a-uuid",
            starts_at: "2026-11-25T08:00:00Z",
            ends_at: "2026-11-25T09:00:00Z",
          },
        }),
      () => removeCalendarEvent({ data: { eventId: "not-a-uuid" } }),
    ]) {
      const result = await call();
      expect(result).toMatchObject({ ok: false, error: EVENT_GONE });
    }
    expect(harness.user.queries).toEqual([]);
    expect(mocks.updateMockEvent).not.toHaveBeenCalled();
    expect(mocks.deleteMockEvent).not.toHaveBeenCalled();
  });

  it("over-long ids and non-ISO calendar ranges are refused by the validator", async () => {
    await expect(removeCalendarEvent({ data: { eventId: "x".repeat(1025) } })).rejects.toThrow();
    await expect(listMyCalendar({ data: { timeMin: "1", timeMax: "2" } })).rejects.toThrow();
    await expect(
      listMyCalendar({
        data: { timeMin: new Date(0).toISOString(), timeMax: new Date(1).toISOString() },
      }),
    ).resolves.toEqual({ events: [], error: null });
  });
});

describe("no internal error text reaches the browser (finding 50)", () => {
  it("a database error object becomes a sentence; the details go to the log", async () => {
    mocks.isGoogleConnected.mockRejectedValueOnce(PG_ERROR);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await updateCalendarEvent({
      data: {
        cardId: "c",
        eventId: EVENT,
        starts_at: "2026-11-25T08:00:00Z",
        ends_at: "2026-11-25T09:00:00Z",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "The event could not be updated right now. Please try again in a moment.",
    );
    expect(log.mock.calls.map((c) => c.join(" ")).join(" ")).toContain("permission denied");
  });

  it("this app's own sentences pass through (a calendar conflict)", async () => {
    mocks.assertNoCalendarConflict.mockRejectedValueOnce(
      new Error("That time overlaps Lecture (10:00-12:00)."),
    );
    const result = await updateCalendarEvent({
      data: { eventId: EVENT, starts_at: "2026-11-25T08:00:00Z", ends_at: "2026-11-25T09:00:00Z" },
    });
    expect(result.error).toBe("That time overlaps Lecture (10:00-12:00).");
  });

  it("a status read that fails throws an Error with a sentence, not the PostgREST object", async () => {
    harness.admin.errors.set("google_oauth_tokens", PG_ERROR);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = getGoogleConnectionStatus();
    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.toThrow(
      "Could not check your Google connection. Please try again in a moment.",
    );
  });

  it("a failed draft save is a sentence, without the old 'Draft save failed:' raw text", async () => {
    mocks.saveReplyDraft.mockRejectedValueOnce(PG_ERROR);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await saveGmailDraft({
      data: { cardId: "d", messageId: "e1", replyBody: "Thanks!" },
    });
    expect(result.error).toBe(
      "The draft could not be saved right now. Please try again in a moment.",
    );
  });
});

describe("Google connection status (finding 36)", () => {
  it("does not send the names of missing server settings to the browser", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("GOOGLE_OAUTH_STATE_SECRET", "");
    const status = await getGoogleConnectionStatus();
    expect(status).toEqual({
      connected: false,
      email: null,
      scopes: null,
      demoMode: false,
      oauthConfigured: false,
    });
    expect(JSON.stringify(status)).not.toMatch(/GOOGLE_OAUTH_/);
  });
});

describe("starting and finishing a Google sign-in (finding 98)", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret");
    vi.stubEnv("GOOGLE_OAUTH_STATE_SECRET", "s".repeat(48));
  });

  it("gives the browser a key whose hash is the state's nonce", async () => {
    const { url, browserKey } = await getGoogleOAuthUrl();
    const state = new URL(url).searchParams.get("state") ?? "";
    const payload = await verifySignedOAuthState(state);
    expect(payload?.uid).toBe(USER);
    expect(payload?.nonce).toBe(await browserKeyHash(browserKey));
  });

  it("ignores a return path an older page still sends", async () => {
    const { url } = await (
      getGoogleOAuthUrl as unknown as (opts: { data: unknown }) => Promise<{ url: string }>
    )({
      data: { returnTo: "//evil.example" },
    });
    const state = new URL(url).searchParams.get("state") ?? "";
    expect((await verifySignedOAuthState(state))?.uid).toBe(USER);
    expect(Buffer.from(state.split(".")[0], "base64url").toString("utf8")).not.toContain("evil");
  });

  it("finishes the sign-in for the signed-in user, never for an id taken from the request body", async () => {
    await completeGoogleOAuth({ data: { code: "c", state: "s.t", browserKey: "k" } });
    expect(mocks.completeGoogleConnection).toHaveBeenCalledWith({
      userId: USER,
      code: "c",
      state: "s.t",
      browserKey: "k",
      origin: "https://monday.example.com",
    });
  });
});

describe("reply suggestions use the shared AI allowance (finding 45)", () => {
  const answer = (content: unknown) => ({ choices: [{ message: { content } }] });

  it("counts one use right before the AI call", async () => {
    mocks.callAI.mockResolvedValueOnce(answer("Thanks, see you then."));
    const result = await draftReplySuggestion({ data: { messageId: "e1" } });
    expect(result).toMatchObject({ ok: true, suggestion: "Thanks, see you then." });
    expect(mocks.enforceAiAllowance).toHaveBeenCalledTimes(1);
    expect(mocks.enforceAiAllowance).toHaveBeenCalledWith(harness.admin.client, USER, "draft");
    expect(mocks.enforceAiAllowance.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.callAI.mock.invocationCallOrder[0],
    );
  });

  it("returns the limit sentence and never calls the AI when the allowance is used up", async () => {
    mocks.enforceAiAllowance.mockRejectedValueOnce(
      new CapReachedError(
        "You have reached this demo's limit of 20 chat messages per hour. Please try again later.",
        "user",
      ),
    );
    const result = await draftReplySuggestion({ data: { messageId: "e1" } });
    expect(result).toMatchObject({
      ok: false,
      error:
        "You have reached this demo's limit of 20 chat messages per hour. Please try again later.",
    });
    expect(mocks.callAI).not.toHaveBeenCalled();
  });

  it("does not count a request that ends before the AI call (unknown email)", async () => {
    const result = await draftReplySuggestion({ data: { messageId: "no-such-email" } });
    expect(result.ok).toBe(false);
    expect(mocks.enforceAiAllowance).not.toHaveBeenCalled();
  });

  it("an AI failure is the AI's sentence, without an 'AI failed:' prefix; an internal fault is replaced", async () => {
    mocks.callAI.mockRejectedValueOnce(
      new Error("Cloudflare Workers AI could not be reached. Please try again in a moment."),
    );
    expect((await draftReplySuggestion({ data: { messageId: "e1" } })).error).toBe(
      "Cloudflare Workers AI could not be reached. Please try again in a moment.",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.callAI.mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'x')"),
    );
    expect((await draftReplySuggestion({ data: { messageId: "e1" } })).error).toBe(
      "The reply suggestion could not be written right now. Please try again in a moment.",
    );
  });

  it("puts at most 80 characters of the profile name into the prompt (finding 80)", async () => {
    harness.admin.tables.set("profiles", [{ id: USER, name: `Ada${"n".repeat(10_000)}` }]);
    mocks.callAI.mockResolvedValueOnce(answer("Hi"));
    await draftReplySuggestion({ data: { messageId: "e1" } });
    const prompt = String(
      (mocks.callAI.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[1].content,
    );
    expect(prompt).toContain("Write a reply on behalf of Ada");
    expect(prompt).not.toMatch(/n{80}/);
    expect(prompt.length).toBeLessThan(2_000);
  });

  it("clips an over-long suggestion to what a saved draft may hold before saving it", async () => {
    mocks.callAI.mockResolvedValueOnce(answer(`Dear Ada,\n${"x".repeat(20_000)}`));
    mocks.saveReplyDraft.mockResolvedValueOnce({
      draftId: "d1",
      subject: "Re: x",
      to: "a@example.com",
      provider: "demo",
    });
    const result = await draftReplySuggestion({ data: { messageId: "e1", save: true } });
    expect(result.ok).toBe(true);
    const saved = (mocks.saveReplyDraft.mock.calls[0]?.[0] as { replyBody: string }).replyBody;
    expect(saved.length).toBe(10_000);
    expect(saved.startsWith("Dear Ada,")).toBe(true);
    expect(result.suggestion).toBe(saved);
    // The same text is accepted by saveGmailDraft, which saves a reviewed suggestion later.
    mocks.saveReplyDraft.mockResolvedValueOnce({
      draftId: "d2",
      subject: "Re: x",
      to: "a@example.com",
      provider: "demo",
    });
    expect((await saveGmailDraft({ data: { messageId: "e1", replyBody: saved } })).ok).toBe(true);
  });

  it("an answer whose content is not text is treated as empty, not a crash", async () => {
    mocks.callAI.mockResolvedValueOnce(answer([{ type: "text", text: "x" }]));
    const result = await draftReplySuggestion({ data: { messageId: "e1" } });
    expect(result).toMatchObject({ ok: false, error: "Empty AI response" });
  });
});
