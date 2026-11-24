import { describe, expect, it } from "vitest";
import {
  appendInsight,
  bulletText,
  calendarStatus,
  gateModelCards,
  normalizeAlternatives,
  normalizeInsightCard,
  normalizeStringArray,
  supersededChanges,
  tabForPanel,
  uniqueKeys,
} from "@/lib/panel-state";
import type { InsightCard, PendingEventChange } from "@/types/panel";

describe("insight bullets the model sent in the wrong shape", () => {
  it("shows object bullets as text and drops null, never '[object Object]' or 'null'", () => {
    const bullets = normalizeStringArray([
      { exercise: "Bench press", sets: 3 },
      "Dips 3x10",
      null,
      { name: "Swim" },
      "  ",
    ]);
    expect(bullets).toEqual(["exercise: Bench press, sets: 3", "Dips 3x10", "Swim"]);
    expect(bullets.join(" ")).not.toMatch(/\[object Object\]|\bnull\b/);
  });

  it("reads a stored JSON string of bullets and ignores anything else", () => {
    expect(normalizeStringArray('["a", 2, true]')).toEqual(["a", "2", "true"]);
    expect(normalizeStringArray("not json")).toEqual([]);
    expect(normalizeStringArray(42)).toEqual([]);
    expect(bulletText({ text: " Use oat milk " })).toBe("Use oat milk");
    expect(bulletText([1, 2])).toBeNull();
  });

  it("drops cards without a title or without bullets to show", () => {
    expect(
      normalizeInsightCard({ kind: "workout", title: "Push day", bullets: [null, {}] }),
    ).toBeUndefined();
    expect(normalizeInsightCard({ kind: "workout", title: "", bullets: ["x"] })).toBeUndefined();
    expect(normalizeInsightCard({ kind: "odd", title: "Plan", bullets: ["x"] })).toEqual({
      kind: "summary",
      title: "Plan",
      bullets: ["x"],
    });
    expect(normalizeAlternatives({ title: "Friday Alternatives", bullets: [] })).toBeUndefined();
  });
});

describe("the model's optional cards are kept only where the request calls for them", () => {
  const summary: InsightCard = {
    kind: "summary",
    title: "Friday Overview",
    bullets: ["One event"],
  };
  const workout: InsightCard = { kind: "workout", title: "Push day", bullets: ["Bench press 3x8"] };
  const alternatives = {
    title: "Friday Alternatives",
    bullets: ["No other events or tasks listed for Friday."],
  };

  it("drops a summary and alternatives for an ordinary calendar question (live QA, 24 Nov 2026)", () => {
    expect(gateModelCards("What's on Friday?", { insight: summary, alternatives })).toEqual({
      insight: undefined,
      alternatives: undefined,
    });
    expect(gateModelCards("Send my reply to Sam now", { insight: summary, alternatives })).toEqual({
      insight: undefined,
      alternatives: undefined,
    });
  });

  it("keeps alternatives when the user lacks something, with straight or curly apostrophes", () => {
    const eggs = { title: "Egg substitutes", bullets: ["Mashed banana"] };
    expect(
      gateModelCards("I don't have eggs for the pancakes", { alternatives: eggs }).alternatives,
    ).toEqual(eggs);
    expect(gateModelCards("I don’t have eggs", { alternatives: eggs }).alternatives).toEqual(eggs);
    expect(
      gateModelCards("We ran out of milk, what can I use instead?", { alternatives: eggs })
        .alternatives,
    ).toEqual(eggs);
  });

  it("keeps summaries the user asked for, and workout, meal and meeting-prep cards", () => {
    expect(gateModelCards("Give me a summary of my week", { insight: summary }).insight).toEqual(
      summary,
    );
    expect(gateModelCards("Help me prep for the interview", { insight: summary }).insight).toEqual(
      summary,
    );
    expect(gateModelCards("Block 3-5 pm gym push workout", { insight: workout }).insight).toEqual(
      workout,
    );
  });

  it("never keeps a card without bullets", () => {
    expect(
      gateModelCards("summarize my day", { insight: { ...summary, bullets: [] } }).insight,
    ).toBeUndefined();
  });
});

