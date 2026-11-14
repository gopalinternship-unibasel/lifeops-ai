/**
 * Limits for a public demo that shares one AI key between many visitors. Server-only.
 *
 * Every limit comes from a setting and is active only when that setting is present, so a local
 * install (no settings) stays unlimited and makes no extra database queries:
 *
 *   AI_CHAT_PER_HOUR      chat messages one user may send per hour
 *   AI_PLANS_PER_DAY      week plans (drafts and refinements) one user may ask for per 24 hours
 *   AI_PLANNER_PER_HOUR   dashboard "Plan it" requests one user may make per hour
 *   AI_CALLS_PER_DAY      requests of all users together per UTC day (chat, week plan, planner)
 *
 * The count is the number of rows the request kind already stored in the window (chat messages
 * the user wrote, week_plan_requests, planner_requests). A request is allowed while that count is
 * below the limit, so a limit of 20 allows 20 requests and refuses the 21st.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type AiRequestKind = "chat" | "plan" | "planner";

export interface AiCaps {
  chatPerHour: number | null;
  plansPerDay: number | null;
  plannerPerHour: number | null;
  callsPerDay: number | null;
}

export interface CapUsage {
  /** Requests of this kind the user already made in the user window. */
  user: number;
  /** Requests of all kinds, all users, since the start of the UTC day. */
  global: number;
}

export type CapDecision = { allowed: true } | { allowed: false; scope: "user" | "global"; message: string };

type Env = Record<string, string | undefined>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function capFrom(value: string | undefined): number | null {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The limits that are switched on. A missing, empty or non-positive setting means no limit. */
export function readCaps(env: Env = process.env): AiCaps {
  return {
    chatPerHour: capFrom(env.AI_CHAT_PER_HOUR),
    plansPerDay: capFrom(env.AI_PLANS_PER_DAY),
    plannerPerHour: capFrom(env.AI_PLANNER_PER_HOUR),
    callsPerDay: capFrom(env.AI_CALLS_PER_DAY),
  };
}

/** The user's limit for a request kind, or null when none is set. */
export function userLimit(kind: AiRequestKind, caps: AiCaps): number | null {
  if (kind === "chat") return caps.chatPerHour;
  if (kind === "plan") return caps.plansPerDay;
  return caps.plannerPerHour;
}

function userWindowMs(kind: AiRequestKind): number {
  return kind === "plan" ? DAY_MS : HOUR_MS;
}

/** Start of the UTC day that contains `now`: the global allowance starts again there. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function userMessage(kind: AiRequestKind, limit: number): string {
  if (kind === "chat") {
    return `You have reached this demo's limit of ${plural(limit, "chat message", "chat messages")} per hour. Please try again later.`;
  }
  if (kind === "plan") {
    return `You have reached this demo's limit of ${plural(limit, "week plan", "week plans")} per day. Please try again tomorrow.`;
  }
  return `You have reached this demo's limit of ${plural(limit, "planner request", "planner requests")} per hour. Please try again later.`;
}

const GLOBAL_MESSAGE = "This demo's AI allowance for today is used up. It starts again at midnight UTC. Please try again tomorrow.";

/**
 * The counting rule. The user's own limit is checked first, then the global one. A limit that is
 * not set never refuses. Pure: the counts come from the caller.
 */
export function decideCap(kind: AiRequestKind, usage: CapUsage, caps: AiCaps): CapDecision {
  const limit = userLimit(kind, caps);
  if (limit !== null && usage.user >= limit) {
    return { allowed: false, scope: "user", message: userMessage(kind, limit) };
  }
  if (caps.callsPerDay !== null && usage.global >= caps.callsPerDay) {
    return { allowed: false, scope: "global", message: GLOBAL_MESSAGE };
  }
  return { allowed: true };
}

export class CapReachedError extends Error {
  constructor(
    message: string,
    readonly scope: "user" | "global",
  ) {
    super(message);
    this.name = "CapReachedError";
  }
}

type Client = SupabaseClient<Database>;

async function countRows(
  client: Client,
  table: "chat_messages" | "week_plan_requests" | "planner_requests",
  since: Date,
  userId?: string,
): Promise<number> {
  const sinceIso = since.toISOString();
  let result;
  if (table === "chat_messages") {
    // Only the messages the user wrote, not the assistant's answers.
    const query = client
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("role", "user")
      .gte("created_at", sinceIso);
    result = await (userId ? query.eq("user_id", userId) : query);
  } else {
    const query = client.from(table).select("id", { count: "exact", head: true }).gte("created_at", sinceIso);
    result = await (userId ? query.eq("user_id", userId) : query);
  }
  if (result.error) throw result.error;
  return result.count ?? 0;
}

async function countUserRequests(client: Client, kind: AiRequestKind, userId: string, since: Date): Promise<number> {
  if (kind === "chat") return countRows(client, "chat_messages", since, userId);
  if (kind === "plan") return countRows(client, "week_plan_requests", since, userId);
  return countRows(client, "planner_requests", since, userId);
}

/**
 * Whether this user may start another request of this kind now. Use the service-role client:
 * the global count spans all users. With no limit set for the kind and no global limit, nothing
 * is queried.
 */
export async function checkAiAllowance(
  client: Client,
  userId: string,
  kind: AiRequestKind,
  options: { now?: Date; env?: Env } = {},
): Promise<CapDecision> {
  const caps = readCaps(options.env);
  const now = options.now ?? new Date();
  const limit = userLimit(kind, caps);
  if (limit === null && caps.callsPerDay === null) return { allowed: true };

  const usage: CapUsage = { user: 0, global: 0 };
  if (limit !== null) {
    usage.user = await countUserRequests(client, kind, userId, new Date(now.getTime() - userWindowMs(kind)));
    // Do not count the whole demo when the user is over their own limit already.
    const early = decideCap(kind, usage, { ...caps, callsPerDay: null });
    if (!early.allowed) return early;
  }
  if (caps.callsPerDay !== null) {
    const since = utcDayStart(now);
    const [chat, plans, planner] = await Promise.all([
      countRows(client, "chat_messages", since),
      countRows(client, "week_plan_requests", since),
      countRows(client, "planner_requests", since),
    ]);
    usage.global = chat + plans + planner;
  }
  return decideCap(kind, usage, caps);
}

/** Like checkAiAllowance, but throws a CapReachedError with the sentence for the visitor. */
export async function enforceAiAllowance(
  client: Client,
  userId: string,
  kind: AiRequestKind,
  options: { now?: Date; env?: Env } = {},
): Promise<void> {
  const decision = await checkAiAllowance(client, userId, kind, options);
  if (!decision.allowed) throw new CapReachedError(decision.message, decision.scope);
}
