import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_ERROR_MESSAGE,
  FAILED_TURN_NOTE,
  INTERRUPTED_NOTE,
  SIGNED_OUT_NOTE,
  chatErrorText,
  normalizeBullets,
  pollForStoredReply,
  type ReplyState,
} from "@/lib/reply-state";
import { storedMessageText } from "@/lib/reply-state";
import { buildRuleBasedBriefing } from "@/server/ai/briefing-fallback.server";

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

  const isUnauthorized = (error: unknown) =>
    error instanceof Error && error.message.startsWith("Unauthorized");

  it("retries a passing failure later, but gives up after the sign-in is refused twice in a row", async () => {
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
      isFatal: isUnauthorized,
      onFatal,
    });

    await vi.advanceTimersByTimeAsync(4000); // network failure: retry in 12 s
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000); // refused once: may be a token being refreshed
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(onFatal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12_000); // refused again: stop and say so
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    expect(onFatal).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    expect(poll.stopped).toBe(true);
  });

  it("keeps waiting after one refused sign-in that the next check gets past (token refreshed)", async () => {
    const fetchHistory = vi
      .fn<() => Promise<History>>()
      .mockRejectedValueOnce(new Error("Unauthorized: Invalid token"))
      .mockResolvedValueOnce(awaiting)
      .mockRejectedValueOnce(new Error("Unauthorized: Invalid token"))
      .mockResolvedValueOnce(answered);
    const onDone = vi.fn();
    const onFatal = vi.fn();
    pollForStoredReply({
      fetchHistory,
      onDone,
      intervalMs: 4000,
      retryMs: 12_000,
      isFatal: isUnauthorized,
      onFatal,
    });

    await vi.advanceTimersByTimeAsync(4000 + 12_000 + 4000 + 12_000);
    expect(fetchHistory).toHaveBeenCalledTimes(4);
    // Two refusals, but not in a row: the count starts again after the successful check.
    expect(onFatal).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(answered);
  });
});

describe("bullet lines in assistant replies", () => {
  it("turns '•' lines into Markdown list items", () => {
    expect(normalizeBullets("**📬 Inbox (2 unread)**\n\n• **A** — *x*\n• **B** — *y*")).toBe(
      "**📬 Inbox (2 unread)**\n\n- **A** — *x*\n- **B** — *y*",
    );
    expect(normalizeBullets("  ● nested\n▪ item")).toBe("  - nested\n- item");
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

describe("rule-based briefings on the hosted demo", () => {
  const ollamaReason =
    "Could not reach Ollama at http://localhost:11434/v1. Is it running? (For local Ollama: docker ps shows the Ollama container on port 11434.)";
  const rest =
    ", so this briefing was put together by simple rules. Ask again later for the AI's own ranking.\n\n**📬 Inbox (1 unread)**\n- **Sam** — *Deck* — see attached";
  // A briefing is stored as an ordinary answer (not a failed turn), with the reason in its header.
  const briefing = {
    role: "assistant",
    content: `⚠️ The AI model did not answer (${ollamaReason})${rest}`,
    panel_payload: { priorities: [] },
  };

  it("leaves the developer reason out of the first line and keeps the briefing", () => {
    expect(storedMessageText(briefing, true)).toBe(`⚠️ The AI model did not answer${rest}`);
  });

  it("masks the header the server's briefing builder actually writes", () => {
    // Tied to the real builder, so a change of its first line (which the mask must follow) fails here.
    const { reply } = buildRuleBasedBriefing({
      emails: [{ from: "Sam", subject: "Deck", snippet: "see attached", unread: true }],
      unreadCount: 1,
      todayEvents: [],
      timeZone: "Europe/Zurich",
      reason: ollamaReason,
      nowMs: Date.parse("2026-11-24T09:00:00Z"),
    });
    expect(reply).toMatch(/localhost/); // the stored text the hosted demo still holds
    const shown = storedMessageText({ role: "assistant", content: reply, panel_payload: {} }, true);
    expect(shown).not.toMatch(/localhost|docker|ollama|11434/i);
    expect(shown).toMatch(/^⚠️ The AI model did not answer, so this briefing was put together by simple rules\./);
    // Everything after the first line is the briefing itself and stays.
    expect(shown.split("\n").slice(1)).toEqual(reply.split("\n").slice(1));
  });

  it("keeps a visitor reason, and the whole text on a local run", () => {
    const visitor = {
      ...briefing,
      content: `⚠️ The AI model did not answer (The AI took too long to answer. Please try again.)${rest}`,
    };
    expect(storedMessageText(visitor, true)).toBe(visitor.content);
    expect(storedMessageText(briefing, false)).toBe(briefing.content);
    // The user's own message is never changed.
    expect(storedMessageText({ ...briefing, role: "user" }, true)).toBe(briefing.content);
  });
});

describe("chat errors on the hosted demo", () => {
  it("replaces a reason with developer details by a plain sentence", () => {
    expect(chatErrorText("The AI took too long. Raise LLM_TIMEOUT_MS.", true)).toBe(
      CHAT_ERROR_MESSAGE,
    );
    expect(chatErrorText("Could not reach Ollama at http://localhost:11434/v1.", true)).toBe(
      CHAT_ERROR_MESSAGE,
    );
  });

  it("keeps visitor reasons, and every reason on a local run", () => {
    const limit = "You have reached today's chat limit. Please try again tomorrow.";
    expect(chatErrorText(limit, true)).toBe(limit);
    expect(chatErrorText("Raise LLM_TIMEOUT_MS.", false)).toBe("Raise LLM_TIMEOUT_MS.");
  });
});

describe("the note after the sign-in was refused while waiting", () => {
  it("tells the visitor what happened and what to do, without internals", () => {
    expect(SIGNED_OUT_NOTE).toMatch(/sign-in has expired/);
    expect(SIGNED_OUT_NOTE).toMatch(/Reload the page/);
    expect(SIGNED_OUT_NOTE).not.toMatch(/401|Unauthori[sz]ed|token/i);
  });
});
