import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "@/lib/validation";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiStatus, planApprovalCounts, type PlannerOfflineReason } from "@/lib/dashboard-view";
import { withoutHandledCards } from "@/lib/panel-state";
import { planRequestView, type PlanRequestResult, type PlanRequestView } from "@/lib/plan-request";
import { cardIdsOfPanel, listCardStates } from "@/server/chat-cards.server";
import { ensureChatSessionFor, maxChatTurnMs, runChatTurn } from "@/server/chat-turn.server";
import { isLocalBaseUrl, resolveLLMConfig } from "@/server/ai/llm.server";
import { ensureSeedEvents } from "@/server/connectors/calendar.mock";
import { toMs, type TimedEvent } from "@/server/calendar/time-ranges.server";
import { dbError } from "@/server/public-error.server";
import {
  addDaysISO,
  mondayOfISODate,
  normalizeTimeZone,
  todayInTimeZone,
  zonedDateTimeToISO,
} from "@/server/timezone.server";
import {
  isGoogleConnected,
  listBusyEvents,
  runApprovedPlannerAction,
  userFacingMessage,
  type UserClient,
} from "@/server/workspace.server";
import {
  backend,
  backendBaseUrl,
  backendOffError,
  BackendUnavailableError,
  busyForPlanner,
  planRequestWindowMs,
  planTimeoutMs,
  plannerOfflineFrom,
  safePlannerNote,
  startPlanRequest,
  storableRequestError,
  visitorSafeText,
  type BackendAction,
  type BackendDashboard,
  type PlannerBusyInterval,
} from "@/server/lifeops-backend.server";
import type { WeekPlan } from "@/types/plan";

const TimeZoneInput = z.object({ timeZone: z.string().max(100).optional() });

const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest a "Plan it" request can take: the planner service, then the in-app assistant. */
function maxPlanRequestMs(): number {
  return planRequestWindowMs(planTimeoutMs(), maxChatTurnMs());
}

/**
 * What the page shows for a stored request. Texts stored before they were written for visitors
 * (the planner's address, setting names, parser output) are replaced on the hosted demo.
 */
function safeView(view: PlanRequestView): PlanRequestView {
  if (view.error) view.error = visitorSafeText(view.error, "Planning failed. Please try again.");
  if (view.result?.mode === "service") {
    view.result = { ...view.result, note: safePlannerNote(view.result.note) };
  } else if (view.result?.mode === "in-app") {
    view.result = {
      ...view.result,
      reason: visitorSafeText(view.result.reason, "The planner service was not available."),
    };
  }
  return view;
}

/**
 * The user's newest "Plan it" request as the page shows it; an in-app answer comes without the
 * cards the user already saved or dismissed.
 */
