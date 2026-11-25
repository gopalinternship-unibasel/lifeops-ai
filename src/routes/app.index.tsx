import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { ChatThread, type ChatTurn } from "@/components/workspace/ChatThread";
import { ChatComposer } from "@/components/workspace/ChatComposer";
import { ContextPanel } from "@/components/workspace/ContextPanel";
import { dismissChatCard, ensureChatSession, fetchSessionHistory, processChat, fetchCalendar } from "@/functions/chat.functions";
import { getGoogleConnectionStatus } from "@/functions/google.functions";
import type { PanelPayload, PriorityRow, ScheduleBlock, PendingEvent, PendingEventChange, InsightCard, InboxSummary, EmailDraftSuggestion } from "@/types/panel";
import {
  appendInsight,
  calendarStatus,
  gateModelCards,
  isToday,
  mergeUnique,
  normalizeAlternatives,
  normalizeInsightCard,
  supersededChanges,
  tabForPanel,
  withoutHandledCards,
  type Alternatives,
  type PanelTab,
} from "@/lib/panel-state";
import {
  CHAT_ERROR_MESSAGE,
  INTERRUPTED_NOTE,
  SIGNED_OUT_NOTE,
  chatErrorText,
  pollForStoredReply,
  storedMessageText,
  type ReplyPoll,
  type ReplyState,
} from "@/lib/reply-state";
import type { CardState } from "@/types/panel";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { getBrowserTimeZone } from "@/lib/date";
import { getErrorMessage, getVisitorErrorMessage, isAuthFailure } from "@/lib/errors";

export const Route = createFileRoute("/app/")({
  component: Workspace,
});

type Tab = PanelTab;

/** How often a reloaded page asks whether the answer to the last message is stored yet. */
const REPLY_POLL_MS = 4000;

/** The public hosted demo (both editions build with VITE_HOSTED_DEMO=true); see storedMessageText. */
const HOSTED_DEMO = import.meta.env.VITE_HOSTED_DEMO === "true";

/** Shown when Google Calendar could not be read (the server's detail goes to its log). */
const GOOGLE_CALENDAR_ERROR = "Could not load today's events from Google Calendar. Reload the page to try again.";

type HistoryMessage = Awaited<ReturnType<typeof fetchSessionHistory>>["messages"][number];

