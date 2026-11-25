import { motion, AnimatePresence } from "framer-motion";
import { Calendar, ChefHat, Dumbbell, Inbox, Lightbulb, ListChecks, Mail, Mic, Sparkles, Save, Loader2, Check, Pencil, Trash2 } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import type { PanelPayload, PriorityRow, ScheduleBlock, PendingEvent, PendingEventChange, InsightCard, InboxSummary, EmailDraftSuggestion } from "@/types/panel";
import { saveCalendarEvent, saveGmailDraft, updateCalendarEvent, removeCalendarEvent } from "@/functions/google.functions";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";
import { getBrowserTimeZone } from "@/lib/date";
import { uniqueKeys, type CalendarStatus, type PanelTab } from "@/lib/panel-state";

type Tab = PanelTab;

const TABS: Tab[] = ["priorities", "schedule", "insights"];

interface Props {
  inbox?: InboxSummary;
  priorities: PriorityRow[];
  schedule: ScheduleBlock[];
  pendingEvents: PendingEvent[];
  pendingEventChanges: PendingEventChange[];
  insights: InsightCard[];
  alternatives?: { title: string; bullets: string[] };
  emailDraft?: EmailDraftSuggestion;
  /** What the calendar badge says (loading, demo data, synced with Google, unavailable). */
  calendarStatus: CalendarStatus;
  /** Why today's events could not be loaded; shown in place of "No events today.". */
  scheduleError?: string | null;
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  onPendingSaved: (id: string, ev: ScheduleBlock) => void;
  onPendingDismiss: DismissHandler;
  onPendingChangeApplied: (id: string, change: PendingEventChange) => void;
  onPendingChangeDismiss: DismissHandler;
  onDraftSaved: (draftId: string, body: string) => void;
}

/**
 * Remove a card from the panel. `remember: false` when the server already has a state for it
 * (saved elsewhere, or dismissed), so nothing new needs to be stored.
 */
export type DismissHandler = (id: string, opts?: { remember?: boolean }) => void;

export function ContextPanel({
  inbox, priorities, schedule, pendingEvents, pendingEventChanges, insights, alternatives, emailDraft,
  calendarStatus, scheduleError,
  activeTab, onTabChange, onPendingSaved, onPendingDismiss, onPendingChangeApplied, onPendingChangeDismiss, onDraftSaved,
}: Props) {
  const insightsCount = insights.length + (alternatives ? 1 : 0) + (emailDraft ? 1 : 0);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  // Arrow keys, Home and End move between the tabs (the keyboard pattern of a tab list).
  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.indexOf(activeTab);
    const next =
      e.key === "ArrowRight" ? TABS[(index + 1) % TABS.length]
      : e.key === "ArrowLeft" ? TABS[(index + TABS.length - 1) % TABS.length]
      : e.key === "Home" ? TABS[0]
      : e.key === "End" ? TABS[TABS.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    onTabChange(next);
    tabRefs.current[next]?.focus();
  }
  const tabProps = (tab: Tab) => ({
    tab,
    active: activeTab === tab,
    onClick: () => onTabChange(tab),
    buttonRef: (el: HTMLButtonElement | null) => { tabRefs.current[tab] = el; },
  });

  return (
    // Below lg the panel sits under the chat at its natural height (the page scrolls to it);
    // from lg it fills the grid row beside the chat and scrolls inside.
    <aside className="flex flex-col border-t border-border lg:border-t-0 lg:border-l lg:h-full lg:min-h-0 bg-card/40">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Context</div>
          <h2 className="text-sm font-semibold mt-0.5">Live workspace</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground" data-testid="calendar-status">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[calendarStatus.tone]}`} /> {calendarStatus.label}
        </span>
      </div>

      <div role="tablist" aria-label="Context panel" onKeyDown={onTabKey} className="px-2 pt-2 border-b border-border flex gap-1">
        <TabBtn {...tabProps("priorities")} icon={<ListChecks className="h-3.5 w-3.5" aria-hidden="true" />} count={priorities.length}>Priorities</TabBtn>
        <TabBtn {...tabProps("schedule")} icon={<Calendar className="h-3.5 w-3.5" aria-hidden="true" />} count={schedule.length + pendingEvents.length + pendingEventChanges.length}>Today</TabBtn>
        <TabBtn {...tabProps("insights")} icon={<Sparkles className="h-3.5 w-3.5" aria-hidden="true" />} count={insightsCount}>Insights</TabBtn>
      </div>

      <div
        role="tabpanel"
        id="ctx-panel"
        aria-labelledby={`ctx-tab-${activeTab}`}
        tabIndex={0}
        className="flex-1 overflow-y-auto p-5 space-y-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {activeTab === "priorities" && <PrioritiesView priorities={priorities} inbox={inbox} />}
        {activeTab === "schedule" && (
          <ScheduleView
            schedule={schedule}
            scheduleError={scheduleError}
            pendingEvents={pendingEvents}
            pendingEventChanges={pendingEventChanges}
            onPendingSaved={onPendingSaved}
            onPendingDismiss={onPendingDismiss}
            onPendingChangeApplied={onPendingChangeApplied}
            onPendingChangeDismiss={onPendingChangeDismiss}
          />
        )}
        {activeTab === "insights" && (
          <InsightsView insights={insights} alternatives={alternatives} emailDraft={emailDraft} onDraftSaved={onDraftSaved} />
        )}
      </div>
    </aside>
  );
}

