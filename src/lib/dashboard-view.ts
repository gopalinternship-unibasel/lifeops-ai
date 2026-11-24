/**
 * What the dashboard (/app/dashboard) shows, as small pure helpers shared by its server function
 * and its page, so the rules can be tested without a browser.
 */
import { isRecord } from "@/lib/errors";
import { planCalendarState } from "@/lib/plan-state";
import type { PlanRequestView } from "@/lib/plan-request";
import type { BusyEvent, WeekPlan } from "@/types/plan";

/* ------------------------------------------------------------------------------------------
 * Metrics
 * ---------------------------------------------------------------------------------------- */

/**
 * "Plan blocks approved": how many of this week's plan items are in the calendar, worked out from
 * the calendar itself as on the plan page. The list of approved event ids only ever grew, so it
 * kept counting events the user had removed and counted re-approved items twice (4/3).
 */
export function planApprovalCounts(
  plan: WeekPlan | null,
  weekEvents: BusyEvent[],
  nowMs: number,
): { approved: number; planned: number } {
  const planned = plan ? plan.days.reduce((sum, day) => sum + day.items.length, 0) : 0;
  const state = planCalendarState(plan, weekEvents, nowMs);
  const approved = Object.values(state.addedItems).reduce((sum, indexes) => sum + indexes.length, 0);
  return { approved, planned };
}

/* ------------------------------------------------------------------------------------------
 * Badges
 * ---------------------------------------------------------------------------------------- */

export interface AiStatus {
  /** False when no AI provider is set up on this site (see LLMConfig.configured). */
  configured: boolean;
  /** "Cloudflare Workers AI · @cf/zai-org/glm-4.7-flash", or a plain sentence when not set up. */
  label: string;
  /** The model runs on this machine (a local Ollama): answers can take minutes. */
  local: boolean;
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/**
 * The AI badge. Without a provider the badge says so, instead of pairing the local default's name
 * with the configured model ("Ollama · @cf/zai-org/glm-4.7-flash", a pair that does not exist).
 */
export function aiStatus(config: { configured: boolean; provider: string; model: string; baseUrl: string }): AiStatus {
  if (!config.configured) return { configured: false, label: "AI not set up on this site", local: false };
  return { configured: true, label: `${config.provider} · ${config.model}`, local: LOCAL_HOST.test(config.baseUrl) };
}

/** Why the planner service is not used (BackendUnavailableReason on the server). */
export type PlannerOfflineReason = "off" | "unreachable" | "timeout" | "rejected" | "failed";

/** The planner badge: "offline" only when it could not be reached, not when it is off or refused. */
export function plannerBadgeText(planner: { online: true } | { online: false; reason?: PlannerOfflineReason }): string {
  if (planner.online) return "Planner service online";
  if (planner.reason === "off") return "Planner service off — in-app assistant";
  if (planner.reason === "unreachable") return "Planner service offline — in-app assistant";
  return "Planner service unavailable — in-app assistant";
}

/** Where an executed planner action went, in words (the planner stores a provider code). */
export function executionProviderLabel(provider: string | null): string {
  switch (provider) {
    case "demo_calendar":
      return "demo calendar";
    case "google_calendar":
      return "Google Calendar";
    case "demo_draft":
      return "demo draft (not sent)";
    case "gmail_draft":
      return "Gmail draft (not sent)";
    case "monday":
      return "noted (nothing scheduled)";
    default:
      return provider ?? "?";
  }
}

/* ------------------------------------------------------------------------------------------
 * "Plan it" request banners
 * ---------------------------------------------------------------------------------------- */

/** After this long a failed or interrupted "Plan it" request is no longer shown. */
export const OUTCOME_SHOWN_MS = 24 * 60 * 60 * 1000;

/**
 * A failed or interrupted request from more than a day ago: its banner would otherwise stay on the
 * dashboard, undated, for weeks (and keep a cause that was fixed meanwhile in view).
 */
export function isStaleOutcome(
  request: Pick<PlanRequestView, "status" | "startedAt" | "finishedAt">,
  nowMs: number,
): boolean {
  if (request.status !== "failed" && request.status !== "interrupted") return false;
  const at = Date.parse(request.finishedAt ?? request.startedAt);
  return Number.isFinite(at) && nowMs - at > OUTCOME_SHOWN_MS;
}

/** "2:05 PM" today, "Tue, Nov 17, 1:53 PM" on another day: a bare clock time hid that a banner was old. */
export function formatRequestTime(
  iso: string,
  nowMs: number = Date.now(),
  opts: { locale?: string; timeZone?: string } = {},
): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const day = (date: Date) =>
    date.toLocaleDateString("en-CA", { timeZone: opts.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const time: Intl.DateTimeFormatOptions = { timeZone: opts.timeZone, hour: "numeric", minute: "2-digit" };
  return day(at) === day(new Date(nowMs))
    ? at.toLocaleTimeString(opts.locale, time)
    : at.toLocaleString(opts.locale, { ...time, weekday: "short", month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------------------------------
 * Page state and server answers
 * ---------------------------------------------------------------------------------------- */

/** The spinner only while loading; a first load that failed shows a message with Try again. */
export function dashboardViewState(loading: boolean, hasData: boolean): "loading" | "error" | "ready" {
  if (hasData) return "ready";
  return loading ? "loading" : "error";
}

/** Shown when a server answer does not have the expected shape (for example after an update). */
export const UNEXPECTED_ANSWER = "The server sent an unexpected answer. Reload the page and try again.";

/** fetchDashboard's answer has the parts the page reads. */
export function isDashboardAnswer(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.workspace) &&
    Array.isArray(value.workspace.priorities) &&
    isRecord(value.planner) &&
    typeof value.planner.online === "boolean"
  );
}

/** runChaosPlan's answer: { request } with a stored request. */
export function isPlanRequestAnswer(value: unknown): value is { request: PlanRequestView } {
  return (
    isRecord(value) &&
    isRecord(value.request) &&
    typeof value.request.id === "string" &&
    typeof value.request.status === "string"
  );
}

/** fetchPlanRequest's answer: { request } with a stored request, or null when there is none. */
export function isPlanPollAnswer(value: unknown): value is { request: PlanRequestView | null } {
  return isRecord(value) && "request" in value && (value.request === null || isPlanRequestAnswer(value));
}

/** executeBackendAction's answer: { ok, message }. */
export function isActionRunAnswer(value: unknown): value is { ok: boolean; message: string } {
  return isRecord(value) && typeof value.ok === "boolean" && typeof value.message === "string";
}
