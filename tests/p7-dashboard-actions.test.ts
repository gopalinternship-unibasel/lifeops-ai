/**
 * Running approved planner actions from the dashboard (runApprovedPlannerAction in
 * src/server/workspace.server.ts), audit of 24 Nov 2026:
 *  - 69 / 89: the block or draft was written, then recording it in the planner failed outside the
 *    try: the user saw an error, and Run again was refused as an overlap with its own block or
 *    saved a second draft;
 *  - 75: the external writes were not idempotent per action;
 *  - 82: a reminder or task was reported as "Marked as done." though nothing was scheduled;
 *  - 44: no screen let the user give a draft's recipient ("(recipient to fill in)" was saved);
 *  - 50: database errors were thrown as raw PostgREST objects.
 * Round 2:
 *  - 69: a block was reused by title and time alone (an event the user made was taken for the
 *    planner's block), and a Gmail draft whose row and planner record both failed was created
 *    again by the next Run;
 *  - 75: two Runs at the same moment both passed the lookups and wrote twice.
 * Review of round 2:
 *  - 69: a block or draft was reused for its reference alone, so after a reset of the planner's
 *    database a new action with an old action's id never got its own;
 *  - 75: a Run during another Run's Gmail call reported the draft as saved (with the row's id).
 * The fake client below applies the database's unique keys: (user_id, seed_key) on
 * calendar_events, and the planner-reference index on email_drafts (migration 20261125110000).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const admin = vi.hoisted(() => ({
  googleRow: null as Record<string, unknown> | null,
  error: null as Record<string, unknown> | null,
  /** The service role's view of the other tables (a test's fake user client), when set. */
  tables: null as { from: (table: string) => unknown } | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: admin.googleRow, error: admin.error }),
  };
  return {
    supabaseAdmin: {
      from: (table: string) => (table === "google_oauth_tokens" || !admin.tables ? query : admin.tables.from(table)),
    },
  };
});

const google = vi.hoisted(() => ({
  events: [] as Array<{ id: string; title: string; starts_at: string; ends_at: string; busy?: boolean }>,
  inserted: [] as Array<Record<string, unknown>>,
  drafts: [] as Array<Record<string, unknown>>,
  /** When set, the Google Calendar insert fails with this raw message (as calendar.server did). */
  insertError: null as string | null,
  /** When set, creating a Gmail draft fails with this message. */
  draftError: null as string | null,
  /** When set, creating a Gmail draft waits for this promise (a Gmail call still under way). */
  draftGate: null as Promise<void> | null,
}));

vi.mock("@/server/google/calendar.server", () => ({
  listCalendarEvents: async () => google.events,
  insertCalendarEvent: async (_userId: string, event: Record<string, unknown>) => {
    if (google.insertError) throw new Error(google.insertError);
    const created = { id: `g-${google.inserted.length + 1}`, ...event };
    google.inserted.push(created);
    google.events.push(created as (typeof google.events)[number]);
    return created;
  },
}));

vi.mock("@/server/google/gmail.server", () => ({
  createDraft: async (_userId: string, draft: Record<string, unknown>) => {
    if (google.draftGate) await google.draftGate;
    if (google.draftError) throw new Error(google.draftError);
    google.drafts.push(draft);
    return { draftId: `gd-${google.drafts.length}` };
  },
  createDraftReply: async () => ({ draftId: "gd-reply", to: "x@example.com", subject: "Re: x" }),
}));

import {
  createCalendarBlock,
  DRAFT_IN_PROGRESS_MESSAGE,
  GMAIL_DRAFT_CLAIM_MS,
  GOOGLE_NOT_CONNECTED_MESSAGE,
  isGoogleConnected,
  NO_RECIPIENT,
  NOT_RECORDED_NOTE,
  runApprovedPlannerAction,
  saveNewDraft,
  userFacingMessage,
  type PlannerActionOutcome,
  type PlannerActionToRun,
  type UserClient,
} from "@/server/workspace.server";

const USER = "11111111-2222-3333-4444-555555555555";
const ZRH = "Europe/Zurich";
// Tuesday 24 Nov 2026, 10:00 in Zurich.
const NOW = Date.parse("2026-11-24T09:00:00Z");

/** The database's unique keys on the two tables (a row's key, or null when the key does not apply). */
const UNIQUE_KEY: Record<string, (row: Row) => string | null> = {
  calendar_events: (row) => (row.seed_key ? `${row.user_id}|${row.seed_key}` : null),
  email_drafts: (row) =>
    String(row.message_id ?? "").startsWith("planner-action-") ? `${row.user_id}|${row.message_id}` : null,
};

const CONNECTION_FAILURE = { code: "08006", message: "connection failure", details: "at Socket (node:net:1)", hint: null };

