/**
 * Keeps the inbox and calendar priorities when the user ranks a list typed in chat.
 *
 * The chat used to replace the whole priorities list with the model's answer, so ranking "renew
 * passport, buy groceries, call mom" removed the Monday interview and tonight's team sync from the
 * panel and the dashboard. The new items stay on top, in the order the model gave; the earlier
 * items follow them. A re-rank of the earlier list ("make the interview first") returns items
 * that already exist, and then the model's list is the whole answer, as before.
 */
import type { PriorityRow } from "@/types/panel";

/** The most priorities kept after a merge (the panel is a list of what matters, not an archive). */
export const MERGED_PRIORITIES_MAX = 12;

const FILLER = new Set(["the", "a", "an", "to", "for", "of", "and", "my", "your", "on", "at", "in", "with"]);

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1 && !FILLER.has(word)),
  );
}

/** Whether two titles name the same item: most words of the shorter one are in the other. */
export function sameItem(a: string, b: string): boolean {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  return shared / small.size >= 0.6;
}

export interface ExistingPriority extends PriorityRow {
  source?: string | null;
}

/**
 * The model's list followed by the earlier items it does not name. Unchanged when there are no
 * earlier items or when the model's list names any of them (a re-rank).
 */
export function mergeWithExisting(
  fresh: PriorityRow[],
  existing: ExistingPriority[],
): { priorities: PriorityRow[]; kept: ExistingPriority[] } {
  if (fresh.length === 0 || existing.length === 0) return { priorities: fresh, kept: [] };
  if (existing.some((old) => fresh.some((item) => sameItem(item.title, old.title)))) {
    return { priorities: fresh, kept: [] };
  }
  const kept: ExistingPriority[] = [];
  for (const old of [...existing].sort((a, b) => a.rank - b.rank)) {
    if (kept.some((other) => sameItem(other.title, old.title))) continue;
    if (fresh.length + kept.length >= MERGED_PRIORITIES_MAX) break;
    kept.push(old);
  }
  const priorities = [
    ...fresh,
    ...kept.map((old, index) => ({ rank: fresh.length + index + 1, title: old.title, reason: old.reason })),
  ];
  return { priorities, kept };
}

/**
 * Takes the "(today's events first, then tasks by importance)" aside out of a ranking reply when
 * none of the listed items is one of the user's events: the sentence then describes a list the
 * reply does not give.
 */
export function dropEventsAside(reply: string, priorities: PriorityRow[], eventTitles: string[]): string {
  const aside = /\s*\((?:today['’]?s? )?events first,? then (?:the )?tasks by importance\)/i;
  if (!aside.test(reply)) return reply;
  const listsEvent = priorities.some((item) => eventTitles.some((title) => sameItem(item.title, title)));
  return listsEvent ? reply : reply.replace(aside, "");
}
