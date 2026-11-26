/**
 * Pure helpers for the workspace's context panel (shared by the route, the chat turn on the
 * server and the unit tests).
 */
import type { CardState, InsightCard, PanelPayload, PendingEvent, PendingEventChange, ScheduleBlock } from "@/types/panel";

export type PanelTab = "priorities" | "schedule" | "insights";
export type Alternatives = { title: string; bullets: string[] };

/** True when the block overlaps the local day of `now` (the browser's time zone). */
export function isToday(block: { starts_at: string; ends_at: string }, now: Date = new Date()): boolean {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const s = Date.parse(block.starts_at);
  const e = Date.parse(block.ends_at);
  return Number.isFinite(s) && Number.isFinite(e) && s < end.getTime() && e > start.getTime();
}

/** How long after its start an event can still be proposed or saved ("right now" is fine). */
export const START_GRACE_MS = 10 * 60 * 1000;
/** What a refused proposal or save of an event whose start has passed says (also the plan page). */
export const PAST_START_MESSAGE = "This start time has passed. Pick a start later than now.";
/** The short note on a proposal whose start has passed. */
export const PAST_PROPOSAL_NOTE = "this start time has passed, so it cannot be saved";

/** Whether an event starts more than the grace period before `nowMs` (an unreadable time is not treated as over). */
export function startsBeforeNow(startsAt: string, nowMs: number = Date.now()): boolean {
  const start = Date.parse(startsAt);
  return Number.isFinite(start) && start < nowMs - START_GRACE_MS;
}

/**
 * Why a proposed event cannot be saved: the server's own reason (a known overlap), or a start
 * that is over by now (the page checks again at every render, because time passes after the
 * proposal was made). Null when Save is offered.
 */
export function proposalRefusal(event: Pick<PendingEvent, "starts_at" | "refusal">, nowMs: number = Date.now()): string | null {
  if (startsBeforeNow(event.starts_at, nowMs)) return PAST_START_MESSAGE;
  return event.refusal ?? null;
}

/** The "Today" tab's count: today's events plus the proposals and changes that are for today. */
export function todayTabCount(
  schedule: ScheduleBlock[],
  pendingEvents: Pick<PendingEvent, "starts_at" | "ends_at">[],
  pendingEventChanges: PendingEventChange[],
  now: Date = new Date(),
): number {
  return (
    schedule.length +
    pendingEvents.filter((event) => isToday(event, now)).length +
    pendingEventChanges.filter((change) => isToday(change.original, now)).length
  );
}

/** Proposals and changes split into those for today and those for other days ("Later"). */
export function splitProposalsByDay(
  pendingEvents: PendingEvent[],
  pendingEventChanges: PendingEventChange[],
  now: Date = new Date(),
): { today: { events: PendingEvent[]; changes: PendingEventChange[] }; later: { events: PendingEvent[]; changes: PendingEventChange[] } } {
  return {
    today: {
      events: pendingEvents.filter((event) => isToday(event, now)),
      changes: pendingEventChanges.filter((change) => isToday(change.original, now)),
    },
    later: {
      events: pendingEvents.filter((event) => !isToday(event, now)),
      changes: pendingEventChanges.filter((change) => !isToday(change.original, now)),
    },
  };
}

/**
 * A stored panel without the cards the user has already handled: saved, applied or dismissed
 * proposals are left out, and a saved reply comes back read-only with the body that was saved.
 */
export function withoutHandledCards(panel: PanelPayload, states: Record<string, CardState>): PanelPayload {
  const draftState = panel.emailDraft?.id ? states[panel.emailDraft.id] : undefined;
  return {
    ...panel,
    pendingEvents: panel.pendingEvents?.filter((event) => !states[event.id]),
    pendingEventChanges: panel.pendingEventChanges?.filter((change) => !states[change.id]),
    emailDraft:
      !panel.emailDraft || draftState?.status === "dismissed"
        ? undefined
        : draftState?.status === "saved"
          ? { ...panel.emailDraft, saved: true, body: draftState.savedBody ?? panel.emailDraft.body }
          : panel.emailDraft,
  };
}

