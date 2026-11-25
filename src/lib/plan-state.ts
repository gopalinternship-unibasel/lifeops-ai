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

// A Map, not an object: "constructor" is a key of every object, and "approve constructor" made
// the date arithmetic throw.
const DAY_NAME_TO_OFFSET = new Map<string, number>([
  ["monday", 0], ["mon", 0], ["tuesday", 1], ["tue", 1], ["tues", 1], ["wednesday", 2], ["wed", 2],
  ["thursday", 3], ["thu", 3], ["thurs", 3], ["friday", 4], ["fri", 4], ["saturday", 5], ["sat", 5],
  ["sunday", 6], ["sun", 6],
]);

/** Words that join two day names into a range: "Monday to Wednesday", "mon through wed". */
const RANGE_WORDS = new Set(["to", "through", "thru", "till", "until"]);

/** Lower case, typographic quotes made plain, and a possessive "'s" removed ("Saturday's plan"). */
function plainMessage(text: string): string {
  return text.toLowerCase().replace(/[’`]/g, "'").replace(/'s\b/g, " ");
}

/**
 * A dash between two day names ("mon-wed", "Monday–Wednesday") written as "to", so that it reads
 * as a range. It used to become two separate days: "approve mon-wed" skipped Tuesday.
 */
function dayRangeDashes(text: string): string {
  return text.replace(/(\p{L}+)\s*[-‐–—]\s*(\p{L}+)/gu, (match, first: string, last: string) =>
    DAY_NAME_TO_OFFSET.has(first) && DAY_NAME_TO_OFFSET.has(last) ? `${first} to ${last}` : match,
  );
}

/** The words of a (plain) text, without punctuation. */
function wordsOf(text: string): string[] {
  return text.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

/** Week-day offsets (0 = Monday) from `first` to `last`. */
function offsetSpan(first: number, last: number): number[] {
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
}

/** What the words at one position name, if they name days of the week shown. */
type DayPhrase =
  | { kind: "days"; offsets: number[]; next: number }
  /** "today" or "tomorrow" when that date is not in the week shown. */
  | { kind: "outside"; word: string; next: number }
  /** A range that runs backwards, such as "fri-mon": which days are meant is unclear. */
  | { kind: "backwards"; next: number };

/**
 * The days named by the words starting at `index`: a day name, a range ("monday to wednesday",
 * "from mon through wed"), "weekdays", "weekend", or "today"/"tomorrow" (in the week of `monday`
 * only). With `openEnded`, "from thursday", "since thursday", "after wednesday" and "thursday
 * onwards" also run to Sunday. Null when the words there name no day. `next` is the index after
 * the phrase.
 */
function dayPhraseAt(words: string[], index: number, monday: string, today: string, openEnded = false): DayPhrase | null {
  const word = words[index];
  const start = word === "from" || (openEnded && (word === "after" || word === "since")) ? index + 1 : index;
  const first = DAY_NAME_TO_OFFSET.get(words[start] ?? "");
  if (first !== undefined) {
    const last = RANGE_WORDS.has(words[start + 1] ?? "") ? DAY_NAME_TO_OFFSET.get(words[start + 2] ?? "") : undefined;
    if (last !== undefined) {
      if (last < first) return { kind: "backwards", next: start + 3 };
      return { kind: "days", offsets: offsetSpan(first, last), next: start + 3 };
    }
    if (start !== index) {
      if (!openEnded) return null;
      return { kind: "days", offsets: offsetSpan(word === "after" ? first + 1 : first, 6), next: start + 1 };
    }
    if (openEnded && (words[start + 1] === "onwards" || words[start + 1] === "onward")) {
      return { kind: "days", offsets: offsetSpan(first, 6), next: start + 2 };
    }
    return { kind: "days", offsets: [first], next: start + 1 };
  }
  if (start !== index) return null;
  if (word === "weekday" || word === "weekdays") return { kind: "days", offsets: offsetSpan(0, 4), next: index + 1 };
  if (word === "weekend" || word === "weekends") return { kind: "days", offsets: [5, 6], next: index + 1 };
  if (word === "today" || word === "tomorrow") {
    const offset = daysBetweenISO(monday, word === "today" ? today : addDaysToISODate(today, 1));
    if (offset < 0 || offset > 6) return { kind: "outside", word, next: index + 1 };
    return { kind: "days", offsets: [offset], next: index + 1 };
  }
  return null;
}

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
 * first word was looked at and anything unknown fell back to "approve all". A range of days
 * ("approve mon-wed", "approve Monday to Wednesday") approves every day in it; one that runs
 * backwards ("fri-mon") is unclear.
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
  const words = wordsOf(dayRangeDashes(plainMessage(text.replace(/^approve\b/, " "))));

  const offsets = new Set<number>();
  for (let index = 0; index < words.length; ) {
    const phrase = dayPhraseAt(words, index, monday, today);
    if (phrase?.kind === "outside") {
      return {
        kind: "unclear",
        reply: `Nothing was added: ${phrase.word} is not in the week shown. Go to that week first, or name a day of this week, for example “approve Saturday”.`,
      };
    }
    if (phrase?.kind === "backwards") return { kind: "unclear", reply: APPROVE_CLARIFY_REPLY };
    if (phrase) {
      phrase.offsets.forEach((offset) => offsets.add(offset));
      index = phrase.next;
      continue;
    }
    if (!APPROVE_FILLER.has(words[index])) return { kind: "unclear", reply: APPROVE_CLARIFY_REPLY };
    index++;
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

/**
 * The reply the plan page's live region reads out: MONDAY's newest message that was not also
 * shown as a toast. Sonner announces its toasts itself, so an approval summary or a refusal that
 * was both a toast and a chat message was read out twice.
 */
export function liveRegionReply<T extends { role: string; toasted?: boolean }>(messages: T[]): T | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && !message.toasted) return message;
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------ *
 * What a refinement asks to remove. The server compares it with what the model's answer would
 * remove (src/functions/plan.functions.ts): a small model can answer with seven empty days.
 * ------------------------------------------------------------------------------------------ */

/**
 * A refinement that asks to clear or remove items. Words such as "free" or "off" are left out on
 * purpose ("add a run in my free time" does not ask to empty the plan).
 */
const CLEAR_REQUEST_RE =
  /\b(clear|remove|delete|drop|cancel|empty|erase|wipe|scrap|skip|nothing|get rid|take out|no (plans?|items?|activities))\b/i;

const CLEAR_VERBS = new Set([
  "clear", "remove", "delete", "drop", "cancel", "empty", "erase", "wipe", "scrap", "skip", "nothing", "rid",
]);

function isClearWordAt(words: string[], index: number): boolean {
  const word = words[index];
  const next = words[index + 1] ?? "";
  return CLEAR_VERBS.has(word) || (word === "take" && next === "out") || (word === "no" && /^(plans?|items?|activities)$/.test(next));
}

/**
 * The words a request to clear the whole plan is made of: "remove everything", "clear the rest of
 * the week", "Could you please wipe my whole plan". A clearing clause with any other word ("remove
 * the hike", "clear all evenings", "clear Saturday") asks for less than the whole plan.
 */
const WHOLE_PLAN_WORDS = new Set([
  ...CLEAR_VERBS, "get", "take", "out", "no",
  "everything", "all", "it", "them", "week", "weeks", "plan", "plans", "item", "items", "activity", "activities",
  "event", "events", "thing", "things", "stuff", "rest", "remaining", "remainder", "whole", "entire", "full",
  "days", "schedule", "calendar",
  "the", "my", "this", "our", "of", "for", "from", "off", "up", "on", "a", "and", "so", "then", "also", "too",
  "just", "now", "please", "can", "could", "would", "will", "you", "i", "id", "d", "ll", "m", "im", "like",
  "want", "need", "to", "me", "let", "lets", "us", "go", "ahead", "completely", "entirely", "totally", "ok",
  "okay", "yes", "actually", "instead", "really",
]);

/**
 * Words that say how much to clear. A whole-plan request needs one: "remove" or "clear it" alone
 * does not say that the whole plan should go.
 */
const WHOLE_PLAN_SCOPE = new Set([
  "everything", "all", "week", "weeks", "plan", "plans", "items", "activities", "events", "things", "stuff",
  "rest", "remaining", "remainder", "whole", "entire", "days", "schedule", "calendar",
]);

/** Words that limit a clearing request to part of a day: "clear the evenings", "remove everything after 6". */
const TIME_WORDS = new Set([
  "morning", "mornings", "afternoon", "afternoons", "evening", "evenings", "night", "nights", "tonight",
  "noon", "midday", "am", "pm", "oclock", "before", "after", "until", "till", "between", "during", "early",
  "earlier", "late", "later", "hour", "hours",
]);

/** Words after which a clause names what to keep: "clear everything except the gym", "…, but keep Saturday". */
const EXCEPTION_WORDS = new Set(["except", "excluding", "but", "besides", "apart", "keep", "keeping", "leave", "leaving"]);

/** Words after which a clause gives a reason: "clear the rest of the week because I'm travelling". */
const REASON_WORDS = new Set(["because", "since", "cause", "cuz", "as", "due", "while"]);

/** Words that name no activity of the plan: "remove the hike on Saturday" names only the hike. */
const NOT_ACTIVITY_WORDS = new Set([
  ...WHOLE_PLAN_WORDS, ...TIME_WORDS, ...RANGE_WORDS, ...EXCEPTION_WORDS, ...REASON_WORDS,
  "at", "in", "with", "or", "an", "by", "its", "that", "these", "those", "there", "here", "any", "some", "one",
  "every", "each", "both", "again", "more", "less", "do", "dont", "don", "not", "is", "are", "be", "day",
  "today", "tomorrow", "weekday", "weekdays", "weekend", "weekends", "add", "move", "put", "make",
]);

/** A rough stem, so that "hikes", "hiking" and "Hike" match: plural, "-ing", a final "e" and a doubled last consonant go. */
function wordStem(word: string): string {
  let stem = word;
  if (stem.length > 4 && stem.endsWith("ies")) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 3 && stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1);
  if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3);
  if (stem.length > 3 && stem.endsWith("e")) stem = stem.slice(0, -1);
  if (/([b-df-hj-np-tv-z])\1$/.test(stem)) stem = stem.slice(0, -1);
  return stem;
}

/** The stems of the words of a text that can name an activity. */
function activityStems(words: string[]): string[] {
  return words
    .filter((word) => word.length > 2 && !NOT_ACTIVITY_WORDS.has(word) && !DAY_NAME_TO_OFFSET.has(word))
    .map(wordStem);
}

export type RefinementClear =
  /** The refinement asks to remove nothing. */
  | { kind: "none" }
  /** It asks to clear the whole plan ("remove everything", "clear the rest of the week"). */
  | { kind: "all" }
  /**
   * It asks to remove less than that: the days it names (YYYY-MM-DD) and the activities (word
   * stems, see namesPlanItem). Both can be empty ("clear all evenings", "remove everything
   * except the gym").
   */
  | { kind: "some"; dates: string[]; words: string[] };

/**
 * What a refinement asks to remove. Only a request whose clearing clause is made of whole-plan
 * words, says how much ("everything", "all", "the week", "the rest"), and names no day, no time
 * of day and nothing to keep, is "all": any clearing word
 * used to count as a request to empty the plan, so "remove the hike on Saturday" let an answer of
 * seven empty days through. Clauses without a clearing word ("…, I'm travelling") and reasons
 * ("because …") do not narrow the request, but the days they name count. "today" and "tomorrow"
 * count when they are in the week of `monday`; "from Thursday" and "after Wednesday" run to Sunday.
 */
export function refinementClear(text: string, monday: string, today: string): RefinementClear {
  if (!CLEAR_REQUEST_RE.test(text)) return { kind: "none" };
  const offsets = new Set<number>();
  const words = new Set<string>();
  let clearingClauses = 0;
  let wholePlan = true;
  let scoped = false;
  let limited = false;
  const clauses = dayRangeDashes(plainMessage(text)).split(/[.!?;,:()\n]+|\s[-‐–—]+\s|[–—]/);
  for (const clause of clauses.map(wordsOf)) {
    // Each word belongs to what to clear, a reason, or (after "except", "but", "keep") what to keep.
    let part: "clear" | "reason" | "keep" = "clear";
    const parts = clause.map((word, index) => {
      if (part === "keep" && isClearWordAt(clause, index)) part = "clear";
      else if (EXCEPTION_WORDS.has(word) || (word === "other" && clause[index + 1] === "than")) part = "keep";
      else if (part === "clear" && REASON_WORDS.has(word) && !DAY_NAME_TO_OFFSET.has(clause[index + 1] ?? "")) part = "reason";
      return part;
    });
    if (parts.includes("keep")) limited = true;

    const notKept = clause.filter((_, index) => parts[index] !== "keep");
    for (let index = 0; index < notKept.length; ) {
      const phrase = dayPhraseAt(notKept, index, monday, today, true);
      if (phrase?.kind === "days") phrase.offsets.forEach((offset) => offsets.add(offset));
      index = phrase ? phrase.next : index + 1;
    }

    const toClear = clause.filter((_, index) => parts[index] === "clear");
    activityStems(toClear).forEach((stem) => words.add(stem));
    if (clause.some((_, index) => parts[index] === "clear" && isClearWordAt(clause, index))) {
      clearingClauses++;
      if (!toClear.every((word) => WHOLE_PLAN_WORDS.has(word))) wholePlan = false;
      if (toClear.some((word) => WHOLE_PLAN_SCOPE.has(word))) scoped = true;
      if (toClear.some((word) => TIME_WORDS.has(word) || /\d/.test(word))) limited = true;
    }
  }
  if (clearingClauses > 0 && wholePlan && scoped && !limited && offsets.size === 0) return { kind: "all" };
  return {
    kind: "some",
    dates: [...offsets].sort((a, b) => a - b).map((offset) => addDaysToISODate(monday, offset)),
    words: [...words],
  };
}

/** True when a clearing request names this item's activity: "remove the hike" names "🥾 Hike". */
export function namesPlanItem(clear: { words: string[] }, title: string): boolean {
  return activityStems(wordsOf(plainMessage(title))).some((stem) => clear.words.includes(stem));
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