function Workspace() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | null>(null);
  // True once the session and its history are on screen: only then can a message be sent (a
  // message sent earlier was dropped, or replaced when the history arrived).
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [pending, setPending] = useState(false);
  const [inbox, setInbox] = useState<InboxSummary | undefined>();
  const [priorities, setPriorities] = useState<PriorityRow[]>([]);
  const [schedule, setSchedule] = useState<ScheduleBlock[]>([]);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [calendarSource, setCalendarSource] = useState<"google" | "mock" | undefined>();
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [pendingEvents, setPendingEvents] = useState<PendingEvent[]>([]);
  const [pendingEventChanges, setPendingEventChanges] = useState<PendingEventChange[]>([]);
  const [insights, setInsights] = useState<InsightCard[]>([]);
  const [alternatives, setAlternatives] = useState<Alternatives | undefined>();
  const [emailDraft, setEmailDraft] = useState<EmailDraftSuggestion | undefined>();
  const [activeTab, setActiveTab] = useState<Tab>("priorities");
  const bootstrapped = useRef(false);
  // Whether the page is on screen; work that resumes after an await checks it before going on.
  const mounted = useRef(false);
  // Messages whose panel is already on screen, and the wait for a pending answer.
  const appliedMessageIds = useRef<Set<string>>(new Set());
  const replyPoll = useRef<ReplyPoll | null>(null);
  const [waitingForEarlierReply, setWaitingForEarlierReply] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Leaving the page (or signing out) ends the wait for a stored answer, also when a check
      // is still running: it then schedules no further check.
      mounted.current = false;
      replyPoll.current?.stop();
      replyPoll.current = null;
    };
  }, []);

  /**
   * Show the stored history: every message, plus a note when the last one was cut off, and the
   * panel of every assistant message not shown yet (minus the cards the user already handled).
   */
  function showHistory(hist: HistoryMessage[], cardStates: Record<string, CardState>, replyState: ReplyState) {
    const turns: ChatTurn[] = hist.map((message) => ({
      id: message.id,
      role: message.role as ChatTurn["role"],
      content: storedMessageText(message, HOSTED_DEMO),
    }));
    if (replyState.kind === "interrupted") {
      turns.push({ id: `interrupted-${replyState.since}`, role: "assistant", content: INTERRUPTED_NOTE });
    }
    setMessages(turns);
    // The user message each answer replied to, so its cards are checked against the request.
    let request = "";
    for (const m of hist) {
      if (m.role === "user") request = m.content;
      if (appliedMessageIds.current.has(m.id)) continue;
      appliedMessageIds.current.add(m.id);
      if (m.role === "assistant" && m.panel_payload) {
        applyPanel(withoutHandledCards(m.panel_payload as unknown as PanelPayload, cardStates), request);
      }
    }
  }

  /**
   * The last message is still being answered on the server (this page was reloaded, or opened in
   * another tab, while the request ran): show "Thinking…" and check every few seconds until
   * the answer, or the stored error, is there.
   */
  function waitForStoredReply(sid: string) {
    if (!mounted.current) return;
    replyPoll.current?.stop();
    setPending(true);
    setWaitingForEarlierReply(true);
    const done = () => {
      setPending(false);
      setWaitingForEarlierReply(false);
    };
    replyPoll.current = pollForStoredReply({
      fetchHistory: () => fetchSessionHistory({ data: { sessionId: sid } }),
      intervalMs: REPLY_POLL_MS,
      // A failed check (for example the dev server restarting) is retried a little later...
      retryMs: REPLY_POLL_MS * 3,
      onDone: ({ messages: hist, cardStates, replyState }) => {
        showHistory(hist, cardStates, replyState);
        done();
      },
      // ...also a refused sign-in once (a token refreshed after sleep); a second one in a row
      // ends the wait, with a note in place of the "Still answering" line.
      isFatal: isAuthFailure,
      onFatal: () => {
        done();
        setMessages((m) => [...m, { id: `signed-out-${Date.now()}`, role: "assistant", content: SIGNED_OUT_NOTE }]);
        toast.error("Your sign-in has expired. Reload the page to try again.");
      },
    });
  }

  /** Today's events for the panel. A failure is shown in the panel; the rest still loads. */
  async function loadTodaysCalendar() {
    try {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date();
      to.setHours(23, 59, 59, 999);
      const cal = await fetchCalendar({ data: { from: from.toISOString(), to: to.toISOString(), timeZone: getBrowserTimeZone() } });
      setSchedule((cal.events ?? []).map((event) => ({
        title: event.title,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        notes: event.notes,
      })));
      setCalendarSource(cal.source ?? "mock");
      // Google Calendar failures come back as `error` (not thrown) with an empty list.
      setScheduleError("error" in cal && cal.error ? GOOGLE_CALENDAR_ERROR : null);
    } catch (e: unknown) {
      setScheduleError(getErrorMessage(e, "Could not load today's calendar."));
    } finally {
      setCalendarLoaded(true);
    }
  }

  /** Load the session, today's calendar and the history; on the first visit, ask for the briefing. */
  async function bootstrap() {
    if (!user) return;
    setBootError(null);
    try {
      // Make sure the user has connected Google or chosen the demo data. If not, onboarding.
      const status = await getGoogleConnectionStatus();
      if (!mounted.current) return;
      if (!status.connected && !status.demoMode && !user.is_anonymous) {
        navigate({ to: "/onboarding/connectors" });
        return;
      }

      const { sessionId: sid } = await ensureChatSession();
      if (!mounted.current) return;
      setSessionId(sid);

      await loadTodaysCalendar();
      if (!mounted.current) return;

      const { messages: hist, cardStates, replyState } = await fetchSessionHistory({ data: { sessionId: sid } });
      if (!mounted.current) return;
      // Rebuild the chat and the panel from the history, minus every card the user already
      // saved, applied or dismissed (stored on the server, so it holds across reloads and devices).
      showHistory(hist, cardStates, replyState);
      setReady(true);
      if (replyState.kind === "awaiting") {
        // A request from before the reload (the first-visit briefing, say) is still running.
        waitForStoredReply(sid);
      } else if (hist.length === 0) {
        await sendMessage("Please check all my emails and messages.", sid, { briefing: true });
      }
    } catch (err: unknown) {
      if (!mounted.current) return;
      // Stay on the page with the reason and a way to try again (the load used to fail silently,
      // leaving "initializing…" on screen for good). An expired sign-in gets a sentence, not the
      // sign-in check's "Unauthorized: Invalid token".
      setBootError(getVisitorErrorMessage(err, "Please try again."));
      toast.error("Could not load your workspace.");
    }
  }

  useEffect(() => {
    if (!user || bootstrapped.current) return;
    bootstrapped.current = true;
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  /**
   * Show a panel from the server. `request` is the user message it answers: the model's optional
   * insight and alternatives cards are kept only where the request calls for them (the server
   * checks the same; this also cleans up panels stored before it did).
   */
  function applyPanel(panel: PanelPayload, request: string) {
    const cards = gateModelCards(request, {
      insight: normalizeInsightCard(panel.insight),
      alternatives: normalizeAlternatives(panel.alternatives),
    });
    if (panel.inbox) setInbox(panel.inbox);
    if (panel.priorities) setPriorities(panel.priorities);
    const newToday = (panel.newEvents ?? []).filter((block) => isToday(block));
    if (newToday.length) setSchedule((previous) => mergeUnique(previous, newToday));
    if (panel.pendingEvents?.length) {
      setPendingEvents((previous) => [...previous, ...(panel.pendingEvents ?? [])]);
    }
    if (panel.pendingEventChanges?.length) {
      setPendingEventChanges((previous) => [
        ...previous,
        ...(panel.pendingEventChanges ?? []),
      ]);
    }

    const insight = cards.insight;
    if (insight) setInsights((previous) => appendInsight(previous, insight));

    if (cards.alternatives) {
      setAlternatives(cards.alternatives);
    } else if (panel.priorities || panel.newEvents || panel.insight) {
      setAlternatives(undefined);
    }

    if (panel.emailDraft) setEmailDraft(panel.emailDraft);

    // Switch to the tab the turn was about; an extra card does not pull the panel away from
    // the priorities or the calendar proposals of the same turn.
    const tab = tabForPanel(panel, cards);
    if (tab) setActiveTab(tab);
  }

  /** Remember a dismissal on the server; the card is already gone from the panel. */
  function rememberDismissal(cardId: string) {
    dismissChatCard({ data: { cardId } }).catch((err: unknown) =>
      toast.error(getErrorMessage(err, "Could not remember the dismissal")),
    );
  }

  async function sendMessage(text: string, sid?: string, opts: { briefing?: boolean } = {}) {
    const targetSid = sid ?? sessionId;
    if (!targetSid) return;
    const userTurn: ChatTurn = { id: `tmp-${Date.now()}`, role: "user", content: text };
    setMessages((m) => [...m, userTurn]);

    setPending(true);
    try {
      const { reply, panel } = await processChat({
        data: { sessionId: targetSid, message: text, timeZone: getBrowserTimeZone(), briefing: opts.briefing },
      });
      // Shown the same way as after a reload (a rule-based briefing without developer details).
      const content = storedMessageText({ role: "assistant", content: reply }, HOSTED_DEMO);
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content }]);
      applyPanel(panel, text);
    } catch (err: unknown) {
      const message = chatErrorText(getErrorMessage(err, CHAT_ERROR_MESSAGE), HOSTED_DEMO);
      toast.error(message);
      setMessages((m) => [
        ...m,
        { id: `e-${Date.now()}`, role: "assistant", content: `⚠️ ${message}` },
      ]);
    } finally { setPending(false); }
  }

  return (
    // Below lg (phones, tablets) the page scrolls: the chat (thread, suggestions, composer) gets a
    // box one screen high of its own and the context panel follows below it. A fixed-height grid
    // with two auto rows let the panel squeeze the thread to nothing and cover the composer.
    // From lg: two columns in one row exactly one screen high; each side scrolls inside.
    <div className="grid grid-cols-1 lg:h-[calc(100dvh-3.5rem)] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
      {/* The divider between the columns only from lg: below it the chat is the only column. */}
      <section className="flex flex-col min-h-0 h-[calc(100dvh-3.5rem)] lg:h-auto border-border lg:border-r">
        <ChatThread
          messages={messages}
          pending={pending}
          pendingNote={waitingForEarlierReply ? "Still answering your last message. The answer appears here when it is ready." : undefined}
          emptyState={bootError ? (
            <BootErrorNotice
              message={bootError}
              onRetry={() => void bootstrap()}
            />
          ) : undefined}
        />
        <ChatComposer
          onSend={(t) => {
            // Nothing can be sent before the session and its history are loaded: keep the text.
            if (!ready || !sessionId) return false;
            void sendMessage(t);
          }}
          busy={pending || !ready}
          placeholder={ready ? undefined : bootError ? "Your workspace did not load. Use Try again." : "Loading your workspace…"}
          showSuggestions={messages.length <= 2}
        />
      </section>
      <ContextPanel
        inbox={inbox}
        priorities={priorities}
        schedule={schedule}
        pendingEvents={pendingEvents}
        pendingEventChanges={pendingEventChanges}
        insights={insights}
        alternatives={alternatives}
        emailDraft={emailDraft}
        calendarStatus={calendarStatus({
          loaded: calendarLoaded,
          source: calendarSource,
          error: scheduleError,
          // A load that failed before the calendar was asked for: "Not loaded", not "unavailable".
          stopped: Boolean(bootError),
        })}
        scheduleError={scheduleError}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onPendingSaved={(id, ev) => {
          setPendingEvents((prev) => prev.filter((p) => p.id !== id));
          // "Today's schedule" lists today only; an event saved for another day is in the calendar.
          if (isToday(ev)) setSchedule((prev) => mergeUnique(prev, [ev]));
        }}
        onPendingDismiss={(id, opts) => {
          setPendingEvents((prev) => prev.filter((p) => p.id !== id));
          if (opts?.remember !== false) rememberDismissal(id);
        }}
        onPendingChangeApplied={(id, change) => {
          // Other open cards for the same event describe it as it was before this change: take
          // them away too, and store them as dismissed so a reload does not bring them back.
          const stale = supersededChanges(pendingEventChanges, change);
          const gone = new Set([id, ...stale.map((card) => card.id)]);
          setPendingEventChanges((prev) => prev.filter((p) => !gone.has(p.id)));
          for (const card of stale) rememberDismissal(card.id);
          const isOriginal = (s: ScheduleBlock) =>
            s.title === change.original.title && Date.parse(s.starts_at) === Date.parse(change.original.starts_at);
          if (change.kind === "delete") {
            setSchedule((prev) => prev.filter((s) => !isOriginal(s)));
          } else {
            const moved: ScheduleBlock = {
              title: change.next?.title ?? change.original.title,
              starts_at: change.next?.starts_at ?? change.original.starts_at,
              ends_at: change.next?.ends_at ?? change.original.ends_at,
            };
            setSchedule((prev) => {
              const notes = prev.find(isOriginal)?.notes;
              const rest = prev.filter((s) => !isOriginal(s));
              // Moved to another day: it leaves today's list; moved into today: it joins it.
              return isToday(moved) ? mergeUnique(rest, [{ ...moved, notes }]) : rest;
            });
          }
        }}
        onPendingChangeDismiss={(id, opts) => {
          setPendingEventChanges((prev) => prev.filter((p) => p.id !== id));
          if (opts?.remember !== false) rememberDismissal(id);
        }}
        onDraftSaved={(_draftId, body) => setEmailDraft((d) => d ? { ...d, saved: true, body } : d)}
      />
    </div>
  );
}

/** In place of the greeting when the workspace could not load: the reason and a retry. */
function BootErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="text-center py-16" data-testid="workspace-load-error">
      <div className="text-lg font-semibold tracking-tight">Could not load your workspace.</div>
      <p className="mt-2 text-muted-foreground text-sm">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted transition"
      >
        Try again
      </button>
    </div>
  );
}
