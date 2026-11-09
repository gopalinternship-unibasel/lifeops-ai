"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import type { DayPlan, EventType } from "@/lib/types";
import { formatHumanDate } from "@/lib/date-utils";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/cn";

const TYPE_STYLE: Record<EventType, string> = {
  task: "bg-moss-50 text-moss",
  habit: "bg-amber-soft/60 text-ink",
  appointment: "bg-amber/30 text-ink",
  rest: "bg-cream-2 text-moss/70",
};

interface Props {
  day: DayPlan;
  index: number;
  isToday?: boolean;
  highlight?: Set<string>;
}

export function DayCard({ day, index, isToday, highlight }: Props) {
  const [open, setOpen] = useState(false);
  const { locale, t } = useLocale();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut", delay: index * 0.05 }}
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "group relative flex cursor-pointer flex-col rounded-card border border-line bg-white/80 p-5 shadow-card transition-all duration-300",
        "hover:-translate-y-0.5 hover:shadow-card-hover",
        isToday && "ring-1 ring-moss/40",
      )}
    >
      <div className="flex items-baseline justify-between">
        <div>
          <div className="font-serif text-lg text-ink">{day.weekday}</div>
          <div className="text-xs text-ink/50">{formatHumanDate(day.date, locale)}</div>
        </div>
        {isToday && (
          <span className="rounded-full bg-amber px-2 py-0.5 text-[10px] font-medium text-ink">
            {t.todayBadge}
          </span>
        )}
      </div>

      <div className="mt-3 font-serif text-[13px] leading-relaxed text-moss">
        {day.focus}
      </div>

      <div className="mt-4 space-y-2.5">
        {day.events.slice(0, open ? day.events.length : 4).map((ev) => {
          const changed = highlight?.has(ev.id);
          return (
            <div
              key={ev.id}
              className={cn(
                "flex items-start gap-2.5 rounded-xl px-2 py-1.5 transition-colors",
                changed && "bg-amber/20",
              )}
            >
              <span className="mt-0.5 text-base leading-none">{ev.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] text-ink">{ev.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink/50">
                  <span>
                    {ev.startTime}–{ev.endTime}
                  </span>
                  <span className="opacity-50">·</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px]",
                      TYPE_STYLE[ev.type],
                    )}
                  >
                    {t.eventType[ev.type]}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {day.events.length > 4 && (
        <div className="mt-3 flex items-center justify-center gap-1 text-[11px] text-moss/60">
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
          />
          <span>{open ? t.expand : t.moreCount(day.events.length - 4)}</span>
        </div>
      )}
    </motion.div>
  );
}
