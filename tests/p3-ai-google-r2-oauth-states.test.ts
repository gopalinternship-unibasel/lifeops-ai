/**
 * The table behind single-use Google sign-ins (finding 98):
 * supabase/migrations/20261125100000_google_oauth_states.sql.
 *
 * Only the server may read or write it: a signed-in visitor who could insert rows would make a
 * state finishable again, and one who could read them would learn other accounts' pending
 * sign-ins. The behaviour (record at start, consume once) is tested in tests/google-oauth.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "supabase/migrations");
const name = readdirSync(dir).find((file) => file.startsWith("20261125100000_"));
const sql = (name ? readFileSync(join(dir, name), "utf8") : "")
  .replace(/--[^\n]*/g, "")
  .replace(/\s+/g, " ")
  .toLowerCase();

describe("google_oauth_states migration", () => {
  it("exists", () => {
    expect(name).toBe("20261125100000_google_oauth_states.sql");
  });

  it("keys a pending sign-in by its nonce, for one account, until its expiry", () => {
    expect(sql).toContain("create table if not exists public.google_oauth_states (");
    expect(sql).toMatch(/nonce text primary key check \(char_length\(nonce\) <= 100\)/);
    expect(sql).toMatch(/user_id uuid not null references auth\.users \(id\) on delete cascade/);
    expect(sql).toContain("expires_at timestamptz not null");
  });

  it("is for the server only: row level security on, no policy, no privileges for the API roles", () => {
    expect(sql).toContain("alter table public.google_oauth_states enable row level security");
    expect(sql).not.toContain("create policy");
    expect(sql).toContain(
      "revoke all on table public.google_oauth_states from public, anon, authenticated",
    );
    expect(sql).not.toMatch(/grant [^;]* to [^;]*(anon|authenticated)/);
    // The three privileges the server uses: insert at start, select + delete for DELETE ... RETURNING.
    expect(sql).toContain(
      "grant select, insert, delete on table public.google_oauth_states to service_role",
    );
  });
});
