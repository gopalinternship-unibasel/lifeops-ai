import { describe, expect, it } from "vitest";
import {
  inboxTasksPromptBlock,
  INBOX_TASKS_RULE,
  itemValue,
  limitDayItems,
  maxItemsForDate,
} from "@/server/plan-inbox.server";
import type { WeekPlanItem } from "@/types/plan";

const ZRH = "Europe/Zurich";
const item = (emoji: string, title: string, from: string, to: string): WeekPlanItem => ({
  emoji,
  title,
  starts_at: `2026-11-27T${from}:00+01:00`,
  ends_at: `2026-11-27T${to}:00+01:00`,
});

describe("inbox tasks in the week-plan prompt (L3)", () => {
  it("lists title, importance and the local deadline, most important and earliest first", () => {
    const block = inboxTasksPromptBlock(
      [
        { title: "Lunch with Sam", importance: "low" },
        { title: "Write research paper final draft", importance: "high", deadline: "2026-11-28T16:00:00.000Z" },
        { title: "Prepare for Acme onsite interview", importance: "high", deadline: "2026-11-29T17:00:00.000Z" },
      ],
      ZRH,
    );
    expect(block.split("\n")).toEqual([
      "  - [high] Write research paper final draft (due 2026-11-28 17:00)",
      "  - [high] Prepare for Acme onsite interview (due 2026-11-29 18:00)",
      "  - [low] Lunch with Sam (no deadline)",
    ]);
    expect(inboxTasksPromptBlock([], ZRH)).toBe("");
  });

  it("the rule asks for high-importance tasks before their deadlines", () => {
    expect(INBOX_TASKS_RULE).toMatch(/\[high\] task.*BEFORE its deadline/);
  });
});

describe("the plan's limit of items per day (L3)", () => {
  it("is 4 on a weekday and 3 on a weekend day", () => {
    expect(maxItemsForDate("2026-11-27")).toBe(4);
    expect(maxItemsForDate("2026-11-28")).toBe(3);
    expect(maxItemsForDate("2026-11-29")).toBe(3);
  });

  it("drops filler (snack, break, movie) before work and inbox tasks, and never a kept item", () => {
    const tasks = [{ title: "Write research paper final draft", importance: "high" as const }];
    const paper = item("✍️", "Paper final draft", "09:00", "11:00");
    const items = [
      item("☕", "Afternoon snack", "15:00", "15:30"),
      paper,
      item("🎬", "Movie or show", "20:00", "22:00"),
      item("🥗", "Lunch", "12:00", "13:00"),
      item("☕", "Evening break", "18:00", "18:20"),
      item("🎯", "Deep work", "14:00", "16:00"),
    ];
    const kept = items[0]; // in the calendar already
    const result = limitDayItems(items, 4, (candidate) => candidate === kept, tasks);
    expect(result.dropped).toBe(2);
    expect(result.items).toHaveLength(4);
    expect(result.items).toContain(kept);
    expect(result.items).toContain(paper);
    expect(result.items.map((i) => i.title)).not.toContain("Movie or show");
    expect(result.items.map((i) => i.title)).not.toContain("Evening break");
    expect(itemValue(paper, tasks)).toBe(100);
  });

  it("leaves a day within its limit alone", () => {
    const items = [item("🎯", "Deep work", "09:00", "11:00")];
    expect(limitDayItems(items, 4, () => false, [])).toEqual({ items, dropped: 0 });
  });
});

describe("second round: scoring, past deadlines and the weekday break (H7)", () => {
  it("an inbox match counts only for a high or medium task", () => {
    const tasks = [
      { title: "Lunch with Sam", importance: "low" as const },
      { title: "Write research paper final draft", importance: "medium" as const },
    ];
    expect(itemValue(item("🥗", "Lunch", "12:00", "13:00"), tasks)).toBe(40);
    expect(itemValue(item("✍️", "Paper final draft", "09:00", "11:00"), tasks)).toBe(100);
  });

  it("'Show and tell prep' is work, a movie is not", () => {
    expect(itemValue(item("🎯", "Show and tell prep", "09:00", "10:00"), [])).toBe(60);
    expect(itemValue(item("🎬", "Movie or show", "20:00", "22:00"), [])).toBe(10);
  });

  it("leaves out inbox tasks whose deadline is before now", () => {
    const tasks = [
      { title: "Team sync at 7 PM", importance: "high" as const, deadline: "2026-11-26T18:00:00.000Z" },
      { title: "Write paper", importance: "high" as const, deadline: "2026-11-28T18:00:00.000Z" },
    ];
    const now = Date.parse("2026-11-26T19:00:00Z");
    expect(inboxTasksPromptBlock(tasks, ZRH, now)).toBe("  - [high] Write paper (due 2026-11-28 19:00)");
  });

  it("a weekday keeps one walk or break when trimming", () => {
    const items = [
      item("☕", "Short break", "10:00", "10:15"),
      item("🎯", "Deep work", "09:00", "11:00"),
      item("📚", "Study", "11:30", "12:30"),
      item("🥗", "Lunch", "12:30", "13:00"),
      item("🎬", "Movie or show", "20:00", "22:00"),
    ];
    const kept = limitDayItems(items, 4, () => false, [], true).items.map((i) => i.title);
    expect(kept).toContain("Short break");
    expect(kept).not.toContain("Movie or show");
    expect(limitDayItems(items, 4, () => false, []).items.map((i) => i.title)).not.toContain("Short break");
  });
});
