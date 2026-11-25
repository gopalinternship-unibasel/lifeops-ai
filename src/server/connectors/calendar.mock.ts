/**
 * Mock calendar connector. Reads from / writes to the calendar_events table
 * through the user-scoped Supabase client, so row-level security still applies.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError, describeCause } from "@/server/public-error.server";
import {
  addDaysISO,
  localDateTime,
  mondayOfISODate,
  normalizeTimeZone,
  zonedDateTimeToISO,
} from "@/server/timezone.server";

export interface CalendarEventRow {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  source: string;
}

export interface CalendarEventInput {
  title: string;
  starts_at: string;
  ends_at: string;
  notes?: string | null;
  source?: string;
}

export interface CalendarEventPatch {
  title?: string;
  starts_at?: string;
  ends_at?: string;
  notes?: string | null;
}

export interface DemoSeedEvent {
  seed_key: "team-sync" | "lecture" | "dentist" | "acme-interview";
  title: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
}

/**
 * The demo calendar as it stands on `today` (the user's local date): a few fixed commitments
 * across the coming week so free-slot planning has something to work around. The demo inbox
 * (gmail.mock.ts) is built from the same dates: the team sync tonight at 7 PM from Alicia's
 * email, and the Acme interview on the Monday of next week.
 */
export function demoSeedEvents(today: string, requestedTimeZone?: string): DemoSeedEvent[] {
  const timeZone = normalizeTimeZone(requestedTimeZone);
  const at = (date: string, hour: number, minute = 0) => zonedDateTimeToISO(date, { hour, minute }, timeZone);
  const nextMonday = mondayOfISODate(addDaysISO(today, 7));
  return [
    {
      seed_key: "team-sync",
      title: "Team sync — demo walkthrough",
      starts_at: at(today, 19),
      ends_at: at(today, 20),
      notes: "Team meeting (from Alicia's email). You have a script ready.",
    },
    {
      seed_key: "lecture",
      title: "Lecture — Distributed Systems",
      starts_at: at(addDaysISO(today, 1), 10),
      ends_at: at(addDaysISO(today, 1), 12),
      notes: null,
    },
    {
      seed_key: "dentist",
      title: "Dentist appointment",
      starts_at: at(addDaysISO(today, 2), 14),
      ends_at: at(addDaysISO(today, 2), 15, 30),
      notes: null,
    },
    {
      seed_key: "acme-interview",
      title: "Acme onsite interview",
      starts_at: at(nextMonday, 10),
      ends_at: at(nextMonday, 12),
      notes: "20-minute system design presentation (from Acme Recruiting).",
    },
  ];
}

/**
 * The connector_status row that records that a user's demo calendar was seeded. Until the
 * review of 24 Nov 2026 the demo events were seeded whenever the calendar was empty, so a user
 * who cancelled every event got all four demo events back on the next page load.
 */
export const DEMO_CALENDAR_SEEDED = "demo_calendar_seeded";

/**
 * Seed the demo calendar once per user, and keep the demo events the user has not touched in
 * step with the demo inbox (see refreshPastDemoEvents). Runs on every mock-calendar read.
 */
export async function ensureSeedEvents(
  supabase: SupabaseClient,
  userId: string,
  requestedTimeZone?: string,
  nowMs: number = Date.now(),
) {
  const timeZone = normalizeTimeZone(requestedTimeZone);
  const today = localDateTime(nowMs, timeZone).date;
  const [marker, pastSeeds] = await Promise.all([
    supabase
      .from("connector_status")
      .select("id")
      .eq("user_id", userId)
      .eq("provider", DEMO_CALENDAR_SEEDED)
      .maybeSingle(),
    // Demo events that are over and that the user has never changed (updateEvent clears seed_key).
    supabase
      .from("calendar_events")
      .select("id,seed_key,starts_at,ends_at")
      .eq("user_id", userId)
      .not("seed_key", "is", null)
      .lte("ends_at", new Date(nowMs).toISOString()),
  ]);
  if (marker.error) throw dbError("load your demo calendar", marker.error);
  if (pastSeeds.error) throw dbError("load your demo calendar", pastSeeds.error);

  if (!marker.data) {
    // Users seeded before the marker existed already have events: they are only marked. A user
    // with an empty calendar and no marker has never been seeded.
    const { data: existing, error: selectError } = await supabase
      .from("calendar_events")
      .select("id")
      .eq("user_id", userId)
      .limit(1);
    if (selectError) throw dbError("load your demo calendar", selectError);
    if (!existing || existing.length === 0) {
      // Two pages can seed at the same moment; the (user_id, seed_key) constraint makes the
      // second insert a no-op instead of duplicating every demo event.
      const { error } = await supabase.from("calendar_events").upsert(
        demoSeedEvents(today, timeZone).map((event) => ({ ...event, user_id: userId, source: "calendar" })),
        { onConflict: "user_id,seed_key", ignoreDuplicates: true },
      );
      if (error) throw dbError("set up your demo calendar", error);
    }
    const { error: markError } = await supabase
      .from("connector_status")
      .upsert(
        { user_id: userId, provider: DEMO_CALENDAR_SEEDED },
        { onConflict: "user_id,provider", ignoreDuplicates: true },
      );
    // Without the marker the calendar still works; only a fully emptied calendar would be seeded
    // again, as before. Not worth failing the page for.
    if (markError) console.error("[lifeops] demo calendar: could not record the seeding:", describeCause(markError));
  }

  await refreshPastDemoEvents(supabase, userId, pastSeeds.data ?? [], demoSeedEvents(today, timeZone));
}

