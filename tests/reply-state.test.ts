import { describe, expect, it, vi } from "vitest";
import { replyStateOf } from "@/lib/reply-state";
import { planRequestView } from "@/lib/plan-request";
import {
  isFailedTurn,
  maxChatTurnMs,
  refusesOverLimit,
  upcomingDates,
} from "@/server/chat-turn.server";

const now = Date.parse("2026-11-09T18:00:00Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const FIFTEEN_MIN = 15 * 60_000;

describe("reply state of a chat history (a reloaded page knows whether an answer is coming)", () => {
  it("is 'awaiting' while the last message is the user's and younger than the longest turn", () => {
    const state = replyStateOf(
      [{ role: "user", created_at: at(10) }],
      now,
      FIFTEEN_MIN,
    );
    expect(state).toEqual({ kind: "awaiting", since: at(10), remainingMs: 5 * 60_000 });
  });

  it("is 'answered' when an assistant message (answer or failed turn) comes last, or there is none", () => {
    expect(replyStateOf([], now, FIFTEEN_MIN)).toEqual({ kind: "answered" });
    expect(
      replyStateOf([{ role: "user", created_at: at(20) }, { role: "assistant", created_at: at(5) }], now, FIFTEEN_MIN),
    ).toEqual({ kind: "answered" });
  });

  it("is 'interrupted' when the user's message is older than a turn can take (no answer will come)", () => {
    expect(replyStateOf([{ role: "user", created_at: at(16) }], now, FIFTEEN_MIN)).toEqual({
      kind: "interrupted",
      since: at(16),
    });
  });

  it("a turn may take the model timeout (twice with a fallback model) plus two minutes", () => {
    expect(maxChatTurnMs({ LLM_TIMEOUT_MS: "900000", LLM_BASE_URL: "http://localhost:11434/v1" })).toBe(900_000 + 120_000);
    expect(maxChatTurnMs({ LLM_TIMEOUT_MS: "900000", HUGGINGFACE_API_KEY: "hf_test" })).toBe(2 * 900_000 + 120_000);
  });

  it("failed turns are recognised by their panel marker", () => {
    expect(isFailedTurn({ role: "assistant", panel_payload: { failed: true } })).toBe(true);
    expect(isFailedTurn({ role: "assistant", panel_payload: { priorities: [] } })).toBe(false);
    expect(isFailedTurn({ role: "user", panel_payload: { failed: true } })).toBe(false);
    expect(isFailedTurn({ role: "assistant", panel_payload: null })).toBe(false);
  });
});

describe("stored plan requests (the dashboard's 'Plan it' survives a reload)", () => {
  const row = {
    id: "r1",
    input: "Gym tomorrow at 6 pm and call mom.",
    status: "running",
    result: null,
    error: null,
    created_at: at(3),
    finished_at: null,
  };

  it("a running request younger than the limit is still running; older, it was cut off", () => {
    expect(planRequestView(row, now, FIFTEEN_MIN).status).toBe("running");
    expect(planRequestView({ ...row, created_at: at(30) }, now, FIFTEEN_MIN).status).toBe("interrupted");
  });

  it("a finished request carries its result; a failed one its error", () => {
    const done = planRequestView(
      {
        ...row,
        status: "done",
        finished_at: at(1),
        result: { mode: "service", summary: "2 tasks", planner: "llm", note: null, tasks: 2, actions: 1 },
      },
      now,
      FIFTEEN_MIN,
    );
    expect(done).toMatchObject({ status: "done", finishedAt: at(1), result: { mode: "service", summary: "2 tasks", tasks: 2, actions: 1 } });

    const inApp = planRequestView(
      { ...row, status: "done", result: { mode: "in-app", reason: "offline", reply: "Done.", panel: { priorities: [] } } },
      now,
      FIFTEEN_MIN,
    );
    expect(inApp.result).toEqual({ mode: "in-app", reason: "offline", reply: "Done.", panel: { priorities: [] } });

    const failed = planRequestView({ ...row, status: "failed", error: "Planner service: boom" }, now, FIFTEEN_MIN);
    expect(failed).toMatchObject({ status: "failed", error: "Planner service: boom", result: null });
  });
});

describe("calendar dates in the chat prompt", () => {
  it("spells out the next days with weekday names in the user's time zone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T23:30:00Z")); // Tuesday 00:30 in Zurich, still Monday in UTC
    expect(upcomingDates("Europe/Zurich", 3)).toBe("Tuesday 2026-11-10 (today), Wednesday 2026-11-11 (tomorrow), Thursday 2026-11-12");
    expect(upcomingDates("UTC", 1)).toBe("Monday 2026-11-09 (today)");
    vi.useRealTimers();
  });
});

describe("a chat turn over the demo limit", () => {
  const failed = { role: "assistant", panel_payload: { failed: true } };

  it("is refused before its message is stored, unless it is the first visit's briefing", () => {
    expect(refusesOverLimit({ briefing: false, earlierMessages: [] })).toBe(true);
    expect(refusesOverLimit({ earlierMessages: [] })).toBe(true);
    expect(refusesOverLimit({ briefing: true, earlierMessages: [] })).toBe(false);
    // Failed turns do not count: the briefing is still the first visit's.
    expect(refusesOverLimit({ briefing: true, earlierMessages: [failed] })).toBe(false);
  });

  it("refuses a briefing that is not the first visit's", () => {
    expect(
      refusesOverLimit({ briefing: true, earlierMessages: [{ role: "user", panel_payload: null }] }),
    ).toBe(true);
    expect(
      refusesOverLimit({
        briefing: true,
        earlierMessages: [failed, { role: "assistant", panel_payload: {} }],
      }),
    ).toBe(true);
  });
});
