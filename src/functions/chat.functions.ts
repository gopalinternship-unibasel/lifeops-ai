import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "@/lib/validation";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ensureSeedEvents, listEventsForRange } from "@/server/connectors/calendar.mock";
import { listCalendarEvents } from "@/server/google/calendar.server";
import { normalizeTimeZone } from "@/server/timezone.server";
import { dismissCard, loadSessionHistory } from "@/server/chat-cards.server";
import { isGoogleConnected } from "@/server/workspace.server";
import { dbError } from "@/server/public-error.server";
import {
  endOfToday,
  ensureChatSessionFor,
  maxChatTurnMs,
  publicMessageOf,
  runChatTurn,
  startOfToday,
} from "@/server/chat-turn.server";

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
  // The chat turn records one use of the demo's AI allowance right before it asks the model
  // (and none for an answer built by rules, such as the demo's first-visit briefing).
  .handler(async ({ data, context }) => runChatTurn(context, data, { recordAiUse: true }));

/* ============================================================
 * Session bootstrap
 * ============================================================ */
export const ensureChatSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => ensureChatSessionFor(context.supabase, context.userId));

/**
 * The session's newest messages (oldest first; see HISTORY_LIMIT), what the user did with each
 * card, whether the last message is still being answered (replyState), so a reloaded page can
 * wait for an answer in progress, and whether older messages exist (hasOlder).
 */
export const fetchSessionHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ sessionId: z.string().uuid() }), d))
  .handler(async ({ data, context }) =>
    loadSessionHistory(context.supabase, context.userId, data.sessionId, { maxTurnMs: maxChatTurnMs() }),
  );

/**
 * A card id as the chat turn makes them: "pending-", "change-" or "draft-" and a UUID (an older
 * draft has "draft-" and its message's UUID). Panels stored before 9 Nov 2026 carry the first
 * version's ids, "pending-<milliseconds>-<n>" and "change-<milliseconds>-<n>", and their cards
 * can still be dismissed.
 */
export const CardId = z
  .string()
  .regex(
    /^(?:(?:pending|change|draft)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:pending|change)-\d{10,16}-\d{1,4})$/i,
    "Unknown card",
  );

/** The user dismissed a proposal card: remember it so a reload does not show it again. */
export const dismissChatCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => parseInput(z.object({ cardId: CardId }), d))
  .handler(async ({ data, context }) => {
    await dismissCard(context.userId, data.cardId);
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
    if (messageDeleteError) throw dbError("delete your chat messages", messageDeleteError);

    const { error: sessionDeleteError } = await supabase
      .from("chat_sessions")
      .delete()
      .eq("user_id", userId);
    if (sessionDeleteError) throw dbError("delete your chat", sessionDeleteError);

    const { error: cardDeleteError } = await supabase
      .from("chat_card_actions")
      .delete()
      .eq("user_id", userId);
    if (cardDeleteError) throw dbError("delete what you did with the cards", cardDeleteError);
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
        // Only a sentence meant for the user goes to the page (no internal codes or addresses).
        return {
          events: [],
          source: "google" as const,
          error: publicMessageOf(e, "Your Google Calendar could not be read right now. Please try again in a moment."),
        };
      }
    }
    await ensureSeedEvents(supabase, userId, timeZone);
    const events = await listEventsForRange(supabase, userId, from, to);
    return {
      events: events.map((event) => ({ ...event, source: "mock" as const })),
      source: "mock" as const,
    };
  });

