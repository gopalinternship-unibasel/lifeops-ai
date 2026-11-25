/**
 * The week plan server functions (src/functions/plan.functions.ts), run for real against an
 * in-memory Supabase, an in-memory demo calendar and a scripted model. Only the TanStack server
 * function wrapper, the auth middleware, the AI allowance and the model call are replaced.
 *
 * "Now" is Tuesday 24 Nov 2026, 09:00 in Zurich; the week shown starts on Monday 23 Nov.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zonedDateTimeToISO } from "@/server/timezone.server";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const tables = new Map<string, Row[]>();
  // "<table>:<op>" -> the error object PostgREST would return.
  const failures = new Map<string, unknown>();
  const upserts: { table: string; payload: Row }[] = [];
  // Per table, delays (ms) for its next updates, one per update, so that two calls can overlap.
  const updateDelays = new Map<string, number[]>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, "0")}`;

  function from(table: string) {
    const filters: ((row: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row = {};
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const rows = () => tables.get(table) ?? [];

    const run = async (): Promise<{ data: Row[] | null; error: unknown }> => {
      const failure = failures.get(`${table}:${op}`);
      if (failure) return { data: null, error: failure };
      if (op === "insert") {
        const row: Row = {
          id: nextId(table),
          created_at: new Date().toISOString(),
          ...(table === "week_plan_requests"
            ? { status: "running", reply: null, error: null, finished_at: null }
            : {}),
          ...payload,
        };
        // The database package's partial unique index: one running request per user and week.
        if (
          table === "week_plan_requests" &&
          row.status === "running" &&
          rows().some(
            (other) =>
              other.status === "running" &&
              other.user_id === row.user_id &&
              other.week_start === row.week_start,
          )
        ) {
          return {
            data: null,
            error: {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "week_plan_requests_one_running"',
            },
          };
        }
        tables.set(table, [...rows(), row]);
        return { data: [{ ...row }], error: null };
      }
      if (op === "update") {
        const delay = updateDelays.get(table)?.shift();
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      let matched = rows().filter((row) => filters.every((test) => test(row)));
      if (op === "update") {
        for (const row of matched) Object.assign(row, payload);
        return { data: matched, error: null };
      }
      if (op === "delete") {
        tables.set(
          table,
          rows().filter((row) => !matched.includes(row)),
        );
        return { data: matched, error: null };
      }
      if (order) {
        const { column, ascending } = order;
        matched = [...matched].sort(
          (a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1),
        );
      }
      if (limit !== null) matched = matched.slice(0, limit);
      return { data: matched.map((row) => ({ ...row })), error: null };
    };

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      lt: (column: string, value: string) => {
        filters.push((row) => String(row[column]) < value);
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        order = { column, ascending: opts?.ascending !== false };
        return builder;
      },
      limit: (n: number) => {
        limit = n;
        return builder;
      },
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
      upsert: async (value: Row, opts?: { onConflict?: string }) => {
        const failure = failures.get(`${table}:upsert`);
        if (failure) return { error: failure };
        upserts.push({ table, payload: value });
        const keys = (opts?.onConflict ?? "id").split(",");
        const existing = rows().find((row) => keys.every((key) => row[key] === value[key]));
        if (existing) Object.assign(existing, value);
        else tables.set(table, [...rows(), { ...value }]);
        return { error: null };
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

  // The demo calendar (calendar_events through calendar.mock), with an optional delay on writes
  // so that two approvals can overlap as they do over the network.
  const calendar = {
    events: [] as {
      id: string;
      title: string;
      starts_at: string;
      ends_at: string;
      notes: string | null;
      source: string;
    }[],
    writeDelayMs: 0,
    // Per write, in order: the delay and the id of the next events (else writeDelayMs and the
    // next sequential id). Real event ids are random, so a later write can get a smaller id.
    writeDelays: [] as number[],
    ids: [] as string[],
    failReads: false,
  };

  return {
    tables,
    failures,
    upserts,
    updateDelays,
    calendar,
    nextId,
    client: { from },
    reset() {
      tables.clear();
      failures.clear();
      upserts.length = 0;
      updateDelays.clear();
      calendar.events.length = 0;
      calendar.writeDelayMs = 0;
      calendar.writeDelays.length = 0;
      calendar.ids.length = 0;
      calendar.failReads = false;
      seq = 0;
    },
  };
});

vi.mock("@tanstack/react-start", () => ({
  // The server function as a plain async function: validator, then handler, with the context
  // the auth middleware would give.
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
vi.mock("@/server/ai/llm.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ai/llm.server")>()),
  callAI: vi.fn(),
}));
vi.mock("@/server/google/calendar.server", () => ({
  listCalendarEvents: vi.fn(async () => {
    throw new Error("Google is not connected in these tests");
  }),
  insertCalendarEvent: vi.fn(async () => {
    throw new Error("Google is not connected in these tests");
  }),
}));
vi.mock("@/server/connectors/calendar.mock", () => ({
  ensureSeedEvents: vi.fn(async () => undefined),
  listEventsForRange: vi.fn(
    async (_client: unknown, _userId: string, fromIso: string, toIso: string) => {
      if (h.calendar.failReads)
        throw { code: "57014", message: "canceling statement due to statement timeout" };
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      return h.calendar.events
        .filter((event) => Date.parse(event.starts_at) < to && Date.parse(event.ends_at) > from)
        .map((event) => ({ ...event }));
    },
  ),
  createEvent: vi.fn(
    async (
      _client: unknown,
      _userId: string,
      input: {
        title: string;
        starts_at: string;
        ends_at: string;
        notes?: string | null;
        source?: string;
      },
    ) => {
      const delay = h.calendar.writeDelays.shift() ?? h.calendar.writeDelayMs;
      const id = h.calendar.ids.shift() ?? h.nextId("ev");
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const event = {
        id,
        title: input.title,
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        notes: input.notes ?? null,
        source: input.source ?? "chat",
      };
      h.calendar.events.push(event);
      return { ...event };
    },
  ),
  deleteEvent: vi.fn(async (_client: unknown, _userId: string, id: string) => {
    const index = h.calendar.events.findIndex((event) => event.id === id);
    if (index < 0)
      throw new Error("This event is no longer in your calendar (already cancelled?).");
    h.calendar.events.splice(index, 1);
  }),
}));

import * as planFunctions from "@/functions/plan.functions";
import { callAI } from "@/server/ai/llm.server";
import { checkAiAllowance, enforceAiAllowance } from "@/server/limits.server";
import { createEvent, listEventsForRange } from "@/server/connectors/calendar.mock";
import type { WeekPlan } from "@/types/plan";

const USER = "11111111-2222-3333-4444-555555555555";
const TZ = "Europe/Zurich";
const MONDAY = "2026-11-23";
const NOW = new Date("2026-11-24T08:00:00Z"); // Tuesday 09:00 in Zurich
const context = { supabase: h.client, userId: USER };

type Call = (opts: { data: unknown; context: unknown }) => Promise<Record<string, unknown>>;
const call = (fn: unknown, data: unknown) => (fn as Call)({ data, context });
const generate = (data: Record<string, unknown>) =>
  call(planFunctions.generateWeekPlan, { timeZone: TZ, ...data });
const refine = (message: string) =>
  call(planFunctions.refineWeekPlan, { weekStart: MONDAY, message, timeZone: TZ });
const fetchPlan = (data: Record<string, unknown> = {}) =>
  call(planFunctions.fetchWeekPlan, { weekStart: MONDAY, timeZone: TZ, ...data });
const approve = (data: Record<string, unknown> = {}) =>
  call(planFunctions.approveWeekPlan, { weekStart: MONDAY, ...data });
const updateItem = (data: Record<string, unknown>) =>
  call(planFunctions.updatePlanItem, { weekStart: MONDAY, timeZone: TZ, ...data });

const at = (date: string, hour: number, minute = 0) =>
  zonedDateTimeToISO(date, { hour, minute }, TZ);
const dates = Array.from({ length: 7 }, (_, i) => `2026-11-${String(23 + i).padStart(2, "0")}`);
const [MON, TUE, WED, THU, FRI, SAT, SUN] = dates;

/** A saved plan: one evening item per day; Monday's is over, Tuesday's at 14:00. */
function savedPlan(): WeekPlan {
  return {
    week_start: MONDAY,
    days: dates.map((date, i) => ({
      date,
      headline: `Day ${i + 1}`,
      items:
        date === TUE
          ? [
              {
                emoji: "🎯",
                title: "Deep work",
                starts_at: at(TUE, 14),
                ends_at: at(TUE, 15),
                notes: null,
              },
            ]
          : [
              {
                emoji: "📖",
                title: `Read ${i + 1}`,
                starts_at: at(date, 18),
                ends_at: at(date, 19),
                notes: null,
              },
            ],
    })),
  };
}

