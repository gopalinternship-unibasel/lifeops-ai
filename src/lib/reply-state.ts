/**
 * Is the assistant still working on the last chat message? Shared by the server (which
 * computes it from the stored history) and the workspace (which shows "Thinking…" and polls).
 *
 * Every chat turn ends with a stored assistant message, the answer or a failed turn (see
 * src/server/chat-turn.server.ts). So a history whose last message is the user's means the
 * request is still running, unless it is older than the longest a turn can take: then the
 * request was cut off (for example the dev server was restarted) and no answer will come.
 *
 * Also here: the workspace's wait for such an answer, and how stored replies are displayed.
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
  "⚠️ No answer was stored for this message because the request stopped before it finished. Please send it again.";

/** Bullet characters a model writes at the start of a line (CommonMark only knows -, * and +). */
const BULLET_CHARACTER = /^([ \t]*)[•●▪◦‣▸·][ \t]*(?=\S)/;

/**
 * An assistant reply as Markdown the chat can render. Models often write lists as "• item"
 * lines; Markdown reads those as one paragraph, so the lines ran together. Each such line starts
 * with "- " instead (outside code blocks). Applied when rendering, so replies already stored in
 * the history are shown correctly too.
 */
export function normalizeBullets(markdown: string): string {
  let inCode = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^[ \t]*(?:```|~~~)/.test(line)) {
        inCode = !inCode;
        return line;
      }
      return inCode ? line : line.replace(BULLET_CHARACTER, "$1- ");
    })
    .join("\n");
}

/**
 * A running check for the stored answer to the last message. `stop()` ends it for good: a check
 * that is still waiting for the server when it is stopped does not schedule another one.
 */
export interface ReplyPoll {
  stop(): void;
  readonly stopped: boolean;
}

/**
 * Ask the server every `intervalMs` whether the answer to the last message is stored yet, until
 * the history no longer says "awaiting"; then call `onDone` once with it.
 *
 * A failed check is retried after `retryMs` (for example a short network outage), except when
 * `isFatal` says the error will not go away (the user signed out): then the poll ends and
 * `onFatal` is told. The workspace stops the poll when the page unmounts, so no timer outlives it.
 */
export function pollForStoredReply<T extends { replyState: ReplyState }>(options: {
  fetchHistory: () => Promise<T>;
  onDone: (result: T) => void;
  intervalMs: number;
  retryMs: number;
  isFatal?: (error: unknown) => boolean;
  onFatal?: (error: unknown) => void;
}): ReplyPoll {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(check, ms);
  };
  const check = async () => {
    timer = null;
    let result: T;
    try {
      result = await options.fetchHistory();
    } catch (error) {
      // Stopped while the request ran (the page was left): do not schedule another check.
      if (stopped) return;
      if (options.isFatal?.(error)) {
        stopped = true;
        options.onFatal?.(error);
        return;
      }
      schedule(options.retryMs);
      return;
    }
    if (stopped) return;
    if (result.replyState.kind === "awaiting") {
      schedule(options.intervalMs);
      return;
    }
    stopped = true;
    options.onDone(result);
  };

  schedule(options.intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get stopped() {
      return stopped;
    },
  };
}

/**
 * Developer details that older failed turns may hold (stored before hosted sites stopped
 * falling back to a local model): local addresses, docker hints, setting names such as
 * LLM_TIMEOUT_MS.
 */
function hasDeveloperDetail(text: string): boolean {
  return /localhost|127\.0\.0\.1|\bdocker\b|\bollama\b|\.env\b/i.test(text) || /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/.test(text);
}

/** What the workspace shows instead of such a stored failure on the hosted demo. */
export const FAILED_TURN_NOTE = "⚠️ MONDAY could not answer this message at the time. Please send it again.";

/**
 * The text to show for a stored chat message. On the hosted demo a stored failed turn whose text
 * holds developer details (from before that wording was fixed on the server) is shown as a short
 * note; the stored row itself is left unchanged. A local run shows the stored text as it is.
 */
export function storedMessageText(
  message: { role: string; content: string; panel_payload?: unknown },
  hosted: boolean,
): string {
  const payload = message.panel_payload;
  const failed =
    message.role === "assistant" &&
    typeof payload === "object" &&
    payload !== null &&
    (payload as { failed?: unknown }).failed === true;
  return hosted && failed && hasDeveloperDetail(message.content) ? FAILED_TURN_NOTE : message.content;
}
