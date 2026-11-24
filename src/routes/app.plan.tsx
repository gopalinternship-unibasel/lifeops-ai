import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Sparkles, Loader2, X as XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatComposer } from "@/components/workspace/ChatComposer";
import { PlanWeekGrid } from "@/components/plan/PlanWeekGrid";
import { fetchWeekPlan, generateWeekPlan, refineWeekPlan, approveWeekPlan, updatePlanItem } from "@/functions/plan.functions";
import type { WeekPlan, BusyEvent } from "@/types/plan";
import { toast } from "sonner";
import { formatLocalDate, getBrowserTimeZone } from "@/lib/date";
import { getErrorMessage } from "@/lib/errors";
import { formatRequestTime, type WeekPlanRequestView } from "@/lib/week-plan-request";
import {
  NO_PLAN_YET_REPLY,
  WEEK_OVER_REPLY,
  parseApproveCommand,
  planCreateInstructions,
  planDayStatus,
  weekIsOver,
} from "@/lib/plan-state";

/** How often the page checks a plan that is still being drafted on the server. */
const DRAFT_POLL_MS = 4000;

/**
 * The hosted demo (Vercel, GitHub Pages) uses a hosted AI service that answers a plan in about
 * half a minute; only a local run may use a model on the same computer, which can take minutes.
 */
const HOSTED_DEMO = import.meta.env.VITE_HOSTED_DEMO === "true";

/** Plan requests whose failure message the visitor closed (this browser only). */
const DISMISSED_KEY = "lifeops.plan.dismissedRequests";

export const Route = createFileRoute("/app/plan")({
  component: PlanPage,
});

interface ChatTurn { id: string; role: "user" | "assistant"; content: string; }

function startOfWeekMondayISO(d: Date): string {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const dow = x.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + diff);
  return formatLocalDate(x);
}

