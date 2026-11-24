/**
 * What the user did with an AI card in the workspace: a proposed event ("Save to Calendar"),
 * a proposed change to an event ("Save changes" / "Cancel event") or a reply draft
 * ("Save as draft"). Stored in public.chat_card_actions (one row per card, row-level security).
 *
 * The workspace rebuilds its panel from every past panel_payload in the chat history, so
 * without this record every handled card came back as actionable after a reload and a saved
 * draft could be saved a second time. Each action first CLAIMS its card (the primary key
 * makes a second claim fail), does the work, then stores the result id; a failed action
 * releases the claim so the user can try again.
 *
 * The claim, its result, its release and a dismissal are written by the server with the
 * service-role client, scoped to the user id the request was authenticated with. With the
 * user's own token anyone could delete a "saved" record through the Data API and save the card
 * again (review of 24 Nov 2026), so the database can refuse user writes to this table. A claim
 * that has a result is never released. Reads stay with the user's client (row-level security).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dbError } from "@/server/public-error.server";
import type { CardState, CardStatus, PanelPayload } from "@/types/panel";
import { isRecord } from "@/lib/errors";
import { replyStateOf, type ReplyState } from "@/lib/reply-state";

type UserClient = SupabaseClient<Database>;

const UNIQUE_VIOLATION = "23505";

/** Writes to chat_card_actions: the service role, always scoped to one user's row. */
const store = supabaseAdmin;

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; existing: { status: CardStatus; resultId: string | null } };

/**
 * Claim a card for an action. `supabase` is the caller's user client, used to read the record
 * of a card that was claimed before; the claim itself is written by the server.
 */
export async function claimCard(
  supabase: UserClient,
  userId: string,
  cardId: string,
  status: CardStatus,
): Promise<ClaimResult> {
  const { error } = await store
    .from("chat_card_actions")
    .insert({ user_id: userId, card_id: cardId, status });
  if (!error) return { claimed: true };
  if (error.code !== UNIQUE_VIOLATION) throw dbError("save what you did with this card", error);
  const { data, error: readError } = await supabase
    .from("chat_card_actions")
    .select("status, result_id")
    .eq("user_id", userId)
    .eq("card_id", cardId)
    .maybeSingle();
  if (readError) throw dbError("read what you did with this card", readError);
  return {
    claimed: false,
    existing: { status: (data?.status as CardStatus | undefined) ?? status, resultId: data?.result_id ?? null },
  };
}

/** Store the id the action produced. A card has one result: one already stored is kept. */
export async function recordCardResult(
  _supabase: UserClient,
  userId: string,
  cardId: string,
  resultId: string | null,
): Promise<void> {
  const { error } = await store
    .from("chat_card_actions")
    .update({ result_id: resultId })
    .eq("user_id", userId)
    .eq("card_id", cardId)
    .is("result_id", null);
  if (error) console.error("Could not record the card result", error);
}

/** Free the claim of a failed action, so the user can try again. A card with a result stays done. */
export async function releaseCard(_supabase: UserClient, userId: string, cardId: string): Promise<void> {
  const { error } = await store
    .from("chat_card_actions")
    .delete()
    .eq("user_id", userId)
    .eq("card_id", cardId)
    .is("result_id", null);
  if (error) console.error("Could not release the card claim", error);
}

/** The user dismissed a proposal card: remembered so a reload does not show it again. */
export async function dismissCard(userId: string, cardId: string): Promise<void> {
  const { error } = await store
    .from("chat_card_actions")
    .upsert(
      { user_id: userId, card_id: cardId, status: "dismissed" },
      { onConflict: "user_id,card_id", ignoreDuplicates: true },
    );
  if (error) throw dbError("hide this card", error);
}

/** The card ids a stored panel carries (older drafts without an id get `draft-<message id>`). */
export function cardIdsOfPanel(panel: PanelPayload): string[] {
  const ids: string[] = [];
  for (const event of panel.pendingEvents ?? []) if (event.id) ids.push(event.id);
  for (const change of panel.pendingEventChanges ?? []) if (change.id) ids.push(change.id);
  if (panel.emailDraft?.id) ids.push(panel.emailDraft.id);
  return ids;
}

