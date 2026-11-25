// The deployment docs describe the database changes of 24 Nov 2026 (supabase/migrations and
// supabase/hosted). These checks read the numbers, file names and job times from the SQL files
// themselves, so the docs fail here when one of them changes and the docs do not.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWANCE_UNAVAILABLE } from "@/server/limits.server";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
/** Markdown with its line breaks joined, so a quote may wrap. */
const flat = (text: string) => text.replace(/\s+/g, " ");
const vercel = flat(read("VERCEL_DEPLOYMENT.md"));
const running = flat(read("RUNNING.md"));
const pages = flat(read("PAGES_DEPLOYMENT.md"));

const list = (dir: string) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((name) => name.endsWith(".sql"));
const migrations = list("supabase/migrations");
const limitsSql = read("supabase/migrations/20261124110100_text_and_row_limits.sql");
const serverRowsSql = read("supabase/migrations/20261124110300_server_written_rows.sql");
const rollingSql = read("supabase/migrations/20261125120000_rolling_row_limits.sql");
const cleanupSql = read("supabase/hosted/cleanup_anonymous_users.sql");
const closeStaleSql = read("supabase/hosted/close_stale_running_requests.sql");

/** 1000 -> "1,000", as the docs write numbers. */
const number = (value: number) => value.toLocaleString("en-US");

describe("the migration count", () => {
  it("is the number of files in supabase/migrations", () => {
    const count = migrations.length;
    expect(count).toBe(20);
    expect(vercel).toContain(`applies the ${count} files in \`supabase/migrations\``);
    expect(vercel).toContain(`The migration list should show ${count} applied`);
    expect(vercel).toContain(`The ${count} migrations, then the one-off clean-up file`);
    expect(running).toContain(`applies the ${count} migrations in \`supabase/migrations\``);
    expect(running).toContain(`is one of the ${count} migrations`);
  });

  it("names each migration of 24 and 25 Nov 2026 and each file in supabase/hosted", () => {
    const newer = migrations.filter((name) => name.startsWith("20261124") || name.startsWith("20261125"));
    expect(newer).toHaveLength(7);
    for (const name of newer) expect(vercel, name).toContain(`\`${name}\``);
    for (const name of list("supabase/hosted")) expect(vercel, name).toContain(`supabase/hosted/${name}`);
  });
});

describe("the hosted upgrade order", () => {
  it("runs the check, the migrations, the stale-request file and the deploy, then the clean-up again", () => {
    const start = vercel.indexOf("Applying the migrations of 24 and 25 Nov 2026 to the hosted project");
    expect(start).toBeGreaterThan(-1);
    const section = vercel.slice(start, vercel.indexOf("### 5.2", start));
    const order = [
      "check_before_20261124_migrations.sql",
      "`supabase db push`",
      "close_stale_running_requests.sql",
      "npx vercel@latest deploy --prod",
      "npm run release:pages",
      "cleanup_anonymous_users.sql",
    ].map((step) => [step, section.indexOf(step)] as const);
    for (const [step, at] of order) expect(at, step).toBeGreaterThan(-1);
    const positions = order.map(([, at]) => at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The new code's refusal without the ledger, quoted from the code, in both deployment docs.
    expect(section).toContain(ALLOWANCE_UNAVAILABLE);
    expect(pages).toContain(ALLOWANCE_UNAVAILABLE);
  });

  it("gives the age after which the stale-request file closes a request", () => {
    const minutes = [...closeStaleSql.matchAll(/created_at < now\(\) - interval '(\d+) minutes'/g)].map((m) => m[1]);
    expect(minutes).toEqual(["15", "15"]);
    expect(vercel).toContain(`"running" for more than ${minutes[0]} minutes`);
  });
});

describe("the size and row limits", () => {
  /** The per-user row limit in force for each table: the triggers of 20261124110100, replaced by
   * those of 20261125120000 (rolling limits for most tables) where it redefines them. */
  function rowLimits(): Record<string, number> {
    const limits: Record<string, number> = {};
    const triggers = /before insert on public\.(\w+)\s+for each row execute function public\.(?:enforce_(?:user_row|weekly_plan)_limit|keep_newest_user_rows)\(\s*'(\d+)'/g;
    for (const sql of [limitsSql, rollingSql]) {
      for (const [, table, limit] of sql.matchAll(triggers)) limits[table] = Number(limit);
    }
    return limits;
  }

  it("are given with the numbers the database uses", () => {
    const limits = rowLimits();
    const words: Record<string, string> = {
      calendar_events: "calendar events",
      chat_card_actions: "handled chat cards",
      chat_messages: "chat messages",
      chat_sessions: "chat sessions",
      connector_status: "connected services",
      email_drafts: "email drafts",
      planner_requests: '"Plan it" requests',
      week_plan_requests: "week plan requests",
      weekly_plans: "saved week plans",
    };
    expect(Object.keys(limits).sort()).toEqual(Object.keys(words).sort());
    for (const [table, phrase] of Object.entries(words)) {
      expect(vercel, table).toContain(`${number(limits[table])} ${phrase}`);
    }
    expect(running).toContain(`${number(limits.chat_messages)} stored chat messages`);
  });

  it("quote the length limits of the constraints", () => {
    const limit = (constraint: string) => {
      const match = new RegExp(`add constraint ${constraint}\\s+check \\((?:char|octet)_length\\([^)]+\\)\\s*<= (\\d+)\\)`).exec(limitsSql);
      expect(match, constraint).not.toBeNull();
      return Number(match![1]);
    };
    expect(vercel).toContain(`${number(limit("profiles_name_length"))} characters for the profile's name`);
    expect(vercel).toContain(`${number(limit("profiles_goals_length"))} for its goals`);
    expect(vercel).toContain(`${number(limit("tasks_title_length"))} for a task title`);
    expect(vercel).toContain(`${number(limit("calendar_events_title_length"))} for an event title`);
    expect(vercel).toContain(`${number(limit("chat_messages_content_length"))} for a chat message`);
    expect(vercel).toContain(`${limit("weekly_plans_payload_size") / 1024} kB for a week plan`);
    const userMessage = /and char_length\(content\) <= (\d+)/.exec(serverRowsSql);
    expect(vercel).toContain(`at most ${number(Number(userMessage![1]))} characters`);
  });
});

describe("the clean-up jobs", () => {
  it("are named with the times the clean-up file schedules", () => {
    const jobs = [...cleanupSql.matchAll(/cron\.schedule\(\s*'([\w-]+)',\s*'(\d+) (\d+) \* \* \*'/g)].map(
      ([, name, minute, hour]) => `\`${name}\` (${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC)`,
    );
    expect(jobs).toEqual(["`delete-old-anonymous-users` (03:17 UTC)", "`delete-orphaned-planner-rows` (03:47 UTC)"]);
    for (const job of jobs) expect(vercel).toContain(job);
    expect(vercel).toContain("Running it twice leaves the two jobs.");
    expect(vercel).not.toContain("Running it twice leaves one job.");
  });

  it("are no longer said to leave the planner's rows or to go by account age alone", () => {
    expect(running).not.toContain("are not linked to them and are not cleaned up");
    expect(running).toContain("deletes the planner's rows in its own `planner` schema whose user no longer exists");
    expect(running).not.toContain("anonymous users older than 7 days");
    expect(vercel).not.toContain("deletes anonymous users older than 7 days");
  });
});

describe("the AI limits", () => {
  it("say that parallel requests are counted one at a time", () => {
    expect(vercel).toContain("parallel requests are counted one at a time");
    expect(running).toContain("parallel requests are counted one at a time");
    expect(vercel).not.toContain("by a few");
  });
});
