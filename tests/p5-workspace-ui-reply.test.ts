import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILED_TURN_NOTE,
  INTERRUPTED_NOTE,
  normalizeBullets,
  pollForStoredReply,
  type ReplyState,
} from "@/lib/reply-state";
import { storedMessageText } from "@/lib/reply-state";

type History = { replyState: ReplyState; marker?: string };
const awaiting: History = {
  replyState: { kind: "awaiting", since: "2026-11-24T10:00:00Z", remainingMs: 60_000 },
};
const answered: History = { replyState: { kind: "answered" }, marker: "done" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("waiting for an answer stored by an earlier request", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops for good when the page is left while a check is still running", async () => {
    const first = deferred<History>();
    const fetchHistory = vi
      .fn<() => Promise<History>>()
      .mockReturnValueOnce(first.promise)
      .mockRejectedValue(new Error("Unauthorized"));
    const onDone = vi.fn();
    const poll = pollForStoredReply({ fetchHistory, onDone, intervalMs: 4000, retryMs: 12_000 });

    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchHistory).toHaveBeenCalledTimes(1); // in flight
    poll.stop(); // the page unmounts (or the user signs out)
    first.resolve(awaiting);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(poll.stopped).toBe(true);
  });

  it("checks again while the answer is pending, then shows it once", async () => {
    const fetchHistory = vi
      .fn<() => Promise<History>>()
      .mockResolvedValueOnce(awaiting)
      .mockResolvedValueOnce(answered);
    const onDone = vi.fn();
    pollForStoredReply({ fetchHistory, onDone, intervalMs: 4000, retryMs: 12_000 });

    await vi.advanceTimersByTimeAsync(4000);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(answered);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("retries a passing failure later, but gives up when the user is signed out", async () => {
    const fetchHistory = vi
      .fn<() => Promise<History>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValue(new Error("Unauthorized: No authorization header provided"));
    const onFatal = vi.fn();
    const poll = pollForStoredReply({
      fetchHistory,
      onDone: vi.fn(),
      intervalMs: 4000,
      retryMs: 12_000,
      isFatal: (error) => error instanceof Error && error.message.startsWith("Unauthorized"),
      onFatal,
    });

    await vi.advanceTimersByTimeAsync(4000); // network failure: retry in 12 s
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000); // signed out: stop
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(onFatal).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(poll.stopped).toBe(true);
  });
});

describe("bullet lines in assistant replies", () => {
  it("turns '•' lines into Markdown list items", () => {
    expect(normalizeBullets("**📬 Inbox (2 unread)**\n\n• **A** — *x*\n• **B** — *y*")).toBe(
      "**📬 Inbox (2 unread)**\n\n- **A** — *x*\n- **B** — *y*",
    );
    expect(normalizeBullets("  ● nested\n▪item")).toBe("  - nested\n- item");
  });

  it("leaves '- ' lists, ordinary text and code blocks alone", () => {
    const text = "- one\n- two\n\nPrice • 5 CHF\n```\n• not a list\n```";
    expect(normalizeBullets(text)).toBe(text);
  });
});

describe("stored failed turns on the hosted demo", () => {
  const ollama = {
    role: "assistant",
    content:
      "⚠️ Could not reach Ollama at http://localhost:11434/v1. Is it running? (For local Ollama: docker ps shows the Ollama container on port 11434.)",
    panel_payload: { failed: true },
  };

  it("shows a short note instead of developer details on the hosted demo", () => {
    expect(storedMessageText(ollama, true)).toBe(FAILED_TURN_NOTE);
    expect(
      storedMessageText(
        {
          ...ollama,
          content:
            "⚠️ The AI took too long. A local model on CPU can be slow; raise LLM_TIMEOUT_MS.",
        },
        true,
      ),
    ).toBe(FAILED_TURN_NOTE);
  });

  it("keeps the stored text on a local run, for ordinary failures and for answers", () => {
    expect(storedMessageText(ollama, false)).toBe(ollama.content);
    const plain = {
      ...ollama,
      content: "⚠️ The AI assistant could not be reached. Please try again later.",
    };
    expect(storedMessageText(plain, true)).toBe(plain.content);
    // An answer that mentions localhost (the user asked about it) is not a failed turn.
    const answer = {
      role: "assistant",
      content: "Open http://localhost:3000 in your browser.",
      panel_payload: {},
    };
    expect(storedMessageText(answer, true)).toBe(answer.content);
  });

  it("words the cut-off note for visitors (no server internals)", () => {
    expect(INTERRUPTED_NOTE).not.toMatch(/server restarted|dev server/i);
    expect(INTERRUPTED_NOTE).toMatch(/Please send it again\.$/);
  });
});
