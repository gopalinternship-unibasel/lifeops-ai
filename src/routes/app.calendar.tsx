import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { fetchCalendar } from "@/functions/chat.functions";
import { ChevronLeft, ChevronRight, Calendar as CalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getBrowserTimeZone } from "@/lib/date";
import { getErrorMessage } from "@/lib/errors";
import { END_HOUR, firstHour, minutesOnDay, positionOnDay } from "@/lib/calendar-grid";

export const Route = createFileRoute("/app/calendar")({
  component: CalendarPage,
});

interface Ev {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  source: string;
}

const HOUR_PX = 48; // height of one hour row

function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = x.getDay(); // 0=Sun
  x.setDate(x.getDate() - dow);
  return x;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function CalendarPage() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"google" | "mock">("mock");
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const from = new Date(weekStart); from.setHours(0, 0, 0, 0);
    const to = addDays(weekStart, 7); to.setHours(0, 0, 0, 0);
    fetchCalendar(
      { data: { from: from.toISOString(), to: to.toISOString(), timeZone: getBrowserTimeZone() } } as Parameters<
        typeof fetchCalendar
      >[0],
    ).then((result: Awaited<ReturnType<typeof fetchCalendar>>) => {
      setEvents((result.events ?? []) as Ev[]);
      setSource(result.source ?? "mock");
      setError("error" in result && result.error ? String(result.error) : null);
    }).catch((e: unknown) => {
      setEvents([]);
      setError(getErrorMessage(e, "Could not load the calendar"));
    }).finally(() => setLoading(false));
  }, [weekStart]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  // 06:00 to midnight, starting earlier when an event of this week does (an early event is never hidden).
  const startHour = useMemo(() => firstHour(events, days), [events, days]);
  const hours = useMemo(() => Array.from({ length: END_HOUR - startHour + 1 }, (_, i) => i + startHour), [startHour]);
  const today = new Date();

  const monthLabel = useMemo(() => {
    const end = addDays(weekStart, 6);
    if (weekStart.getMonth() === end.getMonth()) {
      return weekStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
    return `${weekStart.toLocaleDateString(undefined, { month: "short" })} – ${end.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
  }, [weekStart]);

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>
            Today
          </Button>
          <div className="flex items-center">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setWeekStart(addDays(weekStart, -7))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setWeekStart(addDays(weekStart, 7))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{monthLabel}</h1>
        </div>
        <div className="text-xs text-muted-foreground inline-flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${source === "google" ? "bg-emerald-500" : "bg-amber-500"}`} />
          {source === "google" ? "Synced with Google" : "Demo data"}
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">{error}</div>
      )}
      {loading ? (
        <div className="text-sm text-muted-foreground py-24 text-center">Loading…</div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-[56px_repeat(7,1fr)] border-b border-border bg-muted/30">
            <div />
            {days.map((d) => {
              const isToday = sameDay(d, today);
              return (
                <div key={d.toISOString()} className="px-2 py-2 text-center border-l border-border">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    {d.toLocaleDateString(undefined, { weekday: "short" })}
                  </div>
                  <div
                    className={`mt-1 inline-flex items-center justify-center h-7 w-7 rounded-full text-sm font-medium ${
                      isToday ? "bg-primary text-primary-foreground" : "text-foreground"
                    }`}
                  >
                    {d.getDate()}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Time grid */}
          <div className="relative grid grid-cols-[56px_repeat(7,1fr)]">
            {/* Hour column */}
            <div>
              {hours.map((h) => (
                <div key={h} style={{ height: HOUR_PX }} className="border-b border-border relative">
                  <span className="absolute -top-2 right-2 text-[10px] font-mono text-muted-foreground bg-card px-1">
                    {h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`}
                  </span>
                </div>
              ))}
            </div>

            {/* Day columns */}
            {days.map((d) => {
              // Every event that overlaps this day (one that runs past midnight shows on both days).
              const dayEvents = events.filter((e) => minutesOnDay(e, d) !== null);
              const isToday = sameDay(d, today);
              return (
                <div key={d.toISOString()} className="relative border-l border-border">
                  {hours.map((h) => (
                    <div key={h} style={{ height: HOUR_PX }} className="border-b border-border" />
                  ))}
                  {/* Now line */}
                  {isToday && <NowIndicator startHour={startHour} />}
                  {/* Events */}
                  {dayEvents.map((e) => {
                    const pos = positionOnDay(e, d, startHour, HOUR_PX);
                    if (!pos) return null;
                    return (
                      <div
                        key={e.id}
                        data-testid="calendar-event"
                        className="absolute left-1 right-1 rounded-md px-2 py-1 overflow-hidden text-[11px] leading-tight cursor-pointer hover:shadow-md transition-shadow"
                        style={{
                          top: pos.top,
                          height: pos.height,
                          background: "var(--gradient-brand-soft, color-mix(in oklab, var(--primary) 18%, transparent))",
                          border: "1px solid color-mix(in oklab, var(--primary) 35%, transparent)",
                          color: "var(--foreground)",
                        }}
                        title={`${e.title}\n${fmt(e.starts_at)} – ${fmt(e.ends_at)}${e.notes ? `\n\n${e.notes}` : ""}`}
                      >
                        <div className="font-medium truncate">{e.title}</div>
                        <div className="opacity-70 font-mono">
                          {fmt(e.starts_at)} – {fmt(e.ends_at)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {events.length === 0 && (
            <div className="text-center py-12 border-t border-border text-sm text-muted-foreground">
              <CalIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
              No events this week.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NowIndicator({ startHour }: { startHour: number }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const min = now.getHours() * 60 + now.getMinutes();
  const gridStart = startHour * 60;
  const gridEnd = (END_HOUR + 1) * 60;
  if (min < gridStart || min > gridEnd) return null;
  const top = ((min - gridStart) / 60) * HOUR_PX;
  return (
    <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top }}>
      <div className="h-px bg-red-500" />
      <div className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-red-500" />
    </div>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
