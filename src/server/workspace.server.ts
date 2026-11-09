/**
 * Server-only helpers shared by the workspace, calendar, plan and dashboard server functions.
 * Everything here works the same with a connected Google account and with the demo data.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { createDraft, createDraftReply } from "@/server/google/gmail.server";
import { insertCalendarEvent, listCalendarEvents } from "@/server/google/calendar.server";
import { createEvent as createMockCalendarEvent, listEventsForRange } from "@/server/connectors/calendar.mock";
import { getMockEmail } from "@/server/connectors/gmail.mock";
import { describeConflicts, findConflicts, type TimedEvent } from "@/server/calendar/time-ranges.server";

export type UserClient = SupabaseClient<Database>;

export async function isGoogleConnected(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("google_oauth_tokens")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Busy events overlapping [startIso, endIso) in the user's real or demo calendar. */
export async function listBusyEvents(
  supabase: UserClient,
  userId: string,
  connected: boolean,
  startIso: string,
  endIso: string,
): Promise<TimedEvent[]> {
  if (connected) {
    const events = await listCalendarEvents(userId, startIso, endIso);
    return events.filter((event) => event.busy !== false);
  }
  return listEventsForRange(supabase, userId, startIso, endIso);
}

/** Reject a new or moved event that would double-book the user's calendar. */
export async function assertNoCalendarConflict(opts: {
  supabase: UserClient;
  userId: string;
  connected: boolean;
  startsAt: string;
  endsAt: string;
  ignoreEventId?: string;
  timeZone?: string;
}) {
  const existing = await listBusyEvents(opts.supabase, opts.userId, opts.connected, opts.startsAt, opts.endsAt);
  const conflicts = findConflicts({ starts_at: opts.startsAt, ends_at: opts.endsAt }, existing, {
    ignoreId: opts.ignoreEventId,
  });
  if (conflicts.length > 0) throw new Error(describeConflicts(conflicts, opts.timeZone));
}

/** Create an event in Google Calendar or the demo calendar after the conflict check. */
export async function createCalendarBlock(opts: {
  supabase: UserClient;
  userId: string;
  event: { title: string; starts_at: string; ends_at: string; notes?: string | null };
  source: string;
  timeZone?: string;
}): Promise<{ id: string; provider: "google_calendar" | "demo_calendar" }> {
  const connected = await isGoogleConnected(opts.userId);
  await assertNoCalendarConflict({
    supabase: opts.supabase,
    userId: opts.userId,
    connected,
    startsAt: opts.event.starts_at,
    endsAt: opts.event.ends_at,
    timeZone: opts.timeZone,
  });
  if (connected) {
    const created = await insertCalendarEvent(opts.userId, opts.event);
    return { id: created.id, provider: "google_calendar" };
  }
  const created = await createMockCalendarEvent(opts.supabase, opts.userId, { ...opts.event, source: opts.source });
  return { id: created.id, provider: "demo_calendar" };
}

export interface SavedDraft {
  draftId: string;
  subject: string;
  to: string;
  provider: "gmail" | "demo";
}

async function recordDraft(
  supabase: UserClient,
  row: Database["public"]["Tables"]["email_drafts"]["Insert"],
): Promise<string> {
  const { data, error } = await supabase.from("email_drafts").insert(row).select("id").single();
  if (error) throw error;
  return data.id;
}

/**
 * Save a reviewed reply as a DRAFT. Never sends: with Google connected the draft goes to the
 * user's Gmail drafts folder; in demo mode it is stored in email_drafts. Both are recorded.
 */
export async function saveReplyDraft(opts: {
  supabase: UserClient;
  userId: string;
  messageId: string;
  replyBody: string;
}): Promise<SavedDraft> {
  const connected = await isGoogleConnected(opts.userId);
  if (connected) {
    const draft = await createDraftReply(opts.userId, { messageId: opts.messageId, replyBody: opts.replyBody });
    try {
      await recordDraft(opts.supabase, {
        user_id: opts.userId,
        message_id: opts.messageId,
        to_address: draft.to,
        subject: draft.subject,
        body: opts.replyBody,
        provider: "gmail",
        external_draft_id: draft.draftId,
      });
    } catch (error) {
      console.error("Gmail draft saved, but recording it failed", error);
    }
    return { ...draft, provider: "gmail" };
  }

  const email = getMockEmail(opts.messageId);
  if (!email) throw new Error("That email is not in the demo inbox.");
  const subject = email.subject.toLowerCase().startsWith("re:") ? email.subject : `Re: ${email.subject}`;
  const draftId = await recordDraft(opts.supabase, {
    user_id: opts.userId,
    message_id: email.id,
    to_address: email.from,
    subject,
    body: opts.replyBody,
    provider: "demo",
  });
  return { draftId, subject, to: email.from, provider: "demo" };
}

/** Save a new (non-reply) email as a DRAFT only. Used for planner-proposed emails. */
export async function saveNewDraft(opts: {
  supabase: UserClient;
  userId: string;
  reference: string;
  to: string;
  subject: string;
  body: string;
}): Promise<SavedDraft> {
  const connected = await isGoogleConnected(opts.userId);
  if (connected) {
    const draft = await createDraft(opts.userId, { to: opts.to, subject: opts.subject, body: opts.body });
    await recordDraft(opts.supabase, {
      user_id: opts.userId,
      message_id: opts.reference,
      to_address: opts.to,
      subject: opts.subject,
      body: opts.body,
      provider: "gmail",
      external_draft_id: draft.draftId,
    });
    return { draftId: draft.draftId, subject: opts.subject, to: opts.to, provider: "gmail" };
  }
  const draftId = await recordDraft(opts.supabase, {
    user_id: opts.userId,
    message_id: opts.reference,
    to_address: opts.to,
    subject: opts.subject,
    body: opts.body,
    provider: "demo",
  });
  return { draftId, subject: opts.subject, to: opts.to, provider: "demo" };
}
