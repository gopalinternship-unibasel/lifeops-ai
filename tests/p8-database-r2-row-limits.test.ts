/**
 * Round 2 of the database package, finding 41: per-account row limits that bound storage without
 * locking an account out (migration 20261125120000), the visitor's sentence of a row-limit
 * refusal passed through dbError, and clearChatHistory removing the records of handled cards.
 * The SQL behaviour itself is checked against Postgres by supabase/tests/check-migrations.mjs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  /** Records every query; every query succeeds with no rows. */
  function recorder(name: string) {
    const log: { client: string; table: string; calls: [string, unknown[]][] }[] = [];
    return {
      log,
      client: {
        from(table: string) {
          const calls: [string, unknown[]][] = [];
          log.push({ client: name, table, calls });
          const builder: Record<string, unknown> = {};
          for (const method of ["select", "insert", "update", "delete", "eq", "in", "is", "order", "limit"]) {
            builder[method] = (...args: unknown[]) => {
              calls.push([method, args]);
              return builder;
            };
          }
          builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
          return builder;
        },
      },
    };
  }
  return { state, createServerFn, user: recorder("user"), admin: recorder("admin") };
});

vi.mock("@tanstack/react-start", () => ({ createServerFn: harness.createServerFn }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: harness.admin.client }));
vi.mock("@/server/workspace.server", () => ({ isGoogleConnected: vi.fn(async () => false) }));
vi.mock("@/server/google/calendar.server", () => ({ listCalendarEvents: vi.fn(async () => []) }));
vi.mock("@/server/google/gmail.server", () => ({ listUnreadMessages: vi.fn(), listRecentMessages: vi.fn() }));
vi.mock("@/server/deployment.server", () => ({ isHostedDeployment: () => true }));

import { clearChatHistory } from "@/functions/chat.functions";
import { dbError, isRowLimitError, publicError, rowLimitSentence } from "@/server/public-error.server";

const root = process.cwd();
const migrationFiles = readdirSync(join(root, "supabase/migrations"))
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrations = migrationFiles.map((file) => ({
  file,
  sql: readFileSync(join(root, "supabase/migrations", file), "utf8").replace(/\s+/g, " "),
}));
const rolling = migrations.find((m) => m.file.startsWith("20261125120000"))?.sql ?? "";

/** The row-limit trigger of each table as the last migration that (re)creates it leaves it. */
function triggersInForce(): Record<string, { fn: string; limit: number; sentence?: string; file: string }> {
  const found: Record<string, { fn: string; limit: number; sentence?: string; file: string }> = {};
  const re =
    /create trigger (\w+)_row_limit before insert on public\.(\w+) for each row execute function public\.(\w+)\( ?'(\d+)'(?:, '((?:[^']|'')*)')? ?\)/g;
  for (const { file, sql } of migrations) {
    for (const match of sql.matchAll(re)) {
      found[match[2]] = { fn: match[3], limit: Number(match[4]), sentence: match[5]?.replace(/''/g, "'"), file };
    }
  }
  return found;
}

/** A refusal as supabase-js returns it from PostgREST. */
const refusal = (message: string, details: string) => ({ code: "23514", message, details, hint: null });

