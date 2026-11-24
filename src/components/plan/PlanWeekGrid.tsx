import { useState } from "react";
import type { WeekPlan, WeekPlanDay, WeekPlanItem, BusyEvent } from "@/types/plan";
import { Check, Calendar as CalIcon, Pencil, X as XIcon } from "lucide-react";
import { minutesOnDay } from "@/lib/calendar-grid";
import { canEditPlanItem, planDayStatus } from "@/lib/plan-state";

interface Props {
  plan: WeekPlan | null;
  busyEvents: BusyEvent[];
  approvedDates: Set<string>;
  /** Per date: indexes of the items already in the calendar. */
  addedItems?: Record<string, number[]>;
  onApproveDay: (date: string) => void;
  /** The day being approved ("all" for the whole week), or null. */
  approving: string | null;
  /** Day approvals are paused, for example while the calendar could not be read. */
  approveDisabled?: boolean;
  onItemTimeChange?: (date: string, itemIndex: number, starts_at: string, ends_at: string) => Promise<void> | void;
}

const FULL_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function PlanWeekGrid({ plan, busyEvents, approvedDates, addedItems, onApproveDay, approving, approveDisabled, onItemTimeChange }: Props) {
  if (!plan) return null;
  // One approval at a time: "Approve entire week" and a day's Approve running together both
  // wrote the same events.
  const approveLocked = approving !== null || !!approveDisabled;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
      {plan.days.map((day, i) => (
        <DayCard
          key={day.date}
          day={day}
          dayLabel={FULL_DAY_NAMES[i]}
          // Every day an event overlaps, not only its start day: one that runs past midnight
          // also blocks the next morning.
          busy={busyEvents.filter((b) => minutesOnDay(b, localMidnight(day.date)) !== null)}
          approved={approvedDates.has(day.date)}
          added={addedItems?.[day.date] ?? []}
          approving={approving === day.date}
          approveLocked={approveLocked}
          onApprove={() => onApproveDay(day.date)}
          onItemTimeChange={onItemTimeChange}
        />
      ))}
    </div>
  );
}

function DayCard({ day, dayLabel, busy, approved, added, approving, approveLocked, onApprove, onItemTimeChange }: {
  day: WeekPlanDay;
  dayLabel: string;
  busy: BusyEvent[];
  approved: boolean;
  added: number[];
  approving: boolean;
  approveLocked: boolean;
  onApprove: () => void;
  onItemTimeChange?: Props["onItemTimeChange"];
}) {
  const dateObj = localMidnight(day.date);
  const subLabel = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // Approve only where there is something to add (see planDayStatus).
  const nowMs = Date.now();
  const status = planDayStatus(day, added, approved, nowMs);

  return (
    <div className="rounded-2xl bg-card border border-border/60 p-5 shadow-sm flex flex-col min-h-[260px]" data-testid="plan-day" data-date={day.date} data-approved={approved ? "true" : "false"} data-status={status}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-2xl font-serif tracking-tight text-foreground">{dayLabel}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{subLabel}</div>
        </div>
        {status === "added" ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase text-emerald-600 dark:text-emerald-400">
            <Check className="h-3 w-3" /> Added
          </span>
        ) : status === "approve" ? (
          <button
            type="button"
            onClick={onApprove}
            disabled={approveLocked}
            className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-md border border-border hover:bg-muted disabled:opacity-40 transition"
          >
            {approving ? "…" : "Approve"}
          </button>
        ) : (
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground" data-testid="plan-day-status">
            {status === "over" ? "Past" : "Nothing to add"}
          </span>
        )}
      </div>

      <RhythmBar items={day.items} busy={busy} dayStart={dateObj} />

      {day.headline && (
        <p className="text-sm text-foreground/80 italic font-serif mt-3 leading-snug">
          {day.headline}
        </p>
      )}

      <ul className="mt-4 space-y-3 flex-1">
        {busy.map((b, idx) => (
          <li key={`b-${idx}`} className="flex items-start gap-2.5 opacity-60" data-testid="plan-busy">
            <span className="text-base leading-none mt-0.5">📌</span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-foreground/70 truncate">
                <span className="text-muted-foreground">●</span> {b.title}{" "}
                <span className="text-[10px] font-mono text-muted-foreground">(busy)</span>
              </div>
              <div className="text-[11px] font-mono text-muted-foreground">
                {busyTimeLabel(b, dateObj)}
              </div>
            </div>
          </li>
        ))}
        {day.items.map((it, idx) => (
          <PlanItemRow
            key={idx}
            item={it}
            added={added.includes(idx)}
            // Not for items in the calendar or already started: the server refuses those edits.
            editable={!!onItemTimeChange && canEditPlanItem(it, { added: added.includes(idx), dayApproved: approved, nowMs })}
            onSave={async (s, e) => onItemTimeChange?.(day.date, idx, s, e)}
          />
        ))}
        {day.items.length === 0 && busy.length === 0 && (
          <li className="text-xs text-muted-foreground italic flex items-center gap-2">
            <CalIcon className="h-3 w-3" /> Free day — nothing scheduled.
          </li>
        )}
      </ul>
    </div>
  );
}