/** A small stand-in for the user's Supabase client: the calls the helpers make, on in-memory rows. */
function fakeUserClient(opts: { failInsertInto?: string; failUpdateOf?: string } = {}) {
  const tables: Record<string, Row[]> = { calendar_events: [], email_drafts: [] };
  let nextId = 1;
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let insertRow: Row | null = null;
    let patch: Row | null = null;
    let removing = false;
    let order: { key: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const run = async (single: boolean) => {
      if (insertRow) {
        if (opts.failInsertInto === table) {
          return { data: null, error: CONNECTION_FAILURE };
        }
        const key = UNIQUE_KEY[table]?.(insertRow) ?? null;
        if (key && (tables[table] ?? []).some((row) => UNIQUE_KEY[table](row) === key)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint", details: null, hint: null } };
        }
        const row = { id: `row-${nextId++}`, created_at: new Date(NOW + nextId).toISOString(), ...insertRow };
        (tables[table] ??= []).push(row);
        return { data: row, error: null };
      }
      const matching = (tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      if (removing) {
        tables[table] = (tables[table] ?? []).filter((row) => !matching.includes(row));
        return { data: null, error: null };
      }
      if (patch) {
        if (opts.failUpdateOf === table) return { data: null, error: CONNECTION_FAILURE };
        matching.forEach((row) => Object.assign(row, patch));
        return { data: null, error: null };
      }
      let rows = matching;
      if (order) {
        const { key, ascending } = order;
        rows = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
      }
      if (limit !== null) rows = rows.slice(0, limit);
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    };
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return builder;
      },
      lt: (key: string, value: string) => {
        filters.push((row) => Date.parse(String(row[key])) < Date.parse(value));
        return builder;
      },
      gt: (key: string, value: string) => {
        filters.push((row) => Date.parse(String(row[key])) > Date.parse(value));
        return builder;
      },
      order: (key: string, o?: { ascending?: boolean }) => {
        order = { key, ascending: o?.ascending ?? true };
        return builder;
      },
      limit: (n: number) => {
        limit = n;
        return builder;
      },
      insert: (row: Row) => {
        insertRow = row;
        return builder;
      },
      update: (value: Row) => {
        patch = value;
        return builder;
      },
      delete: () => {
        removing = true;
        return builder;
      },
      single: () => run(true),
      maybeSingle: () => run(true),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run(false).then(resolve, reject),
    };
    return builder;
  }
  return { tables, client: { from } as unknown as UserClient };
}

function action(overrides: Partial<PlannerActionToRun>): PlannerActionToRun {
  return {
    id: 7,
    action_type: "calendar_block",
    title: "Deep work",
    description: null,
    start_time: "2026-11-25T14:00:00",
    end_time: "2026-11-25T16:00:00",
    email_to: null,
    email_subject: null,
    email_body: null,
    ...overrides,
  };
}

function recorder(failTimes = 0) {
  const outcomes: PlannerActionOutcome[] = [];
  let failures = failTimes;
  const record = vi.fn(async (outcome: PlannerActionOutcome) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("The planner service did not answer within 10 s.");
    }
    outcomes.push(outcome);
    return { status: "executed" };
  });
  return { record, outcomes };
}