async function latestPlanRequest(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<PlanRequestView | null> {
  const { data: row, error } = await supabase
    .from("planner_requests")
    .select("id, input, status, result, error, created_at, finished_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw dbError("load your last plan request", error);
  if (!row) return null;
  const view = safeView(planRequestView(row, Date.now(), maxPlanRequestMs()));
  if (view.result?.mode === "in-app") {
    const states = await listCardStates(supabase, userId, cardIdsOfPanel(view.result.panel));
    view.result = { ...view.result, panel: withoutHandledCards(view.result.panel, states) };
  }
  return view;
}

/** The user's current wall-clock time, e.g. "2026-11-09T08:30:00" (no offset). */
function localNow(timeZone: string): string {
  return new Date().toLocaleString("sv-SE", { timeZone, hour12: false }).replace(" ", "T");
}

/** Events that overlap [fromIso, toIso). */
function overlapping<T extends { starts_at: string; ends_at: string }>(events: T[], fromIso: string, toIso: string): T[] {
  const from = toMs(fromIso);
  const to = toMs(toIso);
  return events.filter((event) => toMs(event.starts_at) < to && toMs(event.ends_at) > from);
}

/**
 * The user's busy times for the next 8 days (the planner's date list), so the planner does not
 * propose blocks on top of them. Without the calendar the planner still plans, and every block
 * still passes the conflict check when it is run.
 */
async function busyForPlanRequest(supabase: UserClient, userId: string, timeZone: string): Promise<PlannerBusyInterval[]> {
  try {
    const connected = await isGoogleConnected(userId);
    const now = Date.now();
    const events = await listBusyEvents(
      supabase,
      userId,
      connected,
      new Date(now).toISOString(),
      new Date(now + 8 * DAY_MS).toISOString(),
    );
    return busyForPlanner(events, timeZone);
  } catch (error: unknown) {
    console.error("[lifeops] Plan it: could not read the calendar for the planner", error);
    return [];
  }
}

/**
 * The dashboard's two calendar ranges: "next 7 days" [from, to) and the plan's week
 * [weekStart, weekEnd). The demo calendar is read once for both, from Monday to today + 7 days
 * (today is never before Monday, so that end is never before the week's end). Google answers at
 * most 50 events per read (listCalendarEvents), so with Google each range is read on its own: one
 * read of up to 13 days could leave events out of both in a busy fortnight. On a Monday the two
 * ranges are the same and one read is enough.
 */
async function readDashboardCalendar(
  read: (startIso: string, endIso: string) => Promise<TimedEvent[]>,
  google: boolean,
  range: { from: string; to: string; weekStart: string; weekEnd: string },
): Promise<{ nextDays: TimedEvent[]; planWeek: TimedEvent[] }> {
  if (!google || (range.from === range.weekStart && range.to === range.weekEnd)) {
    const events = await read(range.weekStart, range.to);
    return { nextDays: events, planWeek: events };
  }
  const [nextDays, planWeek] = await Promise.all([read(range.from, range.to), read(range.weekStart, range.weekEnd)]);
  return { nextDays, planWeek };
}

type PlannerState =
  | { online: true; data: BackendDashboard }
  | { online: false; reason: PlannerOfflineReason; error: string };

/* ============================================================
 * fetchDashboard — productivity overview
 * In-app numbers come from Supabase and always work; the planner
 * section comes from the FastAPI service when it is running.
 * ============================================================ */
export const fetchDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(TimeZoneInput.optional(), d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const timeZone = normalizeTimeZone(data?.timeZone);
    const today = todayInTimeZone(timeZone);
    const monday = mondayOfISODate(today);
    // The calendar is read for "next 7 days" from the start of today and for the plan's week from
    // Monday; the list and the count start at now (below), so an event that is over is neither
    // listed nor counted, and one that is running now stays.
    const nowIso = new Date().toISOString();
    const from = zonedDateTimeToISO(today, { hour: 0 }, timeZone);
    const to = zonedDateTimeToISO(addDaysISO(today, 7), { hour: 0 }, timeZone);
    const weekStart = zonedDateTimeToISO(monday, { hour: 0 }, timeZone);
    const weekEnd = zonedDateTimeToISO(addDaysISO(monday, 7), { hour: 0 }, timeZone);

    const googleConnected = await isGoogleConnected(userId);
    let calendarError: string | null = null;
    let nextDays: TimedEvent[] = [];
    let planWeek: TimedEvent[] = [];
    try {
      if (!googleConnected) await ensureSeedEvents(supabase, userId, timeZone);
      ({ nextDays, planWeek } = await readDashboardCalendar(
        (startIso, endIso) => listBusyEvents(supabase, userId, googleConnected, startIso, endIso),
        googleConnected,
        { from, to, weekStart, weekEnd },
      ));
    } catch (error: unknown) {
      console.error("[lifeops] dashboard: calendar read failed", error);
      calendarError = "Your calendar could not be loaded right now. Please try again in a moment.";
    }
    const upcoming = overlapping(nextDays, nowIso, to).map((event) => ({
      title: event.title,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
    }));
    const weekEvents = overlapping(planWeek, weekStart, weekEnd).map((event) => ({
      title: event.title,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
    }));

    const [tasksResult, planResult, draftsResult, draftCountResult, messageCountResult, demoResult, planRequest] = await Promise.all([
      supabase.from("tasks").select("title, priority_rank, reason, source").eq("user_id", userId).order("priority_rank", { ascending: true }),
      supabase.from("weekly_plans").select("payload").eq("user_id", userId).eq("week_start", monday).maybeSingle(),
      supabase.from("email_drafts").select("to_address, subject, provider, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(3),
      supabase.from("email_drafts").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("connector_status").select("id").eq("user_id", userId).eq("provider", "demo").maybeSingle(),
      latestPlanRequest(supabase, userId),
    ]);
    for (const result of [tasksResult, planResult, draftsResult, draftCountResult, messageCountResult, demoResult]) {
      if (result.error) throw dbError("load the dashboard", result.error);
    }

    const plan = (planResult.data?.payload as unknown as WeekPlan | null) ?? null;
    // Which plan items are in the calendar, as on the plan page; unknown when the calendar failed.
    const counts = planApprovalCounts(plan, weekEvents, Date.now());
    const llm = resolveLLMConfig("chat");
    const ai = aiStatus({ ...llm, local: isLocalBaseUrl(llm.baseUrl) });

    let planner: PlannerState;
    try {
      planner = { online: true, data: await backend.dashboard(userId) };
    } catch (error: unknown) {
      planner = { online: false, ...plannerOfflineFrom(error) };
    }

    return {
      workspace: {
        googleConnected,
        demoMode: !googleConnected,
        aiProvider: ai,
        priorities: tasksResult.data ?? [],
        upcoming: upcoming.slice(0, 8),
        eventsNext7Days: upcoming.length,
        calendarError,
        weekStart: monday,
        plannedItems: counts.planned,
        approvedItems: calendarError ? null : counts.approved,
        drafts: draftsResult.data ?? [],
        draftCount: draftCountResult.count ?? 0,
        chatMessages: messageCountResult.count ?? 0,
      },
      planner,
      planRequest,
    };
  });

/** The newest "Plan it" request only: the page polls it while a request is still running. */
export const fetchPlanRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => ({ request: await latestPlanRequest(context.supabase, context.userId) }));

/* ============================================================
 * runChaosPlan — messy input → planner service (FastAPI)
 * When the service cannot be used (switched off, unreachable, too slow, refusing MONDAY's token,
 * or answering with a server error), the in-app assistant (the workspace chat turn) does the
 * same job: priorities and proposals. Both run to the end on the server and the result is
 * stored in planner_requests, so a page reloaded meanwhile shows "Planning…" again and then the
 * result.
 * ============================================================ */
export const runChaosPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ input: z.string().trim().min(3).max(4000), timeZone: z.string().max(100).optional() }), d))
  .handler(async ({ context, data }): Promise<{ request: PlanRequestView }> => {
    const { supabase, userId } = context;
    const timeZone = normalizeTimeZone(data.timeZone);

    // One "Plan it" at a time, and one use of the demo's AI allowance per press, whichever of the
    // two answers it. The use is recorded once this request's row holds the one running slot, and
    // a refused request's row is removed again (see startPlanRequest).
    const plannerOn = backendBaseUrl() !== null;
    const row = await startPlanRequest(supabase, userId, data.input, { windowMs: maxPlanRequestMs() });

    // The answer can take longer than the rest of the browser's access token (1 hour) on a slow
    // local model: the final update uses the service-role client, scoped to this user's row.
    const finish = async (update: { status: "done" | "failed"; result?: PlanRequestResult; error?: string }) => {
      const { data: finished, error } = await supabaseAdmin
        .from("planner_requests")
        .update({
          status: update.status,
          result: (update.result ?? null) as unknown as Json,
          // Within the column's limit: a longer text made the database refuse this update.
          error: update.error === undefined ? null : storableRequestError(update.error),
          finished_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("user_id", userId)
        .select("id, input, status, result, error, created_at, finished_at")
        .single();
      if (error) throw dbError("save the plan result", error);
      return safeView(planRequestView(finished, Date.now(), maxPlanRequestMs()));
    };

    let result: PlanRequestResult;
    try {
      try {
        if (!plannerOn) throw backendOffError();
        const plan = await backend.plan(userId, {
          user_input: data.input,
          current_datetime: localNow(timeZone),
          timezone: timeZone,
          busy: await busyForPlanRequest(supabase, userId, timeZone),
        });
        result = {
          mode: "service",
          summary: plan.summary,
          planner: plan.planner,
          note: safePlannerNote(plan.planner_note),
          tasks: plan.tasks_created,
          actions: plan.actions_created,
        };
      } catch (error: unknown) {
        if (!(error instanceof BackendUnavailableError)) throw error;
        // Planner service not usable: the in-app assistant extracts priorities and proposals instead.
        const { sessionId } = await ensureChatSessionFor(supabase, userId);
        const chat = await runChatTurn(context, { sessionId, message: data.input, timeZone });
        result = { mode: "in-app", reason: error.message, reply: chat.reply, panel: chat.panel };
      }
    } catch (error: unknown) {
      // Only a sentence meant for the user is stored and sent; internal details go to the log.
      const message = userFacingMessage(error, "Planning failed. Please try again.", "Plan it");
      await finish({ status: "failed", error: message }).catch((e: unknown) =>
        console.error("Could not store the failed plan request", e),
      );
      throw new Error(message);
    }
    return { request: await finish({ status: "done", result }) };
  });

/* ============================================================
 * Approval gate for planner actions
 * ============================================================ */
export const decideBackendAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ id: z.number().int().positive(), decision: z.enum(["approve", "reject"]) }), d))
  .handler(async ({ context, data }) => {
    const action =
      data.decision === "approve"
        ? await backend.approve(context.userId, data.id)
        : await backend.reject(context.userId, data.id);
    return { action };
  });

