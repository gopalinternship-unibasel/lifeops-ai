import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("Vercel response headers (finding 101)", () => {
  const config = JSON.parse(read("vercel.json")) as {
    regions?: string[];
    headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const all = config.headers?.find((rule) => rule.source === "/(.*)");
  const header = (key: string) =>
    all?.headers.find((entry) => entry.key.toLowerCase() === key.toLowerCase())?.value;

  it("keeps the function region", () => {
    expect(config.regions).toEqual(["fra1"]);
  });

  it("forbids framing, MIME sniffing and full referrers on every route", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets no script, style or connect rules that would block the inline scripts TanStack Start emits", () => {
    const directives = (header("Content-Security-Policy") ?? "")
      .split(";")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(directives.sort()).toEqual(["base-uri", "frame-ancestors", "object-src"]);
  });
});

const migrations = readdirSync(join(root, "supabase/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const sql = (prefix: string) => {
  const name = migrations.find((file) => file.startsWith(prefix));
  if (!name) throw new Error(`no migration ${prefix}`);
  return read(`supabase/migrations/${name}`).replace(/\s+/g, " ");
};

describe("AI allowance ledger migration (findings 5 and 11)", () => {
  const ledger = sql("20261124110000");

  it("keeps the ledger away from signed-in users", () => {
    expect(ledger).toContain("alter table public.ai_usage enable row level security");
    expect(ledger).toContain("revoke all on table public.ai_usage from public, anon, authenticated");
    expect(ledger).not.toMatch(/create policy/i);
  });

  it("lets only the service role run the allowance function, which locks before it counts", () => {
    const signature = "public.ai_allowance(uuid, text, text[], integer, integer, integer, boolean)";
    expect(ledger).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
    expect(ledger).toContain(`grant execute on function ${signature} to service_role`);
    expect(ledger).toContain("security definer set search_path = ''");
    expect(ledger.indexOf("pg_advisory_xact_lock")).toBeGreaterThan(-1);
    expect(ledger.indexOf("pg_advisory_xact_lock")).toBeLessThan(ledger.indexOf("select count(*)"));
  });
});

describe("text length limits agreed with the forms and the server (contract 2)", () => {
  const limits = sql("20261124110100");
  const agreed: Array<[string, string, number]> = [
    ["profiles", "name", 100],
    ["profiles", "role", 100],
    ["profiles", "goals", 2000],
    ["tasks", "title", 300],
    ["tasks", "reason", 1000],
    ["calendar_events", "title", 200],
    ["calendar_events", "notes", 2000],
    ["chat_messages", "content", 12000],
    ["email_drafts", "subject", 300],
    ["email_drafts", "body", 12000],
    ["email_drafts", "to_address", 320],
  ];

  it.each(agreed)("%s.%s is at most %i characters, checked for new rows only", (table, column, max) => {
    const block = limits.slice(limits.indexOf(`alter table public.${table} add constraint`));
    expect(block).toMatch(
      new RegExp(`check \\(char_length\\(${column}\\) <= ${max}\\) not valid`),
    );
  });

  it("cuts a long sign-up name to the profile limit instead of failing the sign-up", () => {
    expect(limits).toContain("left(coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), 100)");
  });
});

describe("rows per account (finding 41)", () => {
  const limits = sql("20261124110100");
  // One account's worst case stays a small share of the free database (500 MB): see the
  // migration's header for the sum. These checks read the round-1 file as written; since
  // 20261125120000 six of these tables keep each account's newest rows instead of refusing, and
  // the limits in force are checked in tests/p8-database-r2-row-limits.test.ts.
  const caps: Array<[string, number]> = [
    ["calendar_events", 1000],
    ["chat_card_actions", 1000],
    ["chat_messages", 1000],
    ["chat_sessions", 100],
    ["connector_status", 20],
    ["email_drafts", 100],
    ["planner_requests", 200],
    ["week_plan_requests", 300],
  ];

  it.each(caps)("%s: at most %i rows per user, with a sentence for the visitor", (table, cap) => {
    const trigger = limits.match(
      new RegExp(
        `create trigger ${table}_row_limit before insert on public\\.${table} for each row execute function public\\.enforce_user_row_limit\\( '(\\d+)', '([^']*)' \\)`,
      ),
    );
    expect(trigger?.[1]).toBe(String(cap));
    const sentence = trigger?.[2] ?? "";
    expect(sentence).toMatch(/^This demo account has reached its limit of /);
    // No table or column names in what a visitor may read; they go in the error's DETAIL.
    expect(sentence).not.toMatch(/_/);
  });

  it("names the table only in the error detail", () => {
    expect(limits).toContain(
      "detail = format('Row limit %s per user on %I.%I.', v_limit, tg_table_schema, tg_table_name)",
    );
    expect(limits).not.toMatch(/raise exception '[^']*%[^']*rows in %/);
  });

  it("limits the weeks with a stored plan for every role, letting a re-plan of a week through", () => {
    expect(limits).toContain(
      "create trigger weekly_plans_row_limit before insert on public.weekly_plans for each row execute function public.enforce_weekly_plan_limit('52')",
    );
    const fn = limits.slice(limits.indexOf("function public.enforce_weekly_plan_limit()"));
    expect(fn).not.toContain("current_user <> 'authenticated'");
    expect(fn.indexOf("week_start = new.week_start")).toBeLessThan(fn.indexOf("select count(*)"));
  });
});

describe("one running request at a time (contract 3)", () => {
  const running = sql("20261124110200");

  it("has a hosted step that closes cut-off requests again right before the new code ships", () => {
    const close = read("supabase/hosted/close_stale_running_requests.sql").replace(/\s+/g, " ");
    for (const table of ["week_plan_requests", "planner_requests"]) {
      expect(close).toContain(
        `update public.${table} set status = 'failed', error = 'This request was cut off before it finished.', finished_at = coalesce(finished_at, now()) where status = 'running' and created_at < now() - interval '15 minutes'`,
      );
    }
  });

  it("creates the partial unique indexes after closing older running rows", () => {
    expect(running).toMatch(
      /create unique index if not exists week_plan_requests_one_running on public\.week_plan_requests \(user_id, week_start\) where status = 'running'/,
    );
    expect(running).toMatch(
      /create unique index if not exists planner_requests_one_running on public\.planner_requests \(user_id\) where status = 'running'/,
    );
    expect(running.indexOf("update public.week_plan_requests")).toBeLessThan(
      running.indexOf("week_plan_requests_one_running"),
    );
    expect(running.indexOf("update public.planner_requests")).toBeLessThan(
      running.indexOf("planner_requests_one_running"),
    );
  });
});

describe("hosted clean-up (findings 13 and 68)", () => {
  const cleanup = read("supabase/hosted/cleanup_anonymous_users.sql").replace(/\s+/g, " ");

  it("deletes anonymous users by inactivity, not by account age alone", () => {
    expect(cleanup).toContain("from auth.sessions s");
    expect(cleanup).toContain("s.refreshed_at >= now() - interval '7 days'");
    expect(cleanup).toContain("from auth.refresh_tokens rt");
  });

  it("deletes planner rows whose owner no longer exists, keeping the shared local workspace", () => {
    expect(cleanup).toContain("'delete-orphaned-planner-rows'");
    // Every planner table with an owner column, found when the job runs (the planner adds tables).
    expect(cleanup).toContain("where n.nspname = 'planner'");
    expect(cleanup).toContain("and a.attname = 'owner'");
    expect(cleanup).toContain("not exists (select 1 from auth.users u where u.id::text = p.owner)");
    // Only owners that look like a user id: the shared "local" workspace is never deleted.
    expect(cleanup).toContain("p.owner ~ ''^[0-9a-f]{8}-");
  });
});

describe("rows only the server writes (finding 49)", () => {
  const rows = sql("20261124110300");

  it("takes write access to the task list and plan creation away from signed-in users", () => {
    expect(rows).toContain(
      "revoke insert, update, delete on table public.tasks from anon, authenticated",
    );
    expect(rows).toContain("revoke insert, delete on table public.weekly_plans from anon, authenticated");
  });

  it("lets the user's token insert only plain user messages of chat-form length", () => {
    expect(rows).toMatch(
      /create policy "msgs_insert_own"[^;]*role = 'user' and panel_payload is null and char_length\(content\) <= 4000/,
    );
  });

  it("keeps request rows to the columns the app writes with the user's token", () => {
    expect(rows).toContain(
      "grant insert (user_id, week_start, kind, instructions) on table public.week_plan_requests to authenticated",
    );
    expect(rows).toContain(
      "grant insert (user_id, input, status) on table public.planner_requests to authenticated",
    );
    expect(rows).toContain(
      "using (auth.uid() = user_id and status = 'running') with check (auth.uid() = user_id and status = 'failed')",
    );
  });
});
