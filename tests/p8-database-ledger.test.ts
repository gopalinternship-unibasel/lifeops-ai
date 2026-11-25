import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWANCE_UNAVAILABLE,
  CapReachedError,
  checkAiAllowance,
  enforceAiAllowance,
  utcDayStart,
} from "@/server/limits.server";

interface Use {
  user: string;
  kind: string;
  at: number;
}

/**
 * The service-role client with an in-memory ai_usage ledger. Each call of ai_allowance is answered
 * atomically, as the database function does under its lock, but only after a macrotask, so two
 * separate round trips of one request (a check, then a write) would interleave with the round
 * trips of parallel requests, as they do over the network.
 */
function ledgerClient(start: Use[] = [], nowMs = () => Date.parse("2026-11-24T12:00:00Z")) {
  const uses = [...start];
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, ...args });
      return new Promise((resolve) =>
        setTimeout(() => {
          const now = nowMs();
          const kinds = args.p_user_kinds as string[];
          const userLimit = args.p_user_limit as number | null;
          const globalLimit = args.p_global_limit as number | null;
          let scope: "user" | "global" | null = null;
          let userCount = 0;
          let globalCount = 0;
          if (userLimit !== null) {
            const since = now - (args.p_user_window_seconds as number) * 1000;
            userCount = uses.filter(
              (use) => use.user === args.p_user && kinds.includes(use.kind) && use.at >= since,
            ).length;
            if (userCount >= userLimit) scope = "user";
          }
          if (scope === null && globalLimit !== null) {
            const dayStart = utcDayStart(new Date(now)).getTime();
            globalCount = uses.filter((use) => use.at >= dayStart).length;
            if (globalCount >= globalLimit) scope = "global";
          }
          const recorded = args.p_consume === true && scope === null;
          if (recorded) uses.push({ user: args.p_user as string, kind: args.p_kind as string, at: now });
          resolve({
            data: {
              allowed: scope === null,
              scope,
              user_count: userCount,
              global_count: globalCount,
              recorded,
            },
            error: null,
          });
        }, 0),
      );
    },
    from(table: string) {
      throw new Error(`the limits read the app table ${table}`);
    },
  };
  return { client: client as never, calls, uses };
}

const at = (iso: string) => Date.parse(iso);

describe("enforceAiAllowance records each allowed use in the ledger", () => {
  it("checks and records in one database call, and records nothing when refused", async () => {
    const { client, calls, uses } = ledgerClient();
    const env = { AI_CHAT_PER_HOUR: "2" };
    await enforceAiAllowance(client, "u1", "chat", { env });
    await enforceAiAllowance(client, "u1", "chat", { env });
    await expect(enforceAiAllowance(client, "u1", "chat", { env })).rejects.toThrow(
      "You have reached this demo's limit of 2 chat messages per hour. Please try again later.",
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.fn === "ai_allowance" && call.p_consume === true)).toBe(true);
    expect(uses).toHaveLength(2);
  });

  it("counts reply drafts with chat messages (they share the chat limit)", async () => {
    const { client } = ledgerClient();
    const env = { AI_CHAT_PER_HOUR: "3" };
    await enforceAiAllowance(client, "u1", "chat", { env });
    await enforceAiAllowance(client, "u1", "draft", { env });
    await enforceAiAllowance(client, "u1", "chat", { env });
    const refused = enforceAiAllowance(client, "u1", "draft", { env });
    await expect(refused).rejects.toBeInstanceOf(CapReachedError);
    await expect(refused).rejects.toMatchObject({ scope: "user" });
  });

  it("refuses every user once the uses of all users today reach the global allowance", async () => {
    const { client } = ledgerClient();
    const env = { AI_CALLS_PER_DAY: "3", AI_CHAT_PER_HOUR: "20" };
    await enforceAiAllowance(client, "a", "chat", { env });
    await enforceAiAllowance(client, "b", "plan", { env });
    await enforceAiAllowance(client, "c", "planner", { env });
    await expect(enforceAiAllowance(client, "d", "chat", { env })).rejects.toMatchObject({
      scope: "global",
      message:
        "This demo's AI allowance for today is used up. It starts again at midnight UTC. Please try again tomorrow.",
    });
  });

  it("lets only as many parallel requests through as the limit has room for (finding 11)", async () => {
    // 4 of 5 week plans used; 10 requests arrive at once: exactly one may run.
    const earlier = Array.from({ length: 4 }, () => ({
      user: "u1",
      kind: "plan",
      at: at("2026-11-24T09:00:00Z"),
    }));
    const { client, uses } = ledgerClient(earlier);
    const env = { AI_PLANS_PER_DAY: "5", AI_CALLS_PER_DAY: "150" };
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => enforceAiAllowance(client, "u1", "plan", { env })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(refused).toHaveLength(9);
    for (const result of refused) {
      expect(result.reason).toBeInstanceOf(CapReachedError);
      expect(result.reason.scope).toBe("user");
    }
    expect(uses.filter((use) => use.user === "u1")).toHaveLength(5);
  });

  it("makes no database call when no limit is set (a local install)", async () => {
    const { client, calls } = ledgerClient();
    await enforceAiAllowance(client, "u1", "chat", { env: {} });
    await enforceAiAllowance(client, "u1", "plan", { env: { AI_CHAT_PER_HOUR: "5" } });
    expect(calls).toHaveLength(0);
  });
});

