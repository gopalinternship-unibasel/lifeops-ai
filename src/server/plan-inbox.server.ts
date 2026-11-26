/**
 * The inbox's tasks in the weekly plan, and the plan's own limit of items per day.
 *
 * The CV says the plan is built from the inbox, the calendar and messy input, but the week-plan
 * prompt only had the goals and the calendar: the paper due Saturday from the professor's email
 * got no block, while the plan held snack, break and movie items and, on a Friday, 11 items
 * although the prompt asks for 2 to 4 (live check of 26 Nov 2026).
 */
import { localDateTime } from "@/server/timezone.server";
import type { WeekPlanItem } from "@/types/plan";

export interface PlanInboxTask {
  title: string;
  importance: "high" | "medium" | "low";
  /** ISO date-time, when the email names one. */
  deadline?: string;
}

/** Most inbox tasks put into the prompt. */
export const MAX_INBOX_TASKS_IN_PROMPT = 12;
const MAX_INBOX_TITLE_IN_PROMPT = 100;

/** Items per day the prompt asks for: 2 to 4 on a weekday, 2 to 3 on a weekend day. */
export const MAX_PLAN_ITEMS_WEEKDAY = 4;
export const MAX_PLAN_ITEMS_WEEKEND = 3;

const IMPORTANCE_ORDER = { high: 0, medium: 1, low: 2 } as const;

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The prompt's list of the inbox's tasks: title, importance and deadline (local date and time),
 * the most important and earliest first; tasks whose deadline is before `nowMs` are left out.
 * Empty when there are none.
 */
export function inboxTasksPromptBlock(tasks: PlanInboxTask[], timeZone: string, nowMs: number = Date.now()): string {
  const shown = [...tasks]
    .filter((task) => oneLine(task.title, 1).length > 0)
    // A task whose deadline has passed cannot be planned any more ("Team sync at 7 PM" after 19:00).
    .filter((task) => !(task.deadline && Date.parse(task.deadline) < nowMs))
    .sort(
      (a, b) =>
        IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance] ||
        (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity),
    )
    .slice(0, MAX_INBOX_TASKS_IN_PROMPT);
  if (shown.length === 0) return "";
  const lines = shown.map((task) => {
    const due = task.deadline && Number.isFinite(Date.parse(task.deadline))
      ? (() => {
          const local = localDateTime(task.deadline, timeZone);
          return `due ${local.date} ${local.hhmm}`;
        })()
      : "no deadline";
    return `  - [${task.importance}] ${oneLine(task.title, MAX_INBOX_TITLE_IN_PROMPT)} (${due})`;
  });
  return lines.join("\n");
}

/** The rule that goes with the list (static text, so it can sit with the other rules). */
export const INBOX_TASKS_RULE =
  '- If INBOX TASKS are listed below, schedule a work item for every [high] task in a free slot BEFORE its deadline (the item\'s title names the task), and for [medium] tasks when there is room. Never plan a task after its deadline; if no free slot before it is left, say so in "reply". Inbox tasks come before filler items such as breaks or a movie.';

const FILLER_WORDS = new Set([
  "the", "and", "for", "with", "work", "block", "time", "session", "your", "this", "that", "from", "into",
  "task", "tasks", "prep", "prepare", "finish", "write", "complete",
]);

function stems(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ");
  return new Set(words.filter((word) => word.length >= 3 && !FILLER_WORDS.has(word)).map((word) => word.slice(0, 5)));
}

const LOW_VALUE = /\b(snack|break|rest|chill|movie|show|nap|scroll|tv|relax|recovery)\b/i;
const LOW_VALUE_EMOJI = new Set(["☕", "🛌", "🎬"]);
const WORK_VALUE = /\b(study|work|focus|learn|writing|write|read|prep|prepare|review|project|paper|exam|assignment|interview|workout|gym|run)\b/i;
const WORK_VALUE_EMOJI = new Set(["🎯", "📚", "✍️", "📖", "🏋️"]);

/**
 * How much an item is worth keeping: 100 for one that names an inbox task, 60 for study, work and
 * workouts, 40 for meals, 30 for a walk, social, creative or outdoor item, 10 for a break, snack,
 * rest or movie. A long item (3 hours or more) is a day's signature activity and counts as 80 at least.
 */
export function itemValue(item: WeekPlanItem, inboxTasks: PlanInboxTask[]): number {
  const words = stems(item.title);
  // Only a [high] or [medium] inbox task counts: "Lunch" is not the low-importance "Lunch with Sam".
  const wanted = inboxTasks.filter((task) => task.importance !== "low");
  if (wanted.some((task) => [...stems(task.title)].some((word) => words.has(word)))) return 100;
  const hours = (Date.parse(item.ends_at) - Date.parse(item.starts_at)) / 3_600_000;
  const long = hours >= 3 ? 80 : 0;
  // Work words first: "Show and tell prep" is work, not a show.
  if (WORK_VALUE.test(item.title)) return Math.max(60, long);
  if (LOW_VALUE.test(item.title) || LOW_VALUE_EMOJI.has(item.emoji)) return Math.max(10, long);
  if (WORK_VALUE_EMOJI.has(item.emoji)) return Math.max(60, long);
  if (["🍳", "🥗", "🍝"].includes(item.emoji) || /\b(breakfast|lunch|dinner)\b/i.test(item.title)) return Math.max(40, long);
  return Math.max(30, long);
}

const BREAK_ITEM = /\b(walk|break|stroll)\b/i;

/** The most items a day may hold in a plan the model drafted: the prompt's own 2 to 4 / 2 to 3. */
export function maxItemsForDate(date: string): number {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 ? MAX_PLAN_ITEMS_WEEKEND : MAX_PLAN_ITEMS_WEEKDAY;
}

/**
 * Keeps a day to its limit by dropping the lowest-value items first (the shorter one, then the
 * later one, on a tie). An item that is kept as it is (in the calendar, or started) is never
 * dropped; when those alone fill the day, nothing else is added. Returns the items in time order
 * and how many were dropped.
 */
export function limitDayItems(
  items: WeekPlanItem[],
  max: number,
  isProtected: (item: WeekPlanItem) => boolean,
  inboxTasks: PlanInboxTask[],
  keepOneBreak = false,
): { items: WeekPlanItem[]; dropped: number } {
  if (items.length <= max) return { items, dropped: 0 };
  const isBreak = (item: WeekPlanItem) => BREAK_ITEM.test(item.title);
  // A weekday keeps one short walk or break (the prompt asks for one): the most valuable such
  // item is dropped last, and only when nothing else can be dropped.
  const spared = keepOneBreak && !items.some((item) => isProtected(item) && isBreak(item))
    ? items.filter(isBreak).sort((a, b) => itemValue(b, inboxTasks) - itemValue(a, inboxTasks))[0]
    : undefined;
  const droppable = items
    .filter((item) => !isProtected(item) && item !== spared)
    .sort(
      (a, b) =>
        itemValue(a, inboxTasks) - itemValue(b, inboxTasks) ||
        Date.parse(a.ends_at) - Date.parse(a.starts_at) - (Date.parse(b.ends_at) - Date.parse(b.starts_at)) ||
        Date.parse(b.starts_at) - Date.parse(a.starts_at),
    );
  const toDrop = new Set<WeekPlanItem>();
  for (const item of droppable) {
    if (items.length - toDrop.size <= max) break;
    toDrop.add(item);
  }
  if (spared && items.length - toDrop.size > max) toDrop.add(spared);
  return { items: items.filter((item) => !toDrop.has(item)), dropped: toDrop.size };
}
