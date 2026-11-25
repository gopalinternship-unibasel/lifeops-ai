import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * chat_card_actions in memory, one table with a primary key, shared by the service-role client
 * (which writes claims since the review of 24 Nov 2026) and the user's client (which reads).
 */
const table = vi.hoisted(() => new Map<string, { status: string; result_id: string | null }>());

function fakeClient() {
  return {
    from() {
      return {
        insert(row: { user_id: string; card_id: string; status: string }) {
          const key = `${row.user_id}|${row.card_id}`;
          if (table.has(key)) return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
          table.set(key, { status: row.status, result_id: null });
          return Promise.resolve({ error: null });
        },
        select(_columns?: string, opts?: { count?: string; head?: boolean }) {
          const filters: Record<string, string> = {};
          const query = {
            eq(column: string, value: string) {
              filters[column] = value;
              return query;
            },
            maybeSingle() {
              return Promise.resolve({ data: table.get(`${filters.user_id}|${filters.card_id}`) ?? null, error: null });
            },
            // A count of the user's records: select("card_id", { count: "exact", head: true }).
            then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
              const count = [...table.keys()].filter((key) => key.startsWith(`${filters.user_id}|`)).length;
              return Promise.resolve(opts?.head ? { data: null, error: null, count } : { data: [], error: null }).then(resolve, reject);
            },
          };
          return query;
        },
      };
    },
  };
}

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fakeClient() }));

import { CARD_ACTIONS_FULL, CARD_ACTIONS_LIMIT, claimCard } from "@/server/chat-cards.server";

beforeEach(() => {
  table.clear();
});

describe("claimCard", () => {
  it("lets the first save of a card through and refuses the second with the stored state", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = fakeClient() as any;
    expect(await claimCard(supabase, "u1", "draft-1", "saved")).toEqual({ claimed: true });
    table.set("u1|draft-1", { status: "saved", result_id: "d-77" });
    expect(await claimCard(supabase, "u1", "draft-1", "saved")).toEqual({
      claimed: false,
      existing: { status: "saved", resultId: "d-77" },
    });
    // Another user's card with the same id is independent.
    expect(await claimCard(supabase, "u2", "draft-1", "saved")).toEqual({ claimed: true });
  });

  it("refuses a new card at the database's limit of records per user, also for the server's own writes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = fakeClient() as any;
    for (let i = 0; i < CARD_ACTIONS_LIMIT; i++) table.set(`u1|pending-${i}`, { status: "dismissed", result_id: null });
    await expect(claimCard(supabase, "u1", "draft-new", "saved")).rejects.toThrow(CARD_ACTIONS_FULL);
    expect(table.has("u1|draft-new")).toBe(false);
    // A card that has a record already still answers with its state.
    expect(await claimCard(supabase, "u1", "pending-3", "saved")).toEqual({
      claimed: false,
      existing: { status: "dismissed", resultId: null },
    });
    // Other users are not affected.
    expect(await claimCard(supabase, "u2", "draft-new", "saved")).toEqual({ claimed: true });
  });
});