function storePlan(plan: unknown, approvedIds: string[] = []) {
  h.tables.set("weekly_plans", [
    {
      id: "plan-1",
      user_id: USER,
      week_start: MONDAY,
      payload: plan,
      approved_event_ids: approvedIds,
    },
  ]);
}

function storedPlan(): WeekPlan {
  return h.tables.get("weekly_plans")?.[0]?.payload as WeekPlan;
}

function requests(): Row[] {
  return h.tables.get("week_plan_requests") ?? [];
}

/** A completion whose tool call carries `args`, as callAI returns it. */
function modelAnswer(args: unknown) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: "propose_week_plan", arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

function answerDays(
  days: { date: string; items: { emoji: string; title: string; start: string; end: string }[] }[],
  reply = "Here you go.",
) {
  return modelAnswer({ reply, days: days.map((day) => ({ headline: "A good day", ...day })) });
}

/** All seven days, each with the given items (default: none). */
function week(
  itemsByDate: Record<string, { emoji: string; title: string; start: string; end: string }[]>,
) {
  return dates.map((date) => ({ date, items: itemsByDate[date] ?? [] }));
}

const mockedCallAI = vi.mocked(callAI);

beforeEach(() => {
  h.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  // A hosted AI service is set (the hosted check is tested on its own below).
  vi.stubEnv("LLM_BASE_URL", "https://ai.example.test/v1");
  vi.stubEnv("LLM_TIMEOUT_MS", "60000");
  mockedCallAI.mockReset();
  vi.mocked(checkAiAllowance).mockClear();
  vi.mocked(enforceAiAllowance).mockClear();
  vi.mocked(createEvent).mockClear();
  vi.mocked(listEventsForRange).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a refinement keeps the saved plan when the model's answer is not usable (finding 8)", () => {
  it("an answer without a tool call fails, keeps the plan and stores the request as failed", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue({ choices: [{ message: { content: "Sure" } }] });

    await expect(refine("Move the reading to 20:00")).rejects.toThrow(
      /could not be used, so your plan was not changed/,
    );

    expect(storedPlan()).toEqual(savedPlan());
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/plan was not changed/),
    });
  });

  it("an answer cut off at the token limit says so", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue({
      choices: [
        {
          finish_reason: "length",
          message: {
            tool_calls: [{ function: { arguments: '{"reply":"Here","days":[{"date":' } }],
          },
        },
      ],
    } as never);
    await expect(refine("Busier Friday")).rejects.toThrow(/cut off/);
    expect(storedPlan()).toEqual(savedPlan());
  });

  it("a model that returns only the changed day leaves the other days as they were", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(
      answerDays(
        [{ date: WED, items: [{ emoji: "🎯", title: "Deep work", start: "10:00", end: "11:00" }] }],
        "Moved Wednesday.",
      ),
    );

    const result = await refine("Make Wednesday a deep work day");

    const plan = storedPlan();
    expect(plan.days.find((day) => day.date === WED)?.items.map((item) => item.title)).toEqual([
      "Deep work",
    ]);
    for (const date of [THU, FRI, SAT, SUN]) {
      expect(plan.days.find((day) => day.date === date)).toEqual(
        savedPlan().days.find((day) => day.date === date),
      );
    }
    expect(result.reply).toBe("Moved Wednesday.");
    expect(requests()[0]).toMatchObject({ status: "done" });
  });

  it("items whose time has passed and items already in the calendar stay, even in a faithful 7-day answer", async () => {
    storePlan(savedPlan());
    // Tuesday's item was approved: it is a calendar event now (busy time for the planner).
    h.calendar.events.push({
      id: "ev-tue",
      title: "🎯 Deep work",
      starts_at: at(TUE, 14),
      ends_at: at(TUE, 15),
      notes: null,
      source: "plan",
    });
    mockedCallAI.mockResolvedValue(
      answerDays(
        week({
          [MON]: [{ emoji: "📖", title: "Read 1", start: "18:00", end: "19:00" }],
          [TUE]: [{ emoji: "🎯", title: "Deep work", start: "14:00", end: "15:00" }],
          [WED]: [{ emoji: "📖", title: "Read 3", start: "19:00", end: "20:00" }],
          [THU]: [{ emoji: "📖", title: "Read 4", start: "18:00", end: "19:00" }],
          [FRI]: [{ emoji: "📖", title: "Read 5", start: "18:00", end: "19:00" }],
          [SAT]: [{ emoji: "📖", title: "Read 6", start: "18:00", end: "19:00" }],
          [SUN]: [{ emoji: "📖", title: "Read 7", start: "18:00", end: "19:00" }],
        }),
      ),
    );

    const result = await refine("Move Wednesday's reading an hour later");

    const plan = storedPlan();
    expect(plan.days[0].items.map((item) => item.title)).toEqual(["Read 1"]); // Monday, over
    expect(plan.days[1].items.map((item) => item.title)).toEqual(["Deep work"]); // in the calendar
    expect(plan.days[2].items[0].starts_at).toBe(at(WED, 19));
    expect(result.addedItems).toEqual({ [TUE]: [0] });
    // The model repeating kept items is not a rejected suggestion.
    expect(result.reply).toBe("Here you go.");
    // The calendar event of the kept item stays recorded (it used to be reset to []).
    expect(h.tables.get("weekly_plans")?.[0]?.approved_event_ids).toEqual(["ev-tue"]);
  });

  it("a fresh plan whose every suggestion misses the free time is refused, and nothing is saved", async () => {
    // Free time runs from 07:00 to 22:00, so a 03:00 item never fits.
    mockedCallAI.mockResolvedValue(
      answerDays(
        week({ [WED]: [{ emoji: "🎯", title: "Night work", start: "03:00", end: "04:00" }] }),
      ),
    );
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(
      /None of the AI's suggestions fit your free time/,
    );
    expect(h.upserts).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: "failed" });
  });

  it("a fresh plan with no items at all is refused", async () => {
    mockedCallAI.mockResolvedValue(answerDays(week({})));
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(/had no plan items/);
    expect(h.upserts).toHaveLength(0);
  });

  it("seven empty days for a refinement that did not ask to clear anything are refused", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(answerDays(week({}), "Updated your plan."));

    await expect(refine("Make the week a bit lighter")).rejects.toThrow(
      /would have removed every remaining item from your plan without adding any, so your plan was not changed/,
    );

    expect(storedPlan()).toEqual(savedPlan());
    expect(h.upserts).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: "failed" });
  });

  it("a refinement that asks to clear the week may remove every remaining item", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(answerDays(week({}), "Cleared the rest of your week."));

    const result = await refine("Clear the rest of the week, I'm travelling");

    const plan = storedPlan();
    // Monday is over and stays; Tuesday to Sunday had only items still ahead.
    expect(plan.days[0]).toEqual(savedPlan().days[0]);
    expect(plan.days.slice(1).every((day) => day.items.length === 0)).toBe(true);
    expect(result.reply).toBe("Cleared the rest of your week.");
  });

  it("a refinement that empties some days but keeps others is accepted", async () => {
    storePlan(savedPlan());
    // Only Saturday and Sunday come back, empty: the weekdays stay as they were.
    mockedCallAI.mockResolvedValue(
      answerDays([
        { date: SAT, items: [] },
        { date: SUN, items: [] },
      ]),
    );
    await refine("Keep the weekend open");
    const plan = storedPlan();
    expect(plan.days[5].items).toEqual([]);
    expect(plan.days[6].items).toEqual([]);
    expect(plan.days[4]).toEqual(savedPlan().days[4]);
  });
});

