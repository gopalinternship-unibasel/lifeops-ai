/**
 * Review of 24 Nov 2026: the demo calendar and inbox. Finding 24 (cancelling every demo event
 * brought all four back), finding 42 (the inbox's weekday words contradicted its own deadlines
 * and the demo calendar) and the mock-calendar part of finding 50 (raw database errors were
 * thrown to the browser).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_CALENDAR_SEEDED,
  deleteEvent,
  demoSeedEvents,
  ensureSeedEvents,
  listEventsForRange,
  updateEvent,
} from "@/server/connectors/calendar.mock";
import { fetchMockEmails, getMockEmail } from "@/server/connectors/gmail.mock";
import {
  addDaysISO,
  localDateTime,
  mondayOfISODate,
  zonedDateTimeToISO,
} from "@/server/timezone.server";

const ZRH = "Europe/Zurich";
const USER = "user-1";

type Row = Record<string, unknown>;
type Failure = { table: string; op: string; error: Record<string, unknown> };

/**
 * A small in-memory stand-in for the Supabase query builder: the calls the mock connectors make,
 * the (user_id, seed_key) and (user_id, provider) unique constraints, and injected failures.
 */
class FakeDb {
  tables: Record<string, Row[]> = { calendar_events: [], connector_status: [] };
  unique: Record<string, string[]> = {
    calendar_events: ["user_id", "seed_key"],
    connector_status: ["user_id", "provider"],
  };
  failures: Failure[] = [];
  private nextId = 1;