beforeEach(() => {
  admin.googleRow = null;
  admin.error = null;
  admin.tables = null;
  google.events = [];
  google.inserted = [];
  google.drafts = [];
  google.insertError = null;
  google.draftError = null;
  google.draftGate = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a run whose outcome could not be recorded (69, 89, 75)", () => {
  it("reports success with a note, and running it again reuses the calendar block", async () => {
    const db = fakeUserClient();
    const first = recorder(1);
    const base = { supabase: db.client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW };
    const r1 = await runApprovedPlannerAction({ ...base, record: first.record });
    expect(r1).toEqual({ ok: true, message: `Added to your demo calendar. ${NOT_RECORDED_NOTE}` });
    expect(db.tables.calendar_events).toHaveLength(1);

    const second = recorder();
    const r2 = await runApprovedPlannerAction({ ...base, record: second.record });
    expect(r2.ok).toBe(true);
    expect(r2.message).not.toMatch(/overlaps/);
    expect(r2.message).toBe("Already in your demo calendar.");
    expect(db.tables.calendar_events).toHaveLength(1);
    expect(second.outcomes[0]).toMatchObject({ provider: "demo_calendar", external_id: db.tables.calendar_events[0].id });
  });

  it("running an email action again does not save a second draft", async () => {
    const db = fakeUserClient();
    const email = action({ id: 9, action_type: "email_draft", title: "Reschedule", email_subject: "Can we move?", email_body: "Hi" });
    const base = { supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW };
    const r1 = await runApprovedPlannerAction({ ...base, record: recorder(1).record });
    expect(r1.ok).toBe(true);
    expect(r1.message).toContain(NOT_RECORDED_NOTE);
    const second = recorder();
    const r2 = await runApprovedPlannerAction({ ...base, record: second.record });
    expect(r2.message).toBe("Already saved as a demo draft (not sent).");
    expect(db.tables.email_drafts.filter((row) => row.message_id === "planner-action-9")).toHaveLength(1);
    expect(second.outcomes[0]).toMatchObject({ provider: "demo_draft", external_id: db.tables.email_drafts[0].id });
  });

  it("a Google calendar block written once is found again by its tag", async () => {
    admin.googleRow = { user_id: USER };
    const db = fakeUserClient();
    const base = { supabase: db.client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW };
    await runApprovedPlannerAction({ ...base, record: recorder(1).record });
    const r2 = await runApprovedPlannerAction({ ...base, record: recorder().record });
    expect(r2.message).toBe("Already in Google Calendar.");
    expect(google.inserted).toHaveLength(1);
  });

  it("a real overlap with another event is still refused", async () => {
    const db = fakeUserClient();
    db.tables.calendar_events.push({
      id: "lecture",
      user_id: USER,
      title: "Lecture — Distributed Systems",
      starts_at: "2026-11-25T13:00:00.000Z",
      ends_at: "2026-11-25T15:00:00.000Z",
    });
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^This time overlaps "Lecture — Distributed Systems"/);
    expect(rec.record).not.toHaveBeenCalled();
  });
});

describe("reminders and tasks (82)", () => {
  it("a reminder becomes a 15-minute calendar entry titled 'Reminder: …'", async () => {
    const db = fakeUserClient();
    const rec = recorder();
    const reminder = action({ action_type: "reminder", title: "Call the bank", start_time: "2026-11-25T09:00:00", end_time: null });
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: reminder, timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r).toEqual({ ok: true, message: "Added to your demo calendar as a 15-minute reminder." });
    expect(db.tables.calendar_events[0]).toMatchObject({
      title: "Reminder: Call the bank",
      starts_at: "2026-11-25T08:00:00.000Z",
      ends_at: "2026-11-25T08:15:00.000Z",
      source: "planner",
    });
    expect(rec.outcomes[0].provider).toBe("demo_calendar");
    expect(rec.outcomes[0].external_id).toBeTruthy();
    expect(rec.outcomes[0].result).toMatchObject({ reminder: true });
  });

  it("does not double the word Reminder, and refuses a reminder without a time or in the past", async () => {
    const db = fakeUserClient();
    const named = action({ action_type: "reminder", title: "Reminder to pay rent", start_time: "2026-11-26T08:00:00", end_time: null });
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: named, timeZone: ZRH, nowMs: NOW, record: recorder().record });
    expect(db.tables.calendar_events[0].title).toBe("Reminder to pay rent");

    const rec = recorder();
    const noTime = action({ action_type: "reminder", start_time: null, end_time: null });
    expect(await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: noTime, timeZone: ZRH, nowMs: NOW, record: rec.record })).toEqual({
      ok: false,
      message: "This reminder has no time. Reject it, or plan it again with a time.",
    });
    const past = action({ action_type: "reminder", start_time: "2026-11-23T09:00:00", end_time: null });
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: past, timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r.ok).toBe(false);
    expect(rec.record).not.toHaveBeenCalled();
  });

  it("a task is noted honestly, not 'Marked as done.'", async () => {
    const db = fakeUserClient();
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: action({ action_type: "task", start_time: null, end_time: null }), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r.ok).toBe(true);
    expect(r.message).not.toBe("Marked as done.");
    expect(r.message).toMatch(/Nothing was scheduled/);
    expect(rec.outcomes[0]).toMatchObject({ provider: "monday", external_id: null });
  });
});

