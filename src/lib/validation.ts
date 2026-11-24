/**
 * Readable input-validation errors.
 *
 * A server function whose validator calls `schema.parse()` throws a ZodError, and its message
 * is the JSON list of issues ('[ { "code": "too_big", "maximum": 4000, ... } ]'). TanStack
 * Start passes that message to the browser unchanged, so the chat showed raw JSON for a
 * message that was too long. `parseInput` throws a plain sentence instead, and
 * `readableErrorMessage` turns such a JSON list into a sentence for any error that still
 * carries one.
 */
import type { z, ZodTypeAny } from "zod";

interface IssueLike {
  code?: unknown;
  path?: unknown;
  message?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  type?: unknown;
}

/**
 * Longest text the database accepts in each user-written field (CHECK constraints on the
 * tables). Forms use these as maxLength so a user never meets the database error, and the AI
 * prompts trim further. Keep them equal to the constraints in supabase/migrations.
 */
export const TEXT_LIMITS = {
  profileName: 100,
  profileRole: 100,
  profileGoals: 2000,
  taskTitle: 300,
  taskReason: 1000,
  eventTitle: 200,
  eventNotes: 2000,
  chatMessage: 12000,
  draftSubject: 300,
  draftBody: 12000,
  draftRecipient: 320,
} as const;

/**
 * A sentence for the first profile field that is over its limit, or null when all fit. The
 * forms' maxLength stops new typing at the limit, but a profile saved before the limits
 * existed can still hold a longer text, and the database would refuse to save it unchanged.
 */
export function profileLengthProblem(profile: { name?: string | null; role?: string | null; goals?: string | null }): string | null {
  const fields = [
    ["Your name", profile.name, TEXT_LIMITS.profileName],
    ["Your role", profile.role, TEXT_LIMITS.profileRole],
    ["Your goals text", profile.goals, TEXT_LIMITS.profileGoals],
  ] as const;
  for (const [label, value, max] of fields) {
    if ((value ?? "").length > max) {
      return `${label} is too long: the limit is ${formatCount(max)} characters. Please shorten it.`;
    }
  }
  return null;
}

const FIELD_LABELS: Record<string, string> = {
  message: "Your message",
  input: "Your text",
  instructions: "The instructions",
  replyBody: "The reply",
  title: "The title",
  notes: "The notes",
  starts_at: "The start time",
  ends_at: "The end time",
  timeZone: "The time zone",
  name: "Your name",
  role: "Your role",
  goals: "Your goals text",
  reason: "The reason",
  subject: "The subject",
  body: "The message text",
  recipient: "The recipient",
};

function fieldLabel(path: unknown): string {
  const last = Array.isArray(path) && path.length > 0 ? String(path[path.length - 1]) : "";
  return FIELD_LABELS[last] ?? (last ? `The field "${last}"` : "The input");
}

function formatCount(value: unknown): string {
  return typeof value === "number" || typeof value === "bigint"
    ? Number(value).toLocaleString("en-US")
    : String(value);
}

/** One sentence for the first problem in a list of zod issues. */
export function describeIssues(issues: readonly IssueLike[]): string {
  const issue = issues[0];
  if (!issue) return "The input is not valid.";
  const label = fieldLabel(issue.path);
  if (issue.code === "too_big" && issue.type === "string") {
    return `${label} is too long: the limit is ${formatCount(issue.maximum)} characters. Please shorten it.`;
  }
  if (issue.code === "too_small" && issue.type === "string") {
    return Number(issue.minimum) <= 1
      ? `${label} is empty.`
      : `${label} is too short: at least ${formatCount(issue.minimum)} characters are needed.`;
  }
  const detail = typeof issue.message === "string" && issue.message.trim() ? issue.message.trim() : "is not valid";
  // Custom refinements already read as a sentence ("Event must end after it starts").
  if (issue.code === "custom") return detail.endsWith(".") ? detail : `${detail}.`;
  return `${label}: ${detail}${detail.endsWith(".") ? "" : "."}`;
}

/** Validate server-function input; a failure throws an Error with a readable sentence. */
export function parseInput<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(describeIssues(result.error.issues as IssueLike[]));
  return result.data as z.infer<S>;
}

/**
 * If `message` is a serialized list of zod issues, return a readable sentence for it;
 * otherwise return the message unchanged.
 */
export function readableErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("[") || !trimmed.includes('"code"')) return message;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((item) => typeof item === "object" && item !== null && "code" in item)
    ) {
      return describeIssues(parsed as IssueLike[]);
    }
  } catch {
    // Not JSON after all.
  }
  return message;
}