describe("dbError passes the database's row-limit sentence on (finding 41)", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => logged.mockRestore());

  const sentence =
    "This demo account has reached its limit of 1000 calendar events that are not over yet. Ask the assistant to cancel upcoming events you no longer need, or wait until some are over, then try again.";

  it("shows the visitor the sentence of a row-limit refusal instead of 'try again in a moment'", () => {
    const error = dbError("add the event to your calendar", refusal(sentence, "Row limit 1000 per user on public.calendar_events."));
    expect(error.message).toBe(sentence);
    // The cause is still logged for the operator, with the table.
    expect(String(logged.mock.calls[0]?.[1])).toContain("public.calendar_events");
    // Marked, so a loop over many writes can stop on it (approveWeekPlan).
    expect(isRowLimitError(error)).toBe(true);
  });

  it("marks only dbError's row-limit Errors as row-limit errors", () => {
    expect(isRowLimitError(dbError("save it", { code: "57014", message: "canceling statement" }))).toBe(false);
    expect(isRowLimitError(publicError(sentence))).toBe(false);
    expect(isRowLimitError(new Error(sentence))).toBe(false);
    expect(isRowLimitError(refusal(sentence, "Row limit 1000 per user on public.calendar_events."))).toBe(false);
    // The Error itself carries nothing extra to the browser: only its message.
    const error = dbError("add the event", refusal(sentence, "Row limit 1000 per user on public.calendar_events."));
    expect(Object.keys(error)).toEqual([]);
    expect(error.constructor).toBe(Error);
  });

  it("also reads a Postgres driver's error (detail, not details)", () => {
    const cause = { code: "23514", message: sentence, detail: "Row limit 1000 per user on public.calendar_events." };
    expect(dbError("add the event", cause).message).toBe(sentence);
  });

  it("keeps the plain sentence for a CHECK constraint, whose detail holds row data", () => {
    const check = refusal(
      'new row for relation "tasks" violates check constraint "tasks_title_length"',
      "Failing row contains (1, secret title, ...).",
    );
    expect(dbError("save your tasks", check).message).toBe("Could not save your tasks. Please try again in a moment.");
  });

  it.each([
    ["no detail", { code: "23514", message: sentence }],
    ["another detail", refusal(sentence, "Failing row contains (x).")],
    ["another code", { code: "23505", message: sentence, details: "Row limit 1000 per user on public.calendar_events." }],
    ["an internal name in the message", refusal("This demo account has reached its limit of 20 rows in connector_status.", "Row limit 20 per user on public.connector_status.")],
    ["a message for developers", refusal("permission denied for table tasks", "Row limit 1 per user on public.tasks.")],
    ["a thrown string", "This demo account has reached its limit"],
    ["nothing", undefined],
  ])("keeps the plain sentence for %s", (_label, cause) => {
    expect(rowLimitSentence(cause)).toBeNull();
    expect(dbError("save it", cause).message).toBe("Could not save it. Please try again in a moment.");
  });

  it("recognises the refusal of every row-limit trigger in force, in the form the SQL raises it", () => {
    // Both trigger functions raise the detail in this form; the server's pattern must match it.
    const detailFormat = "detail = format('Row limit %s per user on %I.%I.', v_limit, tg_table_schema, tg_table_name)";
    expect(rolling).toContain(detailFormat);
    expect(migrations.find((m) => m.file.startsWith("20261124110100"))?.sql).toContain(detailFormat);
    const withSentence = Object.entries(triggersInForce()).filter(([, t]) => t.sentence);
    expect(withSentence.map(([table]) => table).sort()).toEqual(
      ["calendar_events", "chat_sessions", "connector_status", "planner_requests", "week_plan_requests"],
    );
    for (const [table, trigger] of withSentence) {
      const cause = refusal(trigger.sentence as string, `Row limit ${trigger.limit} per user on public.${table}.`);
      expect(rowLimitSentence(cause), table).toBe(trigger.sentence);
    }
    // The fallback sentence of keep_newest_user_rows passes too.
    const fallback = rolling.match(/coalesce\(v_refusal, '([^']+)'\)/)?.[1] ?? "";
    expect(rowLimitSentence(refusal(fallback, "Row limit 5 per user on public.email_drafts."))).toBe(fallback);
  });
});

