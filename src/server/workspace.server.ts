/**
 * Server-only helpers shared by the workspace, calendar, plan and dashboard server functions.
 * Everything here works the same with a connected Google account and with the demo data.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { readableErrorMessage } from "@/lib/validation";
import { createDraft, createDraftReply } from "@/server/google/gmail.server";
import { insertCalendarEvent, listCalendarEvents } from "@/server/google/calendar.server";
import { createEvent as createMockCalendarEvent, listEventsForRange } from "@/server/connectors/calendar.mock";
import { getMockEmail } from "@/server/connectors/gmail.mock";
import {
  describeConflicts,
  findConflicts,
  parseUserDateTime,
  toMs,
  type TimedEvent,
} from "@/server/calendar/time-ranges.server";
import { isHostedDeployment } from "@/server/deployment.server";
import { dbError, describeCause } from "@/server/public-error.server";

export type UserClient = SupabaseClient<Database>;

/**
 * Errors of the Google clients that carry Google's raw answer, an internal code or a setting name
 * ("Calendar insert failed: 403 {...}", "Draft create failed: ...", "GOOGLE_NOT_CONNECTED",
 * "GOOGLE_CLIENT_ID is not configured"). They are plain Errors, so without this check they reached
 * the page as they were.
 */
const RAW_GOOGLE_ERROR =
  /^(?:(?:Calendar (?:list|insert|patch|delete)|Draft create|Gmail list|Token (?:exchange|refresh)|Google token revocation) failed\b|Could not fetch original message\b|Gmail returned a draft without an ID\b|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b)/;

/** Google was disconnected (or its access ended) between the check and the write. */
export const GOOGLE_NOT_CONNECTED_MESSAGE =
  "Your Google account is no longer connected. Connect it again from your profile, then try again.";

/**
 * The message a visitor sees for an error a server function caught. Errors this app throws
 * carry a sentence meant for users; anything else (a database error object, a TypeError from a
 * bug, a Response, and on the hosted sites a Google error with Google's raw answer or a setting
 * name) is logged and replaced by `fallback`, so no internal text reaches the page.
 */
export function userFacingMessage(error: unknown, fallback: string, context: string): string {
  const internal =
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof SyntaxError ||
    error instanceof ReferenceError;
  if (error instanceof Error && error.message.trim() && !internal) {
    const message = error.message.trim();
    if (message === "GOOGLE_NOT_CONNECTED") {
      console.error(`[lifeops] ${context}:`, describeCause(error));
      return GOOGLE_NOT_CONNECTED_MESSAGE;
    }
    // A local run keeps the developer's detail; the hosted sites show the plain fallback.
    if (!isHostedDeployment() || !RAW_GOOGLE_ERROR.test(message)) return readableErrorMessage(error.message);
    console.error(`[lifeops] ${context}:`, describeCause(error));
    return fallback;
  }
  console.error(`[lifeops] ${context}:`, describeCause(error));
  return fallback;
}

