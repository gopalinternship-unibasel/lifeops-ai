/**
 * Is the assistant still working on the last chat message? Shared by the server (which
 * computes it from the stored history) and the workspace (which shows "Thinking…" and polls).
 *
 * Every chat turn ends with a stored assistant message, the answer or a failed turn (see
 * src/server/chat-turn.server.ts). So a history whose last message is the user's means the
 * request is still running, unless it is older than the longest a turn can take: then the
 * request was cut off (for example the dev server was restarted) and no answer will come.
 */
export type ReplyState =
  | { kind: "answered" }
  | { kind: "awaiting"; since: string; remainingMs: number }
  | { kind: "interrupted"; since: string };

export function replyStateOf(
  messages: ReadonlyArray<{ role: string; created_at: string }>,
  nowMs: number,
  maxTurnMs: number,
): ReplyState {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return { kind: "answered" };
  const sentMs = Date.parse(last.created_at);
  if (!Number.isFinite(sentMs)) return { kind: "answered" };
  const remainingMs = sentMs + maxTurnMs - nowMs;
  return remainingMs > 0
    ? { kind: "awaiting", since: last.created_at, remainingMs }
    : { kind: "interrupted", since: last.created_at };
}

/** The note the workspace shows under a message whose request was cut off. */
export const INTERRUPTED_NOTE =
  "⚠️ No answer was stored for this message: the request was cut off before it finished (for example the server restarted). Please send it again.";