describe("which tab the panel shows after a turn", () => {
  const now = new Date(2026, 10, 24, 10);
  const pendingEvent = {
    id: "p1",
    title: "Gym",
    starts_at: new Date(2026, 10, 24, 15).toISOString(),
    ends_at: new Date(2026, 10, 24, 17).toISOString(),
  };
  const summary: InsightCard = { kind: "summary", title: "Overview", bullets: ["x"] };
  const workout: InsightCard = { kind: "workout", title: "Push day", bullets: ["x"] };
  const alternatives = { title: "Alternatives", bullets: ["y"] };

  it("stays on the priorities or the proposals when an extra summary or alternatives card comes along", () => {
    const priorities = [{ rank: 1, title: "Interview", reason: "Tomorrow" }];
    expect(tabForPanel({ priorities, alternatives }, { alternatives }, now)).toBe("priorities");
    expect(tabForPanel({ priorities, insight: summary }, { insight: summary }, now)).toBe(
      "priorities",
    );
    expect(
      tabForPanel({ pendingEvents: [pendingEvent], insight: summary }, { insight: summary }, now),
    ).toBe("schedule");
  });

  it("shows Insights when the card is what the turn was about", () => {
    expect(tabForPanel({ insight: summary }, { insight: summary }, now)).toBe("insights");
    expect(tabForPanel({ alternatives }, { alternatives }, now)).toBe("insights");
    expect(
      tabForPanel({ pendingEvents: [pendingEvent], insight: workout }, { insight: workout }, now),
    ).toBe("insights");
    expect(
      tabForPanel({ emailDraft: { messageId: "m", to: "a", subject: "s", body: "b" } }, {}, now),
    ).toBe("insights");
  });

  it("does not switch for a card the gate dropped, or for an empty panel", () => {
    expect(tabForPanel({ insight: summary }, {}, now)).toBeUndefined();
    expect(tabForPanel({}, {}, now)).toBeUndefined();
  });

  it("adds an insight card that equals one already listed only once", () => {
    const list = appendInsight(appendInsight([], workout), summary);
    expect(appendInsight(list, { ...workout })).toEqual([summary, workout]);
  });
});

describe("move cards for an event that was just changed", () => {
  const original = {
    title: "Run",
    starts_at: "2026-11-24T18:00:00Z",
    ends_at: "2026-11-24T19:00:00Z",
  };
  const a: PendingEventChange = {
    id: "a",
    kind: "update",
    event_id: "ev-1",
    original,
    next: { starts_at: "2026-11-25T09:00:00Z" },
  };
  const b: PendingEventChange = {
    id: "b",
    kind: "update",
    event_id: "ev-1",
    original,
    next: { starts_at: "2026-11-24T14:00:00Z" },
  };
  const c: PendingEventChange = {
    id: "c",
    kind: "delete",
    event_id: "ev-2",
    original: { ...original, title: "Lunch" },
  };

  it("finds the other cards for the same event (stale now) and leaves other events' cards", () => {
    expect(supersededChanges([a, b, c], a).map((card) => card.id)).toEqual(["b"]);
    expect(supersededChanges([a, c], a)).toEqual([]);
  });
});

describe("priority list keys", () => {
  it("are unique when two priorities share a title, and stay the title otherwise", () => {
    expect(uniqueKeys(["Focus block", "Interview", "Focus block", "Focus block"])).toEqual([
      "Focus block",
      "Interview",
      "Focus block#2",
      "Focus block#3",
    ]);
    expect(new Set(uniqueKeys(["a", "a"])).size).toBe(2);
  });
});

describe("the context panel's calendar badge", () => {
  it("says what was loaded instead of a constant green 'Synced'", () => {
    expect(calendarStatus({ loaded: false })).toEqual({ label: "Loading…", tone: "neutral" });
    expect(calendarStatus({ loaded: true, source: "mock" })).toEqual({
      label: "Demo data",
      tone: "amber",
    });
    expect(calendarStatus({ loaded: true, source: "google" })).toEqual({
      label: "Synced with Google",
      tone: "green",
    });
    expect(calendarStatus({ loaded: true, source: "google", error: "Could not load" })).toEqual({
      label: "Calendar unavailable",
      tone: "red",
    });
  });
});
