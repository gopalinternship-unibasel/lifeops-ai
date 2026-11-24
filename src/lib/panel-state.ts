/**
 * Pure helpers for the workspace's context panel (shared by the route, the chat turn on the
 * server and the unit tests).
 */
import type { CardState, InsightCard, PanelPayload, PendingEventChange, ScheduleBlock } from "@/types/panel";

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

/** The user says something is missing or asks for a substitute: the case alternatives are for. */
const ASKS_FOR_ALTERNATIVES =
  /\b(?:no|don't have|do not have|doesn't have|didn't have|haven't got|out of|ran out|run out|running out|without|missing|lack|lacks|lacking|instead|substitut\w*|replace|replacement|swap|alternatives?|other options?|unavailable|not available|can't get|cannot get|couldn't find)\b/i;

/** The user asks for a summary, an overview, preparation or a plan: the case summary cards are for. */
const ASKS_FOR_SUMMARY =
  /\b(?:summar\w*|overview|recap|brief|briefing|prep|prepare|preparing|preparation|plan|plans|planning|agenda|outline|review)\b/i;

/**
 * Keep the model's optional cards only where the request calls for them. A small model fills
 * these optional fields on ordinary turns ("Friday Alternatives: No other events" for "What's on
 * Friday?"), which cluttered the panel and pulled it to the Insights tab.
 * - alternatives only when the user says something is missing or asks for a substitute;
 * - a "summary" insight only when the user asks for a summary, an overview, prep or a plan
 *   (workout, meal and meeting-prep cards are kept);
 * - no card without bullets.
 */
export function gateModelCards(
  userMessage: string,
  cards: { insight?: InsightCard; alternatives?: Alternatives },
): { insight?: InsightCard; alternatives?: Alternatives } {
  const text = userMessage.replace(/[‘’]/g, "'");
  const insight =
    cards.insight &&
    cards.insight.bullets.length > 0 &&
    (cards.insight.kind !== "summary" || ASKS_FOR_SUMMARY.test(text))
      ? cards.insight
      : undefined;
  const alternatives =
    cards.alternatives && cards.alternatives.bullets.length > 0 && ASKS_FOR_ALTERNATIVES.test(text)
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
 * "Synced" in green at all times, also in demo mode and after a failure).
 */
export function calendarStatus(state: {
  loaded: boolean;
  source?: "google" | "mock";
  error?: string | null;
}): CalendarStatus {
  if (state.error) return { label: "Calendar unavailable", tone: "red" };
  if (!state.loaded) return { label: "Loading…", tone: "neutral" };
  if (state.source === "google") return { label: "Synced with Google", tone: "green" };
  return { label: "Demo data", tone: "amber" };
}
