/**
 * The chat server functions (src/functions/chat.functions.ts) and the card records
 * (src/server/chat-cards.server.ts), run offline: createServerFn is replaced by a stand-in that
 * runs the validator and the handler with a fixed context. Findings of the review of
 * 24 Nov 2026: 49, 50, 87, 104.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

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

  /** A query recorder: every call is logged, and the answer comes from `answer`. */
  function recorder(name: string, answer: (table: string, calls: [string, unknown[]][]) => { data: unknown; error: unknown }) {
    const log: { client: string; table: string; calls: [string, unknown[]][] }[] = [];
    return {
      log,
      client: {
        from(table: string) {
          const calls: [string, unknown[]][] = [];
          log.push({ client: name, table, calls });
          const builder: Record<string, unknown> = {};
          for (const method of ["select", "insert", "upsert", "update", "delete", "eq", "in", "is", "order", "limit", "lt", "gt"]) {
            builder[method] = (...args: unknown[]) => {
              calls.push([method, args]);
              return builder;
            };
          }
          builder.maybeSingle = async () => answer(table, calls);
          builder.single = async () => answer(table, calls);
          builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(answer(table, calls)).then(resolve, reject);
          return builder;
        },
      },
    };
  }

  const answers: { user: (table: string, calls: [string, unknown[]][]) => { data: unknown; error: unknown } } = {
    user: () => ({ data: [], error: null }),
  };
  const user = recorder("user", (table, calls) => answers.user(table, calls));
  const admin = recorder("admin", () => ({ data: null, error: null }));
  return { state, createServerFn, user, admin, answers };
});

