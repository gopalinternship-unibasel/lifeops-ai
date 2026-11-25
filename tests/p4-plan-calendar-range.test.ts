/**
 * fetchCalendar's range check (src/functions/chat.functions.ts, finding 104): "from" and "to"
 * must be date-times with a zone, as the pages send them. Only the server function wrapper, the
 * auth middleware and the database are replaced; a value the check refuses never reaches them.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ handlerCalls: 0 }));

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
        async (opts: { data: unknown; context: unknown }) => {
          const data = validate(opts.data);
          h.handlerCalls++;
          return fn({ data, context: opts.context });
        },
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/server/workspace.server", () => ({ isGoogleConnected: vi.fn(async () => false) }));
vi.mock("@/server/connectors/calendar.mock", () => ({
  ensureSeedEvents: vi.fn(async () => undefined),
  listEventsForRange: vi.fn(async () => []),
}));

import { fetchCalendar } from "@/functions/chat.functions";

type Call = (opts: { data: unknown; context: unknown }) => Promise<unknown>;
const fetchRange = (data: unknown) =>
  (fetchCalendar as unknown as Call)({ data, context: { supabase: {}, userId: "u1" } });

describe("fetchCalendar range (finding 104)", () => {
  it("refuses values that are not date-times with a zone, before any database work", async () => {
    h.handlerCalls = 0;
    await expect(fetchRange({ from: "1", to: "2" })).rejects.toThrow();
    await expect(fetchRange({ from: "2026-11-24", to: "2026-11-25" })).rejects.toThrow();
    await expect(fetchRange({ from: "tomorrow", to: "2026-11-25T00:00:00Z" })).rejects.toThrow();
    expect(h.handlerCalls).toBe(0);
  });

  it("accepts the values the pages send (toISOString) and offsets", async () => {
    await expect(
      fetchRange({ from: new Date(0).toISOString(), to: new Date(3_600_000).toISOString() }),
    ).resolves.toMatchObject({ events: [], source: "mock" });
    await expect(
      fetchRange({ from: "2026-11-24T00:00:00+01:00", to: "2026-11-25T00:00:00+01:00" }),
    ).resolves.toMatchObject({ source: "mock" });
    // No range at all still means today.
    await expect(fetchRange(undefined)).resolves.toMatchObject({ source: "mock" });
  });
});
