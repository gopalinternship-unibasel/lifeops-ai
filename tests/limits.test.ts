import { describe, expect, it } from "vitest";
import {
  CapReachedError,
  checkAiAllowance,
  decideCap,
  enforceAiAllowance,
  readCaps,
  utcDayStart,
  type AiCaps,
} from "@/server/limits.server";

const NONE: AiCaps = { chatPerHour: null, plansPerDay: null, plannerPerHour: null, callsPerDay: null };

describe("readCaps", () => {
  it("is unlimited when nothing is set", () => {
    expect(readCaps({})).toEqual(NONE);
  });

  it("reads each setting and ignores empty, zero, negative and non-numeric values", () => {
    expect(
      readCaps({ AI_CHAT_PER_HOUR: "20", AI_PLANS_PER_DAY: " 10 ", AI_PLANNER_PER_HOUR: "", AI_CALLS_PER_DAY: "800" }),
    ).toEqual({ chatPerHour: 20, plansPerDay: 10, plannerPerHour: null, callsPerDay: 800 });
    expect(readCaps({ AI_CHAT_PER_HOUR: "0", AI_PLANS_PER_DAY: "-3", AI_PLANNER_PER_HOUR: "many" })).toEqual(NONE);
  });

  it("accepts whole numbers only: trailing text, exponents and decimals are no limit", () => {
    expect(
      readCaps({ AI_CHAT_PER_HOUR: "20abc", AI_PLANS_PER_DAY: "1e3", AI_PLANNER_PER_HOUR: "2.5", AI_CALLS_PER_DAY: "+5" }),
    ).toEqual(NONE);
    expect(readCaps({ AI_CHAT_PER_HOUR: "0x10", AI_CALLS_PER_DAY: "150" })).toEqual({ ...NONE, callsPerDay: 150 });
  });
});

describe("decideCap", () => {
  const caps: AiCaps = { chatPerHour: 20, plansPerDay: 10, plannerPerHour: 1, callsPerDay: 800 };

  it("allows requests below the limit and refuses the one after it", () => {
    expect(decideCap("chat", { user: 19, global: 0 }, caps)).toEqual({ allowed: true });
    const refused = decideCap("chat", { user: 20, global: 0 }, caps);
    expect(refused).toMatchObject({ allowed: false, scope: "user" });
  });

  it("uses the limit of the kind of request", () => {
    expect(decideCap("plan", { user: 10, global: 0 }, caps)).toMatchObject({ allowed: false, scope: "user" });
    expect(decideCap("plan", { user: 9, global: 0 }, caps)).toEqual({ allowed: true });
    expect(decideCap("planner", { user: 1, global: 0 }, caps)).toMatchObject({ allowed: false, scope: "user" });
  });

  it("refuses everybody when the daily allowance is used up", () => {
    expect(decideCap("chat", { user: 0, global: 799 }, caps)).toEqual({ allowed: true });
    const refused = decideCap("chat", { user: 0, global: 800 }, caps);
    expect(refused).toMatchObject({ allowed: false, scope: "global" });
  });

  it("gives the user's own limit priority over the global one", () => {
    expect(decideCap("chat", { user: 20, global: 800 }, caps)).toMatchObject({ scope: "user" });
  });

  it("never refuses when no limit is set", () => {
    expect(decideCap("chat", { user: 9999, global: 9999 }, NONE)).toEqual({ allowed: true });
    // Only a global limit: the per-user count does not matter.
    expect(decideCap("plan", { user: 9999, global: 5 }, { ...NONE, callsPerDay: 10 })).toEqual({ allowed: true });
  });

  it("says in a plain sentence what happened", () => {
    const user = decideCap("chat", { user: 1, global: 0 }, { ...NONE, chatPerHour: 1 });
    const day = decideCap("plan", { user: 3, global: 0 }, { ...NONE, plansPerDay: 3 });
    const all = decideCap("chat", { user: 0, global: 5 }, { ...NONE, callsPerDay: 5 });
    expect(user).toMatchObject({
      message: "You have reached this demo's limit of 1 chat message per hour. Please try again later.",
    });
    expect(day).toMatchObject({
      message: "You have reached this demo's limit of 3 week plans per day. Please try again tomorrow.",
    });
    expect(all).toMatchObject({
      message: "This demo's AI allowance for today is used up. It starts again at midnight UTC. Please try again tomorrow.",
    });
  });
});