/** Merge schedule blocks, one per title and start instant (ISO formats differ between sources). */
export function mergeUnique(prev: ScheduleBlock[], next: ScheduleBlock[]): ScheduleBlock[] {
  const map = new Map<string, ScheduleBlock>();
  for (const b of [...prev, ...next]) map.set(`${b.title}|${Date.parse(b.starts_at)}`, b);
  return Array.from(map.values());
}

/* ------------------------------------------------------------------------------------------
 * Insight and alternatives cards
 * ---------------------------------------------------------------------------------------- */

/**
 * One bullet of an insight or alternatives card as text, or null when there is nothing to show.
 * The model is asked for strings but sometimes sends objects ({exercise, sets}) or null, which
 * String() turned into "[object Object]" and "null".
 */
export function bulletText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "name", "title", "label"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  const parts = Object.entries(record).flatMap(([key, entry]) =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
      ? [`${key}: ${String(entry).trim()}`]
      : [],
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Bullets as a list of non-empty strings (stored panels may hold a JSON string instead of an array). */
export function normalizeStringArray(value: unknown): string[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map(bulletText).filter((text): text is string => text !== null).slice(0, 20);
}

/** An insight card fit to show, or undefined (no title, or no bullets to show). */
export function normalizeInsightCard(value: unknown): InsightCard | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || !record.title.trim()) return undefined;
  const allowedKinds: InsightCard["kind"][] = ["workout", "meal", "meeting_prep", "summary"];
  const kind = allowedKinds.includes(record.kind as InsightCard["kind"]) ? (record.kind as InsightCard["kind"]) : "summary";
  const bullets = normalizeStringArray(record.bullets);
  return bullets.length > 0 ? { kind, title: record.title.trim(), bullets } : undefined;
}

/** An alternatives card fit to show, or undefined (no title, or no bullets to show). */
export function normalizeAlternatives(value: unknown): Alternatives | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || !record.title.trim()) return undefined;
  const bullets = normalizeStringArray(record.bullets);
  return bullets.length > 0 ? { title: record.title.trim(), bullets } : undefined;
}

/**
 * The user says something is missing or asks for a substitute: the case alternatives are for.
 * A bare "no" does not count ("No, make it 4 pm", "no rush"), and neither do "instead",
 * "replace" and "swap" on their own: they also move or change events ("Move the sync to Friday
 * instead"). "Out of office" is about the user's time, not about something missing. "No eggs,
 * what can I make?" counts through its question.
 */
