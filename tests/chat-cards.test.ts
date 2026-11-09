import { describe, expect, it } from "vitest";
import { claimCard } from "@/server/chat-cards.server";

/** A tiny stand-in for the user-scoped Supabase client: one table with a primary key. */
function fakeClient() {
  const rows = new Map<string, { status: string; result_id: string | null }>();
  const client = {
    from() {
      return {
        insert(row: { user_id: string; card_id: string; status: string }) {
          const key = `${row.user_id}|${row.card_id}`;
          if (rows.has(key)) return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
          rows.set(key, { status: row.status, result_id: null });
          return Promise.resolve({ error: null });
        },
        select() {
          const filters: Record<string, string> = {};
          const query = {
            eq(column: string, value: string) {
              filters[column] = value;
              return query;
            },
            maybeSingle() {
              return Promise.resolve({ data: rows.get(`${filters.user_id}|${filters.card_id}`) ?? null, error: null });
            },
          };
          return query;
        },
      };
    },
  };
  return { client, rows };
}

describe("claimCard", () => {
  it("lets the first save of a card through and refuses the second with the stored state", async () => {
    const { client, rows } = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = client as any;
    expect(await claimCard(supabase, "u1", "draft-1", "saved")).toEqual({ claimed: true });
    rows.set("u1|draft-1", { status: "saved", result_id: "d-77" });
    expect(await claimCard(supabase, "u1", "draft-1", "saved")).toEqual({
      claimed: false,
      existing: { status: "saved", resultId: "d-77" },
    });
    // Another user's card with the same id is independent.
    expect(await claimCard(supabase, "u2", "draft-1", "saved")).toEqual({ claimed: true });
  });
});
