/**
 * "Plan it" and the demo's AI allowance (finding 11, dashboard part; audit of 24 Nov 2026).
 *
 * runChaosPlan calls startPlanRequest without an allowance of its own, so startPlanRequest must
 * record the use itself: one "planner" use per press, before the request row is stored, also
 * when the planner service is switched off and the in-app assistant answers (its chat turn only
 * checks the chat allowance and records nothing). Before the fix, a press with the planner off
 * recorded no use at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const enforce = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("@/server/limits.server", () => ({ enforceAiAllowance: enforce }));

import { PLAN_ALREADY_RUNNING, startPlanRequest } from "@/server/lifeops-backend.server";

type Row = Record<string, unknown>;

/** planner_requests in memory: enough of the query builder for startPlanRequest. */
function fakeRequests(rows: Row[]): SupabaseClient<Database> {
  function from() {
    const filters: Array<(row: Row) => boolean> = [];
    let insertRow: Row | null = null;
    let updating = false;
    const run = async () => {
      if (insertRow) {
        const row = {
          id: `r${rows.length + 1}`,
          created_at: new Date().toISOString(),
          ...insertRow,
        };
        rows.push(row);
        return { data: row, error: null };
      }
      if (updating) return { data: null, error: null };
      return { data: rows.find((row) => filters.every((keep) => keep(row))) ?? null, error: null };
    };
    const builder = {
      select: () => builder,
      update: () => {
        updating = true;
        return builder;
      },
      insert: (value: Row) => {
        insertRow = value;
        return builder;
      },
      eq: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return builder;
      },
      lt: () => builder,
      gte: () => builder,
      limit: () => builder,
      single: run,
      maybeSingle: run,
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        run().then(resolve, reject),
    };
    return builder;
  }
  return { from } as unknown as SupabaseClient<Database>;
}

beforeEach(() => {
  enforce.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("'Plan it' records one AI use per press (11)", () => {
  it("with the planner switched off, the press still records one 'planner' use before the row", async () => {
    vi.stubEnv("LIFEOPS_BACKEND_URL", "off");
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    const rows: Row[] = [];
    enforce.mockImplementationOnce(async () => {
      // Recorded before the request row exists.
      expect(rows).toHaveLength(0);
    });
    await startPlanRequest(fakeRequests(rows), "u1", "Plan my week", { windowMs: 300_000 });
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(enforce.mock.calls[0][1]).toBe("u1");
    expect(enforce.mock.calls[0][2]).toBe("planner");
    expect(rows).toHaveLength(1);
  });

  it("with the planner on, it is the same single use", async () => {
    vi.stubEnv("LIFEOPS_BACKEND_URL", "https://planner.test");
    await startPlanRequest(fakeRequests([]), "u1", "Plan my week", { windowMs: 300_000 });
    expect(enforce).toHaveBeenCalledTimes(1);
  });

  it("a request refused because one is still running records nothing", async () => {
    const rows: Row[] = [
      { id: "r0", user_id: "u1", status: "running", created_at: new Date().toISOString() },
    ];
    await expect(
      startPlanRequest(fakeRequests(rows), "u1", "Plan my week", { windowMs: 300_000 }),
    ).rejects.toThrow(PLAN_ALREADY_RUNNING);
    expect(enforce).not.toHaveBeenCalled();
  });
});