/**
 * The demo inbox is written relative to today ("Team sync moved to 7 PM today", "interview
 * Monday at 10am"), but the demo events were placed once, on the user's first visit. On a later
 * day the inbox and the calendar contradicted each other (review of 24 Nov 2026). So a demo event
 * that is over and that the user never changed moves forward to where today's demo calendar has
 * it. Events the user moved, renamed or cancelled are left alone.
 */
async function refreshPastDemoEvents(
  supabase: SupabaseClient,
  userId: string,
  pastSeeds: { id: string; seed_key: string | null; starts_at: string; ends_at: string }[],
  schedule: DemoSeedEvent[],
) {
  await Promise.all(
    pastSeeds.map(async (row) => {
      const slot = schedule.find((event) => event.seed_key === row.seed_key);
      // Only ever forward in time, so two time zones can never move an event back and forth.
      if (!slot || Date.parse(slot.starts_at) <= Date.parse(row.starts_at)) return;
      const { error } = await supabase
        .from("calendar_events")
        .update({ starts_at: slot.starts_at, ends_at: slot.ends_at })
        .eq("id", row.id)
        .eq("user_id", userId)
        // Not if the user changed it in the meantime.
        .eq("starts_at", row.starts_at)
        .not("seed_key", "is", null);
      if (error) console.error("[lifeops] demo calendar: could not move a past demo event forward:", describeCause(error));
    }),
  );
}

export async function listEventsForRange(
  supabase: SupabaseClient,
  userId: string,
  fromIso: string,
  toIso: string,
): Promise<CalendarEventRow[]> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("id,title,starts_at,ends_at,notes,source")
    .eq("user_id", userId)
    // Include events that overlap the requested range, even when they begin before it.
    .lt("starts_at", toIso)
    .gt("ends_at", fromIso)
    .order("starts_at", { ascending: true });
  if (error) throw dbError("load your calendar", error);
  return (data ?? []) as unknown as CalendarEventRow[];
}

export async function createEvent(
  supabase: SupabaseClient,
  userId: string,
  input: CalendarEventInput,
): Promise<CalendarEventRow> {
  const { data, error } = await supabase
    .from("calendar_events")
    .insert({
      user_id: userId,
      title: input.title,
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      notes: input.notes ?? null,
      source: input.source ?? "chat",
    })
    .select("id,title,starts_at,ends_at,notes,source")
    .single();
  if (error) throw dbError("add the event to your calendar", error);
  return data as unknown as CalendarEventRow;
}

export async function updateEvent(
  supabase: SupabaseClient,
  userId: string,
  eventId: string,
  patch: CalendarEventPatch,
): Promise<CalendarEventRow> {
  const { data: current, error: readError } = await supabase
    .from("calendar_events")
    .select("id,title,starts_at,ends_at,notes,source")
    .eq("id", eventId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw dbError("change the event", readError);
  if (!current) throw new Error("Calendar event not found");

  const startsAt = patch.starts_at ?? current.starts_at;
  const endsAt = patch.ends_at ?? current.ends_at;
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error("Calendar event must end after it starts");
  }

  const { data, error } = await supabase
    .from("calendar_events")
    .update({
      title: patch.title ?? current.title,
      starts_at: startsAt,
      ends_at: endsAt,
      notes: patch.notes === undefined ? current.notes : patch.notes,
      // A demo event the user changed is theirs now: ensureSeedEvents no longer moves it forward.
      seed_key: null,
    })
    .eq("id", eventId)
    .eq("user_id", userId)
    .select("id,title,starts_at,ends_at,notes,source")
    .single();
  if (error) throw dbError("change the event", error);
  return data as unknown as CalendarEventRow;
}

export async function deleteEvent(
  supabase: SupabaseClient,
  userId: string,
  eventId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("calendar_events")
    .delete()
    .eq("id", eventId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw dbError("cancel the event", error);
  // Deleting nothing is not a success: the event was already cancelled (or never existed).
  if (!data || data.length === 0) {
    throw new Error("This event is no longer in your calendar (already cancelled?).");
  }
}