export async function isGoogleConnected(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("google_oauth_tokens")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw dbError("check your Google connection", error);
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

function sameEvent(event: TimedEvent, wanted: { title: string; starts_at: string; ends_at: string }): boolean {
  return (
    event.title.trim() === wanted.title.trim() &&
    toMs(event.starts_at) === toMs(wanted.starts_at) &&
    toMs(event.ends_at) === toMs(wanted.ends_at)
  );
}

/**
 * Create an event in Google Calendar or the demo calendar after the conflict check.
 *
 * `reuseIdentical`: when the calendar already holds an event with this exact title and time, return
 * it (reused: true) instead of writing a second one. A planner action whose first run wrote the
 * block but could not be recorded can then be run again: without this, the retry was refused as
 * an overlap with its own block.
 */
export async function createCalendarBlock(opts: {
  supabase: UserClient;
  userId: string;
  event: { title: string; starts_at: string; ends_at: string; notes?: string | null };
  source: string;
  timeZone?: string;
  reuseIdentical?: boolean;
}): Promise<{ id: string; provider: "google_calendar" | "demo_calendar"; reused?: boolean }> {
  const connected = await isGoogleConnected(opts.userId);
  const provider = connected ? "google_calendar" : "demo_calendar";
  if (opts.reuseIdentical) {
    const existing = await listBusyEvents(
      opts.supabase,
      opts.userId,
      connected,
      opts.event.starts_at,
      opts.event.ends_at,
    );
    const same = existing.find((event) => event.id && sameEvent(event, opts.event));
    if (same?.id) return { id: same.id, provider, reused: true };
    const conflicts = findConflicts(opts.event, existing);
    if (conflicts.length > 0) throw new Error(describeConflicts(conflicts, opts.timeZone));
  } else {
    await assertNoCalendarConflict({
      supabase: opts.supabase,
      userId: opts.userId,
      connected,
      startsAt: opts.event.starts_at,
      endsAt: opts.event.ends_at,
      timeZone: opts.timeZone,
    });
  }
  if (connected) {
    const created = await insertCalendarEvent(opts.userId, opts.event);
    return { id: created.id, provider };
  }
  const created = await createMockCalendarEvent(opts.supabase, opts.userId, { ...opts.event, source: opts.source });
  return { id: created.id, provider };
}

export interface SavedDraft {
  draftId: string;
  subject: string;
  to: string;
  provider: "gmail" | "demo";
  /** True when a draft with this reference was already saved and nothing new was written. */
  reused?: boolean;
}

async function recordDraft(
  supabase: UserClient,
  row: Database["public"]["Tables"]["email_drafts"]["Insert"],
): Promise<string> {
  const { data, error } = await supabase.from("email_drafts").insert(row).select("id").single();
  if (error) throw dbError("save the draft", error);
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

/**
 * Save a new (non-reply) email as a DRAFT only. Used for planner-proposed emails: `reference`
 * ("planner-action-<id>") identifies the action, and a draft already saved for it is returned
 * instead of saving a second one (a run whose outcome could not be recorded may be run again).
 */
export async function saveNewDraft(opts: {
  supabase: UserClient;
  userId: string;
  reference: string;
  to: string;
  subject: string;
  body: string;
}): Promise<SavedDraft> {
  const { data: existing, error: existingError } = await opts.supabase
    .from("email_drafts")
    .select("id, to_address, subject, provider, external_draft_id")
    .eq("user_id", opts.userId)
    .eq("message_id", opts.reference)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existingError) throw dbError("check your saved drafts", existingError);
  if (existing) {
    const gmail = existing.provider === "gmail";
    return {
      draftId: (gmail ? existing.external_draft_id : null) ?? existing.id,
      subject: existing.subject,
      to: existing.to_address,
      provider: gmail ? "gmail" : "demo",
      reused: true,
    };
  }

  const connected = await isGoogleConnected(opts.userId);
  if (connected) {
    const draft = await createDraft(opts.userId, { to: opts.to, subject: opts.subject, body: opts.body });
    // The Gmail draft exists now. A failed record must not turn the run into an error: the
    // planner would keep the action approved, and the next Run would save a second Gmail draft.
    // As for saveReplyDraft, it is logged and the draft is returned.
    try {
      await recordDraft(opts.supabase, {
        user_id: opts.userId,
        message_id: opts.reference,
        to_address: opts.to,
        subject: opts.subject,
        body: opts.body,
        provider: "gmail",
        external_draft_id: draft.draftId,
      });
    } catch (error: unknown) {
      console.error("[lifeops] Gmail draft saved, but recording it failed:", describeCause(error));
    }
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

/* ============================================================
 * Approved planner actions (dashboard "Run")
 * ============================================================ */

/** The fields of a planner action that running it needs. */
export interface PlannerActionToRun {
  id: number;
  action_type: "task" | "calendar_block" | "email_draft" | "reminder";
  title: string;
  description: string | null;
  start_time: string | null;
  end_time: string | null;
  email_to: string | null;
  email_subject: string | null;
  email_body: string | null;
}

/** What MONDAY did for an action, as the planner records it. */
export interface PlannerActionOutcome {
  provider: string;
  external_id: string | null;
  result: Record<string, unknown>;
}

/** A reminder becomes a calendar entry of this length, as in the chat ("Reminder: <what>"). */
export const REMINDER_MINUTES = 15;

/** Shown when the action was carried out but the planner could not be told. */
export const NOT_RECORDED_NOTE =
  "The planner could not be updated yet, so it may still list this action as approved; running it again will not add it twice.";

/** The placeholder recipient of a draft whose recipient the user has not given. */
export const NO_RECIPIENT = "(recipient to fill in)";

/** Text cut to the database's length limit for the column it goes to. */
function fit(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** One line: a recipient goes into an email header, where a line break would start a new header. */
function oneLine(text: string): string {
  return text.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
}

type Step = { ok: true; outcome: PlannerActionOutcome; done: string } | { ok: false; message: string };

async function carryOutPlannerAction(opts: {
  supabase: UserClient;
  userId: string;
  action: PlannerActionToRun;
  timeZone: string;
  to?: string;
  nowMs: number;
}): Promise<Step> {
  const { supabase, userId, action, timeZone } = opts;
  if (action.action_type === "calendar_block" || action.action_type === "reminder") {
    const reminder = action.action_type === "reminder";
    const startsAt = action.start_time ? parseUserDateTime(action.start_time, timeZone) : null;
    if (!startsAt) {
      return {
        ok: false,
        message: reminder
          ? "This reminder has no time. Reject it, or plan it again with a time."
          : "This calendar block has no valid time range.",
      };
    }
    const endsAt = reminder
      ? new Date(toMs(startsAt) + REMINDER_MINUTES * 60_000).toISOString()
      : action.end_time
        ? parseUserDateTime(action.end_time, timeZone)
        : null;
    if (!endsAt) return { ok: false, message: "This calendar block has no valid time range." };
    // The planner proposes times from now on; one that has passed is not written.
    if (toMs(startsAt) < opts.nowMs) {
      return {
        ok: false,
        message: reminder
          ? "This reminder's time has already passed. Plan it again for a later time."
          : "This block's start time has already passed. Plan it again for a later time.",
      };
    }
    const title = reminder && !/^\W*reminder\b/i.test(action.title) ? `Reminder: ${action.title}` : action.title;
    const created = await createCalendarBlock({
      supabase,
      userId,
      event: { title: fit(title, 200), starts_at: startsAt, ends_at: endsAt, notes: fit(action.description ?? "", 2000) || null },
      source: "planner",
      timeZone,
      reuseIdentical: true,
    });
    const where = created.provider === "google_calendar" ? "Google Calendar" : "your demo calendar";
    return {
      ok: true,
      outcome: {
        provider: created.provider,
        external_id: created.id,
        result: { starts_at: startsAt, ends_at: endsAt, ...(reminder ? { reminder: true } : {}) },
      },
      done: created.reused
        ? `Already in ${where}.`
        : reminder
          ? `Added to ${where} as a ${REMINDER_MINUTES}-minute reminder.`
          : `Added to ${where}.`,
    };
  }

  if (action.action_type === "email_draft") {
    // A recipient the user gave wins, and an empty one means "no recipient": the user cleared the
    // planner's address in the To field. Without a typed value the planner's address is used.
    const recipient = opts.to !== undefined ? oneLine(opts.to) : oneLine(action.email_to ?? "");
    const to = fit(recipient || NO_RECIPIENT, 320);
    const draft = await saveNewDraft({
      supabase,
      userId,
      reference: `planner-action-${action.id}`,
      to,
      subject: fit(oneLine(action.email_subject ?? "") || oneLine(action.title), 300),
      body: fit(action.email_body?.trim() || action.description || "", 12_000),
    });
    const kind = draft.provider === "gmail" ? "a Gmail draft" : "a demo draft";
    return {
      ok: true,
      outcome: {
        provider: draft.provider === "gmail" ? "gmail_draft" : "demo_draft",
        external_id: draft.draftId,
        result: { draft_only: true, to: draft.to, subject: draft.subject },
      },
      done: draft.reused ? `Already saved as ${kind} (not sent).` : `Saved as ${kind} (not sent).`,
    };
  }

  // A task has nothing to schedule: MONDAY notes it, and the user ticks the task off when done.
  return {
    ok: true,
    outcome: { provider: "monday", external_id: null, result: { acknowledged: action.action_type, scheduled: false } },
    done: "Noted. Nothing was scheduled; tick the task off on the planner task board when it is done.",
  };
}

/**
 * Carry out an APPROVED planner action in the user's own calendar or mailbox, then let the
 * planner record the outcome. Calendar blocks and reminders pass the same conflict check as
 * every other calendar write; email actions become drafts only. A second run of the same action
 * reuses what the first run wrote, so a run whose outcome could not be recorded can be repeated.
 */
export async function runApprovedPlannerAction(opts: {
  supabase: UserClient;
  userId: string;
  action: PlannerActionToRun;
  timeZone: string;
  /** The recipient the user typed for an email draft; "" when the user cleared the field. */
  to?: string;
  record: (outcome: PlannerActionOutcome) => Promise<unknown>;
  nowMs?: number;
}): Promise<{ ok: boolean; message: string }> {
  let step: Step;
  try {
    step = await carryOutPlannerAction({ ...opts, nowMs: opts.nowMs ?? Date.now() });
  } catch (error: unknown) {
    return { ok: false, message: userFacingMessage(error, "Could not carry out this action. Please try again.", "planner action") };
  }
  if (!step.ok) return step;
  try {
    await opts.record(step.outcome);
  } catch (error: unknown) {
    // The block or draft exists; only the planner's record of it is missing.
    console.error("[lifeops] planner action carried out, but recording it failed:", describeCause(error));
    return { ok: true, message: `${step.done} ${NOT_RECORDED_NOTE}` };
  }
  return { ok: true, message: step.done };
}