function PlanItemRow({ item, added, editable, onSave }: {
  item: WeekPlanItem;
  added: boolean;
  editable: boolean;
  onSave: (starts_at: string, ends_at: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(() => toLocalHM(item.starts_at));
  const [end, setEnd] = useState(() => toLocalHM(item.ends_at));
  const [saving, setSaving] = useState(false);

  // The editor starts from the item's current times. The row stays mounted when a refinement
  // replaces the plan, and saving kept the times from before, which moved the item back.
  const openEditor = () => {
    setStart(toLocalHM(item.starts_at));
    setEnd(toLocalHM(item.ends_at));
    setEditing(true);
  };

  const save = async () => {
    if (!start || !end) return;
    setSaving(true);
    try {
      const newStart = mergeDateAndHM(item.starts_at, start);
      const newEnd = mergeDateAndHM(item.ends_at, end);
      await onSave(newStart, newEnd);
      setEditing(false);
    } catch {
      // The parent displays the server error. Keep the editor open for correction.
    } finally { setSaving(false); }
  };

  return (
    <li className="group flex items-start gap-2.5" data-testid="plan-item" data-added={added ? "true" : "false"}>
      <span className="text-base leading-none mt-0.5">{item.emoji}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-foreground truncate flex items-center gap-1.5">
          <span className="text-muted-foreground">●</span>
          <span className="truncate">{item.title}</span>
          {added && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-mono uppercase text-emerald-600 dark:text-emerald-400 shrink-0" title="In your calendar">
              <Check className="h-3 w-3" /> in calendar
            </span>
          )}
          {editable && !editing && (
            <button
              type="button"
              onClick={openEditor}
              // Visible on touch screens (no hover there) and under keyboard focus; with a mouse
              // it appears on hover, as before.
              className="pointer-fine:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition text-muted-foreground hover:text-foreground"
              title="Edit time"
              aria-label={`Edit time of ${item.title}`}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </div>
        {editing ? (
          <div className="mt-1 flex items-center gap-1.5">
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              aria-label={`Start time of ${item.title}`}
              className="font-mono text-[11px] bg-background border border-border rounded px-1.5 py-0.5 w-[78px] focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="text-[11px] text-muted-foreground">–</span>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              aria-label={`End time of ${item.title}`}
              className="font-mono text-[11px] bg-background border border-border rounded px-1.5 py-0.5 w-[78px] focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button type="button" onClick={save} disabled={saving} className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {saving ? "…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setStart(toLocalHM(item.starts_at)); setEnd(toLocalHM(item.ends_at)); }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Cancel editing"
              title="Cancel"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <div className="text-[11px] font-mono text-muted-foreground">
            {fmt(item.starts_at)}–{fmt(item.ends_at)}
          </div>
        )}
      </div>
    </li>
  );
}

function RhythmBar({ items, busy, dayStart }: { items: { starts_at: string; ends_at: string }[]; busy: BusyEvent[]; dayStart: Date }) {
  const barStart = 7 * 60;
  const barEnd = 22 * 60;
  const span = barEnd - barStart;
  const seg = (s: string, e: string, color: string, key: string) => {
    // The part of the event on this day: one that crosses midnight ends at 24:00 here and
    // starts at 00:00 on the next day (it used to draw nothing or a wrong span).
    const onDay = minutesOnDay({ starts_at: s, ends_at: e }, dayStart);
    if (!onDay) return null;
    const sm = Math.max(barStart, onDay.start);
    const em = Math.min(barEnd, onDay.end);
    if (em <= sm) return null;
    return (
      <span key={key} className="absolute top-0 bottom-0 rounded-full"
        style={{ left: `${((sm - barStart) / span) * 100}%`, width: `${((em - sm) / span) * 100}%`, background: color }} />
    );
  };
  return (
    <div className="relative mt-4 h-1.5 rounded-full bg-muted overflow-hidden">
      {busy.map((b, i) => seg(b.starts_at, b.ends_at, "color-mix(in oklab, var(--muted-foreground) 50%, transparent)", `b${i}`))}
      {items.map((it, i) => seg(it.starts_at, it.ends_at, "color-mix(in oklab, var(--primary) 65%, transparent)", `i${i}`))}
    </div>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** A busy event's time on one day: "from 10:00 PM" when it goes on past midnight. */
function busyTimeLabel(event: BusyEvent, dayStart: Date): string {
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const startsBefore = new Date(event.starts_at) < dayStart;
  const endsAfter = new Date(event.ends_at) > nextDay;
  if (startsBefore && endsAfter) return "all day";
  if (startsBefore) return `until ${fmt(event.ends_at)}`;
  if (endsAfter) return `from ${fmt(event.starts_at)}`;
  return `${fmt(event.starts_at)}–${fmt(event.ends_at)}`;
}

/** Local midnight at the start of a YYYY-MM-DD day (the page runs in the browser's zone). */
function localMidnight(ymd: string): Date {
  return new Date(`${ymd}T00:00:00`);
}
function toLocalHM(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function mergeDateAndHM(iso: string, hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(iso);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