describe("rows a user can write no longer move the limits (finding 5)", () => {
  it("a check never reads chat messages or request rows, so future-dated or deleted rows change nothing", async () => {
    // 150 uses by user A today. Whatever A does to their own chat_messages, planner_requests or
    // week_plan_requests rows (insert future-dated rows, delete them all), the ledger keeps the
    // 150 uses: the fake client throws if the limits read any of those tables.
    const today = Array.from({ length: 150 }, (_, index) => ({
      user: "a",
      kind: index % 2 ? "chat" : "planner",
      at: at("2026-11-24T08:00:00Z"),
    }));
    const { client } = ledgerClient(today);
    const env = { AI_CALLS_PER_DAY: "150" };
    await expect(checkAiAllowance(client, "a", "chat", { env })).resolves.toMatchObject({
      allowed: false,
      scope: "global",
    });
    await expect(checkAiAllowance(client, "b", "chat", { env })).resolves.toMatchObject({
      allowed: false,
      scope: "global",
    });
  });

  it("a use from yesterday does not count against today's global allowance", async () => {
    const yesterday = Array.from({ length: 150 }, () => ({
      user: "a",
      kind: "chat",
      at: at("2026-11-23T23:59:00Z"),
    }));
    const { client } = ledgerClient(yesterday);
    await expect(
      checkAiAllowance(client, "b", "chat", { env: { AI_CALLS_PER_DAY: "150" } }),
    ).resolves.toEqual({ allowed: true });
  });

  it("checkAiAllowance only reads: it never records a use", async () => {
    const { client, calls, uses } = ledgerClient();
    const env = { AI_PLANNER_PER_HOUR: "6" };
    for (let index = 0; index < 10; index++) {
      await expect(checkAiAllowance(client, "u1", "planner", { env })).resolves.toEqual({
        allowed: true,
      });
    }
    expect(uses).toHaveLength(0);
    expect(calls.every((call) => call.p_consume === false)).toBe(true);
  });
});

describe("when the ledger cannot answer", () => {
  afterEach(() => vi.restoreAllMocks());

  function failingClient(answer: { data: unknown; error: unknown }) {
    return {
      rpc: () => Promise.resolve(answer),
      from: () => {
        throw new Error("no table reads");
      },
    } as never;
  }

  it("throws a plain sentence, never the database error, and logs the cause", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = failingClient({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.ai_allowance",
        details: "schema cache",
        hint: null,
      },
    });
    const env = { AI_CHAT_PER_HOUR: "20" };
    for (const run of [
      () => enforceAiAllowance(client, "u1", "chat", { env }),
      () => checkAiAllowance(client, "u1", "chat", { env }),
    ]) {
      const error = await run().then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(ALLOWANCE_UNAVAILABLE);
      expect(error).not.toHaveProperty("code");
    }
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0][1])).toContain("PGRST202");
  });

  it("treats an answer without counts as unavailable instead of allowing the request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = failingClient({ data: null, error: null });
    await expect(
      enforceAiAllowance(client, "u1", "planner", { env: { AI_PLANNER_PER_HOUR: "6" } }),
    ).rejects.toThrow(ALLOWANCE_UNAVAILABLE);
  });

  it("follows the database when it refused although the counts look below the limits", async () => {
    const answer = (scope: string) => ({
      data: { allowed: false, scope, user_count: 0, global_count: 0, recorded: false },
      error: null,
    });
    const env = { AI_CHAT_PER_HOUR: "20", AI_CALLS_PER_DAY: "150" };
    await expect(
      enforceAiAllowance(failingClient(answer("user")), "u1", "chat", { env }),
    ).rejects.toMatchObject({ scope: "user" });
    await expect(
      enforceAiAllowance(failingClient(answer("global")), "u1", "chat", { env }),
    ).rejects.toMatchObject({ scope: "global" });
  });
});
