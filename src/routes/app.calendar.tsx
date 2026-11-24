import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCalendar } from "@/functions/chat.functions";
import { ChevronLeft, ChevronRight, Calendar as CalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getBrowserTimeZone } from "@/lib/date";
import { getErrorMessage } from "@/lib/errors";
import {
  canWrapEventTime,
  END_HOUR,
  firstHour,
  hourLabel,
  isCompactEvent,
  minutesOnDay,
  positionOnDay,
  settleUnlessCancelled,
  startOfWeekMonday,
} from "@/lib/calendar-grid";

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
const HOUR_COLUMN_PX = 56;

// The day headers and the time grid are two grids, so they must use exactly the same tracks.
// minmax(0,1fr) keeps the seven day tracks equal whatever they hold: with plain 1fr the header
// cells (date circle plus padding) grew wider than the body columns at phone width, the headers
// drifted off their columns and the last header was cut off.
const WEEK_COLUMNS = "grid-cols-[56px_repeat(7,minmax(0,1fr))]";

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
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    // The previous week's error does not belong to the week that is loading now.
    setError(null);
    const from = new Date(weekStart); from.setHours(0, 0, 0, 0);
    const to = addDays(weekStart, 7); to.setHours(0, 0, 0, 0);
    // The cleanup cancels this load when another week is picked first, so a slow answer for
    // this week cannot replace the newer week on screen.
    return settleUnlessCancelled(
      fetchCalendar(
        { data: { from: from.toISOString(), to: to.toISOString(), timeZone: getBrowserTimeZone() } } as Parameters<
          typeof fetchCalendar
        >[0],
      ),
      {
        onResult: (result: Awaited<ReturnType<typeof fetchCalendar>>) => {
          setEvents((result.events ?? []) as Ev[]);
          setSource(result.source ?? "mock");
          setError("error" in result && result.error ? String(result.error) : null);
        },
        onError: (e: unknown) => {
          setEvents([]);
          setError(getErrorMessage(e, "Could not load the calendar"));
        },
        onSettled: () => setLoading(false),
      },
    );
  }, [weekStart]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  // 06:00 to midnight, starting earlier when an event of this week does (an early event is never hidden).
  const startHour = useMemo(() => firstHour(events, days), [events, days]);

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
          <Button variant="outline" size="sm" onClick={() => setWeekStart(startOfWeekMonday(new Date()))}>
            Today
          </Button>
          <div className="flex items-center">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Previous week" onClick={() => setWeekStart(addDays(weekStart, -7))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next week" onClick={() => setWeekStart(addDays(weekStart, 7))}>
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
        <WeekGrid days={days} events={events} startHour={startHour} today={new Date()} />
      )}
    </div>
  );
}

/** The week's day headers, hour rows and event boxes (exported for the layout tests). */
export function WeekGrid({ days, events, startHour, today }: { days: Date[]; events: Ev[]; startHour: number; today: Date }) {
  const hours = Array.from({ length: END_HOUR - startHour + 1 }, (_, i) => i + startHour);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const todayIndex = days.findIndex((d) => sameDay(d, today));

  // On a phone the week scrolls sideways (see below); bring today's column into view, since
  // with Monday-first weeks it is often off to the right. The grid mounts afresh for every
  // week (the page shows "Loading…" in between), so this runs once per week shown.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || todayIndex < 0 || scroller.scrollWidth <= scroller.clientWidth) return;
    const cell = scroller.querySelector<HTMLElement>(`[data-day-index="${todayIndex}"]`);
    if (!cell) return;
    const offset = cell.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    if (offset + cell.offsetWidth <= scroller.clientWidth) return; // already in view
    // Today's column goes right after the hour column, which stays pinned at the left.
    scroller.scrollLeft = Math.max(0, offset - HOUR_COLUMN_PX);
  }, [todayIndex]);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Below the sm breakpoint seven readable days do not fit the screen, so the week scrolls
          sideways inside the card (the header and time grid together, the hour column stays in
          view) instead of squeezing each day to a few pixels. */}
      <div ref={scrollerRef} className="overflow-x-auto" data-testid="calendar-scroller">
        <div className="min-w-[640px] sm:min-w-0">
          {/* Day headers */}
          <div className={`grid ${WEEK_COLUMNS} border-b border-border bg-muted/30`} data-testid="calendar-header-grid">
            <div className="max-sm:sticky max-sm:left-0 max-sm:z-20 bg-card">
              <div className="h-full bg-muted/30" />
            </div>
            {days.map((d, i) => {
              const isToday = i === todayIndex;
              return (
                <div key={d.toISOString()} data-day-index={i} className="px-2 py-2 text-center border-l border-border">
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
          <div className={`relative grid ${WEEK_COLUMNS}`} data-testid="calendar-body-grid">
            {/* Hour column */}
            <div className="max-sm:sticky max-sm:left-0 max-sm:z-20 bg-card">
              {hours.map((h) => (
                <div key={h} style={{ height: HOUR_PX }} className="border-b border-border relative">
                  <span className="absolute -top-2 right-2 text-[10px] font-mono text-muted-foreground bg-card px-1 whitespace-nowrap">
                    {hourLabel(h)}
                  </span>
                </div>
              ))}
            </div>

            {/* Day columns */}
            {days.map((d, i) => {
              // Every event that overlaps this day (one that runs past midnight shows on both days).
              const dayEvents = events.filter((e) => minutesOnDay(e, d) !== null);
              const isToday = i === todayIndex;
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
                    const start = fmt(e.starts_at);
                    // A short event has no room for a second line: title and start time share one.
                    const compact = isCompactEvent(pos.height);
                    return (
                      <div
                        key={e.id}
                        data-testid="calendar-event"
                        data-compact={compact ? "true" : "false"}
                        className={`absolute left-1 right-1 rounded-md px-2 ${compact ? "py-0.5" : "py-1"} overflow-hidden text-[11px] leading-tight cursor-pointer hover:shadow-md transition-shadow`}
                        style={{
                          top: pos.top,
                          height: pos.height,
                          background: "var(--gradient-brand-soft, color-mix(in oklab, var(--primary) 18%, transparent))",
                          border: "1px solid color-mix(in oklab, var(--primary) 35%, transparent)",
                          color: "var(--foreground)",
                        }}
                        title={`${e.title}\n${start} – ${fmt(e.ends_at)}${e.notes ? `\n\n${e.notes}` : ""}`}
                      >
                        {compact ? (
                          <div className="truncate">
                            <span className="font-medium">{e.title}</span>
                            <span className="opacity-70 font-mono"> · {start}</span>
                          </div>
                        ) : (
                          <>
                            <div className="font-medium truncate">{e.title}</div>
                            <div className={`opacity-70 font-mono ${canWrapEventTime(pos.height) ? "" : "truncate"}`}>
                              {/* Phones: the start time alone fits the column; the range would be cut. */}
                              <span className="whitespace-nowrap sm:hidden">{start}</span>
                              <span className="hidden sm:inline">
                                {start} – {fmt(e.ends_at)}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {events.length === 0 && (
        <div className="text-center py-12 border-t border-border text-sm text-muted-foreground">
          <CalIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
          No events this week.
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
