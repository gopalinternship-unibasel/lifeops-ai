/**
 * Pure helpers for the workspace's context panel (shared by the route and the unit tests).
 */
import type { CardState, PanelPayload, ScheduleBlock } from "@/types/panel";

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
