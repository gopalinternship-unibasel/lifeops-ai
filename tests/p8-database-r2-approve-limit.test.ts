/**
 * Round 2 of the database package, finding 41: approving a week plan when the demo calendar is at
 * its row limit (migration 20261125120000: 1000 events that are not over yet). approveWeekPlan
 * used to log each refused insert and count it as "failed", so the plan page read "5 failed" and
 * the visitor never saw the database's sentence, which says what to do. It now stops at the first
 * refusal and passes the sentence on.
 *
 * Runs the real approveWeekPlan, the real demo calendar connector (calendar.mock) and the real
 * dbError against an in-memory stand-in for the user's Supabase client. "Now" is Tuesday 24 Nov
 * 2026, 09:00 in Zurich; the plan's week starts on Monday 23 Nov.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zonedDateTimeToISO } from "@/server/timezone.server";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    plan: null as Row | null,
    events: [] as Row[],
    /** How many events the calendar takes before the database refuses (the row limit). */
    room: Infinity,
    /** Any other error the next inserts get, as PostgREST returns it. */
    insertError: null as unknown,
    insertAttempts: 0,
    seq: 0,
  };
  const SENTENCE =
    "This demo account has reached its limit of 1000 calendar events that are not over yet. Ask the assistant to cancel upcoming events you no longer need, or wait until some are over, then try again.";

  function from(table: string) {
    const filters: ((row: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row = {};
    const run = async (): Promise<{ data: Row[] | null; error: unknown }> => {
      if (table === "google_oauth_tokens") return { data: [], error: null };
      if (table === "weekly_plans") {
        const rows = state.plan ? [state.plan].filter((row) => filters.every((test) => test(row))) : [];
        if (op === "update") for (const row of rows) Object.assign(row, payload);
        return { data: rows.map((row) => ({ ...row })), error: null };
      }
      if (table !== "calendar_events") throw new Error(`unexpected table ${table}`);
      if (op === "insert") {
        state.insertAttempts++;
        if (state.insertError) return { data: null, error: state.insertError };
        if (state.room <= 0) {
          return {
            data: null,
            error: {
              code: "23514",
              message: SENTENCE,
              details: "Row limit 1000 per user on public.calendar_events.",
              hint: null,
            },
          };
        }
        state.room--;
        const row = { id: `ev-${++state.seq}`, ...payload };
        state.events.push(row);
        return { data: [{ ...row }], error: null };
      }
      const rows = state.events.filter((row) => filters.every((test) => test(row)));
      if (op === "delete") state.events = state.events.filter((row) => !rows.includes(row));
      return { data: rows.map((row) => ({ ...row })), error: null };
    };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      lt: (column: string, value: string) => {
        filters.push((row) => Date.parse(String(row[column])) < Date.parse(value));
        return builder;
      },
      gt: (column: string, value: string) => {
        filters.push((row) => Date.parse(String(row[column])) > Date.parse(value));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      insert: (value: Row) => {
        op = "insert";
        payload = value;
        return builder;
      },
      update: (value: Row) => {
        op = "update";
        payload = value;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      maybeSingle: async () => {
        const { data, error } = await run();
        return { data: data?.[0] ?? null, error };
      },
      single: async () => {
        const { data, error } = await run();
        return error ? { data: null, error } : { data: data?.[0] ?? null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        run().then(resolve, reject),
    };
    return builder;
  }
  return { state, SENTENCE, client: { from } };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (input: unknown) => unknown = (input) => input;
    const builder = {
      middleware: () => builder,
      validator: (fn: (input: unknown) => unknown) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (opts: { data: unknown; context: unknown }) =>
          fn({ data: validate(opts.data), context: opts.context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: h.client }));
vi.mock("@/server/limits.server", () => ({
  checkAiAllowance: vi.fn(async () => ({ allowed: true })),
  enforceAiAllowance: vi.fn(async () => undefined),
}));
vi.mock("@/server/google/calendar.server", () => ({
  listCalendarEvents: vi.fn(async () => {
    throw new Error("Google is not connected in these tests");
  }),
  insertCalendarEvent: vi.fn(async () => {
    throw new Error("Google is not connected in these tests");
  }),
}));

import { approveWeekPlan } from "@/functions/plan.functions";

const USER = "11111111-2222-3333-4444-555555555555";
const TZ = "Europe/Zurich";
const MONDAY = "2026-11-23";
const NOW = new Date("2026-11-24T08:00:00Z"); // Tuesday 09:00 in Zurich
const dates = Array.from({ length: 7 }, (_, i) => `2026-11-${String(23 + i).padStart(2, "0")}`);
const at = (date: string, hour: number) => zonedDateTimeToISO(date, { hour, minute: 0 }, TZ);

/** One evening item on each day from Wednesday to Sunday: five events still to come. */
function storePlan() {
  h.state.plan = {
    user_id: USER,
    week_start: MONDAY,
    approved_event_ids: [],
    payload: {
      week_start: MONDAY,
      days: dates.map((date, i) => ({
        date,
        headline: `Day ${i + 1}`,
        items: i >= 2 ? [{ emoji: "📖", title: `Read ${i + 1}`, starts_at: at(date, 18), ends_at: at(date, 19), notes: null }] : [],
      })),
    },
  };
}

type Call = (opts: { data: unknown; context: unknown }) => Promise<Record<string, unknown>>;
const approve = () =>
  (approveWeekPlan as unknown as Call)({ data: { weekStart: MONDAY }, context: { supabase: h.client, userId: USER } });

beforeEach(() => {
  Object.assign(h.state, { plan: null, events: [], room: Infinity, insertError: null, insertAttempts: 0, seq: 0 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  storePlan();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("approving a week plan at the calendar's row limit (finding 41)", () => {
  it("stops at the first refusal and tells the visitor what to do, with what was added", async () => {
    h.state.room = 2;
    await expect(approve()).rejects.toThrow(`Added 2 events of the plan. ${h.SENTENCE}`);
    // The three items after the refusal were not tried: each would be refused the same way.
    expect(h.state.insertAttempts).toBe(3);
    // The two events that were added are recorded as the plan's.
    expect(h.state.plan?.approved_event_ids).toEqual(["ev-1", "ev-2"]);
  });

  it("with no room at all, the visitor reads the database's sentence itself", async () => {
    h.state.room = 0;
    const error = await approve().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(h.SENTENCE);
    expect(h.state.insertAttempts).toBe(1);
    expect(h.state.events).toEqual([]);
  });

  it("still counts any other failed insert as failed and goes on", async () => {
    h.state.insertError = { code: "57014", message: "canceling statement due to statement timeout" };
    const result = await approve();
    expect(result).toMatchObject({ created: 0, failed: 5 });
    expect(h.state.insertAttempts).toBe(5);
  });

  it("adds the whole plan when there is room", async () => {
    const result = await approve();
    expect(result).toMatchObject({ created: 5, failed: 0 });
  });
});