/** Give a stored draft card a stable id when it was saved before drafts had one. */
export function withDraftCardId(panel: unknown, messageId: string): PanelPayload | null {
  if (!isRecord(panel)) return null;
  const payload = panel as PanelPayload;
  if (payload.emailDraft && !payload.emailDraft.id) {
    return { ...payload, emailDraft: { ...payload.emailDraft, id: `draft-${messageId}` } };
  }
  return payload;
}

/** Card ids per request: each id goes into the request's address, which has a length limit. */
const CARD_IDS_PER_QUERY = 100;

/** Stored states for these cards, with the saved body of each saved draft. */
export async function listCardStates(
  supabase: UserClient,
  userId: string,
  cardIds: string[],
): Promise<Record<string, CardState>> {
  const states: Record<string, CardState> = {};
  const unique = [...new Set(cardIds)];
  for (let start = 0; start < unique.length; start += CARD_IDS_PER_QUERY) {
    const { data, error } = await supabase
      .from("chat_card_actions")
      .select("card_id, status, result_id")
      .eq("user_id", userId)
      .in("card_id", unique.slice(start, start + CARD_IDS_PER_QUERY));
    if (error) throw dbError("load what you did with the cards", error);
    for (const row of data ?? []) {
      states[row.card_id] = { status: row.status as CardStatus, resultId: row.result_id };
    }
  }

  const draftIds = Object.entries(states)
    .filter(([cardId, state]) => cardId.startsWith("draft-") && state.status === "saved" && state.resultId)
    .map(([, state]) => state.resultId as string);
  if (draftIds.length > 0) {
    const { data: drafts, error: draftError } = await supabase
      .from("email_drafts")
      .select("id, body, external_draft_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (draftError) throw dbError("load your saved drafts", draftError);
    const bodies = new Map<string, string>();
    for (const draft of drafts ?? []) {
      bodies.set(draft.id, draft.body);
      if (draft.external_draft_id) bodies.set(draft.external_draft_id, draft.body);
    }
    for (const state of Object.values(states)) {
      if (state.resultId && bodies.has(state.resultId)) state.savedBody = bodies.get(state.resultId);
    }
  }
  return states;
}

/**
 * How many of a session's messages the workspace loads: the newest ones. PostgREST answers at
 * most 1,000 rows (db-max-rows) and drops the rest without an error, so a long chat loaded
 * oldest first lost its newest messages and cards, and the reply state was read from the wrong
 * last message (review of 24 Nov 2026).
 */
export const HISTORY_LIMIT = 200;

export interface SessionHistoryMessage {
  id: string;
  role: string;
  content: string;
  panel_payload: Json | null;
  created_at: string;
}

/**
 * The session's newest messages (oldest first), what the user did with each card, whether the
 * last message is still being answered (replyState), and whether older messages exist.
 */
export async function loadSessionHistory(
  supabase: UserClient,
  userId: string,
  sessionId: string,
  opts: { nowMs?: number; maxTurnMs: number; limit?: number },
): Promise<{
  messages: SessionHistoryMessage[];
  cardStates: Record<string, CardState>;
  replyState: ReplyState;
  hasOlder: boolean;
}> {
  const limit = opts.limit ?? HISTORY_LIMIT;
  // One row more than shown tells whether older messages exist.
  const { data: newestFirst, error } = await supabase
    .from("chat_messages")
    .select("id, role, content, panel_payload, created_at")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw dbError("load your chat", error);
  const hasOlder = (newestFirst ?? []).length > limit;
  const rows = (newestFirst ?? []).slice(0, limit).reverse();
  const messages: SessionHistoryMessage[] = rows.map((message) =>
    message.panel_payload
      ? { ...message, panel_payload: (withDraftCardId(message.panel_payload, message.id) ?? message.panel_payload) as Json }
      : message,
  );
  const cardIds = messages.flatMap((message) =>
    message.role === "assistant" && message.panel_payload
      ? cardIdsOfPanel(message.panel_payload as unknown as PanelPayload)
      : [],
  );
  const cardStates = await listCardStates(supabase, userId, cardIds);
  const replyState = replyStateOf(messages, opts.nowMs ?? Date.now(), opts.maxTurnMs);
  return { messages, cardStates, replyState, hasOlder };
}
