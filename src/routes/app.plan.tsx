import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatComposer } from "@/components/workspace/ChatComposer";
import { PlanWeekGrid } from "@/components/plan/PlanWeekGrid";
import { fetchWeekPlan, generateWeekPlan, refineWeekPlan, approveWeekPlan, updatePlanItem } from "@/functions/plan.functions";
import type { WeekPlan, BusyEvent } from "@/types/plan";
import { toast } from "sonner";
import { formatLocalDate, getBrowserTimeZone } from "@/lib/date";
import { getErrorMessage } from "@/lib/errors";
import type { WeekPlanRequestView } from "@/lib/week-plan-request";

/** How often the page checks a plan that is still being drafted on the server. */
const DRAFT_POLL_MS = 4000;

export const Route = createFileRoute("/app/plan")({
  component: PlanPage,
});

interface ChatTurn { id: string; role: "user" | "assistant"; content: string; }

const DAY_NAME_TO_OFFSET: Record<string, number> = {
  monday: 0, mon: 0, tuesday: 1, tue: 1, tues: 1, wednesday: 2, wed: 2,
  thursday: 3, thu: 3, thurs: 3, friday: 4, fri: 4, saturday: 5, sat: 5,
  sunday: 6, sun: 6,
};

function startOfWeekMondayISO(d: Date): string {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const dow = x.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + diff);
  return formatLocalDate(x);
}

