/**
 * Mock calendar connector. Reads from / writes to the calendar_events table
 * through the user-scoped Supabase client, so row-level security still applies.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addDaysISO,
  mondayOfISODate,
  normalizeTimeZone,
  todayInTimeZone,
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

export async function ensureSeedEvents(
  supabase: SupabaseClient,
  userId: string,
  requestedTimeZone?: string,
) {
  const { data: existing, error: selectError } = await supabase
    .from("calendar_events")
    .select("id")
    .eq("user_id", userId)
    .limit(1);
  if (selectError) throw selectError;
  if (existing && existing.length > 0) return;

  const timeZone = normalizeTimeZone(requestedTimeZone);
  const today = todayInTimeZone(timeZone);
  const at = (date: string, hour: number, minute = 0) => zonedDateTimeToISO(date, { hour, minute }, timeZone);
  // A few fixed commitments across the coming week so free-slot planning has something to
  // work around. They match the demo inbox (team sync tonight, Acme interview on Monday).
  const nextMonday = mondayOfISODate(addDaysISO(today, 7));
  const seed = [
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

  // Two pages can seed at the same moment; the (user_id, seed_key) constraint makes the
  // second insert a no-op instead of duplicating every demo event.
  const { error } = await supabase.from("calendar_events").upsert(
    seed.map((event) => ({ ...event, user_id: userId, source: "calendar" })),
    { onConflict: "user_id,seed_key", ignoreDuplicates: true },
  );
  if (error) throw error;
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
  if (error) throw error;
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
  if (error) throw error;
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
  if (readError) throw readError;
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
    })
    .eq("id", eventId)
    .eq("user_id", userId)
    .select("id,title,starts_at,ends_at,notes,source")
    .single();
  if (error) throw error;
  return data as unknown as CalendarEventRow;
}

export async function deleteEvent(
  supabase: SupabaseClient,
  userId: string,
  eventId: string,
): Promise<void> {
  const { error } = await supabase
    .from("calendar_events")
    .delete()
    .eq("id", eventId)
    .eq("user_id", userId);
  if (error) throw error;
}
