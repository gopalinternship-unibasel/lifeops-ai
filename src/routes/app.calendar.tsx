import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { fetchCalendar } from "@/functions/chat.functions";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WeekGrid, type CalendarEvent } from "@/components/calendar/WeekGrid";
import { getBrowserTimeZone } from "@/lib/date";
import { getErrorMessage } from "@/lib/errors";
import { firstHour, settleUnlessCancelled, startOfWeekMonday } from "@/lib/calendar-grid";

export const Route = createFileRoute("/app/calendar")({
  component: CalendarPage,
});

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
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
          setEvents((result.events ?? []) as CalendarEvent[]);
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