export const completeBackendTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ id: z.number().int().positive() }), d))
  .handler(async ({ context, data }) => ({ task: await backend.completeTask(context.userId, data.id) }));

/**
 * The recipient the user typed for a planner email draft: one line (it becomes the draft's To
 * header) and at most the 320 characters an address can have.
 */
const RecipientInput = z
  .string()
  .refine((value) => value.trim().length <= 320, "The recipient is too long: the limit is 320 characters.")
  .refine((value) => !/\p{Cc}/u.test(value.trim()), "The recipient must fit on one line.");

/**
 * Carry out an APPROVED planner action in the user's own calendar/mailbox, then record the
 * outcome in the planner service. Calendar blocks and reminders pass the same conflict check as
 * every other calendar write; email actions become drafts only (see runApprovedPlannerAction).
 */
export const executeBackendAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    parseInput(
      z.object({ id: z.number().int().positive(), timeZone: z.string().max(100).optional(), to: RecipientInput.optional() }),
      d,
    ),
  )
  .handler(async ({ context, data }): Promise<{ ok: boolean; message: string; action?: BackendAction }> => {
    const { supabase, userId } = context;
    const timeZone = normalizeTimeZone(data.timeZone);
    const action = await backend.action(userId, data.id);
    if (action.status === "executed") return { ok: true, message: "Already done.", action };
    // MONDAY's policy is stricter than the service's: every action needs an explicit approval.
    if (action.status !== "approved") {
      return { ok: false, message: "Approve this action before running it." };
    }
    return runApprovedPlannerAction({
      supabase,
      userId,
      action,
      timeZone,
      to: data.to?.trim(),
      record: (outcome) => backend.recordExecution(userId, action.id, outcome),
    });
  });
