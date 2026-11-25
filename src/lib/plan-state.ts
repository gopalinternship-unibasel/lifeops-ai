/**
 * Which items of a week plan are already in the calendar. Approving writes each item as an
 * event titled "<emoji> <title>" at the item's times; after a reload the plan page used to show
 * every approved item twice (once as a "(busy)" event, once as a plan item) and offer Approve
 * again, because "approved" was only page state (QA round 3). The server now works it out from
 * the calendar itself, so it is right after a reload, in another tab and after a restart.
 */
import type { BusyEvent, WeekPlan } from "@/types/plan";
import type { WeekPlanRequestView } from "@/lib/week-plan-request";

export interface PlanCalendarState {
  /** Per date: indexes of the items that are in the calendar. */
  addedItems: Record<string, number[]>;
  /** Days whose items are all in the calendar (items whose time has passed do not count against it). */
  approvedDates: string[];
  /** The week's calendar events that are not one of the plan's items. */
  otherEvents: BusyEvent[];
  /**
   * Ids of the calendar events that are items of this plan (events without an id are left out).
   * The server stores these as weekly_plans.approved_event_ids, so the column follows the calendar
   * instead of a running list that a regenerate reset and two parallel approvals overwrote.
   */
  addedEventIds: string[];
}

/** A calendar event as the plan sees it; the id is there when the event came from a calendar. */
export type PlanCalendarEvent = BusyEvent & { id?: string };

/** The event title an approved plan item gets. */
export function planItemEventTitle(item: { emoji?: string; title: string }): string {
  return `${item.emoji ?? ""} ${item.title}`.trim();
}

function key(title: string, startsAt: string, endsAt: string): string {
  return `${title.trim()}|${Date.parse(startsAt)}|${Date.parse(endsAt)}`;
}