describe("the recipient of a planner draft (44)", () => {
  it("uses the recipient the user typed", async () => {
    const db = fakeUserClient();
    const email = action({ id: 11, action_type: "email_draft", title: "Reschedule", email_to: null });
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW, to: "sam@uni.example", record: recorder().record });
    expect(r.ok).toBe(true);
    expect(db.tables.email_drafts[0]).toMatchObject({ to_address: "sam@uni.example", message_id: "planner-action-11", provider: "demo" });
  });

  it("falls back to the planner's address, then to the placeholder, and keeps a header to one line", async () => {
    const db = fakeUserClient();
    const withPlanner = action({ id: 12, action_type: "email_draft", email_to: "prof@uni.example" });
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: withPlanner, timeZone: ZRH, nowMs: NOW, record: recorder().record });
    const none = action({ id: 13, action_type: "email_draft", email_to: null });
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: none, timeZone: ZRH, nowMs: NOW, record: recorder().record });
    const injected = action({ id: 14, action_type: "email_draft", email_to: null });
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: injected, timeZone: ZRH, nowMs: NOW, to: "a@b.example\r\nBcc: x@y.example", record: recorder().record });
    const to = db.tables.email_drafts.map((row) => row.to_address);
    expect(to).toEqual(["prof@uni.example", NO_RECIPIENT, "a@b.example Bcc: x@y.example"]);
  });

  it("a cleared To field means no recipient, not the planner's address", async () => {
    const db = fakeUserClient();
    const email = action({ id: 16, action_type: "email_draft", email_to: "prof@uni.example" });
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW, to: "", record: recorder().record });
    // Left untouched (no `to` sent), the planner's address is still used.
    const untouched = action({ id: 17, action_type: "email_draft", email_to: "prof@uni.example" });
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: untouched, timeZone: ZRH, nowMs: NOW, record: recorder().record });
    // A pasted tab is one more space, like a line break.
    const tabbed = action({ id: 18, action_type: "email_draft", email_to: null });
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: tabbed, timeZone: ZRH, nowMs: NOW, to: "sam@uni.example\t", record: recorder().record });
    expect(db.tables.email_drafts.map((row) => row.to_address)).toEqual([NO_RECIPIENT, "prof@uni.example", "sam@uni.example"]);
  });

  it("passes the typed recipient to Gmail when Google is connected", async () => {
    admin.googleRow = { user_id: USER };
    const db = fakeUserClient();
    const email = action({ id: 15, action_type: "email_draft", title: "Reschedule", email_subject: "Move our meeting?" });
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW, to: "sam@uni.example", record: recorder().record });
    expect(r.message).toBe("Saved as a Gmail draft (not sent).");
    expect(google.drafts[0]).toMatchObject({ to: "sam@uni.example", subject: "Move our meeting?" });
  });
});

