import { getValidAccessToken } from "./oauth.server";

const BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_API_TIMEOUT_MS = 20_000;

function googleApiSignal() {
  return AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS);
}

interface GoogleCalendarEventApi {
  id?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  transparency?: string;
}

type CalendarPatchBody = {
  summary?: string;
  description?: string;
  start?: { dateTime: string };
  end?: { dateTime: string };
};

export interface GCalEvent {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  notes?: string | null;
  htmlLink?: string;
  /** False for all-day and "show as free" events, which do not block time. */
  busy?: boolean;
}

function isBusy(event: GoogleCalendarEventApi): boolean {
  return !!event.start?.dateTime && event.transparency !== "transparent";
}

function toIso(date?: { dateTime?: string; date?: string }) {
  if (!date) return "";
  return date.dateTime ?? (date.date ? new Date(date.date).toISOString() : "");
}

export async function listCalendarEvents(userId: string, timeMin: string, timeMax: string): Promise<GCalEvent[]> {
  const { accessToken } = await getValidAccessToken(userId);
  const u = new URL(`${BASE}/calendars/primary/events`);
  u.searchParams.set("timeMin", timeMin);
  u.searchParams.set("timeMax", timeMax);
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", "50");
  const res = await fetch(u, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: googleApiSignal(),
  });
  if (!res.ok) throw new Error(`Calendar list failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: GoogleCalendarEventApi[] };
  return (data.items ?? []).map((event) => ({
    id: event.id ?? "",
    title: event.summary ?? "(untitled)",
    starts_at: toIso(event.start),
    ends_at: toIso(event.end),
    notes: event.description ?? null,
    htmlLink: event.htmlLink,
    busy: isBusy(event),
  }));
}

export async function insertCalendarEvent(userId: string, ev: { title: string; starts_at: string; ends_at: string; notes?: string | null }): Promise<GCalEvent> {
  const { accessToken } = await getValidAccessToken(userId);
  const res = await fetch(`${BASE}/calendars/primary/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: ev.title,
      description: ev.notes ?? undefined,
      start: { dateTime: ev.starts_at },
      end: { dateTime: ev.ends_at },
    }),
    signal: googleApiSignal(),
  });
  if (!res.ok) throw new Error(`Calendar insert failed: ${res.status} ${await res.text()}`);
  const event = (await res.json()) as GoogleCalendarEventApi;
  return {
    id: event.id ?? "",
    title: event.summary ?? ev.title,
    starts_at: toIso(event.start),
    ends_at: toIso(event.end),
    notes: event.description ?? null,
    htmlLink: event.htmlLink,
  };
}

export async function patchCalendarEvent(userId: string, eventId: string, patch: { title?: string; starts_at?: string; ends_at?: string; notes?: string | null }): Promise<GCalEvent> {
  const { accessToken } = await getValidAccessToken(userId);
  const body: CalendarPatchBody = {};
  if (patch.title !== undefined) body.summary = patch.title;
  if (patch.notes !== undefined) body.description = patch.notes ?? "";
  if (patch.starts_at) body.start = { dateTime: patch.starts_at };
  if (patch.ends_at) body.end = { dateTime: patch.ends_at };
  const res = await fetch(`${BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: googleApiSignal(),
  });
  if (!res.ok) throw new Error(`Calendar patch failed: ${res.status} ${await res.text()}`);
  const event = (await res.json()) as GoogleCalendarEventApi;
  return {
    id: event.id ?? "",
    title: event.summary ?? "(untitled)",
    starts_at: toIso(event.start),
    ends_at: toIso(event.end),
    notes: event.description ?? null,
    htmlLink: event.htmlLink,
  };
}

export async function deleteCalendarEvent(userId: string, eventId: string): Promise<void> {
  const { accessToken } = await getValidAccessToken(userId);
  const res = await fetch(`${BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: googleApiSignal(),
  });
  // 404/410: the event is gone already. Say so instead of reporting a cancellation that
  // did not happen (the demo calendar does the same).
  if (res.status === 404 || res.status === 410) {
    throw new Error("This event is no longer in your calendar (already cancelled?).");
  }
  if (!res.ok) {
    throw new Error(`Calendar delete failed: ${res.status} ${await res.text()}`);
  }
}
