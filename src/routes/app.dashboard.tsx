import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Bot, Calendar, Check, CheckCircle2, CircleSlash, Inbox, ListChecks, Loader2, Mail, MessageSquare, Play, ShieldCheck,
  Sparkles, X,
} from "lucide-react";
import {
  completeBackendTask, decideBackendAction, executeBackendAction, fetchDashboard, fetchPlanRequest, runChaosPlan,
} from "@/functions/dashboard.functions";
import { dismissChatCard } from "@/functions/chat.functions";
import { EmailDraftCard, PendingEventCard } from "@/components/workspace/ContextPanel";
import type { PlanRequestView } from "@/lib/plan-request";
import { getBrowserTimeZone } from "@/lib/date";
import { getErrorMessage } from "@/lib/errors";
import { prioritiesSubtitle } from "@/lib/priorities";

export const Route = createFileRoute("/app/dashboard")({
  component: DashboardPage,
});

type DashboardData = Awaited<ReturnType<typeof fetchDashboard>>;
type PlannerData = Extract<DashboardData["planner"], { online: true }>["data"];
type PlannerAction = PlannerData["actions"][number];

/** How often the page asks whether a plan that is still running (from before a reload) is done. */
const PLAN_POLL_MS = 5000;

const EXAMPLE =
  "Exams next week, two assignments due Friday, a meeting tomorrow I might need to move, and I keep forgetting to call the bank.";