describe("a request to remove something may empty only what it names (finding 8, round 2)", () => {
  /** The saved plan with a hike on Saturday instead of the reading. */
  function planWithHike(): WeekPlan {
    const plan = savedPlan();
    plan.days[5].items = [
      { emoji: "🥾", title: "Hike", starts_at: at(SAT, 10), ends_at: at(SAT, 14), notes: null },
    ];
    return plan;
  }

  it("'remove the hike on Saturday' answered with seven empty days is refused", async () => {
    storePlan(planWithHike());
    mockedCallAI.mockResolvedValue(answerDays(week({}), "Removed the hike."));

    await expect(refine("remove the hike on Saturday")).rejects.toThrow(
      "The AI's answer would have removed everything planned on Tuesday, Wednesday, Thursday, Friday and Sunday, which your request did not ask for, so your plan was not changed.",
    );

    expect(storedPlan()).toEqual(planWithHike());
    expect(h.upserts).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: "failed" });
  });

  it("the same request answered by emptying Saturday only is accepted", async () => {
    storePlan(planWithHike());
    mockedCallAI.mockResolvedValue(answerDays([{ date: SAT, items: [] }], "Removed the hike."));

    const result = await refine("remove the hike on Saturday");

    expect(storedPlan().days[5].items).toEqual([]);
    expect(storedPlan().days.filter((day) => day.date !== SAT)).toEqual(
      planWithHike().days.filter((day) => day.date !== SAT),
    );
    expect(result.reply).toBe("Removed the hike.");
  });

  it("a request that names only an activity may empty the days whose items are that activity", async () => {
    storePlan(planWithHike());
    mockedCallAI.mockResolvedValue(answerDays([{ date: SAT, items: [] }]));
    await refine("remove the hike");
    expect(storedPlan().days[5].items).toEqual([]);

    // Emptying Sunday too (its reading was not named) is refused.
    storePlan(planWithHike());
    mockedCallAI.mockResolvedValue(
      answerDays([
        { date: SAT, items: [] },
        { date: SUN, items: [] },
      ]),
    );
    await expect(refine("remove the hike")).rejects.toThrow(
      "would have removed everything planned on Sunday, which your request did not ask for",
    );
    expect(storedPlan()).toEqual(planWithHike());
  });

  it("a range of days may be emptied, but not the days outside it", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(
      answerDays([
        { date: WED, items: [] },
        { date: THU, items: [] },
        { date: FRI, items: [] },
      ]),
    );
    await refine("clear wed-fri");
    expect(storedPlan().days.slice(2, 5).every((day) => day.items.length === 0)).toBe(true);
    expect(storedPlan().days[5]).toEqual(savedPlan().days[5]);

    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(answerDays(week({})));
    await expect(refine("Clear Wednesday to Friday")).rejects.toThrow(
      "would have removed everything planned on Tuesday, Saturday and Sunday",
    );
    expect(storedPlan()).toEqual(savedPlan());
  });

  it("'remove everything on Saturday' answered with seven empty days is refused", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(answerDays(week({})));
    await expect(refine("remove everything on Saturday")).rejects.toThrow(
      "would have removed everything planned on Tuesday, Wednesday, Thursday, Friday and Sunday",
    );
    expect(storedPlan()).toEqual(savedPlan());
  });

  it("a request to clear everything but something keeps the guard against an emptied plan", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(answerDays(week({})));
    await expect(refine("Cancel everything except Saturday")).rejects.toThrow(
      /would have removed every remaining item from your plan without adding any/,
    );
    expect(storedPlan()).toEqual(savedPlan());
  });

  it("'remove everything', as the refusal suggests, may still empty the plan", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(answerDays(week({}), "Cleared your week."));
    const result = await refine("remove everything");
    expect(storedPlan().days.slice(1).every((day) => day.items.length === 0)).toBe(true);
    expect(result.reply).toBe("Cleared your week.");
  });
});

