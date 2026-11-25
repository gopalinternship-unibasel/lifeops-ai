// Checks for three points of the second review of the deployment docs: the hosted upgrade of
// 24 Nov 2026 deploys the planner too, RUNNING.md gives no test or warning counts that go stale,
// and the Pages troubleshooting table says what a site shows against a function from before the
// 404 for unknown server functions.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { messageForStatus, SERVER_FN_MESSAGES } from "@/lib/server-fn-errors";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
/** Markdown with its line breaks joined, so a quote may wrap. */
const flat = (text: string) => text.replace(/\s+/g, " ");
const vercel = flat(read("VERCEL_DEPLOYMENT.md"));

const PLANNER_DEPLOY = "`npx vercel@latest deploy --prod --cwd fastapi-backend`";
const WEB_DEPLOY = "`npx vercel@latest deploy --prod`";
const PAGES_RELEASE = "`npm run release:pages`";

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("the hosted upgrade of 24 Nov 2026", () => {
  const upgrade = between(vercel, "Applying the migrations of 24 and 25 Nov 2026 to the hosted project", "### 5.2");
  const firstDeploy = between(vercel, "## 6. Order of the steps", "## 7.");

  it("deploys the planner first, then the web app, then the Pages edition, as section 6 does", () => {
    const order = [
      upgrade.indexOf("close_stale_running_requests.sql"),
      upgrade.indexOf(PLANNER_DEPLOY),
      upgrade.indexOf(WEB_DEPLOY),
      upgrade.indexOf(PAGES_RELEASE),
    ];
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(upgrade).toContain("in the order of section 6, step 11");
    // The Pages guide sends the reader to that order with the planner named.
    expect(flat(read("PAGES_DEPLOYMENT.md"))).toContain(
      "in the order of `VERCEL_DEPLOYMENT.md`, section 5.1, and release the planner and both editions together, the planner first",
    );
    // Section 6, step 11 uses the same two commands, the planner first.
    const step11 = between(firstDeploy, "11. Deploy the planner first", "12. ");
    expect(step11.indexOf(PLANNER_DEPLOY)).toBeGreaterThan(-1);
    expect(step11.indexOf(WEB_DEPLOY)).toBeGreaterThan(step11.indexOf(PLANNER_DEPLOY));
  });

  it("says what the planner does with the new request fields and its new table, as its code does", () => {
    expect(upgrade).toContain("the new fields of its plan request are optional");
    const schemas = read("fastapi-backend/app/schemas.py");
    const planRequest = between(schemas, "class PlanRequest(BaseModel):", "\nclass ");
    expect(planRequest).toMatch(/idempotency_key: str \| None = Field\(default=None,/);
    expect(planRequest).toMatch(/busy: list\[BusyInterval\] = Field\(default_factory=list,/);
    expect(planRequest).toMatch(/deadline: datetime \| None = None/);

    expect(upgrade).toContain("it creates its new table for repeated plan requests itself when it starts");
    expect(read("fastapi-backend/app/models.py")).toContain("class PlanIdempotencyKey(SQLModel, table=True):");
    expect(read("fastapi-backend/app/main.py")).toMatch(/def on_startup\(\):\s+create_db_and_tables\(\)/);

    expect(upgrade).toContain("The old planner ignores the calendar times that the new web app sends it");
  });
});

describe("the guides' test and lint notes", () => {
  it("give no counts of tests or warnings, which change with every round of fixes", () => {
    for (const file of ["RUNNING.md", "README.md", "PAGES_DEPLOYMENT.md", "VERCEL_DEPLOYMENT.md"]) {
      const text = flat(read(file));
      expect(text, file).not.toMatch(/\b\d[\d,]* (?:unit |planner |vitest |pytest )?tests\b/);
      expect(text, file).not.toMatch(/\b\d[\d,]* (?:old )?(?:fast-refresh )?warnings\b/);
    }
    const running = flat(read("RUNNING.md"));
    expect(running).toContain("npm test # unit tests (vitest):");
    expect(running).toContain("npm run lint # 0 errors (the warnings are all fast-refresh ones)");
  });
});

describe("the Pages troubleshooting rows for an unknown server function", () => {
  const lines = read("PAGES_DEPLOYMENT.md").split("\n");
  const rows = lines.filter((line) => line.startsWith("| "));
  const row = (sentence: string) => {
    const found = rows.filter((line) => line.startsWith(`| "${sentence}"`));
    expect(found, sentence).toHaveLength(1);
    return found[0];
  };

  it("say that a function from before the 404 answers with the generic sentence instead", () => {
    const reload = row(SERVER_FN_MESSAGES.outdated);
    expect(reload).toContain("(HTTP 404;");
    expect(reload).toContain("A function built from a commit before this 404 existed (one without `src/lib/server-fn-errors.ts`)");
    expect(existsSync(new URL("../src/lib/server-fn-errors.ts", import.meta.url))).toBe(true);
    expect(reload).toContain(`answers with HTTP 500 instead, and the page then shows "${SERVER_FN_MESSAGES.failed}"`);
    // That is the sentence the page's guard gives an answer it cannot read with HTTP 500.
    expect(messageForStatus(500)).toBe(SERVER_FN_MESSAGES.failed);

    const failed = row(SERVER_FN_MESSAGES.failed);
    expect(failed).toContain("A Pages site released ahead of an older function shows it too");
  });

  it("keep the table's columns aligned", () => {
    // The whole table: the run of "|" lines around the reload row.
    const at = lines.indexOf(row(SERVER_FN_MESSAGES.outdated));
    let first = at;
    while (lines[first - 1].startsWith("|")) first -= 1;
    let last = at;
    while (lines[last + 1].startsWith("|")) last += 1;
    const table = lines.slice(first, last + 1);
    expect(table[0]).toMatch(/^\| What you see +\| Cause and fix +\|$/);
    expect(table[1]).toMatch(/^\| -+ \| -+ \|$/);
    expect(table).toContain(row(SERVER_FN_MESSAGES.failed));
    const column = (line: string) => line.indexOf(" | ");
    for (const line of table) {
      expect(line.length, line.slice(0, 60)).toBe(table[0].length);
      expect(column(line), line.slice(0, 60)).toBe(column(table[0]));
    }
  });
});