describe("errors that reach the page (50)", () => {
  it("a failed draft insert shows a sentence, not the database error", async () => {
    const db = fakeUserClient({ failInsertInto: "email_drafts" });
    const email = action({ action_type: "email_draft" });
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW, record: recorder().record });
    expect(r).toEqual({ ok: false, message: "Could not save the draft. Please try again in a moment." });
  });

  it("isGoogleConnected throws an Error with a sentence instead of the PostgREST object", async () => {
    admin.error = { code: "PGRST301", message: "JWT expired", details: null, hint: null };
    const error = await isGoogleConnected(USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Could not check your Google connection. Please try again in a moment.");
  });

  it("userFacingMessage keeps app sentences and hides internal errors", () => {
    expect(userFacingMessage(new Error("This time overlaps \"Gym\" (6:00 PM–7:00 PM). Pick a free slot instead."), "x", "t")).toMatch(/^This time overlaps/);
    expect(userFacingMessage(new TypeError("Cannot read properties of undefined (reading 'id')"), "Try again.", "t")).toBe("Try again.");
    expect(userFacingMessage({ code: "22P02", message: "invalid input syntax for type uuid" }, "Try again.", "t")).toBe("Try again.");
    expect(userFacingMessage(new Response("Chat session not found", { status: 404 }), "Try again.", "t")).toBe("Try again.");
  });

  it("on the hosted sites, raw Google errors and internal codes become plain sentences (69)", () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    const raw = [
      'Calendar insert failed: 403 {"error":{"code":403,"message":"Insufficient Permission"}}',
      "Draft create failed: 400 Invalid To header",
      "Gmail list failed: 401 Request had invalid authentication credentials.",
      "Token refresh failed (400)",
      "GOOGLE_CLIENT_ID is not configured",
    ];
    for (const message of raw) expect(userFacingMessage(new Error(message), "Try again.", "t")).toBe("Try again.");
    expect(userFacingMessage(new Error("GOOGLE_NOT_CONNECTED"), "Try again.", "t")).toBe(GOOGLE_NOT_CONNECTED_MESSAGE);
    // The Google clients' visitor sentences and the app's own sentences still pass.
    expect(userFacingMessage(new Error("Google Calendar could not add the event right now (HTTP 503). Please try again in a moment."), "x", "t")).toMatch(/^Google Calendar could not/);
    expect(userFacingMessage(new Error('This time overlaps "API_KEY review" (6:00 PM–7:00 PM).'), "x", "t")).toMatch(/^This time overlaps/);
  });

  it("a local run keeps Google's detail for the developer", () => {
    vi.stubEnv("LIFEOPS_HOSTED", "");
    const message = "Calendar insert failed: 403 Insufficient Permission";
    expect(userFacingMessage(new Error(message), "Try again.", "t")).toBe(message);
  });

  it("a Google Calendar failure while running an action shows no raw answer (69)", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    admin.googleRow = { user_id: USER };
    google.insertError = 'Calendar insert failed: 403 {"error":{"message":"Insufficient Permission"}}';
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: fakeUserClient().client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r).toEqual({ ok: false, message: "Could not carry out this action. Please try again." });
    expect(rec.record).not.toHaveBeenCalled();
  });

  it("no Gmail draft is created when its row cannot be saved, so a second Run cannot make a second one (69)", async () => {
    admin.googleRow = { user_id: USER };
    const email = action({ id: 19, action_type: "email_draft", title: "Reschedule", email_subject: "Move our meeting?" });
    // The row cannot be saved and the planner cannot be told: the round-1 code created the Gmail
    // draft first, so every such Run left one more Gmail draft behind.
    const broken = fakeUserClient({ failInsertInto: "email_drafts" });
    const first = recorder(1);
    const r1 = await runApprovedPlannerAction({ supabase: broken.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW, record: first.record });
    expect(r1).toEqual({ ok: false, message: "Could not save the draft. Please try again in a moment." });
    expect(google.drafts).toHaveLength(0);
    expect(first.record).not.toHaveBeenCalled();

    const db = fakeUserClient();
    admin.tables = db.client;
    const second = recorder();
    const r2 = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW, record: second.record });
    expect(r2).toEqual({ ok: true, message: "Saved as a Gmail draft (not sent)." });
    expect(google.drafts).toHaveLength(1);
    expect(db.tables.email_drafts).toEqual([
      expect.objectContaining({ message_id: "planner-action-19", provider: "gmail", external_draft_id: "gd-1" }),
    ]);
    expect(second.outcomes[0]).toMatchObject({ provider: "gmail_draft", external_id: "gd-1" });
  });

  it("a Gmail draft whose id and planner record could not be written is reused by the next Run (69)", async () => {
    admin.googleRow = { user_id: USER };
    const db = fakeUserClient({ failUpdateOf: "email_drafts" });
    admin.tables = db.client;
    const email = action({ id: 20, action_type: "email_draft", title: "Reschedule", email_subject: "Move our meeting?" });
    const base = { supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW };
    const r1 = await runApprovedPlannerAction({ ...base, record: recorder(1).record });
    expect(r1).toEqual({ ok: true, message: `Saved as a Gmail draft (not sent). ${NOT_RECORDED_NOTE}` });
    // Right after, a row without Gmail's id looks like a run still under way (75, round 2 review).
    const soon = recorder();
    const r2 = await runApprovedPlannerAction({ ...base, record: soon.record });
    expect(r2).toEqual({ ok: false, message: DRAFT_IN_PROGRESS_MESSAGE });
    expect(soon.record).not.toHaveBeenCalled();
    const later = recorder();
    const r3 = await runApprovedPlannerAction({ ...base, nowMs: NOW + GMAIL_DRAFT_CLAIM_MS + 1000, record: later.record });
    expect(r3).toEqual({ ok: true, message: "Already saved as a Gmail draft (not sent)." });
    expect(google.drafts).toHaveLength(1);
    expect(db.tables.email_drafts).toHaveLength(1);
  });

  it("a Gmail draft that could not be created frees its reference, so Run can be tried again (69)", async () => {
    admin.googleRow = { user_id: USER };
    const db = fakeUserClient();
    admin.tables = db.client;
    const email = action({ id: 21, action_type: "email_draft", title: "Reschedule", email_subject: "Move our meeting?" });
    const base = { supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW };
    google.draftError = "Gmail could not save the draft right now (HTTP 503). Please try again in a moment.";
    const rec = recorder();
    const r1 = await runApprovedPlannerAction({ ...base, record: rec.record });
    expect(r1).toEqual({ ok: false, message: google.draftError });
    expect(db.tables.email_drafts).toHaveLength(0);
    expect(rec.record).not.toHaveBeenCalled();
    google.draftError = null;
    const r2 = await runApprovedPlannerAction({ ...base, record: rec.record });
    expect(r2).toEqual({ ok: true, message: "Saved as a Gmail draft (not sent)." });
    expect(google.drafts).toHaveLength(1);
  });
});