export function planCalendarState(plan: WeekPlan | null, events: PlanCalendarEvent[], nowMs: number): PlanCalendarState {
  const state: PlanCalendarState = { addedItems: {}, approvedDates: [], otherEvents: events, addedEventIds: [] };
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
  state.addedEventIds = events
    .filter((event) => event.id && itemKeys.has(key(event.title, event.starts_at, event.ends_at)))
    .map((event) => event.id as string);
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

/* ------------------------------------------------------------------------------------------ *
 * The plan page's chat commands and small rules, kept here as plain functions so they can be
 * tested without a browser.
 * ------------------------------------------------------------------------------------------ */

const DAY_NAME_TO_OFFSET: Record<string, number> = {
  monday: 0, mon: 0, tuesday: 1, tue: 1, tues: 1, wednesday: 2, wed: 2,
  thursday: 3, thu: 3, thurs: 3, friday: 4, fri: 4, saturday: 5, sat: 5,
  sunday: 6, sun: 6,
};

/**
 * Words that may stand next to "approve" without changing what is approved. Not "day": "approve
 * this day" names one day without saying which, so it must not add the whole week.
 */
const APPROVE_FILLER = new Set([
  "a", "all", "also", "and", "days", "entire", "event", "events", "everything", "for", "full",
  "it", "item", "items", "just", "my", "now", "of", "on", "only", "plan", "plans", "please", "that",
  "the", "this", "too", "week", "weeks", "whole",
]);

export const APPROVE_CLARIFY_REPLY =
  "Nothing was added. Say “approve” to add the whole week, or name the days, for example “approve Saturday” or “approve Monday and Tuesday”. To change the plan, describe the change without the word “approve”.";

/** Shown when "approve …" is typed before there is a plan (plain text: the page shows no Markdown). */
export const NO_PLAN_YET_REPLY = "There's no plan yet — say “Please create this week's plan for me” first.";

export const WEEK_OVER_REPLY =
  "This week is already over, so there is nothing left to plan. Go to this week or a later one.";

/**
 * What an "approve …" message asks for: nothing (not an approve command, so it refines the plan),
 * the whole week, some days, or something unclear. Unclear text approves nothing: "Approve
 * Saturday." and "approve the hike" used to add the whole week to the calendar, because only the
 * first word was looked at and anything unknown fell back to "approve all".
 *
 * `monday` is the week on screen and `today` the local date; "today" and "tomorrow" count only
 * when they are in that week.
 */
export type ApproveCommand =
  | { kind: "not-approve" }
  | { kind: "week" }
  | { kind: "days"; dates: string[] }
  | { kind: "unclear"; reply: string };

export function parseApproveCommand(raw: string, monday: string, today: string): ApproveCommand {
  const text = raw.trim().toLowerCase().replace(/[’`]/g, "'");
  if (!/^approve\b/.test(text)) return { kind: "not-approve" };
  const words = text
    .replace(/^approve\b/, " ")
    .replace(/'s\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const offsets = new Set<number>();
  for (const word of words) {
    if (word in DAY_NAME_TO_OFFSET) {
      offsets.add(DAY_NAME_TO_OFFSET[word]);
    } else if (word === "weekday" || word === "weekdays") {
      [0, 1, 2, 3, 4].forEach((offset) => offsets.add(offset));
    } else if (word === "weekend" || word === "weekends") {
      offsets.add(5);
      offsets.add(6);
    } else if (word === "today" || word === "tomorrow") {
      const offset = daysBetweenISO(monday, word === "today" ? today : addDaysToISODate(today, 1));
      if (offset < 0 || offset > 6) {
        return {
          kind: "unclear",
          reply: `Nothing was added: ${word} is not in the week shown. Go to that week first, or name a day of this week, for example “approve Saturday”.`,
        };
      }
      offsets.add(offset);
    } else if (!APPROVE_FILLER.has(word)) {
      return { kind: "unclear", reply: APPROVE_CLARIFY_REPLY };
    }
  }
  if (offsets.size === 0) return { kind: "week" };
  return {
    kind: "days",
    dates: [...offsets].sort((a, b) => a - b).map((offset) => addDaysToISODate(monday, offset)),
  };
}

const PLAIN_CREATE_REQUEST =
  /^(please )?(create|make|draft|plan)( me)?( a| my| the| this week's| this weeks| a weekly| my weekly)?( week| weekly)? (plan|week)( for (me|this week|the week|my week))*( please)?$/;

/**
 * What a "create a plan" message adds to the request. The plain request ("Please create this
 * week's plan for me") adds nothing; anything more ("Create a plan with deep work every morning",
 * "…, but keep Saturday free") is passed on as instructions, which used to be dropped. The server
 * accepts 1,000 characters of instructions.
 */
export function planCreateInstructions(text: string): string | undefined {
  const trimmed = text.trim();
  const plain = trimmed
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain || PLAIN_CREATE_REQUEST.test(plain)) return undefined;
  return trimmed.slice(0, 1000);
}

/** True once the whole week (Monday 00:00 to the next Monday 00:00, local time) is over. */
export function weekIsOver(monday: string, nowMs: number): boolean {
  const [year, month, day] = monday.split("-").map(Number);
  return new Date(year, month - 1, day + 7).getTime() <= nowMs;
}

/**
 * Whether a plan item's time can still be edited: not in the calendar yet and not started. The
 * server refuses edits of items that have started (they can no longer be approved), so the page
 * does not offer the editor for them.
 */
export function canEditPlanItem(
  item: { starts_at: string },
  opts: { added: boolean; dayApproved: boolean; nowMs: number },
): boolean {
  return !opts.dayApproved && !opts.added && Date.parse(item.starts_at) > opts.nowMs;
}

/** "HH:MM" of an instant in local time (the page runs in the browser's zone). */
export function localHM(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** An item's new times from the editor's "HH:MM" fields, each kept on its own day (local time). */
export function editedItemTimes(
  item: { starts_at: string; ends_at: string },
  start: string,
  end: string,
): { starts_at: string; ends_at: string } {
  const merge = (iso: string, hm: string) => {
    const [h, m] = hm.split(":").map(Number);
    const d = new Date(iso);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  return { starts_at: merge(item.starts_at, start), ends_at: merge(item.ends_at, end) };
}

/**
 * What the plan page waits for while a draft runs. The hosted sites use a hosted AI service that
 * answers in about half a minute; only a local run may use a model on the same computer.
 */
export function draftingWaitText(hosted: boolean): string {
  return hosted ? "This usually takes under a minute." : "A local AI model can take several minutes.";
}

/* ------------------------------------------------------------------------------------------ *
 * The plan page's view of the week on screen, as a reducer, so that switching weeks, late
 * answers and reloads can be tested without a browser.
 * ------------------------------------------------------------------------------------------ */

/** The server's view of a week, as fetchWeekPlan, a draft or a refinement returns it. */
export interface PlanServerState {
  plan: WeekPlan | null;
  busyEvents?: BusyEvent[];
  addedItems?: Record<string, number[]>;
  approvedDates?: string[];
  calendarError?: string | null;
  /** Left out (undefined) when the answer does not say; null when the week has no request. */
  request?: WeekPlanRequestView | null;
}

export interface PlanWeekView {
  /** The week (its Monday) this view belongs to. */
  week: string;
  /** The newest load of the week; answers of older loads are ignored. */
  loadSeq: number;
  loading: boolean;
  /** Loading the week failed: the plan is unknown, so the page shows this with Retry. */
  loadError: string | null;
  plan: WeekPlan | null;
  busyEvents: BusyEvent[];
  addedItems: Record<string, number[]>;
  approvedDates: Set<string>;
  /** The plan loaded but the calendar did not: approving waits until it loads. */
  calendarError: string | null;
  request: WeekPlanRequestView | null;
  /**
   * Bumped whenever a plan comes from the server. The page keys the week grid with it, so a time
   * editor left open when a refinement lands starts again from the new plan (finding 7).
   */
  version: number;
}

export type PlanWeekAction =
  | { type: "load-started"; week: string; seq: number }
  | { type: "loaded"; seq: number; state: PlanServerState }
  | { type: "load-failed"; seq: number; message: string }
  /** A plan for `week` from a draft, a refinement, a poll or an approval. */
  | { type: "server-state"; week: string; state: PlanServerState }
  /** A draft starts: shown as running until the server answers. */
  | { type: "request-started"; week: string; request: WeekPlanRequestView }
  /** A time edit, shown before the server confirms it. */
  | { type: "item-times"; week: string; date: string; index: number; starts_at: string; ends_at: string }
  /** The server refused a time edit: back to the plan from before, unless a newer one came since. */
  | { type: "plan-restored"; week: string; version: number; plan: WeekPlan | null };

export function initialPlanWeekView(week: string): PlanWeekView {
  return {
    week,
    loadSeq: 0,
    loading: true,
    loadError: null,
    plan: null,
    busyEvents: [],
    addedItems: {},
    approvedDates: new Set(),
    calendarError: null,
    request: null,
    version: 0,
  };
}

function withServerState(view: PlanWeekView, state: PlanServerState): PlanWeekView {
  return {
    ...view,
    plan: state.plan ?? null,
    busyEvents: state.busyEvents ?? [],
    addedItems: state.addedItems ?? {},
    approvedDates: new Set(state.approvedDates ?? []),
    calendarError: state.calendarError ?? null,
    loadError: null,
    request: state.request !== undefined ? state.request : view.request,
    version: view.version + 1,
  };
}

export function planWeekReducer(view: PlanWeekView, action: PlanWeekAction): PlanWeekView {
  switch (action.type) {
    case "load-started":
      // Nothing of the week shown before stays: when a load failed, the previous week's plan
      // stayed on screen under the new week's heading, and its buttons acted on the new week.
      return { ...initialPlanWeekView(action.week), loadSeq: action.seq, version: view.version };
    case "loaded":
      // An answer for a week the page has left (or an older load of this one) is dropped.
      if (action.seq !== view.loadSeq) return view;
      return { ...withServerState(view, action.state), loading: false };
    case "load-failed":
      if (action.seq !== view.loadSeq) return view;
      return { ...view, loading: false, loadError: action.message };
    case "server-state":
      // A draft can take minutes: when it returns, the page may show another week.
      if (action.week !== view.week) return view;
      return withServerState(view, action.state);
    case "request-started":
      if (action.week !== view.week) return view;
      return { ...view, request: action.request };
    case "item-times": {
      if (action.week !== view.week || !view.plan) return view;
      const days = view.plan.days.map((day) =>
        day.date !== action.date
          ? day
          : {
              ...day,
              items: day.items.map((item, index) =>
                index === action.index ? { ...item, starts_at: action.starts_at, ends_at: action.ends_at } : item,
              ),
            },
      );
      return { ...view, plan: { ...view.plan, days } };
    }
    case "plan-restored":
      if (action.week !== view.week || action.version !== view.version) return view;
      return { ...view, plan: action.plan };
  }
}

/** YYYY-MM-DD plus `days` (calendar arithmetic, independent of time zones). */
export function addDaysToISODate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function daysBetweenISO(from: string, to: string): number {
  const toUtc = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}
