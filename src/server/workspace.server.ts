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

type CalendarBlock = { id: string; provider: "google_calendar" | "demo_calendar"; reused?: boolean };

type BlockEvent = { title: string; starts_at: string; ends_at: string; notes?: string | null };

/** How a Google event's description names the planner action that wrote it: "(planner-action-7)". */
function plannerTag(reference: string): string {
  return `(${reference})`;
}

/**
 * Whether a block tagged with an action's reference is that action's block: the same title and
 * time. Planner action ids are the planner database's own row ids, and that database is reset
 * now and then (a deleted lifeops.db, a planner without DATABASE_URL), so a new action can get the
 * id, and the reference, of an action whose block is still in the calendar.
 */
function sameBlock(found: { title: string; starts_at: string; ends_at: string }, wanted: BlockEvent): boolean {
  return (
    found.title.trim() === wanted.title.trim() &&
    toMs(found.starts_at) === toMs(wanted.starts_at) &&
    toMs(found.ends_at) === toMs(wanted.ends_at)
  );
}

type DemoBlockRow = { id: string; title: string; starts_at: string; ends_at: string };

/** The demo calendar's block tagged with this reference (its seed_key), if there is one. */
async function findDemoBlock(supabase: UserClient, userId: string, reference: string): Promise<DemoBlockRow | null> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("id, title, starts_at, ends_at")
    .eq("user_id", userId)
    .eq("seed_key", reference)
    .limit(1)
    .maybeSingle();
  if (error) throw dbError("check your calendar", error);
  return data ?? null;
}

/**
 * A block the planner wrote with this title and time that carries no reference any more: editing
 * a demo event clears its seed_key (calendar.mock updateEvent), even when only its notes changed,
 * and blocks written before the tag existed never had one. Events of other sources (one the user
 * made in the chat, a demo seed event) are never taken for it. Known limit: an untagged planner
 * block another action wrote with the same title and time (one whose tag a later run cleared, or
 * one left from before a planner reset) cannot be told apart from this action's edited block, so
 * it is reused too: nothing is written, the message ("Already in your demo calendar.") is true,
 * and both actions record the one block's id (the id is only shown and stored; nothing deletes
 * by it).
 */
async function findUntaggedPlannerBlock(
  supabase: UserClient,
  userId: string,
  event: BlockEvent,
  source: string,
): Promise<DemoBlockRow | null> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("id, title, starts_at, ends_at, seed_key")
    .eq("user_id", userId)
    .eq("source", source)
    .lt("starts_at", event.ends_at)
    .gt("ends_at", event.starts_at);
  if (error) throw dbError("check your calendar", error);
  return (data ?? []).find((row) => !row.seed_key && sameBlock(row, event)) ?? null;
}

/**
 * A planner block in the demo calendar, tagged with its reference in seed_key. A tagged block
 * with this title and time is reused. A tagged block with other values is either an earlier
 * action's (one that had the same id before the planner's database was reset) or this action's,
 * written by a run from another time zone (the planner's times have no zone, so the same action
 * gives other instants elsewhere); the two cannot be told apart. Nothing is changed while the
 * slot is taken: the conflict check comes first, and only a run that will write its block clears
 * the old block's tag (it stays in the calendar as an ordinary event, as one the user edits does).
 * A run refused as an overlap may still find its own block in the slot: one a run at the same
 * moment just wrote (the unique key on (user_id, seed_key) lets only one of them write it; the
 * other may also get a unique violation, 23505), or one that lost its tag (see
 * findUntaggedPlannerBlock). That block is returned instead of the overlap. Known limit: both
 * fallbacks only recognise a block with this run's instants. Of two runs at the same moment from
 * zones with other offsets (Zurich and London), the second gets the unique violation and "Could
 * not add the event to your calendar"; nothing more is written, and a later run from the first
 * zone reuses the block.
 */
