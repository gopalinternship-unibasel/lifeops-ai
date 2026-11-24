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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const admin = vi.hoisted(() => ({ googleRow: null as Record<string, unknown> | null, error: null as Record<string, unknown> | null }));

vi.mock("@/integrations/supabase/client.server", () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: admin.googleRow, error: admin.error }),
  };
  return { supabaseAdmin: { from: () => query } };
});

const google = vi.hoisted(() => ({
  events: [] as Array<{ id: string; title: string; starts_at: string; ends_at: string; busy?: boolean }>,
  inserted: [] as Array<Record<string, unknown>>,
  drafts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/google/calendar.server", () => ({
  listCalendarEvents: async () => google.events,
  insertCalendarEvent: async (_userId: string, event: Record<string, unknown>) => {
    const created = { id: `g-${google.inserted.length + 1}`, ...event };
    google.inserted.push(created);
    google.events.push(created as (typeof google.events)[number]);
    return created;
  },
}));

vi.mock("@/server/google/gmail.server", () => ({
  createDraft: async (_userId: string, draft: Record<string, unknown>) => {
    google.drafts.push(draft);
    return { draftId: `gd-${google.drafts.length}` };
  },
  createDraftReply: async () => ({ draftId: "gd-reply", to: "x@example.com", subject: "Re: x" }),
}));

import {
  createCalendarBlock,
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

/** A small stand-in for the user's Supabase client: the calls the helpers make, on in-memory rows. */
function fakeUserClient(opts: { failInsertInto?: string } = {}) {
  const tables: Record<string, Row[]> = { calendar_events: [], email_drafts: [] };
  let nextId = 1;
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let insertRow: Row | null = null;
    let order: { key: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const run = async (single: boolean) => {
      if (insertRow) {
        if (opts.failInsertInto === table) {
          return { data: null, error: { code: "08006", message: "connection failure", details: "at Socket (node:net:1)", hint: null } };
        }
        const row = { id: `row-${nextId++}`, created_at: new Date(NOW + nextId).toISOString(), ...insertRow };
        (tables[table] ??= []).push(row);
        return { data: row, error: null };
      }
      let rows = (tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
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
  google.events = [];
  google.inserted = [];
  google.drafts = [];
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

  it("a Google calendar block written once is found again by title and time", async () => {
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
});

describe("existing callers keep their behaviour", () => {
  it("createCalendarBlock without reuseIdentical still refuses an identical event as an overlap", async () => {
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
