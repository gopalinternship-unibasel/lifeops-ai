import { useState } from "react";
import type { WeekPlan, WeekPlanDay, WeekPlanItem, BusyEvent } from "@/types/plan";
import { Check, Calendar as CalIcon, Pencil, X as XIcon } from "lucide-react";
import { formatLocalDate } from "@/lib/date";

interface Props {
  plan: WeekPlan | null;
  busyEvents: BusyEvent[];
  approvedDates: Set<string>;
  /** Per date: indexes of the items already in the calendar. */
  addedItems?: Record<string, number[]>;
  onApproveDay: (date: string) => void;
  approving: string | null;
  onItemTimeChange?: (date: string, itemIndex: number, starts_at: string, ends_at: string) => Promise<void> | void;
}

const FULL_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function PlanWeekGrid({ plan, busyEvents, approvedDates, addedItems, onApproveDay, approving, onItemTimeChange }: Props) {
  if (!plan) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
      {plan.days.map((day, i) => (
        <DayCard
          key={day.date}
          day={day}
          dayLabel={FULL_DAY_NAMES[i]}
          busy={busyEvents.filter(b => sameDay(b.starts_at, day.date))}
          approved={approvedDates.has(day.date)}
          added={addedItems?.[day.date] ?? []}
          approving={approving === day.date}
          onApprove={() => onApproveDay(day.date)}
          onItemTimeChange={onItemTimeChange}
        />
      ))}
    </div>
  );
}

function DayCard({ day, dayLabel, busy, approved, added, approving, onApprove, onItemTimeChange }: {
  day: WeekPlanDay;
  dayLabel: string;
  busy: BusyEvent[];
  approved: boolean;
  added: number[];
  approving: boolean;
  onApprove: () => void;
  onItemTimeChange?: Props["onItemTimeChange"];
}) {
  const dateObj = new Date(day.date + "T00:00:00");
  const subLabel = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="rounded-2xl bg-card border border-border/60 p-5 shadow-sm flex flex-col min-h-[260px]" data-testid="plan-day" data-date={day.date} data-approved={approved ? "true" : "false"}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-2xl font-serif tracking-tight text-foreground">{dayLabel}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{subLabel}</div>
        </div>
        {approved ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase text-emerald-600 dark:text-emerald-400">
            <Check className="h-3 w-3" /> Added
          </span>
        ) : (
          <button
            onClick={onApprove}
            disabled={approving || day.items.length === 0}
            className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-md border border-border hover:bg-muted disabled:opacity-40 transition"
          >
            {approving ? "…" : "Approve"}
          </button>
        )}
      </div>

      <RhythmBar items={day.items} busy={busy} />

      {day.headline && (
        <p className="text-sm text-foreground/80 italic font-serif mt-3 leading-snug">
          {day.headline}
        </p>
      )}

      <ul className="mt-4 space-y-3 flex-1">
        {busy.map((b, idx) => (
          <li key={`b-${idx}`} className="flex items-start gap-2.5 opacity-60">
            <span className="text-base leading-none mt-0.5">📌</span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-foreground/70 truncate">
                <span className="text-muted-foreground">●</span> {b.title}{" "}
                <span className="text-[10px] font-mono text-muted-foreground">(busy)</span>
              </div>
              <div className="text-[11px] font-mono text-muted-foreground">
                {fmt(b.starts_at)}–{fmt(b.ends_at)}
              </div>
            </div>
          </li>
        ))}
        {day.items.map((it, idx) => (
          <PlanItemRow
            key={idx}
            item={it}
            added={added.includes(idx)}
            editable={!!onItemTimeChange && !approved && !added.includes(idx)}
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
  const [start, setStart] = useState(toLocalHM(item.starts_at));
  const [end, setEnd] = useState(toLocalHM(item.ends_at));
  const [saving, setSaving] = useState(false);

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
              onClick={() => setEditing(true)}
              className="opacity-0 group-hover:opacity-100 transition text-muted-foreground hover:text-foreground"
              title="Edit time"
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
              className="font-mono text-[11px] bg-background border border-border rounded px-1.5 py-0.5 w-[78px] focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="text-[11px] text-muted-foreground">–</span>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="font-mono text-[11px] bg-background border border-border rounded px-1.5 py-0.5 w-[78px] focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button onClick={save} disabled={saving} className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {saving ? "…" : "Save"}
            </button>
            <button onClick={() => { setEditing(false); setStart(toLocalHM(item.starts_at)); setEnd(toLocalHM(item.ends_at)); }} className="text-muted-foreground hover:text-foreground">
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

function RhythmBar({ items, busy }: { items: { starts_at: string; ends_at: string }[]; busy: BusyEvent[] }) {
  const dayStart = 7 * 60;
  const dayEnd = 22 * 60;
  const span = dayEnd - dayStart;
  const seg = (s: string, e: string, color: string, key: string) => {
    const sd = new Date(s), ed = new Date(e);
    const sm = Math.max(dayStart, sd.getHours() * 60 + sd.getMinutes());
    const em = Math.min(dayEnd, ed.getHours() * 60 + ed.getMinutes());
    if (em <= sm) return null;
    return (
      <span key={key} className="absolute top-0 bottom-0 rounded-full"
        style={{ left: `${((sm - dayStart) / span) * 100}%`, width: `${((em - sm) / span) * 100}%`, background: color }} />
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
function sameDay(iso: string, ymd: string) {
  return formatLocalDate(new Date(iso)) === ymd;
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