async function createDemoPlannerBlock(
  supabase: UserClient,
  userId: string,
  event: BlockEvent,
  source: string,
  reference: string,
  timeZone: string | undefined,
): Promise<CalendarBlock> {
  const provider = "demo_calendar";
  /** The block a run at the same moment wrote for this action, if there is one now. */
  const writtenMeanwhile = async (): Promise<CalendarBlock | null> => {
    const written = await findDemoBlock(supabase, userId, reference);
    return written && sameBlock(written, event) ? { id: written.id, provider, reused: true } : null;
  };

  const found = await findDemoBlock(supabase, userId, reference);
  if (found && sameBlock(found, event)) return { id: found.id, provider, reused: true };
  try {
    await assertNoCalendarConflict({
      supabase,
      userId,
      connected: false,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      timeZone,
    });
  } catch (error: unknown) {
    const written = await writtenMeanwhile().catch(() => null);
    if (written) return written;
    const untagged = await findUntaggedPlannerBlock(supabase, userId, event, source).catch(() => null);
    if (untagged) return { id: untagged.id, provider, reused: true };
    throw error;
  }
  if (found) {
    const { error: untagError } = await supabase
      .from("calendar_events")
      .update({ seed_key: null })
      .eq("id", found.id)
      .eq("user_id", userId)
      .eq("seed_key", reference);
    if (untagError) throw dbError("add the event to your calendar", untagError);
  }
  const { data, error } = await supabase
    .from("calendar_events")
    .insert({
      user_id: userId,
      title: event.title,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      notes: event.notes ?? null,
      source,
      seed_key: reference,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      const written = await writtenMeanwhile();
      if (written) return written;
    }
    throw dbError("add the event to your calendar", error);
  }
  return { id: data.id, provider };
}

/**
 * A planner block in Google Calendar, tagged with a line in its description. Only an event with
 * that tag and the block's title and time is the planner's block (see sameBlock); any other event
 * in the slot, a tagged one of an earlier action with the same id included, is an overlap.
 * Known limit: two runs at the same moment can both find the slot free and both insert an event.
 * Preventing that needs a claim row (as for Gmail drafts) or a deterministic event id in
 * insertCalendarEvent (calendar.server.ts).
 */
async function createGooglePlannerBlock(
  userId: string,
  event: BlockEvent,
  reference: string,
  timeZone: string | undefined,
): Promise<CalendarBlock> {
  const provider = "google_calendar";
  const tag = plannerTag(reference);
  const inSlot = await listCalendarEvents(userId, event.starts_at, event.ends_at);
  const tagged = inSlot.find(
    (existing) => existing.id && (existing.notes ?? "").includes(tag) && sameBlock(existing, event),
  );
  if (tagged) return { id: tagged.id, provider, reused: true };
  const conflicts = findConflicts(
    event,
    inSlot.filter((existing) => existing.busy !== false),
  );
  if (conflicts.length > 0) throw new Error(describeConflicts(conflicts, timeZone));
  const line = `Added by MONDAY's planner ${tag}.`;
  const notes = event.notes?.trim() ? `${event.notes.trim()}\n\n${line}` : line;
  const created = await insertCalendarEvent(userId, { ...event, notes });
  return { id: created.id, provider };
}

/**
 * Create an event in Google Calendar or the demo calendar after the conflict check.
 *
 * `reference`: a planner action's reference ("planner-action-<id>"). The block carries it (the
 * demo calendar's seed_key; a line in a Google event's description), and a block that already
 * carries it is returned (reused: true) instead of writing a second one. A planner action whose
 * first run wrote the block but could not be recorded can then be run again: without this, the
 * retry was refused as an overlap with its own block. A block counts only with the reference and
 * the action's title and time: an event the user made with the same title and time is not the
 * planner's block and stays an overlap (it was taken for the block, and its id recorded as the
 * planner action's, when blocks were matched by title and time), and neither is a block an
 * earlier action with the same id left at another time (see sameBlock). In the demo calendar, a
 * planner block with the action's title and time that lost its reference (the user edited it) is
 * also reused (see createDemoPlannerBlock).
 */
