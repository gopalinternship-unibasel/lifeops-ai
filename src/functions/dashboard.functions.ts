import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "@/lib/validation";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getErrorMessage } from "@/lib/errors";
import { withoutHandledCards } from "@/lib/panel-state";
import { planRequestView, type PlanRequestResult, type PlanRequestView } from "@/lib/plan-request";
import { cardIdsOfPanel, listCardStates } from "@/server/chat-cards.server";
import { ensureChatSessionFor, maxChatTurnMs, runChatTurn } from "@/server/chat-turn.server";
import { enforceAiAllowance } from "@/server/limits.server";
import { resolveLLMConfig } from "@/server/ai/llm.server";
import { listCalendarEvents } from "@/server/google/calendar.server";
import { ensureSeedEvents, listEventsForRange } from "@/server/connectors/calendar.mock";
import { parseUserDateTime } from "@/server/calendar/time-ranges.server";
import {
  addDaysISO,
  mondayOfISODate,
  normalizeTimeZone,
  todayInTimeZone,
  zonedDateTimeToISO,
} from "@/server/timezone.server";
import { createCalendarBlock, isGoogleConnected, saveNewDraft } from "@/server/workspace.server";
import {
  backend,
  BackendUnavailableError,
  planTimeoutMs,
  type BackendAction,
  type BackendDashboard,
  type BackendPlanResponse,
} from "@/server/lifeops-backend.server";
import type { WeekPlan } from "@/types/plan";

const TimeZoneInput = z.object({ timeZone: z.string().max(100).optional() });

