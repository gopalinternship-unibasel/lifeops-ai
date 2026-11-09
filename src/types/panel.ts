// Shared panel types between server and client
export interface PriorityRow { rank: number; title: string; reason: string; }
export interface ScheduleBlock { title: string; starts_at: string; ends_at: string; notes?: string | null; }
export interface PendingEvent extends ScheduleBlock { id: string; }
export interface PendingEventChange {
  id: string;
  kind: "update" | "delete";
  event_id: string;
  original: { title: string; starts_at: string; ends_at: string };
  next?: { title?: string; starts_at?: string; ends_at?: string; notes?: string | null };
}
export interface InsightCard {
  kind: "workout" | "meal" | "meeting_prep" | "summary";
  title: string;
  bullets: string[];
}
export interface EmailDraftSuggestion {
  /** Card id ("draft-..."); older stored drafts get `draft-<chat message id>` when loaded. */
  id?: string;
  messageId: string;
  to: string;
  subject: string;
  body: string;
  saved?: boolean;
  draftId?: string | null;
}
export interface InboxSummary {
  emails: { id?: string; from: string; subject: string; snippet: string; importance?: "high" | "medium" | "low"; unread?: boolean }[];
  todayEvents: { title: string; starts_at: string; ends_at: string }[];
  unreadCount?: number;
}
export interface PanelPayload {
  inbox?: InboxSummary;
  priorities?: PriorityRow[];
  /** Newly-created (already saved) events */
  newEvents?: ScheduleBlock[];
  /** AI-proposed events the user must confirm with a Save button */
  pendingEvents?: PendingEvent[];
  /** AI-proposed edits/deletes to existing events; user confirms with Save */
  pendingEventChanges?: PendingEventChange[];
  insight?: InsightCard;
  alternatives?: { title: string; bullets: string[] };
  emailDraft?: EmailDraftSuggestion;
}

/** What the user did with a card (see chat_card_actions). */
export type CardStatus = "saved" | "applied" | "dismissed";
export interface CardState {
  status: CardStatus;
  /** Calendar event id or draft id the action produced. */
  resultId: string | null;
  /** For a saved reply draft: the body as it was saved (the user may have edited it). */
  savedBody?: string;
}