describe("row limits that bound storage without locking an account out (finding 41)", () => {
  const inForce = triggersInForce();

  it("keeps each account's newest rows in the tables whose old rows the app no longer needs", () => {
    const keep = Object.fromEntries(
      Object.entries(inForce)
        .filter(([, t]) => t.fn === "keep_newest_user_rows")
        .map(([table, t]) => [table, t.limit]),
    );
    expect(keep).toEqual({
      calendar_events: 1000,
      chat_card_actions: 900,
      chat_messages: 1000,
      email_drafts: 100,
      planner_requests: 200,
      week_plan_requests: 300,
      weekly_plans: 52,
    });
  });

  it("refuses only where the user can make room in the app or the app never gets there", () => {
    const refuse = Object.fromEntries(
      Object.entries(inForce)
        .filter(([, t]) => t.fn === "enforce_user_row_limit")
        .map(([table, t]) => [table, t.limit]),
    );
    expect(refuse).toEqual({ chat_sessions: 100, connector_status: 20 });
  });

  it("removes only calendar events that are over, the demo events last, and refuses with what to do", () => {
    expect(inForce.calendar_events.file).toMatch(/^20261125120000/);
    expect(rolling).toContain(
      "when 'calendar_events' then -- Only events that are over, the one that ended first first; the demo events last. v_removable := 'ends_at <= now()'; v_order := 'seed_key is not null, ends_at, id';",
    );
    expect(inForce.calendar_events.sentence).toBe(
      "This demo account has reached its limit of 1000 calendar events that are not over yet. Ask the assistant to cancel upcoming events you no longer need, or wait until some are over, then try again.",
    );
  });

  it("removes dismissed card records first and a claim of the last hour last", () => {
    const fn = rolling.slice(rolling.indexOf("when 'chat_card_actions' then"));
    expect(fn).toContain(
      "v_order := 'status <> ''dismissed'', (result_id is null and created_at > now() - interval ''1 hour''), ' 'created_at, card_id';",
    );
  });

  it("tells no visitor to clear the chat history, which the app has no control for", () => {
    for (const [table, trigger] of Object.entries(inForce)) {
      expect(trigger.sentence ?? "", table).not.toMatch(/clear the chat/i);
    }
  });

  it("keeps the card records below the server's own refusal at 1000 records", async () => {
    const { CARD_ACTIONS_LIMIT } = await import("@/server/chat-cards.server");
    expect(inForce.chat_card_actions.limit).toBeLessThan(CARD_ACTIONS_LIMIT);
  });

  it("removes rows only of the account the new row belongs to, never a running request", () => {
    const fn = rolling.slice(rolling.indexOf("create or replace function public.keep_newest_user_rows()"));
    expect(fn).toMatch(/^create or replace function public\.keep_newest_user_rows\(\) returns trigger language plpgsql security definer set search_path = ''/);
    // A row for another account (refused by row level security) returns before anything is removed.
    expect(fn.indexOf("v_caller <> new.user_id")).toBeLessThan(fn.indexOf("delete from"));
    expect(fn).toContain("when 'planner_requests', 'week_plan_requests' then v_removable := 'status <> ''running''';");
    expect(fn).toContain("where user_id = $1 and %3$I = any(array(");
    expect(fn).toContain("select %3$I from %1$I.%2$I where user_id = $1 and %4$s order by %5$s limit $2");
    expect(rolling).toContain("revoke all on function public.keep_newest_user_rows() from public, anon, authenticated;");
  });

  it("stores a week plan after the model answered: a re-plan removes nothing and a new week makes room", () => {
    const fn = rolling.slice(rolling.indexOf("when 'weekly_plans' then"));
    expect(fn.indexOf("week_start = new.week_start")).toBeLessThan(fn.indexOf("return new;"));
    expect(rolling).toContain("drop function if exists public.enforce_weekly_plan_limit();");
    expect(inForce.weekly_plans.file).toMatch(/^20261125120000/);
  });
});

describe("clearChatHistory removes the records of handled cards (finding 41)", () => {
  it("deletes the user's card records with the service role, scoped to the user", async () => {
    harness.user.log.length = 0;
    harness.admin.log.length = 0;
    harness.state.context = { supabase: harness.user.client, userId: "user-1" };
    await expect(clearChatHistory()).resolves.toEqual({ ok: true });
    const cardDeletes = [...harness.user.log, ...harness.admin.log].filter(
      (entry) => entry.table === "chat_card_actions" && entry.calls.some(([method]) => method === "delete"),
    );
    expect(cardDeletes.map((entry) => entry.client)).toEqual(["admin"]);
    expect(cardDeletes[0].calls).toContainEqual(["eq", ["user_id", "user-1"]]);
    // Messages and sessions stay with the user's own token (their delete policies allow it).
    expect(harness.user.log.filter((e) => e.calls.some(([m]) => m === "delete")).map((e) => e.table)).toEqual([
      "chat_messages",
      "chat_sessions",
    ]);
  });
});
