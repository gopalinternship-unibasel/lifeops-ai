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
 * A database read or write failed. `action` completes "Could not …", e.g. "save your message".
 * The PostgREST/Postgres details are logged, never sent to the browser.
 */
export function dbError(action: string, cause: unknown): Error {
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