const STATUS_DOT: Record<CalendarStatus["tone"], string> = {
  neutral: "bg-muted-foreground/50",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  red: "bg-red-500",
};

function TabBtn({ children, icon, tab, active, onClick, count, buttonRef }: { children: React.ReactNode; icon: React.ReactNode; tab: Tab; active: boolean; onClick: () => void; count: number; buttonRef: (el: HTMLButtonElement | null) => void }) {
  return (
    <button type="button" role="tab" id={`ctx-tab-${tab}`} aria-selected={active} aria-controls="ctx-panel"
      tabIndex={active ? 0 : -1} ref={buttonRef} onClick={onClick}
      className={`relative flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md transition ${active ? "text-foreground bg-card" : "text-muted-foreground hover:text-foreground"}`}>
      {icon} {children}
      {count > 0 && (
        <span className={`ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-medium ${active ? "bg-gradient-brand text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{count}</span>
      )}
      {active && <span aria-hidden="true" className="absolute -bottom-px left-2 right-2 h-[2px] bg-gradient-brand rounded-full" />}
    </button>
  );
}

function PrioritiesView({ priorities, inbox }: { priorities: PriorityRow[]; inbox?: InboxSummary }) {
  const keys = uniqueKeys(priorities.map((p) => p.title));
  if (priorities.length === 0) {
    return (
      <div className="text-center py-12">
        <Inbox className="h-8 w-8 mx-auto text-muted-foreground/60" />
        <p className="mt-3 text-sm text-muted-foreground">No priorities yet.</p>
        <p className="text-xs text-muted-foreground/80 mt-1">Ask MONDAY to <span className="font-mono">"check my emails"</span>.</p>
        {inbox && inbox.emails.length > 0 && (
          <div className="mt-6 text-left">
            <h3 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-2">Inbox preview</h3>
            <div className="space-y-2">
              {inbox.emails.slice(0, 3).map((e, i) => (
                <div key={i} className="rounded-md border border-border p-2.5 bg-card">
                  <div className="text-xs font-medium truncate">{e.subject}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{e.from}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Ranked priorities</h3>
        <span className="text-[10px] text-muted-foreground">{priorities.length} items</span>
      </div>
      <ol className="space-y-2">
        <AnimatePresence initial={false}>
          {/* Keyed by title (so a reorder animates), made unique when two priorities share a title. */}
          {priorities.map((p, i) => (
            <motion.li key={keys[i]} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="rounded-md border border-border bg-card p-3 flex gap-3">
              <span className="shrink-0 h-7 w-7 rounded-md grid place-items-center text-xs font-mono font-semibold text-primary-foreground" style={{ background: "var(--gradient-brand)" }}>#{p.rank}</span>
              <div className="min-w-0">
                <div className="text-sm font-medium leading-snug">{p.title}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{p.reason}</div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}

function ScheduleView({
  schedule, scheduleError, pendingEvents, pendingEventChanges,
  onPendingSaved, onPendingDismiss, onPendingChangeApplied, onPendingChangeDismiss,
}: {
  schedule: ScheduleBlock[];
  scheduleError?: string | null;
  pendingEvents: PendingEvent[];
  pendingEventChanges: PendingEventChange[];
  onPendingSaved: (id: string, ev: ScheduleBlock) => void;
  onPendingDismiss: DismissHandler;
  onPendingChangeApplied: (id: string, change: PendingEventChange) => void;
  onPendingChangeDismiss: DismissHandler;
}) {
  const sorted = [...schedule].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return (
    <div className="space-y-5">
      {(pendingEvents.length > 0 || pendingEventChanges.length > 0) && (
        <div>
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-amber-700 mb-3">Proposed by AI — review & save</h3>
          <div className="space-y-2">
            {pendingEventChanges.map((c) => (
              <PendingChangeCard key={c.id} change={c} onApplied={onPendingChangeApplied} onDismiss={onPendingChangeDismiss} />
            ))}
            {pendingEvents.map((p) => (
              <PendingEventCard key={p.id} ev={p} onSaved={onPendingSaved} onDismiss={onPendingDismiss} />
            ))}
          </div>
        </div>
      )}

      {scheduleError && (
        // A failed load is not an empty day: say so instead of "No events today.".
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">{scheduleError}</div>
      )}

      {scheduleError && sorted.length === 0 ? null : sorted.length === 0 && pendingEvents.length === 0 && pendingEventChanges.length === 0 ? (
        <div className="text-center py-12">
          <Calendar className="h-8 w-8 mx-auto text-muted-foreground/60" />
          <p className="mt-3 text-sm text-muted-foreground">No events today.</p>
        </div>
      ) : sorted.length > 0 && (
        <div>
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-3">Today's schedule</h3>
          <div className="space-y-2">
            {sorted.map((b) => (
              <div key={`${b.title}-${b.starts_at}`} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium leading-snug truncate">{b.title}</div>
                  <div className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">{fmtTime(b.starts_at)}–{fmtTime(b.ends_at)}</div>
                </div>
                {b.notes && <div className="text-[11px] text-muted-foreground mt-1">{b.notes}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PendingChangeCard({ change, onApplied, onDismiss }: { change: PendingEventChange; onApplied: (id: string, c: PendingEventChange) => void; onDismiss: DismissHandler }) {
  const [busy, setBusy] = useState(false);
  const isDelete = change.kind === "delete";
  async function apply() {
    setBusy(true);
    try {
      const r = isDelete
        ? await removeCalendarEvent({ data: { eventId: change.event_id, cardId: change.id, originalStartsAt: change.original.starts_at, originalEndsAt: change.original.ends_at } })
        : await updateCalendarEvent({ data: {
            cardId: change.id,
            eventId: change.event_id,
            title: change.next?.title,
            starts_at: change.next?.starts_at,
            ends_at: change.next?.ends_at,
            timeZone: getBrowserTimeZone(),
            // The server refuses the card when the event no longer has these times (out of date).
            originalStartsAt: change.original.starts_at,
            originalEndsAt: change.original.ends_at,
          } });
      if (r.alreadyHandled) {
        // Handled before (another tab, or before a reload): just take the card away.
        toast.info(r.error ?? "This change was already handled.");
        onDismiss(change.id, { remember: false });
        return;
      }
      if (!r.ok) {
        toast.error(r.error ?? (isDelete ? "Could not cancel event" : "Could not update event"));
        setBusy(false);
        return;
      }
      toast.success(isDelete ? "Event cancelled" : "Event updated");
      onApplied(change.id, change);
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Failed"));
      setBusy(false);
    }
  }
  return (
    <div className={`rounded-md border p-3 ${isDelete ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50/60"}`}>
      <div className="flex items-center gap-2 mb-1">
        {isDelete ? <Trash2 className="h-3.5 w-3.5 text-red-700" /> : <Pencil className="h-3.5 w-3.5 text-amber-700" />}
        <div className={`text-[10px] font-mono uppercase tracking-wider ${isDelete ? "text-red-700" : "text-amber-700"}`}>
          {isDelete ? "Cancel event" : "Update event"}
        </div>
      </div>
      <div className="text-sm font-medium leading-snug truncate">{change.next?.title ?? change.original.title}</div>
      <div className="mt-1 space-y-0.5 text-[11px]">
        <div className="text-muted-foreground line-through">
          {change.original.title}: {fmtDayPrefix(change.original.starts_at)}{fmtTime(change.original.starts_at)}–{fmtTime(change.original.ends_at)}
        </div>
        {!isDelete && change.next && (change.next.starts_at || change.next.ends_at) && (
          <div className="text-foreground font-medium">
            → {fmtDayPrefix(change.next.starts_at ?? change.original.starts_at)}{fmtTime(change.next.starts_at ?? change.original.starts_at)}–{fmtTime(change.next.ends_at ?? change.original.ends_at)}
          </div>
        )}
      </div>
      <div className="mt-2.5 flex gap-2">
        <button onClick={apply} disabled={busy}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-95 disabled:opacity-60 ${isDelete ? "bg-red-600" : "bg-gradient-brand"}`}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} {isDelete ? "Cancel event" : "Save changes"}
        </button>
        {/* Not while the change is being saved: a dismissal then could neither stop the save nor be stored. */}
        <button type="button" onClick={() => onDismiss(change.id)} disabled={busy} className="text-xs px-2.5 py-1.5 rounded-md text-foreground/80 hover:bg-muted disabled:opacity-60 disabled:pointer-events-none">Dismiss</button>
      </div>
    </div>
  );
}

export function PendingEventCard({ ev, onSaved, onDismiss }: { ev: PendingEvent; onSaved: (id: string, ev: ScheduleBlock) => void; onDismiss: DismissHandler }) {
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await saveCalendarEvent({ data: { cardId: ev.id, title: ev.title, starts_at: ev.starts_at, ends_at: ev.ends_at, notes: ev.notes ?? undefined, timeZone: getBrowserTimeZone() } });
      if (r.alreadyHandled) {
        toast.info(r.error ?? "This proposal was already handled.");
        onDismiss(ev.id, { remember: false });
        return;
      }
      if (!r.ok) { toast.error(r.error ?? "Save failed"); setBusy(false); return; }
      toast.success("Added to your calendar");
      onSaved(ev.id, { title: ev.title, starts_at: ev.starts_at, ends_at: ev.ends_at, notes: ev.notes });
    } catch (e: unknown) { toast.error(getErrorMessage(e, "Save failed")); setBusy(false); }
  }
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium leading-snug truncate text-amber-950">{ev.title}</div>
        <div className="font-mono text-[11px] text-amber-800 whitespace-nowrap">{fmtDayPrefix(ev.starts_at)}{fmtTime(ev.starts_at)}–{fmtTime(ev.ends_at)}</div>
      </div>
      {ev.notes && <div className="text-[11px] text-amber-900/80 mt-1">{ev.notes}</div>}
      <div className="mt-2.5 flex gap-2">
        <button onClick={save} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-gradient-brand px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-95 disabled:opacity-60">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save to Calendar
        </button>
        {/* Not while the event is being saved: a dismissal then could neither stop the save nor be stored. */}
        <button type="button" onClick={() => onDismiss(ev.id)} disabled={busy} className="text-xs px-2.5 py-1.5 rounded-md text-amber-900 hover:bg-amber-100 disabled:opacity-60 disabled:pointer-events-none">Dismiss</button>
      </div>
    </div>
  );
}

function InsightsView({ insights, alternatives, emailDraft, onDraftSaved }: { insights: InsightCard[]; alternatives?: { title: string; bullets: string[] }; emailDraft?: EmailDraftSuggestion; onDraftSaved: (draftId: string, body: string) => void }) {
  if (insights.length === 0 && !alternatives && !emailDraft) {
    return (
      <div className="text-center py-12">
        <Sparkles className="h-8 w-8 mx-auto text-muted-foreground/60" />
        <p className="mt-3 text-sm text-muted-foreground">No insights yet.</p>
        <p className="text-xs text-muted-foreground/80 mt-1">Workouts, meals, meeting prep, and email drafts land here.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {emailDraft && <EmailDraftCard key={emailDraft.id ?? emailDraft.messageId} draft={emailDraft} onSaved={onDraftSaved} />}
      {insights.map((card, i) => (
        <div key={`${card.kind}-${i}`} className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border flex items-center gap-2" style={{ background: "var(--gradient-brand-soft)" }}>
            <InsightIcon kind={card.kind} />
            <h4 className="text-sm font-semibold">{card.title}</h4>
          </div>
          <ul className="p-4 space-y-1.5">
            {card.bullets.map((b, j) => (
              <li key={j} className="text-sm text-foreground/85 flex gap-2 leading-relaxed">
                <span className="text-primary mt-1 shrink-0">▸</span><span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {alternatives && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60">
          <div className="px-4 py-2.5 border-b border-amber-200 flex items-center gap-2">
            {/* Alternatives can be for any missing resource, not only a meal ingredient. */}
            <Lightbulb className="h-4 w-4 text-amber-700" aria-hidden="true" />
            <h4 className="text-sm font-semibold text-amber-900">{alternatives.title}</h4>
          </div>
          <ul className="p-4 space-y-1.5">
            {alternatives.bullets.map((b, j) => (
              <li key={j} className="text-sm text-amber-950/85 flex gap-2 leading-relaxed">
                <span className="text-amber-700 mt-1 shrink-0">▸</span><span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function EmailDraftCard({ draft, onSaved }: { draft: EmailDraftSuggestion; onSaved: (draftId: string, body: string) => void }) {
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(!!draft.saved);

  async function saveDraft() {
    setBusy(true);
    try {
      const r = await saveGmailDraft({ data: { cardId: draft.id, messageId: draft.messageId, replyBody: body } });
      if (r.alreadyHandled) {
        toast.info(r.error ?? "This reply is already saved as a draft.");
        setSaved(true);
        return;
      }
      if (!r.ok || !r.draft) { toast.error(r.error ?? "Could not save draft"); return; }
      toast.success(r.draft.provider === "gmail" ? "Draft saved to Gmail (not sent)" : "Draft saved to the demo mailbox (not sent)");
      setSaved(true);
      onSaved(r.draft.draftId, body);
    } catch (e: unknown) { toast.error(getErrorMessage(e, "Failed")); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-blue-200 flex items-center gap-2">
        <Mail className="h-4 w-4 text-blue-700" />
        <h4 className="text-sm font-semibold text-blue-900 truncate">Reply: {draft.subject}</h4>
      </div>
      <div className="p-4 space-y-2">
        <div className="text-[11px] text-blue-900/70">To: {draft.to}</div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={saved}
          rows={7}
          className="w-full text-sm rounded-md border border-blue-200 bg-card p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:opacity-70 resize-none" />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] text-blue-900/70">Saved as a draft only — MONDAY never sends email.</p>
          <button onClick={saveDraft} disabled={busy || saved}
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-brand px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-95 disabled:opacity-60">
            {saved ? <><Check className="h-3 w-3" /> Draft saved</> : busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Save className="h-3 w-3" /> Save as draft</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function InsightIcon({ kind }: { kind: InsightCard["kind"] }) {
  switch (kind) {
    case "workout": return <Dumbbell className="h-4 w-4 text-primary" />;
    case "meal": return <ChefHat className="h-4 w-4 text-primary" />;
    case "meeting_prep": return <Mic className="h-4 w-4 text-primary" />;
    default: return <Sparkles className="h-4 w-4 text-primary" />;
  }
}

function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

/** "" for today, "Tomorrow " or "Wed, Nov 11 " for other days (proposals can be for any day). */
function fmtDayPrefix(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diffDays = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return "";
  if (diffDays === 1) return "Tomorrow ";
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} `;
}
