/**
 * Errors that leave a server function reach the browser: TanStack Start sends an Error's message,
 * and a plain object (such as a PostgREST error with code, details and hint) is sent whole. So a
 * server function must only throw errors whose message is meant for the user.
 *
 * These helpers log the internal cause on the server and return an Error with a short, readable
 * message for the user.
 */

/** Log `cause` (when given) under `context` and return an Error that is safe to show to users. */
export function publicError(userMessage: string, cause?: unknown, context?: string): Error {
  if (cause !== undefined) {
    console.error(`[lifeops] ${context ?? userMessage}:`, describeCause(cause));
  }
  return new Error(userMessage);
}

/**
 * The database's per-account row limits (migrations 20261124110100 and 20261125120000) refuse a row
 * with SQLSTATE 23514, a sentence written for the visitor as the message ("This demo account has
 * reached its limit of 1000 calendar events that are not over yet. Ask the assistant to cancel
 * ...") and the detail "Row limit <n> per user on <schema>.<table>.". A CHECK constraint fails
 * with 23514 too, but with a developer message and the detail "Failing row contains (...)", which
 * holds row data.
 */
const ROW_LIMIT_DETAIL = /^Row limit \d+ per user on [a-z_]+\.[a-z_]+\.$/;
const ROW_LIMIT_MESSAGE = /^This demo account has [^\n_]{1,300}$/;

/**
 * The visitor's sentence of a row-limit refusal, or null for any other error. PostgREST sends the
 * detail as `details`, a Postgres driver as `detail`.
 */
export function rowLimitSentence(cause: unknown): string | null {
  if (!cause || typeof cause !== "object") return null;
  const record = cause as Record<string, unknown>;
  const detail = typeof record.details === "string" ? record.details : record.detail;
  if (record.code !== "23514" || typeof record.message !== "string" || typeof detail !== "string") {
    return null;
  }
  return ROW_LIMIT_DETAIL.test(detail) && ROW_LIMIT_MESSAGE.test(record.message) ? record.message : null;
}

/** The Errors dbError returned for a row-limit refusal (a mark that never reaches the browser). */
const rowLimitErrors = new WeakSet<Error>();

/**
 * Whether `error` is dbError's Error for a row-limit refusal. Code that goes on after a failed
 * write (a loop that adds many events) stops on it and passes its sentence on: every further row
 * would be refused the same way, and counting it as "failed" hides what the visitor can do.
 */
export function isRowLimitError(error: unknown): error is Error {
  return error instanceof Error && rowLimitErrors.has(error);
}

/**
 * A database read or write failed. `action` completes "Could not …", e.g. "save your message".
 * The PostgREST/Postgres details are logged, never sent to the browser. A row-limit refusal is
 * the exception: "Please try again in a moment" can never succeed there, so its own sentence,
 * which says what to do, is what the visitor reads.
 */
export function dbError(action: string, cause: unknown): Error {
  const limit = rowLimitSentence(cause);
  if (limit) {
    const error = publicError(limit, cause, `database: ${action} (row limit)`);
    rowLimitErrors.add(error);
    return error;
  }
  return publicError(
    `Could not ${action}. Please try again in a moment.`,
    cause,
    `database: ${action}`,
  );
}

/** One loggable line for any thrown value (Error, PostgREST error object, string, other). */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    const parts = ["code", "message", "details", "hint"]
      .map((key) =>
        typeof record[key] === "string" && record[key] ? `${key}=${String(record[key])}` : "",
      )
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }
  return String(cause);
}
