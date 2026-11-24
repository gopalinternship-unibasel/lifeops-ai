import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "@/lib/validation";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import { ensureSeedEvents, listEventsForRange } from "@/server/connectors/calendar.mock";
import { listCalendarEvents } from "@/server/google/calendar.server";
import { getErrorMessage } from "@/lib/errors";
import { normalizeTimeZone } from "@/server/timezone.server";
import { cardIdsOfPanel, listCardStates, withDraftCardId } from "@/server/chat-cards.server";
import { isGoogleConnected } from "@/server/workspace.server";
import {
  endOfToday,
  ensureChatSessionFor,
  maxChatTurnMs,
  runChatTurn,
  startOfToday,
} from "@/server/chat-turn.server";
import { replyStateOf } from "@/lib/reply-state";
import type { CardState, PanelPayload } from "@/types/panel";

/* ============================================================
 * Types (shared with the client)
 * ============================================================ */
export type {
  PriorityRow,
  ScheduleBlock,
  PendingEvent,
  PendingEventChange,
  InsightCard,
  InboxSummary,
  EmailDraftSuggestion,
  PanelPayload,
} from "@/types/panel";
export type { ReplyState } from "@/lib/reply-state";

/* ============================================================
 * processChat — one chat turn (src/server/chat-turn.server.ts)
 * ============================================================ */
const ProcessChatInput = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  timeZone: z.string().max(100).optional(),
  /** The workspace's automatic first-visit briefing; it gets a rule-based answer if the model fails. */
  briefing: z.boolean().optional(),
});

export const processChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => parseInput(ProcessChatInput, input))
  .handler(async ({ data, context }) => runChatTurn(context, data));

/* ============================================================
 * Session bootstrap
 * ============================================================ */
export const ensureChatSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => ensureChatSessionFor(context.supabase, context.userId));

/**
 * The session's messages, what the user did with each card, and whether the last message is
 * still being answered (replyState), so a reloaded page can wait for an answer in progress.
 */
export const fetchSessionHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ sessionId: z.string().uuid() }), d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: msgs, error: messagesError } = await supabase
      .from("chat_messages")
      .select("id, role, content, panel_payload, created_at")
      .eq("session_id", data.sessionId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (messagesError) throw messagesError;
    const messages = (msgs ?? []).map((message) =>
      message.panel_payload
        ? { ...message, panel_payload: (withDraftCardId(message.panel_payload, message.id) ?? message.panel_payload) as Json }
        : message,
    );
    const cardIds = messages.flatMap((message) =>
      message.role === "assistant" && message.panel_payload
        ? cardIdsOfPanel(message.panel_payload as unknown as PanelPayload)
        : [],
    );
    const cardStates: Record<string, CardState> = await listCardStates(supabase, userId, cardIds);
    const replyState = replyStateOf(messages, Date.now(), maxChatTurnMs());
    return { messages, cardStates, replyState };
  });

/** The user dismissed a proposal card: remember it so a reload does not show it again. */
export const dismissChatCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ cardId: z.string().min(1).max(100) }), d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("chat_card_actions")
      .upsert(
        { user_id: context.userId, card_id: data.cardId, status: "dismissed" },
        { onConflict: "user_id,card_id", ignoreDuplicates: true },
      );
    if (error) throw error;
    return { ok: true };
  });

/**
 * Explicitly wipe all chat history for the current user.
 * This is not called automatically during sign-out.
 */
export const clearChatHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { error: messageDeleteError } = await supabase
      .from("chat_messages")
      .delete()
      .eq("user_id", userId);
    if (messageDeleteError) throw messageDeleteError;

    const { error: sessionDeleteError } = await supabase
      .from("chat_sessions")
      .delete()
      .eq("user_id", userId);
    if (sessionDeleteError) throw sessionDeleteError;

    const { error: cardDeleteError } = await supabase
      .from("chat_card_actions")
      .delete()
      .eq("user_id", userId);
    if (cardDeleteError) throw cardDeleteError;
    return { ok: true };
  });

/* ============================================================
 * Calendar (used by /app/calendar route)
 * ============================================================ */
export const fetchCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({
    // Date-times with a zone, as the pages send them (toISOString): a loose check let "1" through,
    // and the database answered with a raw error.
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    timeZone: z.string().max(100).optional(),
  }).optional(), d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const timeZone = normalizeTimeZone(data?.timeZone);
    const from = data?.from ?? startOfToday(timeZone);
    const to = data?.to ?? endOfToday(timeZone);
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error("Calendar range must use valid ISO date-times");
    }
    if (toMs <= fromMs) throw new Error("Calendar range end must be after its start");

    const connected = await isGoogleConnected(userId);
    if (connected) {
      try {
        const evs = await listCalendarEvents(userId, from, to);
        return {
          events: evs.map((event) => ({
            id: event.id,
            title: event.title,
            starts_at: event.starts_at,
            ends_at: event.ends_at,
            notes: event.notes,
            source: "google" as const,
          })),
          source: "google" as const,
        };
      } catch (e: unknown) {
        console.error("Real calendar fetch failed", e);
        return { events: [], source: "google" as const, error: String(getErrorMessage(e)) };
      }
    }
    await ensureSeedEvents(supabase, userId, timeZone);
    const events = await listEventsForRange(supabase, userId, from, to);
    return {
      events: events.map((event) => ({ ...event, source: "mock" as const })),
      source: "mock" as const,
    };
  });