const ASKS_FOR_ALTERNATIVES =
  /\b(?:(?:have|has|had|got|there's|there is|there are)\s+no|no\s+[\w-]+(?:\s+[\w-]+)?\s+(?:left|at home|in the (?:fridge|house|kitchen|pantry|cupboard))|don't have|do not have|doesn't have|does not have|didn't have|did not have|haven't got|out of(?!\s+(?:the\s+)?office)|ran out|run out|running out|missing|lack|lacks|lacking|substitut\w*|replacement|alternatives?|other options?|unavailable|not available|can't get|cannot get|couldn't find|what (?:else )?(?:can|could|should) I (?:use|make|cook|bake))\b/i;

/**
 * "without" and "instead of" also describe a calendar entry ("Add lunch without onions", "Move
 * the sync to Friday instead of Thursday"): they count only when the message is not just a
 * calendar command, as in "How do I bake a cake without eggs?". A command may follow a short
 * word ("Hey, add...", "Okay add...", "Please, add..."), and a command that goes on to ask for
 * something ("Cancel the gym, what else can I do without weights?", "Book a table, something
 * without meat") still counts.
 */
const MAY_ASK_FOR_ALTERNATIVES = /\b(?:without|instead of)\b/i;
const CALENDAR_COMMAND =
  /^\W*(?:(?:hey|hi|hello|ok|okay|alright|all right|yes|yeah|sure|great|perfect|thanks|thank you|also|and|then|now|so)\b[\s,!.]*){0,2}(?:(?:please|pls|can you|could you|would you|will you)\b[\s,]*)?(?:please\b[\s,]*)?(?:add|schedule|book|block|move|reschedule|shift|push|postpone|cancel|delete|remove|set up)\b/i;
const ASKS_FOR_SOMETHING = /\b(?:what|how|which|where|anything|something|suggest\w*|recommend\w*|ideas?)\b/i;

/** The user asks for a summary, an overview, preparation or a plan. */
const ASKS_FOR_SUMMARY =
  /\b(?:summar\w*|overview|recap|brief|briefing|prep|prepare|preparing|preparation|plan|plans|planning|agenda|outline|review)\b/i;

/**
 * The user asks for something to read or use other than a calendar entry: ideas, a list, steps,
 * tips, suggestions, a post or other text ("Make a packing list for Zurich", "List restaurants
 * in Basel", "List the best restaurants in Basel", "Write a LinkedIn post"). "List my events",
 * "list today's meetings", "list the meetings" and "list all unread emails" ask about the
 * calendar or the inbox: after "list" (and "the"), only up to two of the words in
 * LIST_QUALIFIER may come before such a noun, so "List questions for meetings" and "List 5 tasks
 * to do this weekend" still ask for content. "A post office trip" is an event, not a post.
 */
const LIST_QUALIFIER = String.raw`(?:all|unread|new|upcoming|recent|latest|important|urgent|pending|open|remaining|starred|flagged|next|today's|tomorrow's|tonight's|(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:'s)?|morning|afternoon|evening|week's|weekend(?:'s)?|work|personal|team)`;
const LIST_CALENDAR_ITEMS = String.raw`(?:events?|meetings?|appointments?|tasks?|to-?dos?|reminders?|deadlines?|calls?|e-?mails?|mails?|messages?|inbox|calendar|schedule|free\s+(?:time|slots?)|slots?|priorities|conflicts?)`;
const LIST_OTHER_THAN_CALENDAR = String.raw`list(?!\s+(?:all\s+)?(?:my|today's|tomorrow's|this|next|(?:the\s+)?(?:${LIST_QUALIFIER}\s+){0,2}${LIST_CALENDAR_ITEMS})\b)`;
const ASKS_FOR_CONTENT = new RegExp(
  String.raw`\b(?:ideas?|brainstorm\w*|suggest\w*|recommend\w*|tips?|advice|steps|checklist|list of|(?:a|an|my)\s+(?:[\w-]+\s+){0,2}list|${LIST_OTHER_THAN_CALENDAR}|template|examples?|pack(?:ing)?|how (?:do|can|could|should) I|write|draft|compose)\b|\b(?:a|the|my)\s+(?:[\w-]+\s+)?post(?![\w-])(?!\s+office)`,
  "i",
);

/** A reply to an email: the reply draft card is the content then, not a summary card. */
const ABOUT_A_REPLY = /\b(?:repl(?:y|ies|ying)|respond|response)\b/i;

/**
 * Keep the model's optional cards only where the request calls for them. A small model fills
 * these optional fields on ordinary turns ("Friday Alternatives: No other events" for "What's on
 * Friday?"), which cluttered the panel and pulled it to the Insights tab.
 * - alternatives only when the user says something is missing or asks for a substitute
 *   ("without" and "instead of" not in a message that is only a calendar command);
 * - a "summary" insight only when the user asks for a summary, an overview, prep or a plan, or
 *   for other content such as ideas, a list or a post (not when it is about an email reply).
 *   "summary" is also the kind any unknown kind becomes (see normalizeInsightCard), so this
 *   covers every generic card. Workout, meal and meeting-prep cards are always kept;
 * - no card without bullets.
 * This is a word check: a content request in other words loses its summary card (the reply
 * text still has the answer), and a placeholder card next to such words stays.
 */
export function gateModelCards(
  userMessage: string,
  cards: { insight?: InsightCard; alternatives?: Alternatives },
): { insight?: InsightCard; alternatives?: Alternatives } {
  const text = userMessage.replace(/[‘’]/g, "'");
  const asksForCard =
    ASKS_FOR_SUMMARY.test(text) || (ASKS_FOR_CONTENT.test(text) && !ABOUT_A_REPLY.test(text));
  const insight =
    cards.insight &&
    cards.insight.bullets.length > 0 &&
    (cards.insight.kind !== "summary" || asksForCard)
      ? cards.insight
      : undefined;
  const onlyACalendarCommand = CALENDAR_COMMAND.test(text) && !ASKS_FOR_SOMETHING.test(text);
  const asksForAlternatives =
    ASKS_FOR_ALTERNATIVES.test(text) || (MAY_ASK_FOR_ALTERNATIVES.test(text) && !onlyACalendarCommand);
  const alternatives =
    cards.alternatives && cards.alternatives.bullets.length > 0 && asksForAlternatives
      ? cards.alternatives
      : undefined;
  return { insight, alternatives };
}

/** Add an insight card to the list, once: a card equal to one already listed moves to the end. */
export function appendInsight(previous: InsightCard[], card: InsightCard): InsightCard[] {
  const key = (c: InsightCard) => JSON.stringify([c.kind, c.title.trim().toLowerCase(), c.bullets]);
  const cardKey = key(card);
  return [...previous.filter((c) => key(c) !== cardKey), card];
}

/**
 * The tab to show after a panel arrives, or undefined to stay on the current one. Calendar
 * cards and priorities come first; an insight or alternatives card only takes over when it is
 * what the turn was about (a workout, meal or meeting-prep card, or a summary or alternatives
 * card with nothing else in the panel). A reply draft always shows, since the user asked for it.
 */
export function tabForPanel(
  panel: PanelPayload,
  cards: { insight?: InsightCard; alternatives?: Alternatives },
  now: Date = new Date(),
): PanelTab | undefined {
  const scheduleChanged =
    (panel.newEvents ?? []).some((block) => isToday(block, now)) ||
    (panel.pendingEvents?.length ?? 0) > 0 ||
    (panel.pendingEventChanges?.length ?? 0) > 0;
  const hasOther = Boolean(panel.priorities) || scheduleChanged;
  let tab: PanelTab | undefined;
  if (panel.priorities) tab = "priorities";
  if (scheduleChanged) tab = "schedule";
  if (cards.insight && (cards.insight.kind !== "summary" || !hasOther)) tab = "insights";
  if (cards.alternatives && !hasOther) tab = "insights";
  if (panel.emailDraft) tab = "insights";
  return tab;
}

/* ------------------------------------------------------------------------------------------
 * Proposed changes and priorities
 * ---------------------------------------------------------------------------------------- */

/**
 * The other open change cards for the event a change card was just applied to. They describe
 * the event as it was before, so they are stale: the workspace removes them and stores them as
 * dismissed, so they do not come back after a reload.
 */
export function supersededChanges(open: PendingEventChange[], applied: PendingEventChange): PendingEventChange[] {
  return open.filter((change) => change.id !== applied.id && change.event_id === applied.event_id);
}

/**
 * React keys for a list whose labels may repeat (two priorities can share a title): the label
 * itself, and "label#2", "label#3" for repeats, so a reorder keeps each row's key.
 */
export function uniqueKeys(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label}#${count}`;
  });
}

/* ------------------------------------------------------------------------------------------
 * Calendar status badge
 * ---------------------------------------------------------------------------------------- */

export type CalendarStatus = { label: string; tone: "neutral" | "amber" | "green" | "red" };

/**
 * The context panel's calendar badge, from what the workspace actually loaded (it used to say
 * "Synced" in green at all times, also in demo mode and after a failure). `stopped` means the
 * workspace stopped loading (an earlier step failed): a calendar that was not asked for yet is
 * "Not loaded", not "unavailable".
 */
export function calendarStatus(state: {
  loaded: boolean;
  source?: "google" | "mock";
  error?: string | null;
  stopped?: boolean;
}): CalendarStatus {
  if (state.error) return { label: "Calendar unavailable", tone: "red" };
  if (!state.loaded) return state.stopped ? { label: "Not loaded", tone: "neutral" } : { label: "Loading…", tone: "neutral" };
  if (state.source === "google") return { label: "Synced with Google", tone: "green" };
  return { label: "Demo data", tone: "amber" };
}