  client(): SupabaseClient {
    return { from: (table: string) => new FakeQuery(this, table) } as unknown as SupabaseClient;
  }
  newId() {
    return `row-${this.nextId++}`;
  }
  conflicts(table: string, row: Row) {
    const keys = this.unique[table];
    if (keys.some((key) => row[key] === null || row[key] === undefined)) return false;
    return this.tables[table].some((other) => keys.every((key) => other[key] === row[key]));
  }
  rows(userId = USER) {
    return this.tables.calendar_events.filter((row) => row.user_id === userId);
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private filters: ((row: Row) => boolean)[] = [];
  private payload: Row[] = [];
  private patch: Row = {};
  private ignoreDuplicates = false;
  private returning = false;
  private limitTo?: number;
  private mode: "many" | "single" | "maybeSingle" = "many";

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select() {
    this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], options: { ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.ignoreDuplicates = Boolean(options.ignoreDuplicates);
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    if (operator !== "is" || value !== null) throw new Error("fake: unsupported not()");
    this.filters.push((row) => row[column] !== null && row[column] !== undefined);
    return this;
  }
  lt(column: string, value: string) {
    this.filters.push((row) => Date.parse(String(row[column])) < Date.parse(value));
    return this;
  }
  lte(column: string, value: string) {
    this.filters.push((row) => Date.parse(String(row[column])) <= Date.parse(value));
    return this;
  }
  gt(column: string, value: string) {
    this.filters.push((row) => Date.parse(String(row[column])) > Date.parse(value));
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.limitTo = n;
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }

  then<A = { data: unknown; error: unknown }, B = never>(
    onFulfilled?: ((value: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    // Resolve on a later tick, so concurrent calls interleave as they would over the network.
    return new Promise<{ data: unknown; error: unknown }>((resolve) =>
      setTimeout(() => resolve(this.run()), 0),
    ).then(onFulfilled, onRejected);
  }

  private run(): { data: unknown; error: unknown } {
    const failure = this.db.failures.find((f) => f.table === this.table && f.op === this.op);
    if (failure) return { data: null, error: failure.error };
    const table = this.db.tables[this.table];
    const matches = () => table.filter((row) => this.filters.every((filter) => filter(row)));
    let result: Row[] = [];
    if (this.op === "select") {
      result = matches();
    } else if (this.op === "insert" || this.op === "upsert") {
      for (const input of this.payload) {
        const row = { id: this.db.newId(), seed_key: null, ...input };
        if (this.db.conflicts(this.table, row)) {
          if (this.op === "upsert" && this.ignoreDuplicates) continue;
          return {
            data: null,
            error: {
              code: "23505",
              message: "duplicate key value violates unique constraint",
              details: "Key exists.",
              hint: null,
            },
          };
        }
        table.push(row);
        result.push(row);
      }
    } else if (this.op === "update") {
      result = matches();
      for (const row of result) Object.assign(row, this.patch);
    } else {
      result = matches();
      this.db.tables[this.table] = table.filter((row) => !result.includes(row));
    }
    if (this.limitTo !== undefined) result = result.slice(0, this.limitTo);
    const copy = result.map((row) => ({ ...row }));
    if (this.mode === "many")
      return { data: this.op === "select" || this.returning ? copy : null, error: null };
    if (copy.length === 0 && this.mode === "single")
      return { data: null, error: { code: "PGRST116", message: "no rows" } };
    return { data: copy[0] ?? null, error: null };
  }
}

/** Tuesday 24 Nov 2026, 10:00 in Zurich. */
const TUESDAY = Date.parse("2026-11-24T09:00:00Z");
const DAY = 86_400_000;

describe("seeding the demo calendar (finding 24)", () => {
  it("seeds the four demo events once and records it", async () => {
    const db = new FakeDb();
    await ensureSeedEvents(db.client(), USER, ZRH, TUESDAY);
    expect(db.rows().map((row) => row.seed_key)).toEqual([
      "team-sync",
      "lecture",
      "dentist",
      "acme-interview",
    ]);
    expect(db.rows().find((row) => row.seed_key === "team-sync")?.starts_at).toBe(
      "2026-11-24T18:00:00.000Z",
    );
    expect(db.tables.connector_status).toEqual([
      expect.objectContaining({ user_id: USER, provider: DEMO_CALENDAR_SEEDED }),
    ]);
  });

  it("does not bring cancelled demo events back", async () => {
    const db = new FakeDb();
    const client = db.client();
    await ensureSeedEvents(client, USER, ZRH, TUESDAY);
    for (const row of db.rows()) await deleteEvent(client, USER, String(row.id));
    expect(db.rows()).toHaveLength(0);
    await ensureSeedEvents(client, USER, ZRH, TUESDAY + 60_000);
    await ensureSeedEvents(client, USER, ZRH, TUESDAY + 3 * DAY);
    expect(db.rows()).toHaveLength(0);
  });

  it("seeds a new user only once when two pages load at the same moment", async () => {
    const db = new FakeDb();
    await Promise.all([
      ensureSeedEvents(db.client(), USER, ZRH, TUESDAY),
      ensureSeedEvents(db.client(), USER, ZRH, TUESDAY),
    ]);
    expect(db.rows()).toHaveLength(4);
    expect(db.tables.connector_status).toHaveLength(1);
  });

  it("marks a user seeded before the marker existed without seeding again", async () => {
    const db = new FakeDb();
    db.tables.calendar_events.push({
      id: "own",
      user_id: USER,
      title: "Gym",
      starts_at: "2026-11-25T17:00:00.000Z",
      ends_at: "2026-11-25T18:00:00.000Z",
      seed_key: null,
    });
    await ensureSeedEvents(db.client(), USER, ZRH, TUESDAY);
    expect(db.rows()).toHaveLength(1);
    expect(db.tables.connector_status).toHaveLength(1);
  });

  it("keeps the calendar working when the marker cannot be written", async () => {
    const db = new FakeDb();
    db.failures.push({
      table: "connector_status",
      op: "upsert",
      error: { code: "42501", message: "permission denied" },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await ensureSeedEvents(db.client(), USER, ZRH, TUESDAY);
    expect(db.rows()).toHaveLength(4);
    expect(log).toHaveBeenCalled();
  });
});

describe("demo events that are over follow the demo inbox (finding 42)", () => {
  it("moves untouched demo events that are over to where today's demo calendar has them", async () => {
    const db = new FakeDb();
    const client = db.client();
    await ensureSeedEvents(client, USER, ZRH, TUESDAY);
    // Wednesday 21:00: the team sync (Tue 19-20) and the lecture (Wed 10-12) are over.
    const wednesdayEvening = Date.parse("2026-11-25T20:00:00Z");
    await ensureSeedEvents(client, USER, ZRH, wednesdayEvening);
    const byKey = (key: string) => db.rows().find((row) => row.seed_key === key)!;
    expect(byKey("team-sync")).toMatchObject({
      starts_at: "2026-11-25T18:00:00.000Z",
      ends_at: "2026-11-25T19:00:00.000Z",
    });
    expect(byKey("lecture")).toMatchObject({
      starts_at: "2026-11-26T09:00:00.000Z",
      ends_at: "2026-11-26T11:00:00.000Z",
    });
    // Not over yet: left where it is.
    expect(byKey("dentist")).toMatchObject({ starts_at: "2026-11-26T13:00:00.000Z" });
    expect(byKey("acme-interview")).toMatchObject({ starts_at: "2026-11-30T09:00:00.000Z" });
    // Running it again changes nothing.
    const before = JSON.stringify(db.rows());
    await ensureSeedEvents(client, USER, ZRH, wednesdayEvening + 60_000);
    expect(JSON.stringify(db.rows())).toBe(before);
  });

  it("leaves a demo event the user changed alone", async () => {
    const db = new FakeDb();
    const client = db.client();
    await ensureSeedEvents(client, USER, ZRH, TUESDAY);
    const sync = db.rows().find((row) => row.seed_key === "team-sync")!;
    await updateEvent(client, USER, String(sync.id), {
      starts_at: "2026-11-24T17:00:00.000Z",
      ends_at: "2026-11-24T18:00:00.000Z",
    });
    await ensureSeedEvents(client, USER, ZRH, Date.parse("2026-11-26T09:00:00Z"));
    expect(db.rows().find((row) => row.id === sync.id)).toMatchObject({
      starts_at: "2026-11-24T17:00:00.000Z",
      seed_key: null,
    });
  });

  it("builds the inbox from the same dates as its texts and the demo calendar, on every day of the week", () => {
    for (let day = 0; day < 7; day++) {
      for (const hour of [0, 12, 21]) {
        // Mon 23 Nov to Sun 29 Nov 2026, at 01:00, 13:00 and 22:00 in Zurich.
        const nowMs = Date.parse("2026-11-23T00:00:00Z") + day * DAY + hour * 3_600_000;
        const today = localDateTime(nowMs, ZRH).date;
        const label = `${today} ${hour + 1}:00`;
        const weekday = (iso: string) =>
          new Date(Date.parse(iso)).toLocaleDateString("en-US", { timeZone: ZRH, weekday: "long" });
        const emails = fetchMockEmails(ZRH, nowMs);
        const email = (id: string) => emails.find((e) => e.id === id)!;

        // (a) The paper's weekday is the weekday of its deadline.
        const paper = email("e1");
        const named = /due (\w+day)/.exec(paper.subject)?.[1];
        expect(named, label).toBe(weekday(paper.extractedTask!.deadline!));
        expect(paper.snippet, label).toContain(`due on ${named}`);

        // (b) Lunch is due on a Saturday that is still ahead: on a Saturday after 1 PM the next
        // one, called "next Saturday" (reviewer of 24 Nov 2026: the deadline was already over).
        const lunch = email("e3").extractedTask!.deadline!;
        expect(weekday(lunch), label).toBe("Saturday");
        expect(Date.parse(lunch), label).toBeGreaterThan(nowMs);
        const weekAway = localDateTime(lunch, ZRH).date >= addDaysISO(today, 7);
        const lunchDay = weekAway ? "next Saturday" : "this Saturday";
        expect(email("e3").subject, label).toBe(`Lunch ${lunchDay}?`);
        expect(email("e3").snippet, label).toContain(`lunch ${lunchDay} around 1pm`);
        expect(weekAway, label).toBe(
          weekday(new Date(nowMs).toISOString()) === "Saturday" && hour >= 12,
        );

        // (c) The interview is the demo calendar's, and the prep is due before it and not yet over.
        const interview = zonedDateTimeToISO(
          mondayOfISODate(addDaysISO(today, 7)),
          { hour: 10 },
          ZRH,
        );
        expect(
          demoSeedEvents(today, ZRH).find((e) => e.seed_key === "acme-interview")?.starts_at,
        ).toBe(interview);
        const prep = Date.parse(email("e2").extractedTask!.deadline!);
        expect(prep, label).toBeLessThan(Date.parse(interview));
        expect(prep, label).toBeGreaterThan(nowMs);
        expect(email("e2").snippet, label).toContain(
          `on Monday, ${new Date(Date.parse(interview)).toLocaleDateString("en-US", { timeZone: ZRH, month: "short", day: "numeric" })} at 10am`,
        );

        // (d) "Team sync moved to 7 PM today" is the demo calendar's team sync.
        expect(email("e5").extractedTask!.deadline, label).toBe(
          demoSeedEvents(today, ZRH).find((e) => e.seed_key === "team-sync")?.starts_at,
        );
      }
    }
  });

  it("keeps the subjects the briefing checks look for", () => {
    const emails = fetchMockEmails(ZRH, TUESDAY);
    expect(emails.map((e) => e.subject)).toEqual([
      "Research paper — final draft due Thursday",
      "Onsite interview — next steps",
      "Lunch this Saturday?",
      "Your monthly summary",
      "Team sync moved to 7 PM today",
    ]);
    expect(emails.filter((e) => e.unread)).toHaveLength(4);
    expect(getMockEmail("e3", ZRH)?.subject).toBe("Lunch this Saturday?");
    expect(getMockEmail("nope")).toBeNull();
  });
});

describe("database errors from the mock calendar (finding 50)", () => {
  afterEach(() => vi.restoreAllMocks());
  const raw = {
    code: "42501",
    message: "permission denied for table calendar_events",
    details: "at /var/task/server.js:12",
    hint: "grant select",
  };

  it("throws an Error with a sentence for the user and logs the details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: [string, () => Promise<unknown>, FakeDb][] = [];
    const listing = new FakeDb();
    listing.failures.push({ table: "calendar_events", op: "select", error: raw });
    cases.push([
      "list",
      () =>
        listEventsForRange(listing.client(), USER, "2026-11-24T00:00:00Z", "2026-11-25T00:00:00Z"),
      listing,
    ]);
    const seeding = new FakeDb();
    seeding.failures.push({ table: "calendar_events", op: "upsert", error: raw });
    cases.push(["seed", () => ensureSeedEvents(seeding.client(), USER, ZRH, TUESDAY), seeding]);
    const deleting = new FakeDb();
    deleting.failures.push({ table: "calendar_events", op: "delete", error: raw });
    cases.push(["delete", () => deleteEvent(deleting.client(), USER, "row-1"), deleting]);
    for (const [name, run] of cases) {
      const error = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, name).toBeInstanceOf(Error);
      expect((error as Error).message, name).toMatch(
        /^Could not .+\. Please try again in a moment\.$/,
      );
      expect((error as Error).message, name).not.toMatch(
        /permission|calendar_events|42501|server\.js/,
      );
    }
    expect(log.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("42501");
  });
});
