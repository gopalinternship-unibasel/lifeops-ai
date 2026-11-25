import { readableErrorMessage } from "@/lib/validation";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the browser's fetch throws (a TypeError) when a request never reached the server or the
 * connection dropped: Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError when
 * attempting to fetch resource.", and "Network request failed" from fetch polyfills.
 */
const NETWORK_FAILURE =
  /^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)(?:\s*\(.*\))?$/i;

/**
 * Shown in place of the browser's own wording. It does not promise that nothing was changed: a
 * connection can drop after the server already finished the request.
 */
export const NETWORK_FAILURE_MESSAGE = "Could not reach MONDAY. Check your connection and try again.";

/** True for the TypeError fetch throws when the server could not be reached. */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FAILURE.test(error.message.trim());
}

/**
 * True when a request was refused because the user is not signed in (any more). The auth
 * middleware answers 401 with a text starting "Unauthorized", which the server-function client
 * turns into an Error with that text.
 */
export function isAuthFailure(error: unknown): boolean {
  if (typeof Response !== "undefined" && error instanceof Response) {
    return error.status === 401 || error.status === 403;
  }
  if (isRecord(error) && (error.status === 401 || error.status === 403)) return true;
  const message =
    error instanceof Error ? error.message : isRecord(error) && typeof error.message === "string" ? error.message : "";
  return /^\s*Unauthori[sz]ed\b/i.test(message);
}

export function getErrorMessage(error: unknown, fallback = "Unexpected error"): string {
  if (isNetworkFailure(error)) return NETWORK_FAILURE_MESSAGE;
  if (error instanceof Error && error.message) return readableErrorMessage(error.message);
  if (typeof error === "string" && error.trim()) return readableErrorMessage(error);

  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
    return readableErrorMessage(error.message);
  }

  return fallback;
}

/**
 * Shown in place of the sign-in check's own text ("Unauthorized: Invalid token") when a request
 * was refused because the visitor is no longer signed in (see isAuthFailure).
 */
export const SIGN_IN_EXPIRED_MESSAGE = "Your sign-in has expired. Reload the page or sign in again.";

/** getErrorMessage for text the visitor reads, with a sentence for a refused sign-in. */
export function getVisitorErrorMessage(error: unknown, fallback?: string): string {
  return isAuthFailure(error) ? SIGN_IN_EXPIRED_MESSAGE : getErrorMessage(error, fallback);
}