/** The longest a "Plan it" request can take: the planner service, then the in-app assistant. */
function maxPlanRequestMs(): number {
  return planTimeoutMs() + maxChatTurnMs() + 60_000;
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
  if (error) throw error;
  if (!row) return null;
  const view = planRequestView(row, Date.now(), maxPlanRequestMs());
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
    const from = zonedDateTimeToISO(today, { hour: 0 }, timeZone);
    const to = zonedDateTimeToISO(addDaysISO(today, 7), { hour: 0 }, timeZone);
    const monday = mondayOfISODate(today);

    const googleConnected = await isGoogleConnected(userId);
    let calendarError: string | null = null;
    let upcoming: { title: string; starts_at: string; ends_at: string }[] = [];
    try {
      if (googleConnected) {
        upcoming = (await listCalendarEvents(userId, from, to)).filter((event) => event.busy !== false);
      } else {
        await ensureSeedEvents(supabase, userId, timeZone);
        upcoming = await listEventsForRange(supabase, userId, from, to);
      }
    } catch (error: unknown) {
      calendarError = getErrorMessage(error, "Calendar unavailable");
    }

    const [tasksResult, planResult, draftsResult, draftCountResult, messageCountResult, demoResult, planRequest] = await Promise.all([
      supabase.from("tasks").select("title, priority_rank, reason, source").eq("user_id", userId).order("priority_rank", { ascending: true }),
      supabase.from("weekly_plans").select("payload, approved_event_ids").eq("user_id", userId).eq("week_start", monday).maybeSingle(),
      supabase.from("email_drafts").select("to_address, subject, provider, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(3),
      supabase.from("email_drafts").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("connector_status").select("id").eq("user_id", userId).eq("provider", "demo").maybeSingle(),
      latestPlanRequest(supabase, userId),
    ]);
    for (const result of [tasksResult, planResult, draftsResult, draftCountResult, messageCountResult, demoResult]) {
      if (result.error) throw result.error;
    }

    const plan = (planResult.data?.payload as unknown as WeekPlan | null) ?? null;
    const plannedItems = plan ? plan.days.reduce((sum, day) => sum + day.items.length, 0) : 0;
    const approvedItems = Array.isArray(planResult.data?.approved_event_ids)
      ? planResult.data.approved_event_ids.length
      : 0;
    const llm = resolveLLMConfig("chat");

    let planner: { online: true; data: BackendDashboard } | { online: false; error: string };
    try {
      planner = { online: true, data: await backend.dashboard(userId) };
    } catch (error: unknown) {
      planner = { online: false, error: getErrorMessage(error, "Planner service unavailable") };
    }

    return {
      workspace: {
        googleConnected,
        demoMode: !googleConnected,
        aiProvider: { provider: llm.provider, model: llm.model },
        priorities: tasksResult.data ?? [],
        upcoming: upcoming.slice(0, 8),
        eventsNext7Days: upcoming.length,
        calendarError,
        weekStart: monday,
        plannedItems,
        approvedItems,
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
 * When the service is down, the in-app assistant (the workspace chat turn) does the same job:
 * priorities and proposals. Both run to the end on the server and the result is stored in
 * planner_requests, so a page reloaded meanwhile shows "Planning…" again and then the result.
 * ============================================================ */
export const runChaosPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ input: z.string().trim().min(3).max(4000), timeZone: z.string().max(100).optional() }), d))
  .handler(async ({ context, data }): Promise<{ request: PlanRequestView }> => {
    const { supabase, userId } = context;
    const timeZone = normalizeTimeZone(data.timeZone);
    // Demo limits (off unless the AI_* settings are set): refuse before a request row is stored.
    await enforceAiAllowance(supabaseAdmin, userId, "planner");
    const { data: row, error: insertError } = await supabase
      .from("planner_requests")
      .insert({ user_id: userId, input: data.input, status: "running" })
      .select("id, input, status, result, error, created_at, finished_at")
      .single();
    if (insertError) throw insertError;

    // The answer can take longer than the rest of the browser's access token (1 hour) on a slow
    // local model: the final update uses the service-role client, scoped to this user's row.
    const finish = async (update: { status: "done" | "failed"; result?: PlanRequestResult; error?: string }) => {
      const { data: finished, error } = await supabaseAdmin
        .from("planner_requests")
        .update({
          status: update.status,
          result: (update.result ?? null) as unknown as Json,
          error: update.error ?? null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("user_id", userId)
        .select("id, input, status, result, error, created_at, finished_at")
        .single();
      if (error) throw error;
      return planRequestView(finished, Date.now(), maxPlanRequestMs());
    };

    let result: PlanRequestResult;
    try {
      try {
        const plan = await backend.plan(userId, {
          user_input: data.input,
          current_datetime: localNow(timeZone),
          timezone: timeZone,
        });
        result = {
          mode: "service",
          summary: plan.summary,
          planner: plan.planner,
          note: plan.planner_note,
          tasks: plan.tasks_created,
          actions: plan.actions_created,
        };
      } catch (error: unknown) {
        if (!(error instanceof BackendUnavailableError)) throw error;
        // Planner service down: the in-app assistant extracts priorities and proposals instead.
        const { sessionId } = await ensureChatSessionFor(supabase, userId);
        const chat = await runChatTurn(context, { sessionId, message: data.input, timeZone });
        result = { mode: "in-app", reason: error.message, reply: chat.reply, panel: chat.panel };
      }
    } catch (error: unknown) {
      await finish({ status: "failed", error: getErrorMessage(error, "Planning failed") }).catch((e: unknown) =>
        console.error("Could not store the failed plan request", e),
      );
      throw error;
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
 * Carry out an APPROVED planner action in the user's own calendar/mailbox, then record the
 * outcome in the planner service. Calendar blocks pass the same conflict check as every other
 * calendar write; email actions become drafts only.
 */
export const executeBackendAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ id: z.number().int().positive(), timeZone: z.string().max(100).optional() }), d))
  .handler(async ({ context, data }): Promise<{ ok: boolean; message: string; action?: BackendAction }> => {
    const { supabase, userId } = context;
    const timeZone = normalizeTimeZone(data.timeZone);
    const action = await backend.action(userId, data.id);
    if (action.status === "executed") return { ok: true, message: "Already done.", action };
    // MONDAY's policy is stricter than the service's: every action needs an explicit approval.
    if (action.status !== "approved") {
      return { ok: false, message: "Approve this action before running it." };
    }

    let outcome: { provider: string; external_id: string | null; result: Record<string, unknown> };
    try {
      if (action.action_type === "calendar_block") {
        const startsAt = action.start_time ? parseUserDateTime(action.start_time, timeZone) : null;
        const endsAt = action.end_time ? parseUserDateTime(action.end_time, timeZone) : null;
        if (!startsAt || !endsAt) return { ok: false, message: "This calendar block has no valid time range." };
        // The planner proposes blocks from now on; one whose time has passed is not written.
        if (new Date(startsAt).getTime() < Date.now()) {
          return { ok: false, message: "This block's start time has already passed. Plan it again for a later time." };
        }
        const created = await createCalendarBlock({
          supabase,
          userId,
          event: { title: action.title, starts_at: startsAt, ends_at: endsAt, notes: action.description },
          source: "planner",
          timeZone,
        });
        outcome = { provider: created.provider, external_id: created.id, result: { starts_at: startsAt, ends_at: endsAt } };
      } else if (action.action_type === "email_draft") {
        const draft = await saveNewDraft({
          supabase,
          userId,
          reference: `planner-action-${action.id}`,
          to: action.email_to?.trim() || "(recipient to fill in)",
          subject: action.email_subject?.trim() || action.title,
          body: action.email_body?.trim() || action.description || "",
        });
        outcome = {
          provider: draft.provider === "gmail" ? "gmail_draft" : "demo_draft",
          external_id: draft.draftId,
          result: { draft_only: true, to: draft.to, subject: draft.subject },
        };
      } else {
        outcome = { provider: "monday", external_id: null, result: { acknowledged: action.action_type } };
      }
    } catch (error: unknown) {
      return { ok: false, message: getErrorMessage(error, "Could not carry out this action") };
    }

    await backend.recordExecution(userId, action.id, outcome);
    const done =
      action.action_type === "calendar_block"
        ? outcome.provider === "google_calendar"
          ? "Added to Google Calendar."
          : "Added to your demo calendar."
        : action.action_type === "email_draft"
          ? outcome.provider === "gmail_draft"
            ? "Saved as a Gmail draft (not sent)."
            : "Saved as a demo draft (not sent)."
          : "Marked as done.";
    return { ok: true, message: done };
  });
