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
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { CardState, CardStatus, PanelPayload } from "@/types/panel";
import { isRecord } from "@/lib/errors";

type UserClient = SupabaseClient<Database>;

const UNIQUE_VIOLATION = "23505";

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; existing: { status: CardStatus; resultId: string | null } };

export async function claimCard(
  supabase: UserClient,
  userId: string,
  cardId: string,
  status: CardStatus,
): Promise<ClaimResult> {
  const { error } = await supabase
    .from("chat_card_actions")
    .insert({ user_id: userId, card_id: cardId, status });
  if (!error) return { claimed: true };
  if (error.code !== UNIQUE_VIOLATION) throw error;
  const { data, error: readError } = await supabase
    .from("chat_card_actions")
    .select("status, result_id")
    .eq("user_id", userId)
    .eq("card_id", cardId)
    .maybeSingle();
  if (readError) throw readError;
  return {
    claimed: false,
    existing: { status: (data?.status as CardStatus | undefined) ?? status, resultId: data?.result_id ?? null },
  };
}

export async function recordCardResult(
  supabase: UserClient,
  userId: string,
  cardId: string,
  resultId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("chat_card_actions")
    .update({ result_id: resultId })
    .eq("user_id", userId)
    .eq("card_id", cardId);
  if (error) console.error("Could not record the card result", error);
}

export async function releaseCard(supabase: UserClient, userId: string, cardId: string): Promise<void> {
  const { error } = await supabase
    .from("chat_card_actions")
    .delete()
    .eq("user_id", userId)
    .eq("card_id", cardId);
  if (error) console.error("Could not release the card claim", error);
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

/** Stored states for these cards, with the saved body of each saved draft. */
export async function listCardStates(
  supabase: UserClient,
  userId: string,
  cardIds: string[],
): Promise<Record<string, CardState>> {
  const states: Record<string, CardState> = {};
  if (cardIds.length === 0) return states;
  const { data, error } = await supabase
    .from("chat_card_actions")
    .select("card_id, status, result_id")
    .eq("user_id", userId)
    .in("card_id", cardIds);
  if (error) throw error;
  for (const row of data ?? []) {
    states[row.card_id] = { status: row.status as CardStatus, resultId: row.result_id };
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
    if (draftError) throw draftError;
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
