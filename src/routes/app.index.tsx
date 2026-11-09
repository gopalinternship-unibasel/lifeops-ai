import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { ChatThread, type ChatTurn } from "@/components/workspace/ChatThread";
import { ChatComposer } from "@/components/workspace/ChatComposer";
import { ContextPanel } from "@/components/workspace/ContextPanel";
import { dismissChatCard, ensureChatSession, fetchSessionHistory, processChat, fetchCalendar } from "@/functions/chat.functions";
import { getGoogleConnectionStatus } from "@/functions/google.functions";
import type { PanelPayload, PriorityRow, ScheduleBlock, PendingEvent, PendingEventChange, InsightCard, InboxSummary, EmailDraftSuggestion } from "@/types/panel";
import { isToday, mergeUnique, withoutHandledCards } from "@/lib/panel-state";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { getBrowserTimeZone } from "@/lib/date";
import { getErrorMessage, isRecord } from "@/lib/errors";

export const Route = createFileRoute("/app/")({
  component: Workspace,
});

type Tab = "priorities" | "schedule" | "insights";

function Workspace() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [pending, setPending] = useState(false);
  const [inbox, setInbox] = useState<InboxSummary | undefined>();
  const [priorities, setPriorities] = useState<PriorityRow[]>([]);
  const [schedule, setSchedule] = useState<ScheduleBlock[]>([]);
  const [pendingEvents, setPendingEvents] = useState<PendingEvent[]>([]);
  const [pendingEventChanges, setPendingEventChanges] = useState<PendingEventChange[]>([]);
  const [insights, setInsights] = useState<InsightCard[]>([]);
  const [alternatives, setAlternatives] = useState<{ title: string; bullets: string[] } | undefined>();
  const [emailDraft, setEmailDraft] = useState<EmailDraftSuggestion | undefined>();
  const [activeTab, setActiveTab] = useState<Tab>("priorities");
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (!user || bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      try {
        // Make sure the user has connected Google or chosen the demo data. If not, onboarding.
        const status = await getGoogleConnectionStatus();
        if (!status.connected && !status.demoMode && !user.is_anonymous) {
          navigate({ to: "/onboarding/connectors" });
          return;
        }

        const { sessionId: sid } = await ensureChatSession();
        setSessionId(sid);

        // Load real calendar for the day
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
        } catch (e) { /* ignore */ }

        const { messages: hist, cardStates } = await fetchSessionHistory({ data: { sessionId: sid } });
        const turns: ChatTurn[] = hist.map((message) => ({
          id: message.id,
          role: message.role as ChatTurn["role"],
          content: message.content,
        }));
        setMessages(turns);
        // Rebuild the panel from the history, minus every card the user already saved,
        // applied or dismissed (stored on the server, so it holds across reloads and devices).
        for (const m of hist) {
          if (m.role === "assistant" && m.panel_payload) {
            applyPanel(withoutHandledCards(m.panel_payload as unknown as PanelPayload, cardStates));
          }
        }
        if (hist.length === 0) {
          await sendMessage("Please check all my emails and messages.", sid, { briefing: true });
        }
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, "Failed to load workspace"));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  function applyPanel(panel: PanelPayload) {
    if (panel.inbox) setInbox(panel.inbox);
    if (panel.priorities) {
      setPriorities(panel.priorities);
      setActiveTab("priorities");
    }
    const newToday = (panel.newEvents ?? []).filter((block) => isToday(block));
    if (newToday.length) {
      setSchedule((previous) => mergeUnique(previous, newToday));
      setActiveTab("schedule");
    }
    if (panel.pendingEvents?.length) {
      setPendingEvents((previous) => [...previous, ...(panel.pendingEvents ?? [])]);
      setActiveTab("schedule");
    }
    if (panel.pendingEventChanges?.length) {
      setPendingEventChanges((previous) => [
        ...previous,
        ...(panel.pendingEventChanges ?? []),
      ]);
      setActiveTab("schedule");
    }

    const insight = normalizeInsightCard(panel.insight);
    if (insight) {
      setInsights((previous) => [...previous, insight]);
      setActiveTab("insights");
    }

    const alternatives = normalizeAlternatives(panel.alternatives);
    if (alternatives) {
      setAlternatives(alternatives);
      setActiveTab("insights");
    } else if (panel.priorities || panel.newEvents || panel.insight) {
      setAlternatives(undefined);
    }

    if (panel.emailDraft) {
      setEmailDraft(panel.emailDraft);
      setActiveTab("insights");
    }
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

    // Intercept "create the post" / "create a post" → show post framework in Insights
    if (/^\s*create\s+(the|a)\s+post\b/i.test(text)) {
      const reply = "Here's a proven post framework — open the Insights panel on the right to follow it step-by-step.";
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: reply }]);
      const card: InsightCard = {
        kind: "summary",
        title: "Post framework",
        bullets: [
          "Hook — Start with a strong, scroll-stopping line. This could be a surprising statement, a question, or a common misconception. Keep it short and relatable.",
          "Context — Briefly explain the situation, experience, or observation. Give just enough detail so the reader understands the background without overloading them.",
          "Insight — Share what you learned or realized. This is the core value of your post—make it clear and practical.",
          "Takeaway — Translate your insight into something useful for others. What should they do differently or think about?",
          "Engagement — End with a simple question or prompt to invite responses and discussion.",
        ],
      };
      applyPanel({ insight: card });
      setActiveTab("insights");
      return;
    }

    setPending(true);
    try {
      const { reply, panel } = await processChat({
        data: { sessionId: targetSid, message: text, timeZone: getBrowserTimeZone(), briefing: opts.briefing },
      });
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: reply }]);
      applyPanel(panel);
    } catch (err: unknown) {
      const message = getErrorMessage(err, "Something went wrong");
      toast.error(message);
      setMessages((m) => [
        ...m,
        { id: `e-${Date.now()}`, role: "assistant", content: `⚠️ ${message}` },
      ]);
    } finally { setPending(false); }
  }

  return (
    <div className="h-[calc(100vh-3.5rem)] grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="flex flex-col min-h-0 border-r border-border">
        <ChatThread messages={messages} pending={pending} />
        <ChatComposer onSend={(t) => sendMessage(t)} busy={pending} showSuggestions={messages.length <= 2} />
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
          setPendingEventChanges((prev) => prev.filter((p) => p.id !== id));
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

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeInsightCard(value: unknown): InsightCard | undefined {
  if (!isRecord(value)) return undefined;
  const allowedKinds: InsightCard["kind"][] = ["workout", "meal", "meeting_prep", "summary"];
  const kind = allowedKinds.includes(value.kind as InsightCard["kind"])
    ? (value.kind as InsightCard["kind"])
    : "summary";
  if (typeof value.title !== "string") return undefined;

  return {
    kind,
    title: value.title,
    bullets: normalizeStringArray(value.bullets),
  };
}

function normalizeAlternatives(
  value: unknown,
): { title: string; bullets: string[] } | undefined {
  if (!isRecord(value) || typeof value.title !== "string") return undefined;
  return { title: value.title, bullets: normalizeStringArray(value.bullets) };
}