function PlanPage() {
  const [monday, setMonday] = useState<string>(() => startOfWeekMondayISO(new Date()));
  const timeZone = useMemo(() => getBrowserTimeZone(), []);
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [busyEvents, setBusyEvents] = useState<BusyEvent[]>([]);
  // Both come from the server (which plan items are in the calendar), so they survive a reload.
  const [approvedDates, setApprovedDates] = useState<Set<string>>(new Set());
  const [addedItems, setAddedItems] = useState<Record<string, number[]>>({});
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastWeekFetched = useRef<string | null>(null);
  // The newest plan request of the shown week, as stored on the server: a draft that is still
  // running (started before a reload, or in another tab) shows as "Drafting…" until it is done.
  const [request, setRequest] = useState<WeekPlanRequestView | null>(null);
  // Requests whose reply or error this page has already shown.
  const announced = useRef<Set<string>>(new Set());
  const draftPoll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const weekLabel = useMemo(() => {
    const start = new Date(monday + "T00:00:00");
    const end = new Date(start); end.setDate(end.getDate() + 6);
    if (start.getMonth() === end.getMonth()) {
      return start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
    return `${start.toLocaleDateString("en-US", { month: "short" })} – ${end.toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
  }, [monday]);

  useEffect(() => {
    if (lastWeekFetched.current === monday) return;
    lastWeekFetched.current = monday;
    setLoading(true);
    setApprovedDates(new Set());
    setAddedItems({});
    setRequest(null);
    fetchWeekPlan({ data: { weekStart: monday, timeZone } } as Parameters<typeof fetchWeekPlan>[0])
      .then((r: Awaited<ReturnType<typeof fetchWeekPlan>>) => applyPlanState(r))
      .catch((error: unknown) => toast.error(getErrorMessage(error, "Failed to load plan")))
      .finally(() => setLoading(false));
  }, [monday, timeZone]);

  /** Plan, calendar events and which items are already in the calendar, as the server sees them. */
  function applyPlanState(r: {
    plan: WeekPlan | null;
    busyEvents?: BusyEvent[];
    addedItems?: Record<string, number[]>;
    approvedDates?: string[];
    request?: WeekPlanRequestView | null;
  }) {
    setPlan(r.plan ?? null);
    setBusyEvents(r.busyEvents ?? []);
    setAddedItems(r.addedItems ?? {});
    setApprovedDates(new Set(r.approvedDates ?? []));
    if (r.request !== undefined) setRequest(r.request);
  }

  // A draft that runs on the server without this page waiting for it (the page was reloaded or
  // opened in another tab): check until it is done, then show the plan and the reply.
  const serverDrafting = request?.status === "running" && !busy;
  useEffect(() => {
    if (!serverDrafting) return;
    let stopped = false;
    const waitingFor = request?.id;
    const check = async () => {
      try {
        const r = await fetchWeekPlan({ data: { weekStart: monday, timeZone } } as Parameters<typeof fetchWeekPlan>[0]);
        if (stopped) return;
        if (r.request?.status === "running") {
          draftPoll.current = setTimeout(check, DRAFT_POLL_MS);
          return;
        }
        applyPlanState(r);
        const outcome = r.request;
        if (outcome && outcome.id === waitingFor && !announced.current.has(outcome.id)) {
          announced.current.add(outcome.id);
          if (outcome.status === "done" && outcome.reply) {
            setMessages((m) => [...m, { id: `a-${outcome.id}`, role: "assistant", content: outcome.reply ?? "" }]);
            toast.success("Your week plan is ready.");
          } else if (outcome.status === "failed") {
            toast.error(outcome.error ?? "Drafting the plan failed.");
          }
        }
      } catch {
        if (!stopped) draftPoll.current = setTimeout(check, DRAFT_POLL_MS * 3);
      }
    };
    draftPoll.current = setTimeout(check, DRAFT_POLL_MS);
    return () => {
      stopped = true;
      if (draftPoll.current) clearTimeout(draftPoll.current);
    };
  }, [serverDrafting, request?.id, monday, timeZone]);

  const drafting = busy || request?.status === "running";

  const shiftWeek = (delta: number) => {
    const d = new Date(monday + "T00:00:00");
    d.setDate(d.getDate() + delta * 7);
    setMonday(startOfWeekMondayISO(d));
  };

  /** After a failed call: the server's view of the request (it may still be drafting). */
  const resync = async () => {
    try {
      applyPlanState(await fetchWeekPlan({ data: { weekStart: monday, timeZone } } as Parameters<typeof fetchWeekPlan>[0]));
    } catch {
      /* the toast already reports the failure */
    }
  };

  const generate = async (instructions?: string) => {
    if (drafting) return;
    setBusy(true);
    setRequest({ id: "pending", kind: "create", status: "running", startedAt: new Date().toISOString(), finishedAt: null, reply: null, error: null });
    try {
      const r = await generateWeekPlan(
        { data: { weekStart: monday, instructions, timeZone } } as Parameters<
          typeof generateWeekPlan
        >[0],
      );
      if (r.request) announced.current.add(r.request.id);
      applyPlanState(r);
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: r.reply }]);
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Failed to generate plan"));
      await resync();
    } finally {
      setBusy(false);
    }
  };

  const parseApproveCommand = (raw: string): { isApprove: boolean; dayDate?: string } => {
    const t = raw.trim().toLowerCase();
    if (!/^approve\b/.test(t)) return { isApprove: false };
    const rest = t.replace(/^approve\b/, "").trim();
    if (!rest || rest === "all" || rest === "the week" || rest === "week") return { isApprove: true };
    if (rest === "today") {
      return { isApprove: true, dayDate: formatLocalDate(new Date()) };
    }
    if (rest === "tomorrow") {
      const d = new Date(); d.setDate(d.getDate() + 1);
      return { isApprove: true, dayDate: formatLocalDate(d) };
    }
    const dayKey = rest.split(/\s+/)[0];
    const offset = DAY_NAME_TO_OFFSET[dayKey];
    if (offset != null) {
      const d = new Date(monday + "T00:00:00");
      d.setDate(d.getDate() + offset);
      return { isApprove: true, dayDate: formatLocalDate(d) };
    }
    return { isApprove: true }; // fallback: approve all
  };

  const handleSend = async (text: string) => {
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: text }]);

    // Trigger phrase: generate
    if (!plan && /create.*plan|plan.*for.*week|please create this week/i.test(text)) {
      await generate(undefined);
      return;
    }

    // Approve commands handled client-side
    const ap = parseApproveCommand(text);
    if (ap.isApprove) {
      if (!plan) {
        setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: "There's no plan yet — say *“Please create this week's plan for me”* first." }]);
        return;
      }
      await approveDay(ap.dayDate);
      return;
    }

    // Otherwise: refine
    if (drafting) return;
    setBusy(true);
    setRequest({ id: "pending", kind: "refine", status: "running", startedAt: new Date().toISOString(), finishedAt: null, reply: null, error: null });
    try {
      const r = await refineWeekPlan(
        { data: { weekStart: monday, message: text, timeZone } } as Parameters<
          typeof refineWeekPlan
        >[0],
      );
      if (r.request) announced.current.add(r.request.id);
      applyPlanState(r); // a refined plan's new items need approving again
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: r.reply }]);
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Failed to update plan"));
      await resync();
    } finally {
      setBusy(false);
    }
  };

  const approveDay = async (dayDate?: string) => {
    setApproving(dayDate ?? "all");
    try {
      const r = await approveWeekPlan(
        { data: { weekStart: monday, dayDate } } as Parameters<typeof approveWeekPlan>[0],
      );
      // What is in the calendar now decides "Added", not this click (held-back or failed items stay open).
      try {
        applyPlanState(await fetchWeekPlan({ data: { weekStart: monday, timeZone } } as Parameters<typeof fetchWeekPlan>[0]));
      } catch {
        /* the toast below still reports the approval */
      }
      const niceDay = dayDate
        ? new Date(dayDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" })
        : "the whole week";
      const parts = [`Added ${r.created} event${r.created === 1 ? "" : "s"}`];
      if (r.skipped > 0) parts.push(`skipped ${r.skipped} already-existing event${r.skipped === 1 ? "" : "s"}`);
      if (r.past > 0) parts.push(`skipped ${r.past} whose time has already passed`);
      if (r.conflicts > 0) {
        parts.push(`held back ${r.conflicts} that would overlap your calendar (${r.conflictTitles.join(", ")})`);
      }
      if (r.failed > 0) parts.push(`${r.failed} failed`);
      const summary = `${parts.join(", ")} for ${niceDay}.`;
      toast.success(summary);
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: `✅ ${summary}` }]);
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Approval failed"));
    } finally {
      setApproving(null);
    }
  };

  const planSuggestions = plan
    ? ["I have a meeting from 5 to 6 so plan the hike till 4", "Make weekday mornings deep work", "Approve all", "Approve Saturday"]
    : ["Please create this week's plan for me"];

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          {(() => {
            const isThisWeek = monday === startOfWeekMondayISO(new Date());
            return (
              <Button
                variant={isThisWeek ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  const cur = startOfWeekMondayISO(new Date());
                  // Force a refetch even if already on this week
                  lastWeekFetched.current = null;
                  setMonday(cur);
                }}
                className={isThisWeek ? "bg-gradient-brand text-primary-foreground hover:opacity-95" : ""}
              >
                This week
              </Button>
            );
          })()}
          <div className="flex items-center">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => shiftWeek(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => shiftWeek(1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{weekLabel}</h1>
        </div>
        <div className="flex items-center gap-2">
          {plan && (
            <Button
              size="sm"
              onClick={() => approveDay(undefined)}
              disabled={approving !== null || drafting}
              style={{ background: "var(--gradient-brand)" }}
              className="text-primary-foreground"
            >
              {approving === "all" ? "Approving…" : "Approve entire week"}
            </Button>
          )}
          <Button
            size="sm"
            variant={plan ? "outline" : "default"}
            onClick={() => generate(undefined)}
            disabled={drafting}
          >
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            {drafting && !approving ? "Drafting…" : plan ? "Regenerate" : "Create plan"}
          </Button>
        </div>
      </div>

      {/* A draft still running on the server, or the last one that did not finish */}
      {!loading && request?.status === "running" && (
        <div className="rounded-xl border border-border bg-card/60 px-4 py-3 text-sm flex items-center gap-2" data-testid="plan-drafting">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
          <span>
            Drafting your {request.kind === "refine" ? "updated " : ""}week plan (started {fmtClock(request.startedAt)}). It keeps
            running on the server, also if you reload or leave this page; the plan appears here when it is ready.
          </span>
        </div>
      )}
      {!loading && !busy && request?.status === "interrupted" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm" data-testid="plan-interrupted">
          The plan request started {fmtClock(request.startedAt)} did not finish: it was cut off, for example by a server restart.
          {plan ? " The plan below is the one from before." : ""} Create the plan again.
        </div>
      )}
      {!loading && !busy && request?.status === "failed" && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm" data-testid="plan-failed">
          The last plan request ({fmtClock(request.startedAt)}) failed: {request.error}
          {plan ? " The plan below is the one from before." : ""}
        </div>
      )}

      {/* Empty state / grid */}
      {loading ? (
        <div className="grid place-items-center py-24">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !plan && drafting ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/40 py-16 px-6 text-center" data-testid="plan-empty-drafting">
          <Loader2 className="h-6 w-6 mx-auto mb-3 animate-spin text-muted-foreground" />
          <h2 className="text-lg font-serif">MONDAY is drafting this week's plan…</h2>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-md mx-auto">
            A local AI model can take several minutes. Nothing is added to your calendar until you approve it.
          </p>
        </div>
      ) : !plan ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/40 py-16 px-6 text-center">
          <Sparkles className="h-6 w-6 mx-auto mb-3 text-muted-foreground" />
          <h2 className="text-lg font-serif">No plan for this week yet.</h2>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-md mx-auto">
            Type <span className="font-mono text-foreground/80">“Please create this week's plan for me”</span> below
            and MONDAY will fill your free time with a balanced rhythm.
          </p>
        </div>
      ) : (
        <PlanWeekGrid
          plan={plan}
          busyEvents={busyEvents}
          approvedDates={approvedDates}
          addedItems={addedItems}
          onApproveDay={(d) => approveDay(d)}
          approving={approving}
          onItemTimeChange={async (date, idx, starts_at, ends_at) => {
            const previousPlan = plan;
            setPlan((prev) => {
              if (!prev) return prev;
              return { ...prev, days: prev.days.map(d => d.date === date ? { ...d, items: d.items.map((it, i) => i === idx ? { ...it, starts_at, ends_at } : it) } : d) };
            });
            try {
              await updatePlanItem(
                {
                  data: { weekStart: monday, dayDate: date, itemIndex: idx, starts_at, ends_at, timeZone },
                } as Parameters<typeof updatePlanItem>[0],
              );
              toast.success("Time updated");
            } catch (e: unknown) {
              setPlan(previousPlan);
              toast.error(getErrorMessage(e, "Could not update time"));
              throw e;
            }
          }}
        />
      )}

      {/* Recent messages */}
      {messages.length > 0 && (
        <div className="rounded-xl border border-border bg-card/60 p-4 max-w-3xl mx-auto w-full space-y-3">
          {messages.slice(-6).map((m) => (
            <div key={m.id} className={`text-sm ${m.role === "user" ? "text-foreground" : "text-foreground/80"}`}>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mr-2">
                {m.role === "user" ? "You" : "MONDAY"}
              </span>
              {m.content}
            </div>
          ))}
        </div>
      )}

      <div className="-mx-4 sm:-mx-6">
        <ChatComposer
          onSend={handleSend}
          busy={drafting || approving !== null}
          showSuggestions
          suggestions={planSuggestions}
          placeholder={
            plan
              ? "Refine the plan — e.g. 'I have a meeting 5–6, end the hike by 4', or type 'approve' / 'approve Saturday'…"
              : "Type 'Please create this week's plan for me' to get started…"
          }
          hint="Type 'approve' to add the whole week, or 'approve Saturday' for one day."
          maxLength={1500}
        />
      </div>
    </div>
  );
}

function fmtClock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
