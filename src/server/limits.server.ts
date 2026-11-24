/**
 * Limits for a public demo that shares one AI key between many visitors. Server-only.
 *
 * Every limit comes from a setting and is active only when that setting is present, so a local
 * install (no settings) stays unlimited and makes no extra database queries:
 *
 *   AI_CHAT_PER_HOUR      chat messages (and reply drafts) one user may send per hour
 *   AI_PLANS_PER_DAY      week plans (drafts and refinements) one user may ask for per 24 hours
 *   AI_PLANNER_PER_HOUR   dashboard "Plan it" requests one user may make per hour
 *   AI_CALLS_PER_DAY      AI requests of all users together per UTC day (all kinds)
 *
 * Every AI request that is allowed records one use in public.ai_usage, a ledger only the server
 * can write (migration 20261124110000_ai_usage_ledger.sql). The limits count those uses; rows a
 * user can write or delete (chat messages, request rows) no longer count. A request is allowed
 * while the count is below the limit, so a limit of 20 allows 20 requests and refuses the 21st.
 *
 * enforceAiAllowance checks AND records one use in one database transaction, under a lock, so
 * parallel requests are counted one at a time. Call it exactly once per request that will call
 * the AI, right before the AI work, and not for work that makes no AI call (a rule-based answer).
 * checkAiAllowance only reads, for a refusal before anything is stored.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { publicError } from "@/server/public-error.server";

/** "draft" is an email reply draft (draftReplySuggestion); it shares the chat limit. */
export type AiRequestKind = "chat" | "plan" | "planner" | "draft";

export interface AiCaps {
  chatPerHour: number | null;
  plansPerDay: number | null;
  plannerPerHour: number | null;
  callsPerDay: number | null;
}

export interface CapUsage {
  /** Requests of this kind (and the kinds sharing its limit) the user made in the user window. */
  user: number;
  /** Requests of all kinds, all users, since the start of the UTC day. */
  global: number;
}

export type CapDecision =
  { allowed: true } | { allowed: false; scope: "user" | "global"; message: string };

type Env = Record<string, string | undefined>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A whole number of 1 or more; anything else ("20abc", "1e3", "2.5", "-3") is no limit. */
function capFrom(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The limits that are switched on. A missing, empty, non-positive or not whole-number setting
 * means no limit.
 */
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
  if (kind === "chat" || kind === "draft") return caps.chatPerHour;
  if (kind === "plan") return caps.plansPerDay;
  return caps.plannerPerHour;
}

/** The kinds whose uses count toward this kind's per-user limit: chat and reply drafts share one. */
export function userLimitKinds(kind: AiRequestKind): AiRequestKind[] {
  return kind === "chat" || kind === "draft" ? ["chat", "draft"] : [kind];
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
  if (kind === "chat" || kind === "draft") {
    return `You have reached this demo's limit of ${plural(limit, "chat message", "chat messages")} per hour. Please try again later.`;
  }
  if (kind === "plan") {
    return `You have reached this demo's limit of ${plural(limit, "week plan", "week plans")} per day. Please try again tomorrow.`;
  }
  return `You have reached this demo's limit of ${plural(limit, "planner request", "planner requests")} per hour. Please try again later.`;
}

const GLOBAL_MESSAGE =
  "This demo's AI allowance for today is used up. It starts again at midnight UTC. Please try again tomorrow.";

/** Shown when the usage could not be read or recorded (the database did not answer). */
export const ALLOWANCE_UNAVAILABLE =
  "The demo's usage limits could not be checked right now. Please try again in a moment.";

/**
 * The counting rule. The user's own limit is checked first, then the global one. A limit that is
 * not set never refuses. Pure: the counts come from the caller. public.ai_allowance applies the
 * same rule in the database when it decides whether to record a use.
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

interface LedgerAnswer {
  usage: CapUsage;
  recorded: boolean;
  /** The limit the database found reached, if any. */
  scope: "user" | "global" | null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Ask public.ai_allowance for the user's and the demo's usage, and with `consume` record one use
 * when the request is allowed. Needs the service-role client: only the service role may execute
 * the function, and the global count spans all users.
 */
async function askLedger(
  client: Client,
  userId: string,
  kind: AiRequestKind,
  caps: AiCaps,
  consume: boolean,
): Promise<LedgerAnswer> {
  const { data, error } = await client.rpc("ai_allowance", {
    p_user: userId,
    p_kind: kind,
    p_user_kinds: userLimitKinds(kind),
    p_user_limit: userLimit(kind, caps),
    p_user_window_seconds: userWindowMs(kind) / 1000,
    p_global_limit: caps.callsPerDay,
    p_consume: consume,
  });
  if (error) throw publicError(ALLOWANCE_UNAVAILABLE, error, `AI allowance (${kind})`);
  const answer: Record<string, unknown> =
    data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const { user_count: user, global_count: global, recorded, scope } = answer;
  if (!isCount(user) || !isCount(global) || typeof recorded !== "boolean") {
    throw publicError(ALLOWANCE_UNAVAILABLE, data, `AI allowance (${kind}): unexpected answer`);
  }
  return {
    usage: { user, global },
    recorded,
    scope: scope === "user" || scope === "global" ? scope : null,
  };
}

/**
 * Whether this user may start another request of this kind now. Only reads: nothing is recorded.
 * Use the service-role client. With no limit set for the kind and no global limit, nothing is
 * queried. The windows are measured with the database clock; `options.now` is not used for them.
 */
export async function checkAiAllowance(
  client: Client,
  userId: string,
  kind: AiRequestKind,
  options: { now?: Date; env?: Env } = {},
): Promise<CapDecision> {
  const caps = readCaps(options.env);
  if (userLimit(kind, caps) === null && caps.callsPerDay === null) return { allowed: true };
  const { usage } = await askLedger(client, userId, kind, caps, false);
  return decideCap(kind, usage, caps);
}

/**
 * Check the limits and record one use of the AI allowance, in one step: call it once per request
 * that will call the AI, right before the AI work. Throws a CapReachedError with the sentence for
 * the visitor when a limit is reached (nothing is recorded then). With no limit set for the kind
 * and no global limit, nothing is queried or recorded.
 */
export async function enforceAiAllowance(
  client: Client,
  userId: string,
  kind: AiRequestKind,
  options: { now?: Date; env?: Env } = {},
): Promise<void> {
  const caps = readCaps(options.env);
  if (userLimit(kind, caps) === null && caps.callsPerDay === null) return;
  const { usage, recorded, scope } = await askLedger(client, userId, kind, caps, true);
  if (recorded) return;
  // The database refused. It applies decideCap's rule to the same counts, so decideCap names the
  // limit that was reached; the database's own answer is the fallback.
  const decision = decideCap(kind, usage, caps);
  if (!decision.allowed) throw new CapReachedError(decision.message, decision.scope);
  const limit = userLimit(kind, caps);
  if (scope === "user" && limit !== null) {
    throw new CapReachedError(userMessage(kind, limit), "user");
  }
  throw new CapReachedError(GLOBAL_MESSAGE, "global");
}