describe("utcDayStart", () => {
  it("is midnight UTC of the same day", () => {
    expect(utcDayStart(new Date("2026-11-14T23:59:59Z")).toISOString()).toBe("2026-11-14T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-11-14T00:00:00Z")).toISOString()).toBe("2026-11-14T00:00:00.000Z");
  });
});

/** A stand-in for the Supabase client: records each count query and answers from `counts`. */
function fakeClient(counts: Record<string, number>) {
  const calls: Array<{ table: string; filters: Record<string, unknown>; since: string | null }> = [];
  const client = {
    from(table: string) {
      const call = { table, filters: {} as Record<string, unknown>, since: null as string | null };
      calls.push(call);
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          call.filters[column] = value;
          return query;
        },
        gte: (_column: string, value: string) => {
          call.since = value;
          return query;
        },
        then: (resolve: (value: unknown) => void) => resolve({ count: counts[table] ?? 0, error: null }),
      };
      return query;
    },
  };
  return { client: client as never, calls };
}

describe("checkAiAllowance", () => {
  const now = new Date("2026-11-14T15:30:00Z");

  it("asks the database nothing when no limit is set", async () => {
    const { client, calls } = fakeClient({});
    expect(await checkAiAllowance(client, "u1", "chat", { now, env: {} })).toEqual({ allowed: true });
    expect(calls).toHaveLength(0);
  });

  it("counts the user's chat messages of the last hour", async () => {
    const { client, calls } = fakeClient({ chat_messages: 20 });
    const decision = await checkAiAllowance(client, "u1", "chat", { now, env: { AI_CHAT_PER_HOUR: "20" } });
    expect(decision).toMatchObject({ allowed: false, scope: "user" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      table: "chat_messages",
      filters: { role: "user", user_id: "u1" },
      since: "2026-11-14T14:30:00.000Z",
    });
  });

  it("counts week plans over 24 hours and planner requests over one hour", async () => {
    const plan = fakeClient({ week_plan_requests: 3 });
    await checkAiAllowance(plan.client, "u1", "plan", { now, env: { AI_PLANS_PER_DAY: "10" } });
    expect(plan.calls[0]).toMatchObject({ table: "week_plan_requests", since: "2026-11-13T15:30:00.000Z" });
    const planner = fakeClient({ planner_requests: 3 });
    await checkAiAllowance(planner.client, "u1", "planner", { now, env: { AI_PLANNER_PER_HOUR: "10" } });
    expect(planner.calls[0]).toMatchObject({ table: "planner_requests", since: "2026-11-14T14:30:00.000Z" });
  });

  it("adds up all kinds of requests of all users for the global allowance, from UTC midnight", async () => {
    const { client, calls } = fakeClient({ chat_messages: 500, week_plan_requests: 200, planner_requests: 100 });
    const decision = await checkAiAllowance(client, "u1", "chat", { now, env: { AI_CALLS_PER_DAY: "800" } });
    expect(decision).toMatchObject({ allowed: false, scope: "global" });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.since).toBe("2026-11-14T00:00:00.000Z");
      expect(call.filters).not.toHaveProperty("user_id");
    }
    const under = fakeClient({ chat_messages: 500, week_plan_requests: 200, planner_requests: 99 });
    expect(await checkAiAllowance(under.client, "u1", "chat", { now, env: { AI_CALLS_PER_DAY: "800" } })).toEqual({
      allowed: true,
    });
  });

  it("skips the global count when the user is over their own limit", async () => {
    const { client, calls } = fakeClient({ chat_messages: 5 });
    const decision = await checkAiAllowance(client, "u1", "chat", {
      now,
      env: { AI_CHAT_PER_HOUR: "5", AI_CALLS_PER_DAY: "800" },
    });
    expect(decision).toMatchObject({ allowed: false, scope: "user" });
    expect(calls).toHaveLength(1);
  });

  it("enforceAiAllowance throws the visitor's sentence", async () => {
    const { client } = fakeClient({ week_plan_requests: 10 });
    const run = enforceAiAllowance(client, "u1", "plan", { now, env: { AI_PLANS_PER_DAY: "10" } });
    await expect(run).rejects.toBeInstanceOf(CapReachedError);
    await expect(run).rejects.toThrow(
      "You have reached this demo's limit of 10 week plans per day. Please try again tomorrow.",
    );
  });
});
