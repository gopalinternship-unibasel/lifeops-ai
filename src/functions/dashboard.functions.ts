import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getErrorMessage } from "@/lib/errors";
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
  type BackendAction,
  type BackendDashboard,
  type BackendPlanResponse,
} from "@/server/lifeops-backend.server";
import type { WeekPlan } from "@/types/plan";

const TimeZoneInput = z.object({ timeZone: z.string().max(100).optional() });

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
  .validator((d) => TimeZoneInput.optional().parse(d))
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

    const [tasksResult, planResult, draftsResult, draftCountResult, messageCountResult, demoResult] = await Promise.all([
      supabase.from("tasks").select("title, priority_rank, reason").eq("user_id", userId).order("priority_rank", { ascending: true }),
      supabase.from("weekly_plans").select("payload, approved_event_ids").eq("user_id", userId).eq("week_start", monday).maybeSingle(),
      supabase.from("email_drafts").select("to_address, subject, provider, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(3),
      supabase.from("email_drafts").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("connector_status").select("id").eq("user_id", userId).eq("provider", "demo").maybeSingle(),
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
    };
  });

/* ============================================================
 * runChaosPlan — messy input → planner service (FastAPI)
 * When the service is down the client falls back to the in-app
 * assistant (processChat), which extracts priorities and proposals.
 * ============================================================ */
export const runChaosPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z.object({ input: z.string().trim().min(3).max(4000), timeZone: z.string().max(100).optional() }).parse(d),
  )
  .handler(
    async ({
      context,
      data,
    }): Promise<{ mode: "service"; result: BackendPlanResponse } | { mode: "offline"; reason: string }> => {
      const timeZone = normalizeTimeZone(data.timeZone);
      try {
        const result = await backend.plan(context.userId, {
          user_input: data.input,
          current_datetime: localNow(timeZone),
          timezone: timeZone,
        });
        return { mode: "service", result };
      } catch (error: unknown) {
        if (error instanceof BackendUnavailableError) return { mode: "offline", reason: error.message };
        throw error;
      }
    },
  );

/* ============================================================
 * Approval gate for planner actions
 * ============================================================ */
export const decideBackendAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ id: z.number().int().positive(), decision: z.enum(["approve", "reject"]) }).parse(d))
  .handler(async ({ context, data }) => {
    const action =
      data.decision === "approve"
        ? await backend.approve(context.userId, data.id)
        : await backend.reject(context.userId, data.id);
    return { action };
  });

export const completeBackendTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ id: z.number().int().positive() }).parse(d))
  .handler(async ({ context, data }) => ({ task: await backend.completeTask(context.userId, data.id) }));

/**
 * Carry out an APPROVED planner action in the user's own calendar/mailbox, then record the
 * outcome in the planner service. Calendar blocks pass the same conflict check as every other
 * calendar write; email actions become drafts only.
 */
export const executeBackendAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ id: z.number().int().positive(), timeZone: z.string().max(100).optional() }).parse(d))
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