function DashboardPage() {
  const timeZone = useMemo(() => getBrowserTimeZone(), []);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  // This page's own "Plan it" call is running.
  const [planning, setPlanning] = useState(false);
  // The newest plan request as stored on the server: its result survives a reload, and a request
  // that is still running (started before a reload, or in another tab) shows as "Planning…".
  const [request, setRequest] = useState<PlanRequestView | null>(null);
  const planPoll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busyAction, setBusyAction] = useState<number | null>(null);
  // Fallback cards (in-app assistant) the user saved or dismissed on this page.
  const [handledCards, setHandledCards] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDashboard({ data: { timeZone } });
      setData(next);
      setRequest(next.planRequest);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Could not load the dashboard"));
    } finally {
      setLoading(false);
    }
  }, [timeZone]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A request that runs on the server without this page waiting for it: check until it is done.
  const serverRunning = request?.status === "running" && !planning;
  useEffect(() => {
    if (!serverRunning) return;
    let stopped = false;
    const check = async () => {
      try {
        const { request: latest } = await fetchPlanRequest();
        if (stopped) return;
        if (latest?.status === "running") {
          planPoll.current = setTimeout(check, PLAN_POLL_MS);
          return;
        }
        setRequest(latest);
        await refresh();
      } catch {
        if (!stopped) planPoll.current = setTimeout(check, PLAN_POLL_MS * 3);
      }
    };
    planPoll.current = setTimeout(check, PLAN_POLL_MS);
    return () => {
      stopped = true;
      if (planPoll.current) clearTimeout(planPoll.current);
    };
  }, [serverRunning, refresh]);

  async function plan() {
    const text = input.trim();
    if (text.length < 3 || planning || serverRunning) return;
    setPlanning(true);
    setRequest({ id: "pending", input: text, status: "running", startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null });
    try {
      // The planner service, or the in-app assistant when the service is down (both on the server).
      const { request: done } = await runChaosPlan({ data: { input: text, timeZone } });
      setRequest(done);
      setInput("");
      await refresh();
    } catch (error: unknown) {
      void refresh();
      toast.error(getErrorMessage(error, "Planning failed"));
    } finally {
      setPlanning(false);
    }
  }

  async function decide(action: PlannerAction, decision: "approve" | "reject") {
    setBusyAction(action.id);
    try {
      await decideBackendAction({ data: { id: action.id, decision } });
      toast.success(decision === "approve" ? "Approved — run it when you are ready" : "Rejected");
      await refresh();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Could not update the action"));
    } finally {
      setBusyAction(null);
    }
  }

  async function run(action: PlannerAction) {
    setBusyAction(action.id);
    try {
      const r = await executeBackendAction({ data: { id: action.id, timeZone } });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      await refresh();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Could not run the action"));
    } finally {
      setBusyAction(null);
    }
  }

  async function completeTask(id: number) {
    try {
      await completeBackendTask({ data: { id } });
      await refresh();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Could not complete the task"));
    }
  }

  if (loading || !data) {
    return <div className="grid place-items-center py-24"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const ws = data.workspace;
  const busy = planning || serverRunning;
  const planResult = request?.status === "done" ? request.result : null;
  const planner = data.planner.online ? data.planner.data : null;
  const actions = planner ? [...planner.actions].sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || b.id - a.id) : [];
  const executed = actions.filter((a) => a.status === "executed");

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 space-y-6" data-testid="dashboard">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Dashboard</div>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">Your week at a glance</h1>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <Badge tone={ws.googleConnected ? "green" : "amber"}>{ws.googleConnected ? "Google connected" : "Demo inbox & calendar"}</Badge>
          <Badge tone="slate"><Bot className="h-3 w-3" /> {ws.aiProvider.provider} · {ws.aiProvider.model}</Badge>
          <Badge tone={data.planner.online ? "green" : "amber"} testId="planner-status">
            {data.planner.online ? "Planner service online" : "Planner service offline — in-app assistant"}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Metric icon={<ListChecks className="h-4 w-4" />} label="Ranked priorities" value={ws.priorities.length} />
        <Metric icon={<Calendar className="h-4 w-4" />} label="Events next 7 days" value={ws.eventsNext7Days} />
        <Metric icon={<Sparkles className="h-4 w-4" />} label="Plan blocks approved" value={`${ws.approvedItems}/${ws.plannedItems}`} />
        <Metric icon={<Mail className="h-4 w-4" />} label="Drafts saved (unsent)" value={ws.draftCount} />
        <Metric icon={<MessageSquare className="h-4 w-4" />} label="Chat messages" value={ws.chatMessages} />
        <Metric icon={<ShieldCheck className="h-4 w-4" />} label="Actions awaiting approval" value={planner ? planner.metrics.pending_actions : "—"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6 min-w-0">
          <Card title="From chaos to plan" subtitle="Dump everything on your mind. MONDAY extracts tasks, ranks them and proposes calendar blocks and email drafts — nothing happens until you approve it.">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={4}
              placeholder={EXAMPLE}
              maxLength={4000}
              data-testid="chaos-input"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
              <button type="button" onClick={() => setInput(EXAMPLE)} className="text-xs text-muted-foreground hover:text-foreground">Use an example</button>
              <button
                type="button"
                onClick={plan}
                disabled={busy || input.trim().length < 3}
                data-testid="chaos-submit"
                className="inline-flex items-center gap-2 rounded-md bg-gradient-brand px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-95 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {busy ? "Planning… (a local model can take a few minutes)" : "Plan it"}
              </button>
            </div>

            {serverRunning && request && (
              <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="plan-running">
                <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                Still planning “{shorten(request.input, 120)}” (started {fmtClock(request.startedAt)}). The result appears here when it is ready.
              </div>
            )}
            {request?.status === "failed" && !busy && (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="plan-failed">
                Planning “{shorten(request.input, 80)}” failed: {request.error}
              </div>
            )}
            {request?.status === "interrupted" && !busy && (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" data-testid="plan-interrupted">
                The plan for “{shorten(request.input, 80)}” (started {fmtClock(request.startedAt)}) did not finish: the request was cut off, for example by a server restart. Plan it again.
              </div>
            )}

            {planResult?.mode === "service" && (
              <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-sm" data-testid="plan-result">
                <div className="font-medium">{planResult.summary}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {planResult.tasks} tasks and {planResult.actions} proposed actions ·{" "}
                  {planResult.planner === "llm" ? "planned by the AI model" : "keyword planner (no model answer)"}
                  {request?.finishedAt ? ` · ${fmtClock(request.finishedAt)}` : ""}
                </div>
                {planResult.note && <div className="mt-1 text-xs text-amber-800">{planResult.note}</div>}
              </div>
            )}
            {planResult?.mode === "in-app" && (
              <div className="mt-4 space-y-3" data-testid="plan-result">
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  {planResult.reason} The in-app assistant handled it instead.
                </div>
                <div className="rounded-md border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap">{planResult.reply}</div>
                {(planResult.panel.pendingEvents ?? []).filter((ev) => !handledCards.has(ev.id)).map((ev) => (
                  <PendingEventCard
                    key={ev.id}
                    ev={ev}
                    onSaved={(id) => {
                      setHandledCards((prev) => new Set(prev).add(id));
                      void refresh();
                    }}
                    onDismiss={(id, opts) => {
                      setHandledCards((prev) => new Set(prev).add(id));
                      if (opts?.remember !== false) {
                        dismissChatCard({ data: { cardId: id } }).catch((error: unknown) =>
                          toast.error(getErrorMessage(error, "Could not remember the dismissal")),
                        );
                      }
                    }}
                  />
                ))}
                {planResult.panel.emailDraft && (
                  <EmailDraftCard
                    key={planResult.panel.emailDraft.id ?? planResult.panel.emailDraft.messageId}
                    draft={planResult.panel.emailDraft}
                    onSaved={() => void refresh()}
                  />
                )}
              </div>
            )}
          </Card>

          <Card title="Action approval center" subtitle="Proposed by the planner. Approve, then run: calendar blocks are checked for conflicts, emails become drafts only.">
            {!planner ? (
              <Empty icon={<CircleSlash className="h-6 w-6" />} text={data.planner.online ? "" : data.planner.error} />
            ) : actions.length === 0 ? (
              <Empty icon={<ShieldCheck className="h-6 w-6" />} text="No proposed actions yet. Plan something above." />
            ) : (
              <ul className="space-y-2" data-testid="action-list">
                {actions.map((action) => (
                  <li key={action.id} data-testid={`action-${action.id}`} data-status={action.status}
                    className="rounded-md border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{action.title}</span>
                          <Badge tone="slate">{labelFor(action.action_type)}</Badge>
                          <Badge tone={action.risk_level === "low" ? "green" : action.risk_level === "medium" ? "amber" : "red"}>{action.risk_level} risk</Badge>
                          <Badge tone={statusTone(action.status)} testId="action-status">{action.status}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {/* An email draft has no meaningful time (a model gave one: "0:00Draft to ..."). */}
                          {action.start_time && action.action_type !== "email_draft"
                            ? action.end_time && action.end_time > action.start_time
                              ? `${fmtNaive(action.start_time)} – ${fmtNaive(action.end_time, true)}`
                              : fmtNaive(action.start_time)
                            : null}
                          {action.email_to ? `Draft to ${action.email_to}: ${action.email_subject ?? ""}` : null}
                          {!action.start_time && !action.email_to ? action.description : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        {action.status === "pending" && (
                          <>
                            <button onClick={() => decide(action, "approve")} disabled={busyAction === action.id}
                              className="inline-flex items-center gap-1 rounded-md bg-gradient-brand px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60">
                              <Check className="h-3 w-3" /> Approve
                            </button>
                            <button onClick={() => decide(action, "reject")} disabled={busyAction === action.id}
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-60">
                              <X className="h-3 w-3" /> Reject
                            </button>
                          </>
                        )}
                        {action.status === "approved" && (
                          <>
                            <button onClick={() => run(action)} disabled={busyAction === action.id}
                              className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background disabled:opacity-60">
                              {busyAction === action.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run
                            </button>
                            {/* An approved action that cannot run (overlap, time passed) can still be turned down. */}
                            <button onClick={() => decide(action, "reject")} disabled={busyAction === action.id}
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-60">
                              <X className="h-3 w-3" /> Reject
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {executed.length > 0 && (
            <Card title="Execution log" subtitle="What MONDAY actually did, and where.">
              <ul className="space-y-1.5 text-xs" data-testid="execution-log">
                {executed.map((action) => (
                  <li key={action.id} className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    <span className="font-medium">{action.title}</span>
                    <span className="text-muted-foreground">→ {action.provider ?? "?"}{action.external_id ? ` (${action.external_id.slice(0, 12)})` : ""}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6 min-w-0">
          <Card title="Top priorities" subtitle={prioritiesSubtitle(ws.priorities.map((p) => p.source))} testId="priorities-card">
            {ws.priorities.length === 0 ? (
              <Empty icon={<Inbox className="h-6 w-6" />} text="Ask the Workspace chat to check your emails." />
            ) : (
              <ol className="space-y-2" data-testid="priority-list">
                {ws.priorities.slice(0, 5).map((p) => (
                  <li key={`${p.priority_rank}-${p.title}`} className="flex gap-3">
                    <span className="shrink-0 h-6 w-6 rounded-md grid place-items-center text-[11px] font-mono font-semibold text-primary-foreground" style={{ background: "var(--gradient-brand)" }}>#{p.priority_rank ?? "?"}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium leading-snug">
                        {p.title}
                        {p.source === "rules" && <span className="ml-1.5 align-middle"><Badge tone="slate" testId="priority-by-rule">rule</Badge></span>}
                      </div>
                      {p.reason && <div className="text-[11px] text-muted-foreground">{p.reason}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="Next 7 days" subtitle={ws.googleConnected ? "From Google Calendar." : "From your demo calendar."}>
            {ws.calendarError ? (
              <div className="text-xs text-red-700">{ws.calendarError}</div>
            ) : ws.upcoming.length === 0 ? (
              <Empty icon={<Calendar className="h-6 w-6" />} text="Nothing scheduled." />
            ) : (
              <ul className="space-y-1.5 text-sm" data-testid="upcoming-list">
                {ws.upcoming.map((e, index) => (
                  <li key={`${index}-${e.title}-${e.starts_at}`} className="flex justify-between gap-3">
                    <span className="truncate">{e.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fmtDayTime(e.starts_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {planner && (
            <Card title="Planner task board" subtitle={planner.last_plan ? `Last plan: ${planner.last_plan.summary}` : "Tasks extracted by the planner service."}>
              {planner.next_best_actions.length === 0 ? (
                <Empty icon={<ListChecks className="h-6 w-6" />} text="No open tasks." />
              ) : (
                <ul className="space-y-2" data-testid="planner-tasks">
                  {planner.next_best_actions.map((task) => (
                    <li key={task.id} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{task.title}</div>
                        <div className="text-[11px] text-muted-foreground">
                          Priority {task.priority}/5 · ~{task.estimated_minutes} min{task.deadline ? ` · due ${fmtNaive(task.deadline)}` : ""}
                        </div>
                      </div>
                      <button onClick={() => completeTask(task.id)} className="shrink-0 text-[11px] rounded-md border border-border px-2 py-1 hover:bg-muted">Done</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 text-[11px] text-muted-foreground">
                {planner.metrics.done_tasks} done · {planner.metrics.pending_tasks} open · {planner.metrics.executed_actions} actions run
              </div>
            </Card>
          )}

          <Card title="Recent drafts" subtitle="Saved for review. MONDAY never sends email.">
            {ws.drafts.length === 0 ? (
              <Empty icon={<Mail className="h-6 w-6" />} text="No drafts yet." />
            ) : (
              <ul className="space-y-1.5 text-sm" data-testid="draft-list">
                {ws.drafts.map((d) => (
                  <li key={`${d.created_at}-${d.subject}`} className="min-w-0">
                    <div className="truncate font-medium">{d.subject}</div>
                    <div className="text-[11px] text-muted-foreground truncate">To {d.to_address} · {d.provider === "gmail" ? "Gmail draft" : "demo draft"}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function shorten(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function fmtClock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function statusOrder(status: string) {
  return ["pending", "approved", "failed", "executed", "rejected"].indexOf(status);
}

function statusTone(status: string): "green" | "amber" | "red" | "slate" | "blue" {
  if (status === "executed") return "green";
  if (status === "approved") return "blue";
  if (status === "pending") return "amber";
  if (status === "failed" || status === "rejected") return "red";
  return "slate";
}

function labelFor(type: string) {
  return ({ calendar_block: "calendar block", email_draft: "email draft", reminder: "reminder", task: "task" } as Record<string, string>)[type] ?? type;
}

/** Planner times are the user's local wall-clock time without an offset. */
function fmtNaive(value: string, timeOnly = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return value;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return timeOnly
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtDayTime(iso: string) {
  return new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function Card({ title, subtitle, children, testId }: { title: string; subtitle?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">{icon}<span className="text-[11px] leading-tight">{label}</span></div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function Badge({ tone, children, testId }: { tone: "green" | "amber" | "red" | "slate" | "blue"; children: React.ReactNode; testId?: string }) {
  const tones = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    red: "border-red-200 bg-red-50 text-red-800",
    slate: "border-border bg-muted text-foreground/80",
    blue: "border-blue-200 bg-blue-50 text-blue-800",
  } as const;
  return (
    <span data-testid={testId} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tones[tone]}`}>{children}</span>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="text-center py-6 text-muted-foreground">
      <div className="mx-auto w-fit opacity-60">{icon}</div>
      <p className="mt-2 text-xs">{text}</p>
    </div>
  );
}