describe("only the planner's own block is reused (69)", () => {
  it("an event the user made with the same title and time is an overlap, not the planner's block", async () => {
    const db = fakeUserClient();
    db.tables.calendar_events.push({
      id: "mine",
      user_id: USER,
      title: "Deep work",
      starts_at: "2026-11-25T13:00:00.000Z",
      ends_at: "2026-11-25T15:00:00.000Z",
      source: "chat",
      seed_key: null,
    });
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^This time overlaps "Deep work"/);
    // The round-1 code reused it and recorded its id as the planner action's block.
    expect(rec.record).not.toHaveBeenCalled();
    expect(db.tables.calendar_events).toHaveLength(1);
  });

  it("the same holds for a Google event without the planner's tag", async () => {
    admin.googleRow = { user_id: USER };
    google.events.push({ id: "g-mine", title: "Deep work", starts_at: "2026-11-25T13:00:00.000Z", ends_at: "2026-11-25T15:00:00.000Z" });
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: fakeUserClient().client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^This time overlaps "Deep work"/);
    expect(rec.record).not.toHaveBeenCalled();
    expect(google.inserted).toHaveLength(0);
  });

  it("tags the block: seed_key in the demo calendar, a line in the Google description", async () => {
    const db = fakeUserClient();
    const withNotes = action({ description: "Chapter 3 and 4" });
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: withNotes, timeZone: ZRH, nowMs: NOW, record: recorder().record });
    expect(db.tables.calendar_events[0]).toMatchObject({ seed_key: "planner-action-7", notes: "Chapter 3 and 4", source: "planner" });

    admin.googleRow = { user_id: USER };
    await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: withNotes, timeZone: ZRH, nowMs: NOW, record: recorder().record });
    expect(google.inserted[0].notes).toBe("Chapter 3 and 4\n\nAdded by MONDAY's planner (planner-action-7).");
  });
});

describe("two Runs of the same action at the same moment (75)", () => {
  it("write one demo calendar block; the second reuses it", async () => {
    const db = fakeUserClient();
    const base = { supabase: db.client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW };
    const a = recorder();
    const b = recorder();
    const [ra, rb] = await Promise.all([
      runApprovedPlannerAction({ ...base, record: a.record }),
      runApprovedPlannerAction({ ...base, record: b.record }),
    ]);
    expect(db.tables.calendar_events).toHaveLength(1);
    expect([ra.message, rb.message].sort()).toEqual(["Added to your demo calendar.", "Already in your demo calendar."]);
    const id = db.tables.calendar_events[0].id;
    expect([...a.outcomes, ...b.outcomes].map((outcome) => outcome.external_id)).toEqual([id, id]);
  });

  it("a second Run whose conflict check sees the first one's new block reuses it instead of reporting an overlap", async () => {
    const db = fakeUserClient();
    const realFrom = (db.client as unknown as { from: (table: string) => Record<string, unknown> }).from;
    let raced = false;
    // The first run's insert lands right after this run looked for the tagged block.
    const client = {
      from: (table: string) => {
        const builder = realFrom(table);
        if (table === "calendar_events" && !raced) {
          const lookup = builder.maybeSingle as () => Promise<unknown>;
          builder.maybeSingle = async () => {
            const result = await lookup();
            raced = true;
            db.tables.calendar_events.push({
              id: "first-run",
              user_id: USER,
              title: "Deep work",
              starts_at: "2026-11-25T13:00:00.000Z",
              ends_at: "2026-11-25T15:00:00.000Z",
              source: "planner",
              seed_key: "planner-action-7",
            });
            return result;
          };
        }
        return builder;
      },
    } as unknown as UserClient;
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r).toEqual({ ok: true, message: "Already in your demo calendar." });
    expect(db.tables.calendar_events).toHaveLength(1);
    expect(rec.outcomes[0]).toMatchObject({ provider: "demo_calendar", external_id: "first-run" });
  });

  it("save one demo draft; the second reuses it instead of failing", async () => {
    const db = fakeUserClient();
    const email = action({ id: 22, action_type: "email_draft", title: "Reschedule", email_subject: "Can we move?", email_body: "Hi" });
    const base = { supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW };
    const [ra, rb] = await Promise.all([
      runApprovedPlannerAction({ ...base, record: recorder().record }),
      runApprovedPlannerAction({ ...base, record: recorder().record }),
    ]);
    expect([ra.ok, rb.ok]).toEqual([true, true]);
    expect([ra.message, rb.message].sort()).toEqual(["Already saved as a demo draft (not sent).", "Saved as a demo draft (not sent)."]);
    expect(db.tables.email_drafts).toHaveLength(1);
  });

  it("create one Gmail draft; a Run during the first one's Gmail call is told so and records nothing", async () => {
    admin.googleRow = { user_id: USER };
    const db = fakeUserClient();
    admin.tables = db.client;
    const email = action({ id: 23, action_type: "email_draft", title: "Reschedule", email_subject: "Can we move?", email_body: "Hi" });
    const base = { supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW };
    let gmailAnswers = () => {};
    google.draftGate = new Promise<void>((resolve) => {
      gmailAnswers = resolve;
    });
    const a = recorder();
    const b = recorder();
    const first = runApprovedPlannerAction({ ...base, record: a.record });
    const second = runApprovedPlannerAction({ ...base, record: b.record });
    // The second run finds the first one's row (or loses the insert to it) while Gmail is still
    // answering the first. It used to report "Already saved as a Gmail draft" with the row's id
    // as the Gmail draft's, also when the Gmail call then failed.
    const rb = await second;
    expect(rb).toEqual({ ok: false, message: DRAFT_IN_PROGRESS_MESSAGE });
    expect(b.record).not.toHaveBeenCalled();
    gmailAnswers();
    const ra = await first;
    expect(ra).toEqual({ ok: true, message: "Saved as a Gmail draft (not sent)." });
    expect(google.drafts).toHaveLength(1);
    expect(db.tables.email_drafts).toHaveLength(1);
    expect(a.outcomes[0]).toMatchObject({ provider: "gmail_draft", external_id: "gd-1" });

    // Once Gmail's id is on the row, a later Run reuses the draft with that id.
    const c = recorder();
    const rc = await runApprovedPlannerAction({ ...base, record: c.record });
    expect(rc).toEqual({ ok: true, message: "Already saved as a Gmail draft (not sent)." });
    expect(c.outcomes[0]).toMatchObject({ provider: "gmail_draft", external_id: "gd-1" });
  });

  it("a Run during a Gmail call that then fails records nothing, and the next Run saves the draft", async () => {
    admin.googleRow = { user_id: USER };
    const db = fakeUserClient();
    admin.tables = db.client;
    const email = action({ id: 24, action_type: "email_draft", title: "Reschedule", email_subject: "Can we move?", email_body: "Hi" });
    const base = { supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW };
    let gmailAnswers = () => {};
    google.draftGate = new Promise<void>((resolve) => {
      gmailAnswers = resolve;
    });
    google.draftError = "Gmail could not save the draft right now (HTTP 503). Please try again in a moment.";
    const a = recorder();
    const b = recorder();
    const first = runApprovedPlannerAction({ ...base, record: a.record });
    const rb = await runApprovedPlannerAction({ ...base, record: b.record });
    expect(rb).toEqual({ ok: false, message: DRAFT_IN_PROGRESS_MESSAGE });
    gmailAnswers();
    expect(await first).toEqual({ ok: false, message: google.draftError });
    // Neither run told the planner about a Gmail draft that does not exist.
    expect(a.record).not.toHaveBeenCalled();
    expect(b.record).not.toHaveBeenCalled();
    expect(db.tables.email_drafts).toHaveLength(0);

    google.draftGate = null;
    google.draftError = null;
    const c = recorder();
    expect(await runApprovedPlannerAction({ ...base, record: c.record })).toEqual({ ok: true, message: "Saved as a Gmail draft (not sent)." });
    expect(c.outcomes[0]).toMatchObject({ provider: "gmail_draft", external_id: "gd-1" });
  });
});

