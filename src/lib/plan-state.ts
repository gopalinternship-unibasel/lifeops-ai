/**
 * Which items of a week plan are already in the calendar. Approving writes each item as an
 * event titled "<emoji> <title>" at the item's times; after a reload the plan page used to show
 * every approved item twice (once as a "(busy)" event, once as a plan item) and offer Approve
 * again, because "approved" was only page state (QA round 3). The server now works it out from
 * the calendar itself, so it is right after a reload, in another tab and after a restart.
 */
import type { BusyEvent, WeekPlan } from "@/types/plan";

export interface PlanCalendarState {
  /** Per date: indexes of the items that are in the calendar. */
  addedItems: Record<string, number[]>;
  /** Days whose items are all in the calendar (items whose time has passed do not count against it). */
  approvedDates: string[];
  /** The week's calendar events that are not one of the plan's items. */
  otherEvents: BusyEvent[];
}

/** The event title an approved plan item gets. */
export function planItemEventTitle(item: { emoji?: string; title: string }): string {
  return `${item.emoji ?? ""} ${item.title}`.trim();
}

function key(title: string, startsAt: string, endsAt: string): string {
  return `${title.trim()}|${Date.parse(startsAt)}|${Date.parse(endsAt)}`;
}

export function planCalendarState(plan: WeekPlan | null, events: BusyEvent[], nowMs: number): PlanCalendarState {
  const state: PlanCalendarState = { addedItems: {}, approvedDates: [], otherEvents: events };
  if (!plan) return state;
  const eventKeys = new Set(events.map((event) => key(event.title, event.starts_at, event.ends_at)));
  const itemKeys = new Set<string>();
  for (const day of plan.days) {
    const added: number[] = [];
    day.items.forEach((item, index) => {
      const itemKey = key(planItemEventTitle(item), item.starts_at, item.ends_at);
      itemKeys.add(itemKey);
      if (eventKeys.has(itemKey)) added.push(index);
    });
    if (added.length > 0) state.addedItems[day.date] = added;
    const allDone = day.items.every((item, index) => added.includes(index) || Date.parse(item.starts_at) < nowMs);
    if (added.length > 0 && allDone) state.approvedDates.push(day.date);
  }
  state.otherEvents = events.filter((event) => !itemKeys.has(key(event.title, event.starts_at, event.ends_at)));
  return state;
}

/**
 * What a day card offers. "approve" only when an item is not in the calendar yet and still
 * ahead; "added" when its items are there; "over" when nothing is left to add because the day
 * or its items are over; "empty" for a day without items. QA round 4 saw an Approve button on
 * Monday, a day that was over and had no items, next to days that read Added.
 */
export type PlanDayStatus = "approve" | "added" | "over" | "empty";

export function planDayStatus(
  day: { date: string; items: { starts_at: string }[] },
  added: number[],
  approved: boolean,
  nowMs: number,
): PlanDayStatus {
  if (approved) return "added";
  const approvable = day.items.some((item, index) => !added.includes(index) && Date.parse(item.starts_at) >= nowMs);
  if (approvable) return "approve";
  if (added.length > 0) return "added";
  // The day's end in local time (the page runs in the browser's time zone).
  const [year, month, date] = day.date.split("-").map(Number);
  const dayOver = new Date(year, month - 1, date, 23, 59, 59).getTime() < nowMs;
  return dayOver || day.items.length > 0 ? "over" : "empty";
}

/**
 * The emoji of a plan item: the first emoji the model wrote, or a bullet. The real default model
 * wrote " hal..." into the emoji field (10 Nov 2026), which was shown as the item's icon and would
 * have become part of the calendar title ("hal Evening chill") on approval.
 */
export function planItemEmoji(value: unknown): string {
  if (typeof value !== "string") return "•";
  const match = /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*/u.exec(value);
  return match ? match[0] : "•";
}