function readDismissedRequests(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveDismissedRequest(id: string) {
  try {
    const ids = [...readDismissedRequests().filter((other) => other !== id), id].slice(-50);
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // No storage (private window, blocked site data): the message stays closed until a reload.
  }
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
  // The week this page is waiting for a draft of (the call that started it has not returned).
  const [busyWeek, setBusyWeek] = useState<string | null>(null);
  const busy = busyWeek !== null;
  const [approving, setApproving] = useState<string | null>(null);
  // Set at once, unlike state: a second click in the same moment must not start a second approval.
  const approvingNow = useRef(false);
  const [loading, setLoading] = useState(true);
  // Loading the week failed: shown instead of the plan (which is unknown), with Retry.
  const [loadError, setLoadError] = useState<string | null>(null);
  // The plan loaded but the calendar did not: approving waits until it loads.
  const [calendarError, setCalendarError] = useState<string | null>(null);
  // Bumped to load the shown week again ("This week" while on this week, Retry).
  const [reloadTick, setReloadTick] = useState(0);
  // Bumped whenever a plan comes from the server, so open time editors start again from it.
  const [planVersion, setPlanVersion] = useState(0);
  const lastWeekFetched = useRef<string | null>(null);
  const loadSeq = useRef(0);
  // The week on screen now. A draft can take minutes; when it returns, the user may be looking
  // at another week, and that week must not be overwritten with this one's plan.
  const shownWeek = useRef(monday);
  shownWeek.current = monday;
  // The newest plan request of the shown week, as stored on the server: a draft that is still
  // running (started before a reload, or in another tab) shows as "Drafting…" until it is done.
  const [request, setRequest] = useState<WeekPlanRequestView | null>(null);
  // Requests whose reply or error this page has already shown.
  const announced = useRef<Set<string>>(new Set());
  // Requests whose failure banner is not shown: closed by the visitor, or an older failure that a
  // later refused attempt would otherwise present as its own outcome.
  const [hiddenRequests, setHiddenRequests] = useState<Set<string>>(new Set());
  const draftPoll = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setHiddenRequests((current) => new Set([...current, ...readDismissedRequests()]));
  }, []);

  const weekLabel = useMemo(() => {
    const start = new Date(monday + "T00:00:00");
    const end = new Date(start); end.setDate(end.getDate() + 6);
    if (start.getMonth() === end.getMonth()) {
      return start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
    return `${start.toLocaleDateString("en-US", { month: "short" })} – ${end.toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
  }, [monday]);

  useEffect(() => {
    const loadKey = `${monday}#${reloadTick}`;
    if (lastWeekFetched.current === loadKey) return;
    lastWeekFetched.current = loadKey;
    const seq = ++loadSeq.current;
    setLoading(true);
    // Nothing of the week shown before stays: when this load failed, the previous week's plan
    // stayed on screen under the new week's heading, and its buttons acted on the new week.
    setPlan(null);
    setBusyEvents([]);
    setApprovedDates(new Set());
    setAddedItems({});
    setRequest(null);
    setLoadError(null);
    setCalendarError(null);
    fetchWeekPlan({ data: { weekStart: monday, timeZone } } as Parameters<typeof fetchWeekPlan>[0])
      .then((r: Awaited<ReturnType<typeof fetchWeekPlan>>) => {
        if (loadSeq.current === seq) applyPlanState(r);
      })
      .catch((error: unknown) => {
        if (loadSeq.current !== seq) return;
        lastWeekFetched.current = null;
        setLoadError(getErrorMessage(error, "Please try again in a moment."));
      })
      .finally(() => {
        if (loadSeq.current === seq) setLoading(false);
      });
  }, [monday, timeZone, reloadTick]);

  /** Plan, calendar events and which items are already in the calendar, as the server sees them. */
  function applyPlanState(r: {
    plan: WeekPlan | null;
    busyEvents?: BusyEvent[];
    addedItems?: Record<string, number[]>;
    approvedDates?: string[];
    calendarError?: string | null;
    request?: WeekPlanRequestView | null;
  }) {
    setPlan(r.plan ?? null);
    setPlanVersion((version) => version + 1);
    setBusyEvents(r.busyEvents ?? []);
    setAddedItems(r.addedItems ?? {});
    setApprovedDates(new Set(r.approvedDates ?? []));
    setCalendarError(r.calendarError ?? null);
    setLoadError(null);
    if (r.request !== undefined) setRequest(r.request);
  }

  // A draft that runs on the server without this page waiting for it (the page was reloaded or
  // opened in another tab): check until it is done, then show the plan and the reply.
  const serverDrafting = request?.status === "running" && busyWeek !== monday;
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

  // One draft at a time from this page; `draftingHere` is the week on screen being drafted.
  const drafting = busy || request?.status === "running";
  const draftingHere = busyWeek === monday || request?.status === "running";
  const weekOver = weekIsOver(monday, Date.now());

  const shiftWeek = (delta: number) => {
    const d = new Date(monday + "T00:00:00");
    d.setDate(d.getDate() + delta * 7);
    setMonday(startOfWeekMondayISO(d));
  };

  const say = (content: string) =>
    setMessages((m) => [...m, { id: `a-${Date.now()}-${m.length}`, role: "assistant", content }]);

  const dismissRequest = (id: string) => {
    saveDismissedRequest(id);
    setHiddenRequests((current) => new Set([...current, id]));
  };

  /**
   * After a failed draft call: the server's view of the request (it may still be drafting). A
   * refusal (a limit, a draft already running, the AI not set up) stores no request, so the
   * newest one is still the one from before; its old failure must not read as this attempt's
   * outcome, and the reason stays readable in the chat instead.
   */
  const afterFailedDraft = async (week: string, previousRequestId: string | null, message: string) => {
    try {
      const r = await fetchWeekPlan({ data: { weekStart: week, timeZone } } as Parameters<typeof fetchWeekPlan>[0]);
      if (shownWeek.current !== week) return;
      applyPlanState(r);
      if (!r.request || r.request.id === previousRequestId) {
        if (previousRequestId) setHiddenRequests((current) => new Set([...current, previousRequestId]));
        say(message);
      }
    } catch {
      /* the toast already reports the failure */
    }
  };

  /** The plan that came back belongs to `week`; show it only if that week is still on screen. */
  const showDraft = (week: string, r: Parameters<typeof applyPlanState>[0] & { reply: string }) => {
    if (r.request) announced.current.add(r.request.id);
    if (shownWeek.current !== week) {
      toast.success(`The plan for the week of ${fmtWeek(week)} is ready.`);
      return;
    }
    applyPlanState(r);
    setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: r.reply }]);
  };

  const generate = async (instructions?: string) => {
    if (drafting) return;
    // Nothing is left to plan in a week that is over (the server refuses it as well).
    if (weekIsOver(monday, Date.now())) {
      say(WEEK_OVER_REPLY);
      return;
    }
    const week = monday;
    const previousRequestId = request?.id ?? null;
    setBusyWeek(week);
    setRequest({ id: "pending", kind: "create", status: "running", startedAt: new Date().toISOString(), finishedAt: null, reply: null, error: null });
    try {
      const r = await generateWeekPlan(
        { data: { weekStart: week, instructions, timeZone } } as Parameters<
          typeof generateWeekPlan
        >[0],
      );
      showDraft(week, r);
    } catch (e: unknown) {
      const message = getErrorMessage(e, "Failed to generate plan");
      toast.error(message);
      if (shownWeek.current === week) await afterFailedDraft(week, previousRequestId, message);
    } finally {
      setBusyWeek(null);
    }
  };

  const handleSend = async (text: string) => {
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: text }]);

    // Trigger phrase: generate, with whatever the message adds ("…, but keep Saturday free").
    if (!plan && /create.*plan|plan.*for.*week|please create this week/i.test(text)) {
      await generate(planCreateInstructions(text));
      return;
    }

    // Approve commands handled client-side
    const command = parseApproveCommand(text, monday, formatLocalDate(new Date()));
    if (command.kind !== "not-approve") {
      if (!plan) {
        say(NO_PLAN_YET_REPLY);
        return;
      }
      if (command.kind === "unclear") {
        say(command.reply);
        return;
      }
      if (calendarError) {
        say("Nothing was added: your calendar could not be loaded, so approving is paused. Use Retry above first.");
        return;
      }
      await approveDays(command.kind === "days" ? command.dates : undefined);
      return;
    }

    // Otherwise: refine
    if (drafting) return;
    if (weekIsOver(monday, Date.now())) {
      say(WEEK_OVER_REPLY);
      return;
    }
    const week = monday;
    const previousRequestId = request?.id ?? null;
    setBusyWeek(week);
    setRequest({ id: "pending", kind: "refine", status: "running", startedAt: new Date().toISOString(), finishedAt: null, reply: null, error: null });
    try {
      const r = await refineWeekPlan(
        { data: { weekStart: week, message: text, timeZone } } as Parameters<
          typeof refineWeekPlan
        >[0],
      );
      showDraft(week, r); // a refined plan's new items need approving again
    } catch (e: unknown) {
      const message = getErrorMessage(e, "Failed to update plan");
      toast.error(message);
      if (shownWeek.current === week) await afterFailedDraft(week, previousRequestId, message);
    } finally {
      setBusyWeek(null);
    }
  };

  /** Approve some days (one request per day, in order), or the whole week when none are given. */
  const approveDays = async (dayDates?: string[]) => {
    if (approvingNow.current) return;
    approvingNow.current = true;
    const week = monday;
    const totals = { created: 0, skipped: 0, past: 0, conflicts: 0, failed: 0, conflictTitles: [] as string[] };
    let approvedSome = false;
    // What is in the calendar now decides "Added", not this click (held-back or failed items stay open).
    const refresh = async () => {
      try {
        const r = await fetchWeekPlan({ data: { weekStart: week, timeZone } } as Parameters<typeof fetchWeekPlan>[0]);
        if (shownWeek.current === week) applyPlanState(r);
      } catch {
        /* the toast still reports the approval */
      }
    };
    try {
      for (const dayDate of dayDates && dayDates.length > 0 ? dayDates : [undefined]) {
        setApproving(dayDate ?? "all");
        const r = await approveWeekPlan(
          { data: { weekStart: week, dayDate } } as Parameters<typeof approveWeekPlan>[0],
        );
        approvedSome = true;
        totals.created += r.created;
        totals.skipped += r.skipped;
        totals.past += r.past;
        totals.conflicts += r.conflicts;
        totals.failed += r.failed;
        totals.conflictTitles.push(...r.conflictTitles);
      }
      await refresh();
      const niceDays = dayDates && dayDates.length > 0
        ? joinNames(dayDates.map((date) => new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" })))
        : "the whole week";
      const parts = [`Added ${totals.created} event${totals.created === 1 ? "" : "s"}`];
      if (totals.skipped > 0) parts.push(`skipped ${totals.skipped} already-existing event${totals.skipped === 1 ? "" : "s"}`);
      if (totals.past > 0) parts.push(`skipped ${totals.past} whose time has already passed`);
      if (totals.conflicts > 0) {
        parts.push(`held back ${totals.conflicts} that would overlap your calendar (${totals.conflictTitles.join(", ")})`);
      }
      if (totals.failed > 0) parts.push(`${totals.failed} failed`);
      const summary = `${parts.join(", ")} for ${niceDays}.`;
      toast.success(summary);
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: `✅ ${summary}` }]);
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Approval failed"));
      if (approvedSome) await refresh();
    } finally {
      approvingNow.current = false;
      setApproving(null);
    }
  };

  const planSuggestions = plan
    ? ["I have a meeting from 5 to 6 so plan the hike till 4", "Make weekday mornings deep work", "Approve all", "Approve Saturday"]
    : ["Please create this week's plan for me"];

  const failedShown = request?.status === "failed" && !hiddenRequests.has(request.id);
  const interruptedShown = request?.status === "interrupted" && !hiddenRequests.has(request.id);

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
                  // Already on this week: load it again (the server may have a newer plan, for
                  // example from another tab). Setting the same week changed nothing before.
                  if (cur === monday) setReloadTick((tick) => tick + 1);
                  else setMonday(cur);
                }}
                className={isThisWeek ? "bg-gradient-brand text-primary-foreground hover:opacity-95" : ""}
              >
                This week
              </Button>
            );
          })()}
          <div className="flex items-center">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Previous week" onClick={() => shiftWeek(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next week" onClick={() => shiftWeek(1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{weekLabel}</h1>
        </div>
        <div className="flex items-center gap-2">
          {plan && !loading && (
            <Button
              size="sm"
              onClick={() => approveDays(undefined)}
              // Nothing left to add (every day reads Added, Past or Nothing to add): the button
              // did nothing but stayed enabled (QA round 5).
              disabled={approving !== null || drafting || !!calendarError || !plan.days.some((day) => planDayStatus(day, addedItems?.[day.date] ?? [], approvedDates.has(day.date), Date.now()) === "approve")}
              title={calendarError ? "Approving is paused until your calendar loads" : "Adds every day that still has something to add"}
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
            disabled={drafting || loading || !!loadError || weekOver}
            title={
              weekOver
                ? "This week is already over"
                : drafting && !draftingHere
                  ? "A plan for another week is still being drafted."
                  : undefined
            }
          >
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            {draftingHere && !approving ? "Drafting…" : plan ? "Regenerate" : "Create plan"}
          </Button>
        </div>
      </div>

      {/* A draft still running on the server, or the last one that did not finish */}
      {!loading && request?.status === "running" && (
        <div className="rounded-xl border border-border bg-card/60 px-4 py-3 text-sm flex items-center gap-2" data-testid="plan-drafting">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
          <span>
            Drafting your {request.kind === "refine" ? "updated " : ""}week plan (started {formatRequestTime(request.startedAt)}). It keeps
            running on the server, also if you reload or leave this page; the plan appears here when it is ready.
          </span>
        </div>
      )}
      {!loading && busyWeek !== monday && interruptedShown && request && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm flex items-start justify-between gap-3" data-testid="plan-interrupted">
          <span>
            The plan request started {formatRequestTime(request.startedAt)} did not finish: it was cut off, for example by a server restart.
            {plan ? " The plan below is the one from before." : ""} Create the plan again.
          </span>
          <DismissButton onClick={() => dismissRequest(request.id)} />
        </div>
      )}
      {!loading && busyWeek !== monday && failedShown && request && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm flex items-start justify-between gap-3" data-testid="plan-failed">
          <span>
            The plan request from {formatRequestTime(request.startedAt)} failed: {request.error}
            {plan ? " The plan below is the one from before." : ""}
          </span>
          <DismissButton onClick={() => dismissRequest(request.id)} />
        </div>
      )}
      {!loading && calendarError && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm flex items-center justify-between gap-3" data-testid="plan-calendar-error" role="status">
          <span>{calendarError}</span>
          <Button size="sm" variant="outline" onClick={() => setReloadTick((tick) => tick + 1)}>
            Retry
          </Button>
        </div>
      )}

      {/* Empty state / grid */}
      {loading ? (
        <div className="grid place-items-center py-24">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 py-12 px-6 text-center" data-testid="plan-load-error" role="alert">
          <h2 className="text-lg font-serif">Could not load this week's plan.</h2>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-md mx-auto">{loadError}</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => setReloadTick((tick) => tick + 1)}>
            Retry
          </Button>
        </div>
      ) : !plan && draftingHere ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/40 py-16 px-6 text-center" data-testid="plan-empty-drafting">
          <Loader2 className="h-6 w-6 mx-auto mb-3 animate-spin text-muted-foreground" />
          <h2 className="text-lg font-serif">MONDAY is drafting this week's plan…</h2>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-md mx-auto">
            {HOSTED_DEMO ? "This usually takes under a minute." : "A local AI model can take several minutes."} Nothing is
            added to your calendar until you approve it.
          </p>
        </div>
      ) : !plan ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/40 py-16 px-6 text-center">
          <Sparkles className="h-6 w-6 mx-auto mb-3 text-muted-foreground" />
          <h2 className="text-lg font-serif">No plan for this week yet.</h2>
          {weekOver ? (
            <p className="text-sm text-muted-foreground mt-1.5 max-w-md mx-auto">
              This week is already over, so there is nothing left to plan. Go to this week or a later one.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1.5 max-w-md mx-auto">
              Type <span className="font-mono text-foreground/80">“Please create this week's plan for me”</span> below
              and MONDAY will fill your free time with a balanced rhythm.
            </p>
          )}
        </div>
      ) : (
        <PlanWeekGrid
          // A plan from the server (a refinement, a reload) starts any open time editor afresh.
          key={planVersion}
          plan={plan}
          busyEvents={busyEvents}
          approvedDates={approvedDates}
          addedItems={addedItems}
          onApproveDay={(d) => approveDays([d])}
          approving={approving}
          approveDisabled={drafting || !!calendarError}
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
        // Screen readers announce MONDAY's replies (a new plan, an approval summary) as they arrive.
        <div className="rounded-xl border border-border bg-card/60 p-4 max-w-3xl mx-auto w-full space-y-3" aria-live="polite">
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
          // Not while the week is loading or failed to load: the plan is unknown then, and a
          // "create" or "approve" would act on a week the page does not show.
          busy={drafting || approving !== null || loading || !!loadError}
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

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Dismiss this message"
      title="Dismiss"
      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <XIcon className="h-4 w-4" />
    </button>
  );
}

/** "Saturday", "Saturday and Sunday", "Monday, Tuesday and Friday". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function fmtWeek(monday: string) {
  return new Date(`${monday}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