const mocks = vi.hoisted(() => ({
  isGoogleConnected: vi.fn(async () => false),
  listCalendarEvents: vi.fn(async () => [] as unknown[]),
  ensureSeedEvents: vi.fn(async () => {}),
  listEventsForRange: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@tanstack/react-start", () => ({ createServerFn: harness.createServerFn }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: harness.admin.client }));
vi.mock("@/server/workspace.server", () => ({ isGoogleConnected: mocks.isGoogleConnected }));
vi.mock("@/server/google/calendar.server", () => ({ listCalendarEvents: mocks.listCalendarEvents }));
vi.mock("@/server/google/gmail.server", () => ({ listUnreadMessages: vi.fn(), listRecentMessages: vi.fn() }));
vi.mock("@/server/connectors/calendar.mock", async () => {
  const actual = await vi.importActual<typeof import("@/server/connectors/calendar.mock")>("@/server/connectors/calendar.mock");
  return { ...actual, ensureSeedEvents: mocks.ensureSeedEvents, listEventsForRange: mocks.listEventsForRange };
});
vi.mock("@/server/deployment.server", () => ({ isHostedDeployment: () => true }));

import { dismissChatCard, fetchCalendar, fetchSessionHistory } from "@/functions/chat.functions";
import { HISTORY_LIMIT, recordCardResult, releaseCard } from "@/server/chat-cards.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const USER = "user-1";
const SESSION = "11111111-1111-4111-8111-111111111111";
const CARD = "pending-22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  harness.state.context = { supabase: harness.user.client, userId: USER };
  harness.user.log.length = 0;
  harness.admin.log.length = 0;
  harness.answers.user = () => ({ data: [], error: null });
  mocks.isGoogleConnected.mockReset().mockResolvedValue(false);
  mocks.listCalendarEvents.mockReset().mockResolvedValue([]);
  mocks.listEventsForRange.mockReset().mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the chat history loads the newest messages (87)", () => {
  /** A session of 1,001 messages: 500 answered turns, then a message still being answered. */
  function messages(): Row[] {
    const rows: Row[] = [];
    const start = Date.parse("2026-11-20T08:00:00Z");
    for (let i = 0; i < 1001; i++) {
      rows.push({
        id: `m${String(i).padStart(4, "0")}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
        panel_payload: null,
        created_at: new Date(start + i * 60_000).toISOString(),
      });
    }
    rows[1000].created_at = new Date(Date.now() - 1000).toISOString();
    return rows;
  }

  it("asks for the newest rows (descending, limited) and shows them oldest first, with the true reply state", async () => {
    const all = messages();
    harness.answers.user = (table, calls) => {
      if (table !== "chat_messages") return { data: [], error: null };
      // PostgREST: order and limit as asked, never more than 1,000 rows.
      const descending = calls.some(([method, args]) => method === "order" && (args[1] as { ascending?: boolean })?.ascending === false);
      const limit = calls.find(([method]) => method === "limit")?.[1][0] as number | undefined;
      const ordered = descending ? [...all].reverse() : all;
      return { data: ordered.slice(0, Math.min(limit ?? Infinity, 1000)), error: null };
    };
    const result = await fetchSessionHistory({ data: { sessionId: SESSION } });
    expect(result.messages).toHaveLength(HISTORY_LIMIT);
    expect(result.messages.at(-1)?.content).toBe("message 1000");
    expect(result.messages[0].content).toBe(`message ${1001 - HISTORY_LIMIT}`);
    expect(result.replyState.kind).toBe("awaiting");
    expect(result.hasOlder).toBe(true);
  });

  it("splits many card ids over several requests", async () => {
    const panel = { pendingEvents: Array.from({ length: 150 }, (_, i) => ({ id: `pending-${i}`, title: "x", starts_at: "", ends_at: "" })) };
    harness.answers.user = (table) =>
      table === "chat_messages"
        ? { data: [{ id: "a1", role: "assistant", content: "x", panel_payload: panel, created_at: "2026-11-24T08:00:00.000Z" }], error: null }
        : { data: [], error: null };
    await fetchSessionHistory({ data: { sessionId: SESSION } });
    const cardQueries = harness.user.log.filter((entry) => entry.table === "chat_card_actions");
    expect(cardQueries).toHaveLength(2);
    for (const query of cardQueries) {
      const ids = query.calls.find(([method]) => method === "in")?.[1][1] as string[];
      expect(ids.length).toBeLessThanOrEqual(100);
    }
  });

  it("a database error is a plain sentence", async () => {
    harness.answers.user = () => ({ data: null, error: { code: "08006", message: "connection failure", details: "at node_modules/x.js:1", hint: "" } });
    const failure = await fetchSessionHistory({ data: { sessionId: SESSION } }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Could not load your chat. Please try again in a moment.");
  });
});

describe("card records are written by the server (49)", () => {
  it("a dismissal goes through the service role, for this user's card only", async () => {
    await expect(dismissChatCard({ data: { cardId: CARD } })).resolves.toEqual({ ok: true });
    expect(harness.user.log).toHaveLength(0);
    expect(harness.admin.log).toHaveLength(1);
    const upsert = harness.admin.log[0].calls.find(([method]) => method === "upsert")!;
    expect(upsert[1][0]).toEqual({ user_id: USER, card_id: CARD, status: "dismissed" });
  });

  it("a result is recorded, and a claim released, only while the card has no result", async () => {
    const supabase = harness.user.client as unknown as SupabaseClient<Database>;
    await recordCardResult(supabase, USER, CARD, "event-1");
    await releaseCard(supabase, USER, CARD);
    expect(harness.user.log).toHaveLength(0);
    for (const entry of harness.admin.log) {
      expect(entry.calls).toContainEqual(["eq", ["user_id", USER]]);
      expect(entry.calls).toContainEqual(["is", ["result_id", null]]);
    }
  });

  it("a card id that is not one the chat makes is refused before anything is written", async () => {
    await expect(dismissChatCard({ data: { cardId: "x" } })).rejects.toThrow();
    await expect(dismissChatCard({ data: { cardId: "pending-1; drop table" } })).rejects.toThrow();
    expect(harness.admin.log).toHaveLength(0);
  });
});

describe("the calendar range is checked (104) and errors are plain (50)", () => {
  it("refuses values that are not date-times with a zone", async () => {
    await expect(fetchCalendar({ data: { from: "1", to: "2" } })).rejects.toThrow();
    await expect(fetchCalendar({ data: { from: "2026-11-24" } })).rejects.toThrow();
    await expect(
      fetchCalendar({ data: { from: new Date(0).toISOString(), to: new Date(3_600_000).toISOString(), timeZone: "Europe/Zurich" } }),
    ).resolves.toMatchObject({ source: "mock" });
  });

  it("a Google error with an internal code is shown as a plain sentence", async () => {
    mocks.isGoogleConnected.mockResolvedValue(true);
    mocks.listCalendarEvents.mockRejectedValue(new Error("GOOGLE_NOT_CONNECTED"));
    await expect(fetchCalendar({ data: {} })).resolves.toMatchObject({
      events: [],
      error: "Your Google Calendar could not be read right now. Please try again in a moment.",
    });
    mocks.listCalendarEvents.mockRejectedValue(new Error("Google Calendar could not load your events right now (HTTP 503). Please try again in a moment."));
    await expect(fetchCalendar({ data: {} })).resolves.toMatchObject({
      error: "Google Calendar could not load your events right now (HTTP 503). Please try again in a moment.",
    });
  });
});