describe("a stored item without an emoji keeps matching its calendar event (finding 49, round 2)", () => {
  it("shows as added, is not approved again, and an edit of another item keeps it as stored", async () => {
    const plan = savedPlan();
    // Approved under its title alone ("Read 3"), as the approval of a row without an emoji did.
    delete (plan.days[2].items[0] as { emoji?: string }).emoji;
    storePlan(plan);
    h.calendar.events.push({
      id: "ev-wed",
      title: "Read 3",
      starts_at: at(WED, 18),
      ends_at: at(WED, 19),
      notes: null,
      source: "plan",
    });

    const loaded = await fetchPlan();
    expect(loaded.addedItems).toEqual({ [WED]: [0] });
    expect(loaded.busyEvents).toEqual([]);

    const result = await approve({ dayDate: WED });
    expect(result).toMatchObject({ created: 0, skipped: 1, conflicts: 0 });
    expect(createEvent).not.toHaveBeenCalled();

    await updateItem({ dayDate: THU, itemIndex: 0, starts_at: at(THU, 19), ends_at: at(THU, 20) });
    expect(storedPlan().days[2].items[0].emoji).toBe("");
  });
});

describe("a regeneration keeps the saved plan where its answer is partial (finding 8)", () => {
  it("days the answer leaves out stay as they were", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(
      answerDays([
        { date: WED, items: [{ emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" }] },
      ]),
    );

    await generate({ weekStart: MONDAY });

    const plan = storedPlan();
    expect(plan.days.find((day) => day.date === WED)?.items.map((item) => item.title)).toEqual([
      "Focus",
    ]);
    for (const date of [MON, TUE, THU, FRI, SAT, SUN]) {
      expect(plan.days.find((day) => day.date === date)).toEqual(
        savedPlan().days.find((day) => day.date === date),
      );
    }
  });

  it("in the middle of the week, the days that are over and the items in the calendar stay", async () => {
    storePlan(savedPlan());
    h.calendar.events.push({
      id: "ev-tue",
      title: "🎯 Deep work",
      starts_at: at(TUE, 14),
      ends_at: at(TUE, 15),
      notes: null,
      source: "plan",
    });
    mockedCallAI.mockResolvedValue(
      answerDays(
        week({
          [TUE]: [{ emoji: "🚶", title: "Walk", start: "16:00", end: "16:30" }],
          [WED]: [{ emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" }],
        }),
      ),
    );

    const result = await generate({ weekStart: MONDAY });

    const plan = storedPlan();
    // Monday is over: its item was replaced by "Day already over" with no items before.
    expect(plan.days[0]).toEqual(savedPlan().days[0]);
    // Tuesday: the approved item stays a plan item, next to the new suggestion.
    expect(plan.days[1].items.map((item) => item.title)).toEqual(["Deep work", "Walk"]);
    expect(result.addedItems).toEqual({ [TUE]: [0] });
    expect(h.tables.get("weekly_plans")?.[0]?.approved_event_ids).toEqual(["ev-tue"]);
    // Days the answer returned are drafted afresh: Wednesday's old reading is gone.
    expect(plan.days[2].items.map((item) => item.title)).toEqual(["Focus"]);
    // A fresh draft does not show the saved plan to the model.
    const system = String(mockedCallAI.mock.calls[0][0].messages[0].content);
    expect(system).not.toContain("CURRENT PLAN");
  });

  it("an answer with no items is refused and the saved plan is kept", async () => {
    storePlan(savedPlan());
    mockedCallAI.mockResolvedValue(answerDays(week({})));
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(/had no plan items/);
    expect(storedPlan()).toEqual(savedPlan());
    expect(requests()[0]).toMatchObject({ status: "failed" });
  });
});

describe("developer wording never reaches a visitor of the hosted site (findings 6, 52, 50)", () => {
  const ollamaText =
    "Could not reach Ollama at http://localhost:11434/v1. Is it running? (For local Ollama: docker ps shows the Ollama container on port 11434.)";

  function storeFailedRequest(error: string) {
    h.tables.set("week_plan_requests", [
      {
        id: "r-failed",
        user_id: USER,
        week_start: MONDAY,
        kind: "create",
        status: "failed",
        reply: null,
        error,
        created_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
        finished_at: new Date(NOW.getTime() - 3_590_000).toISOString(),
      },
    ]);
  }

  it("a stored failure with developer text is shown as a plain sentence on the hosted site", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    storeFailedRequest(ollamaText);
    const result = await fetchPlan();
    expect(result.request).toMatchObject({
      status: "failed",
      error: "Drafting the plan failed. Please try again.",
    });
    // The row itself is left as it was.
    expect(requests()[0].error).toBe(ollamaText);
  });

  it("a plain failure sentence is shown as it is, and a local run keeps the developer text", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    storeFailedRequest("The AI's answer could not be used, so your plan was not changed. Please try again.");
    expect((await fetchPlan()).request).toMatchObject({
      error: "The AI's answer could not be used, so your plan was not changed. Please try again.",
    });
    vi.stubEnv("LIFEOPS_HOSTED", "");
    storeFailedRequest(ollamaText);
    expect((await fetchPlan()).request).toMatchObject({ error: ollamaText });
  });

  it("a new failure with developer text is stored and shown as a plain sentence on the hosted site", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    mockedCallAI.mockRejectedValue(
      new Error("The AI provider did not answer within 60 s. A local model on CPU can be slow; raise LLM_TIMEOUT_MS or try again."),
    );
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(
      /^Drafting the plan failed\. Please try again\.$/,
    );
    expect(requests()[0]).toMatchObject({
      status: "failed",
      error: "Drafting the plan failed. Please try again.",
    });
  });

  it("a failure meant for the visitor (a limit) is kept on the hosted site", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    vi.mocked(enforceAiAllowance).mockRejectedValueOnce(
      new Error("You have reached this demo's limit of 5 week plans per day. Please try again tomorrow."),
    );
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(/limit of 5 week plans per day/);
    expect(mockedCallAI).not.toHaveBeenCalled();
  });
});