export async function createCalendarBlock(opts: {
  supabase: UserClient;
  userId: string;
  event: BlockEvent;
  source: string;
  timeZone?: string;
  reference?: string;
}): Promise<CalendarBlock> {
  const connected = await isGoogleConnected(opts.userId);
  const provider = connected ? "google_calendar" : "demo_calendar";
  if (opts.reference) {
    return connected
      ? createGooglePlannerBlock(opts.userId, opts.event, opts.reference, opts.timeZone)
      : createDemoPlannerBlock(opts.supabase, opts.userId, opts.event, opts.source, opts.reference, opts.timeZone);
  }
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
 *
 * `timeZone`: the visitor's, as the chat's inbox list uses it. The demo emails are dated from the
 * visitor's today, so without it a Saturday-afternoon reply in Zurich was saved as "Re: Lunch
 * this Saturday?" while the inbox listed "Lunch next Saturday?" (finding 42). Without it the email
 * is read in UTC, as before. The email is read when the draft is saved, so a reply card made
 * before the dates move on (Saturday 1 PM for the lunch email) and saved after it gets the newer
 * subject.
 */
export async function saveReplyDraft(opts: {
  supabase: UserClient;
  userId: string;
  messageId: string;
  replyBody: string;
  timeZone?: string;
  nowMs?: number;
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

  const email = getMockEmail(opts.messageId, opts.timeZone, opts.nowMs);
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

type DraftRow = {
  id: string;
  to_address: string;
  subject: string;
  body: string;
  provider: string;
  external_draft_id: string | null;
  created_at: string;
};

/** The draft saved under this reference (the oldest, if there are several), or null. */
async function findDraftRow(supabase: UserClient, userId: string, reference: string): Promise<DraftRow | null> {
  const { data, error } = await supabase
    .from("email_drafts")
    .select("id, to_address, subject, body, provider, external_draft_id, created_at")
    .eq("user_id", userId)
    .eq("message_id", reference)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw dbError("check your saved drafts", error);
  return data ?? null;
}

/**
 * Whether a draft saved under an action's reference is that action's draft: the same subject and
 * body. As for calendar blocks (see sameBlock), a reset of the planner's database gives a new
 * action the id, and the reference, of an earlier one whose draft is still saved. The recipient is
 * not compared: the user may type another one before running the action again.
 */
function sameDraft(row: DraftRow, wanted: { subject: string; body: string }): boolean {
  return row.subject === wanted.subject && row.body === wanted.body;
}

/**
 * How long a Gmail draft's row may be without Gmail's id while the run that wrote it is still
 * creating the Gmail draft: a token refresh and one Google request, each limited to 20 seconds.
 */
export const GMAIL_DRAFT_CLAIM_MS = 2 * 60_000;

/** Shown to a second run of an action while the first is still creating its Gmail draft. */
export const DRAFT_IN_PROGRESS_MESSAGE = "This action is being run already. Try again in a moment.";

/**
 * The saved draft, returned to a second run (reused: true). With Google connected the row is
 * written before the Gmail draft exists; while it is recent and has no Gmail id yet, the first
 * run is still at work, and the second gets DRAFT_IN_PROGRESS_MESSAGE as an error (nothing is
 * recorded). It used to report the draft as saved, with the row's own id as the Gmail draft's,
 * also when the Gmail call then failed and no Gmail draft existed. Known limit: an older row
 * without Gmail's id is reused with the row's id. That happens when the Gmail draft was created
 * but writing its id failed (the planner then records the row's id), or when the Gmail call
 * failed and neither the user's nor the service role's delete of the row worked (see
 * releaseDraftRow), and then no Gmail draft exists.
 */
function reusedDraft(row: DraftRow, nowMs: number): SavedDraft {
  const gmail = row.provider === "gmail";
  if (gmail && !row.external_draft_id && nowMs - Date.parse(row.created_at) < GMAIL_DRAFT_CLAIM_MS) {
    throw new Error(DRAFT_IN_PROGRESS_MESSAGE);
  }
  return {
    draftId: (gmail ? row.external_draft_id : null) ?? row.id,
    subject: row.subject,
    to: row.to_address,
    provider: gmail ? "gmail" : "demo",
    reused: true,
  };
}

/**
 * Remove the row of a Gmail draft that could not be created. When the user's delete fails, the
 * service role removes it (scoped to this row and user): a row left without Gmail's id looks like
 * a saved Gmail draft to every Run after GMAIL_DRAFT_CLAIM_MS, and no Gmail draft exists.
 */
async function releaseDraftRow(supabase: UserClient, userId: string, rowId: string): Promise<void> {
  const { error } = await supabase.from("email_drafts").delete().eq("id", rowId).eq("user_id", userId);
  if (!error) return;
  console.error("[lifeops] could not remove an unused draft row:", describeCause(error));
  try {
    const { error: adminError } = await supabaseAdmin.from("email_drafts").delete().eq("id", rowId).eq("user_id", userId);
    if (adminError) console.error("[lifeops] could not remove an unused draft row:", describeCause(adminError));
  } catch (adminError: unknown) {
    console.error("[lifeops] could not remove an unused draft row:", describeCause(adminError));
  }
}

/**
 * Save a new (non-reply) email as a DRAFT only. Used for planner-proposed emails: `reference`
 * ("planner-action-<id>") identifies the action, and the draft already saved for it is returned
 * instead of saving a second one (a run whose outcome could not be recorded may be run again).
 * A draft under the reference with another subject or body is an earlier action's (see
 * sameDraft): it is kept, its reference gets its own id appended, as migration 20261125110000
 * does for duplicates, and a new draft is saved.
 *
 * The row with the reference is written first. The unique index on planner references
 * (migration 20261125110000) lets only one of two runs at the same moment write it; the other
 * gets a unique violation (23505) and returns the first one's draft. With Google connected the
 * Gmail draft is created only after that, so one action never makes two Gmail drafts: not when
 * two runs race, and not when the row or the planner's record of a run could not be written.
 */
export async function saveNewDraft(opts: {
  supabase: UserClient;
  userId: string;
  reference: string;
  to: string;
  subject: string;
  body: string;
  nowMs?: number;
}): Promise<SavedDraft> {
  const nowMs = opts.nowMs ?? Date.now();
  const earlier = await findDraftRow(opts.supabase, opts.userId, opts.reference);
  if (earlier) {
    if (sameDraft(earlier, opts)) return reusedDraft(earlier, nowMs);
    // Users cannot change their drafts (no UPDATE policy): the service role, scoped to this row.
    const { error: renameError } = await supabaseAdmin
      .from("email_drafts")
      .update({ message_id: `${opts.reference} (earlier action ${earlier.id})` })
      .eq("id", earlier.id)
      .eq("user_id", opts.userId)
      .eq("message_id", opts.reference);
    if (renameError) throw dbError("save the draft", renameError);
  }

  const connected = await isGoogleConnected(opts.userId);
  const { data: row, error: insertError } = await opts.supabase
    .from("email_drafts")
    .insert({
      user_id: opts.userId,
      message_id: opts.reference,
      to_address: opts.to,
      subject: opts.subject,
      body: opts.body,
      provider: connected ? "gmail" : "demo",
    })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === "23505") {
      const written = await findDraftRow(opts.supabase, opts.userId, opts.reference);
      if (written && sameDraft(written, opts)) return reusedDraft(written, nowMs);
    }
    throw dbError("save the draft", insertError);
  }
  if (!connected) return { draftId: row.id, subject: opts.subject, to: opts.to, provider: "demo" };

  let draft: { draftId: string };
  try {
    draft = await createDraft(opts.userId, { to: opts.to, subject: opts.subject, body: opts.body });
  } catch (error: unknown) {
    // Nothing was created in Gmail: free the reference again, so Run can be tried again.
    await releaseDraftRow(opts.supabase, opts.userId, row.id);
    throw error;
  }
  // Gmail's id goes on the row with the service role (users cannot change their drafts). When that
  // fails the row still carries the reference, so a second run reuses it instead of creating a
  // second Gmail draft; it is only logged, and the draft is returned as saveReplyDraft does.
  try {
    const { error } = await supabaseAdmin
      .from("email_drafts")
      .update({ external_draft_id: draft.draftId })
      .eq("id", row.id)
      .eq("user_id", opts.userId);
    if (error) console.error("[lifeops] Gmail draft saved, but recording its id failed:", describeCause(error));
  } catch (error: unknown) {
    console.error("[lifeops] Gmail draft saved, but recording its id failed:", describeCause(error));
  }
  return { draftId: draft.draftId, subject: opts.subject, to: opts.to, provider: "gmail" };
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

/** What a planner action writes is tagged with this, so a second run finds it ("planner-action-7"). */
function plannerReference(actionId: number): string {
  return `planner-action-${actionId}`;
}

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
      reference: plannerReference(action.id),
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
      reference: plannerReference(action.id),
      to,
      subject: fit(oneLine(action.email_subject ?? "") || oneLine(action.title), 300),
      body: fit(action.email_body?.trim() || action.description || "", 12_000),
      nowMs: opts.nowMs,
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
