/**
 * Round 2 of the week plan fixes, the parts that need no server: day ranges in approve commands
 * (finding 57), what a refinement asks to remove (finding 8), the reply the page's live region
 * reads out (finding 48) and the icon a stored item shows (finding 49).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APPROVE_CLARIFY_REPLY,
  liveRegionReply,
  namesPlanItem,
  parseApproveCommand,
  refinementClear,
} from "@/lib/plan-state";
import { PlanWeekGrid } from "@/components/plan/PlanWeekGrid";
import type { WeekPlan } from "@/types/plan";

const MONDAY = "2026-11-23";
const TODAY = "2026-11-24"; // a Tuesday
const dates = Array.from({ length: 7 }, (_, i) => `2026-11-${23 + i}`);
const [MON, TUE, WED, THU, FRI, SAT, SUN] = dates;

describe("day ranges in approve commands (finding 57)", () => {
  const parse = (text: string) => parseApproveCommand(text, MONDAY, TODAY);

  it("a range approves every day in it, not only its two ends", () => {
    expect(parse("approve mon-wed")).toEqual({ kind: "days", dates: [MON, TUE, WED] });
    expect(parse("approve Monday to Wednesday")).toEqual({ kind: "days", dates: [MON, TUE, WED] });
    expect(parse("approve monday through wednesday")).toEqual({ kind: "days", dates: [MON, TUE, WED] });
    expect(parse("approve from Thu till Sat")).toEqual({ kind: "days", dates: [THU, FRI, SAT] });
    expect(parse("Approve Wednesday–Friday.")).toEqual({ kind: "days", dates: [WED, THU, FRI] });
    expect(parse("approve mon - tue and saturday")).toEqual({ kind: "days", dates: [MON, TUE, SAT] });
  });

  it("a range that runs backwards, or one without an end, adds nothing", () => {
    expect(parse("approve fri-mon")).toEqual({ kind: "unclear", reply: APPROVE_CLARIFY_REPLY });
    expect(parse("approve monday to")).toEqual({ kind: "unclear", reply: APPROVE_CLARIFY_REPLY });
    expect(parse("approve from thursday")).toEqual({ kind: "unclear", reply: APPROVE_CLARIFY_REPLY });
  });

  it("a word that every object has is not a day ('approve constructor' used to throw)", () => {
    expect(parse("approve constructor")).toEqual({ kind: "unclear", reply: APPROVE_CLARIFY_REPLY });
  });

  it("a hyphen between other words is not a range", () => {
    expect(parse("approve check-in")).toEqual({ kind: "unclear", reply: APPROVE_CLARIFY_REPLY });
    expect(parse("approve saturday")).toEqual({ kind: "days", dates: [SAT] });
  });
});

describe("what a refinement asks to remove (finding 8)", () => {
  const clear = (text: string) => refinementClear(text, MONDAY, TODAY);

  it("asks for nothing without a clearing word", () => {
    expect(clear("Make the week a bit lighter")).toEqual({ kind: "none" });
    expect(clear("Keep the weekend open")).toEqual({ kind: "none" });
  });

  it.each([
    "remove everything",
    "clear the rest of the week",
    "Clear the rest of the week, I'm travelling",
    "Clear the rest of the week because I'm travelling",
    "I'm sick, cancel everything",
    "Could you please wipe my whole plan?",
    "no plans this week",
    "get rid of everything",
    "scrap the whole thing",
  ])("'%s' clears the whole plan", (text) => {
    expect(clear(text)).toEqual({ kind: "all" });
  });

  it("a clearing word alone does not say that the whole plan should go", () => {
    expect(clear("remove")).toEqual({ kind: "some", dates: [], words: [] });
    expect(clear("clear it")).toEqual({ kind: "some", dates: [], words: [] });
  });

  it("a request that names a day or an activity is not a request to clear the whole plan", () => {
    expect(clear("remove the hike on Saturday")).toEqual({ kind: "some", dates: [SAT], words: ["hik"] });
    expect(clear("remove everything on Saturday")).toEqual({ kind: "some", dates: [SAT], words: [] });
    expect(clear("cancel Saturday's hike")).toEqual({ kind: "some", dates: [SAT], words: ["hik"] });
    expect(clear("remove all hikes")).toEqual({ kind: "some", dates: [], words: ["hik"] });
    expect(clear("remove the hike this week")).toEqual({ kind: "some", dates: [], words: ["hik"] });
    expect(clear("drop the reading")).toEqual({ kind: "some", dates: [], words: ["read"] });
  });

  it("ranges, 'from' and 'after' a day, the weekend, today and tomorrow name days", () => {
    expect(clear("clear wed-fri")).toMatchObject({ kind: "some", dates: [WED, THU, FRI] });
    expect(clear("clear Wednesday to Friday")).toMatchObject({ kind: "some", dates: [WED, THU, FRI] });
    expect(clear("clear everything from Friday")).toMatchObject({ kind: "some", dates: [FRI, SAT, SUN] });
    expect(clear("clear everything since Friday")).toMatchObject({ kind: "some", dates: [FRI, SAT, SUN] });
    // "since" before a reason is not a day: the whole plan.
    expect(clear("clear the rest of the week since I'm travelling")).toEqual({ kind: "all" });
    expect(clear("drop everything after Friday")).toMatchObject({ kind: "some", dates: [SAT, SUN] });
    expect(clear("clear the weekend")).toMatchObject({ kind: "some", dates: [SAT, SUN] });
    expect(clear("cancel everything today and tomorrow")).toMatchObject({ kind: "some", dates: [TUE, WED] });
  });

  it("a time of day or something to keep makes it less than the whole plan, naming no day", () => {
    expect(clear("clear all evenings")).toEqual({ kind: "some", dates: [], words: [] });
    expect(clear("cancel everything except Saturday")).toEqual({ kind: "some", dates: [], words: [] });
    expect(clear("clear the week but keep the gym")).toEqual({ kind: "some", dates: [], words: [] });
    // What follows "but" is not something to remove: Sunday is not named.
    expect(clear("remove the hike but add a walk on Sunday")).toEqual({ kind: "some", dates: [], words: ["hik"] });
  });

  it("an item is named by its activity, in any form of the word", () => {
    const hike = clear("remove the hikes");
    expect(namesPlanItem(hike as { words: string[] }, "🥾 Hike")).toBe(true);
    expect(namesPlanItem(hike as { words: string[] }, "Hiking with Sam")).toBe(true);
    expect(namesPlanItem(hike as { words: string[] }, "Bike ride")).toBe(false);
    const reading = clear("drop the reading");
    expect(namesPlanItem(reading as { words: string[] }, "Read 3")).toBe(true);
    expect(namesPlanItem(reading as { words: string[] }, "Deep work")).toBe(false);
    // Words such as "week", "time" or "morning" name no activity.
    const week = clear("remove the week review");
    expect(namesPlanItem(week as { words: string[] }, "Morning walk")).toBe(false);
  });
});

describe("the reply the plan page's live region reads out (finding 48)", () => {
  type Turn = { id: string; role: "user" | "assistant"; content: string; toasted?: boolean };

  it("is MONDAY's newest reply that was not also a toast", () => {
    const messages: Turn[] = [
      { id: "u1", role: "user", content: "Please create this week's plan for me" },
      { id: "a1", role: "assistant", content: "Here's your week plan." },
      { id: "u2", role: "user", content: "approve" },
      // Sonner announces the toast with the same sentence; the region must not repeat it.
      { id: "a2", role: "assistant", content: "✅ Added 6 events for the whole week.", toasted: true },
    ];
    expect(liveRegionReply(messages)?.id).toBe("a1");
    messages.push({ id: "a3", role: "assistant", content: "Nothing was added. Say “approve” …" });
    expect(liveRegionReply(messages)?.id).toBe("a3");
  });

  it("is nothing before MONDAY has replied", () => {
    expect(liveRegionReply<Turn>([])).toBeUndefined();
    expect(liveRegionReply<Turn>([{ id: "u1", role: "user", content: "hi" }])).toBeUndefined();
  });
});

describe("the icon of a stored item (finding 49)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 24, 9, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the first real emoji or a bullet, whatever the stored value kept for matching is", () => {
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();
    const plan: WeekPlan = {
      week_start: MONDAY,
      days: [
        {
          date: WED,
          headline: "",
          items: [
            { emoji: "", title: "No icon", starts_at: at(25, 10), ends_at: at(25, 11) },
            { emoji: " hal", title: "Old answer", starts_at: at(25, 12), ends_at: at(25, 13) },
            { emoji: "🎯", title: "Focus", starts_at: at(25, 14), ends_at: at(25, 15) },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(PlanWeekGrid, {
        plan,
        busyEvents: [],
        approvedDates: new Set<string>(),
        addedItems: {},
        onApproveDay: () => undefined,
        approving: null,
      }),
    );
    const icons = [...html.matchAll(/<span class="text-base leading-none mt-0\.5">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(icons).toEqual(["•", "•", "🎯"]);
  });
});
