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

/**
 * The note the workspace shows when it stopped waiting for a stored answer because the server
 * no longer accepted the sign-in (twice in a row, so not just a token being refreshed). A reload
 * either refreshes the sign-in and shows the answer, or leads to the sign-in page.
 */
export const SIGNED_OUT_NOTE =
  "⚠️ The answer to your last message could not be loaded because your sign-in has expired. Reload the page to try again.";

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
 * A failed check is retried after `retryMs` (for example a short network outage). An error that
 * `isFatal` says may not go away (the user is signed out) is retried too, since the first one can
 * be an access token that expired while the laptop slept and is refreshed a moment later; only
 * `fatalAfter` such errors in a row (default 2) end the poll, and then `onFatal` is told. The
 * workspace stops the poll when the page unmounts, so no timer outlives it.
 */
export function pollForStoredReply<T extends { replyState: ReplyState }>(options: {
  fetchHistory: () => Promise<T>;
  onDone: (result: T) => void;
  intervalMs: number;
  retryMs: number;
  isFatal?: (error: unknown) => boolean;
  fatalAfter?: number;
  onFatal?: (error: unknown) => void;
}): ReplyPoll {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fatalInARow = 0;
  const fatalAfter = Math.max(1, options.fatalAfter ?? 2);

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
      fatalInARow = options.isFatal?.(error) ? fatalInARow + 1 : 0;
      if (fatalInARow >= fatalAfter) {
        stopped = true;
        options.onFatal?.(error);
        return;
      }
      schedule(options.retryMs);
      return;
    }
    fatalInARow = 0;
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

/** What the workspace shows when a chat message could not be answered and no better reason is known. */
export const CHAT_ERROR_MESSAGE = "MONDAY could not answer this message. Please try again.";

/**
 * The first line of a briefing put together by rules when the AI did not answer (see
 * buildRuleBasedBriefing on the server), with the reason in brackets. The reason runs to the
 * last "), so this briefing" because it may hold brackets of its own.
 */
const RULE_BRIEFING_HEADER = /^(⚠️ The AI model did not answer) \((.+)\)(, so this briefing was put together by simple rules\.)/;

/**
 * A rule-based briefing without developer details in its first line: the bracketed reason is
 * left out when it holds them (a local address, a docker hint, a setting name). The rest of the
 * briefing, and a reason meant for visitors, stay as they are.
 */
function withoutBriefingDeveloperDetail(text: string): string {
  const match = RULE_BRIEFING_HEADER.exec(text);
  if (!match || !hasDeveloperDetail(match[2])) return text;
  return `${match[1]}${match[3]}${text.slice(match[0].length)}`;
}

/**
 * The text to show for a chat message from the server, stored or just received. On the hosted
 * demo, developer details from before that wording was fixed on the server do not reach
 * visitors: a stored failed turn that holds them is shown as a short note, and a rule-based
 * briefing loses the bracketed reason in its first line. The stored row itself is left
 * unchanged, and a local run shows the text as it is.
 */
export function storedMessageText(
  message: { role: string; content: string; panel_payload?: unknown },
  hosted: boolean,
): string {
  if (!hosted || message.role !== "assistant") return message.content;
  const payload = message.panel_payload;
  const failed =
    typeof payload === "object" && payload !== null && (payload as { failed?: unknown }).failed === true;
  if (failed && hasDeveloperDetail(message.content)) return FAILED_TURN_NOTE;
  return withoutBriefingDeveloperDetail(message.content);
}

/**
 * The reason shown when sending a chat message failed. On the hosted demo a reason with developer
 * details (a local address, a docker hint, a setting name) becomes a plain sentence.
 */
export function chatErrorText(reason: string, hosted: boolean): string {
  return hosted && hasDeveloperDetail(reason) ? CHAT_ERROR_MESSAGE : reason;
}
