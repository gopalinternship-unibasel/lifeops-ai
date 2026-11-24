import { getValidAccessToken } from "./oauth.server";

const BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_API_TIMEOUT_MS = 20_000;

/** The same sentence the demo calendar uses for an event that is not there any more. */
export const EVENT_GONE = "This event is no longer in your calendar (already cancelled?).";

function googleApiSignal() {
  return AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS);
}

/**
 * fetch() for the Calendar API. Its errors reach users (toasts, card errors), so a network failure
 * or a timeout becomes a sentence and the details go to the server log.
 */
async function calendarFetch(url: string | URL, init: RequestInit, action: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: googleApiSignal() });
  } catch (error) {
    console.error(`[google] Calendar: could not ${action}:`, error);
    throw new Error(`Google Calendar could not be reached to ${action}. Please try again in a moment.`);
  }
}

/** A failed Calendar API answer as a sentence; Google's answer body goes to the server log only. */
async function calendarError(res: Response, action: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  console.error(`[google] Calendar: could not ${action}: HTTP ${res.status}: ${body.slice(0, 500)}`);
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `Google Calendar did not allow MONDAY to ${action}. Please connect Google again from your profile.`,
    );
  }
  return new Error(`Google Calendar could not ${action} right now (HTTP ${res.status}). Please try again in a moment.`);
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
  const res = await calendarFetch(u, { headers: { Authorization: `Bearer ${accessToken}` } }, "load your events");
  if (!res.ok) throw await calendarError(res, "load your events");
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
  const res = await calendarFetch(`${BASE}/calendars/primary/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: ev.title,
      description: ev.notes ?? undefined,
      start: { dateTime: ev.starts_at },
      end: { dateTime: ev.ends_at },
    }),
  }, "add the event");
  if (!res.ok) throw await calendarError(res, "add the event");
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
  const res = await calendarFetch(`${BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, "update the event");
  if (res.status === 404 || res.status === 410) throw new Error(EVENT_GONE);
  if (!res.ok) throw await calendarError(res, "update the event");
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
  const res = await calendarFetch(`${BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  }, "cancel the event");
  // 404/410: the event is gone already. Say so instead of reporting a cancellation that
  // did not happen (the demo calendar does the same).
  if (res.status === 404 || res.status === 410) {
    throw new Error(EVENT_GONE);
  }
  if (!res.ok) {
    throw await calendarError(res, "cancel the event");
  }
}

/**
 * One event as it is now, or null when it is gone (deleted, cancelled, or never there). Used to
 * check that a suggested change still describes the event before it is applied.
 */
export async function getCalendarEvent(userId: string, eventId: string): Promise<GCalEvent | null> {
  const { accessToken } = await getValidAccessToken(userId);
  const res = await calendarFetch(`${BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, "read the event");
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw await calendarError(res, "read the event");
  const event = (await res.json()) as GoogleCalendarEventApi & { status?: string };
  if (event.status === "cancelled") return null;
  return {
    id: event.id ?? eventId,
    title: event.summary ?? "(untitled)",
    starts_at: toIso(event.start),
    ends_at: toIso(event.end),
    notes: event.description ?? null,
    htmlLink: event.htmlLink,
    busy: isBusy(event),
  };
}