describe("a reference left by an earlier planner database (69, round 2 review)", () => {
  // Planner action ids are the planner database's own row ids; after a reset (a deleted
  // lifeops.db, a hosted planner without DATABASE_URL) a new action 7 has the reference of an
  // old action 7 whose block or draft is still in Supabase.
  const oldBlock = {
    id: "old-block",
    user_id: USER,
    title: "Gym (old plan)",
    starts_at: "2026-11-10T06:00:00.000Z",
    ends_at: "2026-11-10T07:00:00.000Z",
    source: "planner",
    seed_key: "planner-action-7",
  };

  it("a demo block tagged by the old action at another time is kept, and the new action gets its own block", async () => {
    const db = fakeUserClient();
    db.tables.calendar_events.push({ ...oldBlock });
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r).toEqual({ ok: true, message: "Added to your demo calendar." });
    expect(db.tables.calendar_events).toHaveLength(2);
    const [kept, added] = db.tables.calendar_events;
    // The old block stays in the calendar as an ordinary event, without the tag.
    expect(kept).toMatchObject({ id: "old-block", title: "Gym (old plan)", seed_key: null });
    expect(added).toMatchObject({ title: "Deep work", starts_at: "2026-11-25T13:00:00.000Z", seed_key: "planner-action-7" });
    expect(rec.outcomes[0]).toMatchObject({ provider: "demo_calendar", external_id: added.id });

    // A second Run of the new action reuses the new block.
    const again = recorder();
    const r2 = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: again.record });
    expect(r2).toEqual({ ok: true, message: "Already in your demo calendar." });
    expect(db.tables.calendar_events).toHaveLength(2);
    expect(again.outcomes[0]).toMatchObject({ external_id: added.id });
  });

  it("a demo block tagged by the old action in the same slot is an overlap, not the new action's block", async () => {
    const db = fakeUserClient();
    db.tables.calendar_events.push({ ...oldBlock, starts_at: "2026-11-25T13:00:00.000Z", ends_at: "2026-11-25T15:00:00.000Z" });
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^This time overlaps "Gym \(old plan\)"/);
    expect(rec.record).not.toHaveBeenCalled();
    expect(db.tables.calendar_events).toHaveLength(1);
  });

  it("a Google event tagged by the old action at an overlapping time is an overlap, not the new action's block", async () => {
    admin.googleRow = { user_id: USER };
    google.events.push({
      id: "g-old",
      title: "Gym (old plan)",
      starts_at: "2026-11-25T12:30:00.000Z",
      ends_at: "2026-11-25T13:30:00.000Z",
      notes: "Added by MONDAY's planner (planner-action-7).",
    } as (typeof google.events)[number]);
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: fakeUserClient().client, userId: USER, action: action({}), timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^This time overlaps "Gym \(old plan\)"/);
    expect(rec.record).not.toHaveBeenCalled();
    expect(google.inserted).toHaveLength(0);
  });

  it("a draft saved by the old action is kept under a renamed reference, and the new action's draft is saved", async () => {
    const db = fakeUserClient();
    admin.tables = db.client;
    db.tables.email_drafts.push({
      id: "old-draft",
      user_id: USER,
      message_id: "planner-action-7",
      to_address: "coach@gym.example",
      subject: "Cancel Tuesday",
      body: "Old plan",
      provider: "demo",
      external_draft_id: null,
      created_at: "2026-11-10T06:00:00.000Z",
    });
    const email = action({ action_type: "email_draft", title: "Reschedule", email_subject: "Can we move?", email_body: "Hi" });
    const rec = recorder();
    const r = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW, record: rec.record });
    expect(r).toEqual({ ok: true, message: "Saved as a demo draft (not sent)." });
    expect(db.tables.email_drafts).toHaveLength(2);
    const [kept, saved] = db.tables.email_drafts;
    expect(kept).toMatchObject({ id: "old-draft", subject: "Cancel Tuesday", message_id: "planner-action-7 (earlier action old-draft)" });
    expect(saved).toMatchObject({ message_id: "planner-action-7", subject: "Can we move?", body: "Hi" });
    expect(rec.outcomes[0]).toMatchObject({ provider: "demo_draft", external_id: saved.id });

    const again = recorder();
    const r2 = await runApprovedPlannerAction({ supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW, record: again.record });
    expect(r2).toEqual({ ok: true, message: "Already saved as a demo draft (not sent)." });
    expect(db.tables.email_drafts).toHaveLength(2);
  });

  it("a draft saved by the same action is still reused when the user typed another recipient", async () => {
    const db = fakeUserClient();
    const email = action({ id: 25, action_type: "email_draft", title: "Reschedule", email_subject: "Can we move?", email_body: "Hi" });
    const base = { supabase: db.client, userId: USER, action: email, timeZone: ZRH, nowMs: NOW };
    await runApprovedPlannerAction({ ...base, to: "a@x.example", record: recorder(1).record });
    const r2 = await runApprovedPlannerAction({ ...base, to: "b@x.example", record: recorder().record });
    expect(r2).toEqual({ ok: true, message: "Already saved as a demo draft (not sent)." });
    expect(db.tables.email_drafts).toHaveLength(1);
  });
});

describe("existing callers keep their behaviour", () => {
  it("createCalendarBlock without a reference still refuses an identical event as an overlap", async () => {
    const db = fakeUserClient();
    const event = { title: "Gym", starts_at: "2026-11-25T17:00:00.000Z", ends_at: "2026-11-25T18:00:00.000Z" };
    await createCalendarBlock({ supabase: db.client, userId: USER, event, source: "chat", timeZone: ZRH });
    await expect(createCalendarBlock({ supabase: db.client, userId: USER, event, source: "chat", timeZone: ZRH })).rejects.toThrow(/overlaps/);
  });

  it("saveNewDraft saves a new draft for a new reference", async () => {
    const db = fakeUserClient();
    const a = await saveNewDraft({ supabase: db.client, userId: USER, reference: "planner-action-1", to: "a@x.example", subject: "A", body: "a" });
    const b = await saveNewDraft({ supabase: db.client, userId: USER, reference: "planner-action-2", to: "b@x.example", subject: "B", body: "b" });
    expect(a.reused).toBeUndefined();
    expect(b.draftId).not.toBe(a.draftId);
    expect(db.tables.email_drafts).toHaveLength(2);
  });
});