describe("plan quality checks (finding 90)", () => {
  it("drops a repeat of a busy event and a meal outside its window, and says so", async () => {
    h.calendar.events.push({
      id: "ev-run",
      title: "Run",
      starts_at: at(WED, 7),
      ends_at: at(WED, 8),
      notes: null,
      source: "calendar",
    });
    mockedCallAI.mockResolvedValue(
      answerDays(
        week({
          [WED]: [
            { emoji: "🏃", title: "Morning run", start: "08:00", end: "09:00" },
            { emoji: "🥗", title: "Lunch break", start: "17:00", end: "17:30" },
            { emoji: "🎯", title: "Deep work block", start: "09:00", end: "11:00" },
          ],
        }),
      ),
    );

    const result = await generate({ weekStart: MONDAY });

    expect(storedPlan().days[2].items.map((item) => item.title)).toEqual(["Deep work block"]);
    expect(result.reply).toMatch(/2 suggested items were left out/);
  });

  it("keeps a lunch at lunch time and a cooking afternoon with the 🍝 emoji", async () => {
    mockedCallAI.mockResolvedValue(
      answerDays(
        week({
          [WED]: [{ emoji: "🥗", title: "Lunch", start: "12:00", end: "12:45" }],
          [SAT]: [{ emoji: "🍝", title: "Cook a new recipe", start: "15:00", end: "17:00" }],
        }),
      ),
    );
    await generate({ weekStart: MONDAY });
    expect(storedPlan().days[2].items.map((item) => item.title)).toEqual(["Lunch"]);
    expect(storedPlan().days[5].items.map((item) => item.title)).toEqual(["Cook a new recipe"]);
  });

  it("a second deep-work block next to an approved one is not a repeat (the plan's own events do not count)", async () => {
    const plan = savedPlan();
    plan.days[2].items = [
      { emoji: "🎯", title: "Deep work", starts_at: at(WED, 9), ends_at: at(WED, 11), notes: null },
    ];
    storePlan(plan);
    // Wednesday's item was approved: it is a calendar event titled "🎯 Deep work".
    h.calendar.events.push({
      id: "ev-wed",
      title: "🎯 Deep work",
      starts_at: at(WED, 9),
      ends_at: at(WED, 11),
      notes: null,
      source: "plan",
    });
    mockedCallAI.mockResolvedValue(
      answerDays([
        {
          date: WED,
          items: [
            { emoji: "🎯", title: "Deep work", start: "09:00", end: "11:00" },
            { emoji: "🎯", title: "Deep work", start: "14:00", end: "16:00" },
          ],
        },
      ]),
    );

    const result = await refine("Add a second deep work block on Wednesday afternoon");

    const wednesday = storedPlan().days[2].items;
    expect(wednesday.map((item) => [item.title, item.starts_at])).toEqual([
      ["Deep work", at(WED, 9)],
      ["Deep work", at(WED, 14)],
    ]);
    expect(result.reply).toBe("Here you go.");
  });

  it("an item that names an activity of its own stays next to a one-word or seeded event", async () => {
    h.calendar.events.push(
      {
        id: "ev-meeting",
        title: "Meeting",
        starts_at: at(WED, 10),
        ends_at: at(WED, 11),
        notes: null,
        source: "calendar",
      },
      {
        id: "ev-lecture",
        title: "Lecture — Distributed Systems",
        starts_at: at(WED, 13),
        ends_at: at(WED, 15),
        notes: null,
        source: "seed",
      },
      {
        id: "ev-work",
        title: "Work",
        starts_at: at(THU, 9),
        ends_at: at(THU, 12),
        notes: null,
        source: "calendar",
      },
    );
    mockedCallAI.mockResolvedValue(
      answerDays(
        week({
          [WED]: [
            { emoji: "🎯", title: "Prep for meeting", start: "09:00", end: "09:45" },
            { emoji: "📚", title: "Review distributed systems lecture", start: "16:00", end: "17:00" },
          ],
          [THU]: [{ emoji: "🎯", title: "Deep work", start: "14:00", end: "16:00" }],
        }),
      ),
    );

    const result = await generate({ weekStart: MONDAY });

    expect(storedPlan().days[2].items.map((item) => item.title)).toEqual([
      "Prep for meeting",
      "Review distributed systems lecture",
    ]);
    expect(storedPlan().days[3].items.map((item) => item.title)).toEqual(["Deep work"]);
    expect(result.reply).toBe("Here you go.");
  });

  it("when every suggestion repeats a busy event, the refusal says so instead of 'free time'", async () => {
    h.calendar.events.push({
      id: "ev-run",
      title: "Run",
      starts_at: at(WED, 7),
      ends_at: at(WED, 8),
      notes: null,
      source: "calendar",
    });
    mockedCallAI.mockResolvedValue(
      answerDays(week({ [WED]: [{ emoji: "🏃", title: "Evening run", start: "18:00", end: "19:00" }] })),
    );

    const error = await generate({ weekStart: MONDAY }).catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      "The AI's only suggestion could not be used (it repeated an event already in your calendar), so your plan was not changed. Please try again.",
    );
    expect(h.upserts).toHaveLength(0);
  });

  it("the left-out note names the reasons that applied", async () => {
    h.calendar.events.push({
      id: "ev-run",
      title: "Run",
      starts_at: at(WED, 7),
      ends_at: at(WED, 8),
      notes: null,
      source: "calendar",
    });
    mockedCallAI.mockResolvedValue(
      answerDays(
        week({
          [WED]: [
            { emoji: "🏃", title: "Evening run", start: "18:00", end: "19:00" },
            { emoji: "🏃", title: "Short run", start: "19:30", end: "20:00" },
            { emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" },
          ],
        }),
      ),
    );
    const result = await generate({ weekStart: MONDAY });
    expect(result.reply).toBe(
      "Here you go. 2 suggested items were left out because they repeated events already in your calendar.",
    );
  });

  it("the prompt asks for meal windows, no repeats of busy events and true headlines", async () => {
    mockedCallAI.mockResolvedValue(
      answerDays(week({ [WED]: [{ emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" }] })),
    );
    await generate({ weekStart: MONDAY });
    const system = String(mockedCallAI.mock.calls[0][0].messages[0].content);
    expect(system).toMatch(/lunch 11:30-14:00/);
    expect(system).toMatch(/Do not add an item that repeats or extends a busy event/);
    expect(system).toMatch(/never claim that an event was moved, cleared or cancelled/);
  });
});

describe("item times from the model are read on their own day (finding 22, plan part)", () => {
  it("drops a date-time on another day and an hour of 25", async () => {
    mockedCallAI.mockResolvedValue(
      answerDays(
        week({
          [WED]: [
            { emoji: "🎯", title: "Other day", start: "2026-11-26T10:00", end: "2026-11-26T11:00" },
            { emoji: "🎯", title: "Rolled over", start: "25:00", end: "26:00" },
            { emoji: "🎯", title: "Fine", start: "2026-11-25T10:00", end: "2026-11-25T11:00" },
          ],
        }),
      ),
    );
    const result = await generate({ weekStart: MONDAY });
    expect(storedPlan().days[2].items.map((item) => item.title)).toEqual(["Fine"]);
    expect(storedPlan().days[3].items).toEqual([]);
    expect(result.reply).toMatch(/2 suggested items were left out/);
  });
});

describe("prompt size (finding 80)", () => {
  it("cuts long goals and event titles before they reach the prompt", async () => {
    h.tables.set("profiles", [{ id: USER, goals: "g".repeat(5000) }]);
    h.calendar.events.push({
      id: "ev-long",
      title: `Long ${"t".repeat(500)}`,
      starts_at: at(WED, 7),
      ends_at: at(WED, 8),
      notes: null,
      source: "calendar",
    });
    mockedCallAI.mockResolvedValue(
      answerDays(week({ [WED]: [{ emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" }] })),
    );
    await generate({ weekStart: MONDAY });
    const system = String(mockedCallAI.mock.calls[0][0].messages[0].content);
    expect(system).toContain(`USER GOALS: ${"g".repeat(1500)}\n`);
    expect(system).not.toContain("g".repeat(1501));
    expect(system).not.toContain("t".repeat(100));
  });
});

describe("a week that is over (finding 63) and an AI that is not set up (findings 6, 52)", () => {
  it("refuses a past week before any request, allowance or model call", async () => {
    await expect(generate({ weekStart: "2026-11-16" })).rejects.toThrow(/already over/);
    await expect(
      call(planFunctions.refineWeekPlan, { weekStart: "2026-11-16", message: "x", timeZone: TZ }),
    ).rejects.toThrow(/already over/);
    expect(mockedCallAI).not.toHaveBeenCalled();
    expect(checkAiAllowance).not.toHaveBeenCalled();
    expect(enforceAiAllowance).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(0);
    expect(h.upserts).toHaveLength(0);
  });

  it("this week still asks the model once, and records the allowance use after reading the calendar", async () => {
    mockedCallAI.mockResolvedValue(
      answerDays(week({ [WED]: [{ emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" }] })),
    );
    await generate({ weekStart: MONDAY });
    expect(mockedCallAI).toHaveBeenCalledTimes(1);
    expect(enforceAiAllowance).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enforceAiAllowance).mock.calls[0][2]).toBe("plan");
    const enforceOrder = vi.mocked(enforceAiAllowance).mock.invocationCallOrder[0];
    expect(vi.mocked(listEventsForRange).mock.invocationCallOrder[0]).toBeLessThan(enforceOrder);
    expect(enforceOrder).toBeLessThan(mockedCallAI.mock.invocationCallOrder[0]);
  });

  it("on the hosted site without an AI service, refuses with a visitor sentence and stores nothing", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("HUGGINGFACE_API_KEY", "");
    const error = await generate({ weekStart: MONDAY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not set up on this site/);
    expect((error as Error).message).not.toMatch(/localhost|LLM_|docker|Ollama/);
    expect(requests()).toHaveLength(0);
    expect(mockedCallAI).not.toHaveBeenCalled();
  });
});

describe("one running request per week (finding 11)", () => {
  it("maps the database's unique violation to the 'still being drafted' sentence", async () => {
    h.failures.set("week_plan_requests:insert", {
      code: "23505",
      message: 'duplicate key value violates unique constraint "week_plan_requests_one_running"',
      details: "Key (user_id, week_start)=(…) already exists.",
    });
    const error = await generate({ weekStart: MONDAY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "A plan for this week is still being drafted. It appears on this page when it is ready.",
    );
    expect(mockedCallAI).not.toHaveBeenCalled();
  });

  it("still refuses while the newest request is running", async () => {
    h.tables.set("week_plan_requests", [
      {
        id: "r1",
        user_id: USER,
        week_start: MONDAY,
        kind: "create",
        status: "running",
        reply: null,
        error: null,
        created_at: new Date(NOW.getTime() - 30_000).toISOString(),
        finished_at: null,
      },
    ]);
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(/still being drafted/);
  });

  it("a request cut off long ago is closed first, so it does not block new ones", async () => {
    h.tables.set("week_plan_requests", [
      {
        id: "r-old",
        user_id: USER,
        week_start: MONDAY,
        kind: "create",
        status: "running",
        reply: null,
        error: null,
        created_at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
        finished_at: null,
      },
    ]);
    mockedCallAI.mockResolvedValue(
      answerDays(week({ [WED]: [{ emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" }] })),
    );
    await generate({ weekStart: MONDAY });
    expect(requests().find((row) => row.id === "r-old")).toMatchObject({ status: "failed" });
    expect(requests().filter((row) => row.status === "done")).toHaveLength(1);
  });

  // Older code never closed cut-off rows: a server restart followed by a retry that worked left
  // a "running" row under a newer finished one. The fake insert refuses a second running row of
  // the week (23505), as the database package's partial unique index does.
  function requestRow(id: string, status: string, ageMs: number): Row {
    return {
      id,
      user_id: USER,
      week_start: MONDAY,
      kind: "create",
      status,
      reply: status === "done" ? "Here you go." : null,
      error: null,
      created_at: new Date(NOW.getTime() - ageMs).toISOString(),
      finished_at: status === "running" ? null : new Date(NOW.getTime() - ageMs + 30_000).toISOString(),
    };
  }

  it("a cut-off request under a newer finished one is closed too, so the week is not blocked", async () => {
    h.tables.set("week_plan_requests", [
      requestRow("r-cut-off", "running", 3 * 3_600_000),
      requestRow("r-retry", "done", 2 * 3_600_000),
    ]);
    mockedCallAI.mockResolvedValue(
      answerDays(week({ [WED]: [{ emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" }] })),
    );

    const result = await generate({ weekStart: MONDAY });

    expect(result.request).toMatchObject({ status: "done" });
    expect(requests().find((row) => row.id === "r-cut-off")).toMatchObject({ status: "failed" });
    expect(requests().filter((row) => row.status === "running")).toHaveLength(0);
    expect(mockedCallAI).toHaveBeenCalledTimes(1);
  });

  it("a request that may still be running under a newer finished one is left alone and answered as running", async () => {
    h.tables.set("week_plan_requests", [
      requestRow("r-recent", "running", 60_000),
      requestRow("r-done", "done", 30_000),
    ]);
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(/still being drafted/);
    expect(requests().find((row) => row.id === "r-recent")).toMatchObject({ status: "running" });
    expect(mockedCallAI).not.toHaveBeenCalled();
  });
});

describe("the calendar cannot be read (finding 62)", () => {
  it("the page still gets the saved plan, with a calendar message instead of a failure", async () => {
    storePlan(savedPlan());
    h.calendar.failReads = true;
    const result = await fetchPlan();
    expect(result.plan).toEqual(savedPlan());
    expect(result.calendarError).toEqual(expect.stringMatching(/calendar/));
    expect(String(result.calendarError)).not.toMatch(/Plan generation/);
    expect(result.busyEvents).toEqual([]);
  });

  it("a time edit says that the conflicts could not be checked", async () => {
    storePlan(savedPlan());
    h.calendar.failReads = true;
    await expect(
      updateItem({ dayDate: WED, itemIndex: 0, starts_at: at(WED, 17), ends_at: at(WED, 18) }),
    ).rejects.toThrow(/Could not check your calendar for conflicts, so the time was not changed/);
  });

  it("a successful load reports no calendar problem", async () => {
    storePlan(savedPlan());
    expect((await fetchPlan()).calendarError).toBeNull();
  });
});

describe("errors sent to the browser are sentences, never database objects (finding 50)", () => {
  it("a failed plan read becomes a plain Error", async () => {
    h.failures.set("weekly_plans:select", {
      code: "42P01",
      message: 'relation "weekly_plans" does not exist',
      hint: null,
    });
    const error = await fetchPlan().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Could not load this week's plan. Please try again in a moment.",
    );
  });

  it("a failed plan save is stored and shown as a sentence", async () => {
    h.failures.set("weekly_plans:upsert", {
      code: "XX000",
      message: "internal error with details",
      details: "stack",
    });
    mockedCallAI.mockResolvedValue(
      answerDays(week({ [WED]: [{ emoji: "🎯", title: "Focus", start: "10:00", end: "11:00" }] })),
    );
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(
      "Could not save the week plan. Please try again in a moment.",
    );
    expect(requests()[0]).toMatchObject({
      status: "failed",
      error: "Could not save the week plan. Please try again in a moment.",
    });
  });

  it("an unexpected programming error is stored as a general sentence", async () => {
    mockedCallAI.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'choices')"),
    );
    await expect(generate({ weekStart: MONDAY })).rejects.toThrow(
      "Drafting the plan failed. Please try again.",
    );
    expect(requests()[0]).toMatchObject({
      status: "failed",
      error: "Drafting the plan failed. Please try again.",
    });
  });
});

describe("input checks (finding 104)", () => {
  it("weekStart and dayDate must be dates; item times must carry a time zone", async () => {
    await expect(fetchPlan({ weekStart: "x" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(fetchPlan({ weekStart: "2026-13-45" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(approve({ dayDate: "x" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      updateItem({ dayDate: WED, itemIndex: 0, starts_at: "2026-11-25", ends_at: at(WED, 19) }),
    ).rejects.toThrow(/time zone/);
    await expect(
      updateItem({ dayDate: WED, itemIndex: 0, starts_at: "1", ends_at: "2" }),
    ).rejects.toThrow(/time zone/);
  });

  it("valid values still pass", async () => {
    storePlan(savedPlan());
    await expect(fetchPlan({ weekStart: "2026-11-25" })).resolves.toMatchObject({ monday: MONDAY });
  });
});

describe("editing the time of an item (finding 60)", () => {
  function planWithStartedItem(): WeekPlan {
    const plan = savedPlan();
    // Started ten minutes ago, ends in twenty.
    plan.days[1].items = [
      {
        emoji: "🎯",
        title: "Started",
        starts_at: at(TUE, 8, 50),
        ends_at: at(TUE, 9, 20),
        notes: null,
      },
    ];
    return plan;
  }

  it("an end-only edit of an item that has started says why it is refused", async () => {
    storePlan(planWithStartedItem());
    await expect(
      updateItem({
        dayDate: TUE,
        itemIndex: 0,
        starts_at: at(TUE, 8, 50),
        ends_at: at(TUE, 9, 50),
      }),
    ).rejects.toThrow("This item has already started, so its time can no longer be changed.");
  });

  it("moving a started item to later than now is accepted", async () => {
    storePlan(planWithStartedItem());
    await expect(
      updateItem({ dayDate: TUE, itemIndex: 0, starts_at: at(TUE, 9, 30), ends_at: at(TUE, 10) }),
    ).resolves.toBeTruthy();
    expect(storedPlan().days[1].items[0].starts_at).toBe(at(TUE, 9, 30));
  });

  it("moving an item that has not started into the past names the start", async () => {
    storePlan(savedPlan());
    await expect(
      updateItem({ dayDate: TUE, itemIndex: 0, starts_at: at(TUE, 8), ends_at: at(TUE, 9) }),
    ).rejects.toThrow("That start time is already over. Pick a start later than now.");
  });
});

describe("approving does not trust the stored plan (finding 49)", () => {
  it.each([
    ["days that are not a list", { days: "x" }],
    [
      "an item without times",
      { days: [{ date: WED, headline: "", items: [{ emoji: "🎯", title: "x" }] }] },
    ],
    ["a day of another week", { days: [{ date: "2027-01-06", headline: "", items: [] }] }],
    [
      "an item far outside its day",
      {
        days: [
          {
            date: WED,
            headline: "",
            items: [
              {
                emoji: "🎯",
                title: "x",
                starts_at: "2026-12-25T10:00:00Z",
                ends_at: "2026-12-25T11:00:00Z",
              },
            ],
          },
        ],
      },
    ],
    [
      "thousands of items",
      {
        days: [
          {
            date: WED,
            headline: "",
            items: Array.from({ length: 5000 }, () => ({
              emoji: "🎯",
              title: "x",
              starts_at: at(WED, 10),
              ends_at: at(WED, 11),
            })),
          },
        ],
      },
    ],
  ])("refuses %s with a sentence and writes nothing", async (_label, payload) => {
    storePlan(payload);
    await expect(approve()).rejects.toThrow(
      "The saved plan for this week could not be read, so nothing was added. Please create the plan again.",
    );
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("a well-formed plan is approved as before", async () => {
    storePlan(savedPlan());
    const result = await approve({ dayDate: WED });
    expect(result).toMatchObject({ created: 1, skipped: 0, past: 0 });
    expect(h.calendar.events.map((event) => event.title)).toEqual(["📖 Read 3"]);
  });
});

describe("two approvals at the same time (findings 58, 39)", () => {
  it("leave each item in the calendar once, and record every event id", async () => {
    storePlan(savedPlan());
    h.calendar.writeDelayMs = 5;

    await Promise.all([approve(), approve({ dayDate: SUN }), approve({ dayDate: SUN })]);

    const planEvents = h.calendar.events.filter((event) => event.source === "plan");
    const keys = planEvents.map((event) => `${event.title}|${event.starts_at}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Tuesday to Sunday (Monday's item is over).
    expect(planEvents).toHaveLength(6);
    const ids = h.tables.get("weekly_plans")?.[0]?.approved_event_ids as string[];
    expect([...ids].sort()).toEqual(planEvents.map((event) => event.id).sort());
  });

  it("the recorded ids never name the copy that the other approval removed", async () => {
    storePlan(savedPlan());
    // Approval A writes its copy first (id "ev-z"), reads the calendar before B's copy exists
    // and saves its ids late. Approval B writes "ev-a" later, sees both copies, keeps the
    // smaller id and removes A's copy, then saves its ids first.
    h.calendar.ids.push("ev-z", "ev-a");
    h.calendar.writeDelays.push(5, 30);
    h.updateDelays.set("weekly_plans", [80]);

    const [first, second] = await Promise.all([
      approve({ dayDate: WED }),
      approve({ dayDate: WED }),
    ]);

    expect(h.calendar.events.map((event) => event.id)).toEqual(["ev-a"]);
    expect(h.tables.get("weekly_plans")?.[0]?.approved_event_ids).toEqual(["ev-a"]);
    // Together they report the one event once.
    expect(Number(first.created) + Number(second.created)).toBe(1);
    expect(first).toMatchObject({ created: 0, skipped: 1, eventIds: [] });
    expect(second).toMatchObject({ created: 1, eventIds: ["ev-a"] });
  });

  it("a later approval of the same day adds nothing and keeps the recorded ids", async () => {
    storePlan(savedPlan());
    await approve({ dayDate: WED });
    const again = await approve({ dayDate: WED });
    expect(again).toMatchObject({ created: 0, skipped: 1 });
    expect(h.tables.get("weekly_plans")?.[0]?.approved_event_ids).toEqual(
      h.calendar.events.map((event) => event.id),
    );
  });
});
