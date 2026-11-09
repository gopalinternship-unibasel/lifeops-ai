"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronLeft, MessageCircleHeart } from "lucide-react";
import type { WeekPlan } from "@/lib/types";
import { todayISO } from "@/lib/date-utils";
import { Button } from "@/components/ui/button";
import { DayCard } from "@/components/DayCard";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { useLocale } from "@/lib/i18n";

interface Props {
  plan: WeekPlan;
  highlight?: Set<string>;
}

export function WeekPlanView({ plan, highlight }: Props) {
  const today = todayISO();
  const { t } = useLocale();

  return (
    <div className="mx-auto max-w-7xl px-6 py-10 md:py-14">
      <div className="flex items-start justify-between gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-ink/50 transition-colors hover:text-moss"
        >
          <ChevronLeft className="h-4 w-4" />
          {t.backHome}
        </Link>
        <div className="flex items-center gap-2">
          <LocaleSwitch />
          <Link href="/checkin">
            <Button variant="amber" size="sm">
              <MessageCircleHeart className="h-4 w-4" />
              {t.todayCheckin}
            </Button>
          </Link>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="mt-10"
      >
        <div className="text-xs uppercase tracking-[0.2em] text-amber">{t.weekTheme}</div>
        <h1 className="mt-2 font-serif text-3xl leading-tight text-ink md:text-4xl">
          {plan.theme}
        </h1>
        <p className="mt-5 max-w-3xl font-serif text-[15px] leading-loose text-ink/70">
          {plan.rationale}
        </p>
      </motion.div>

      <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {plan.days.map((d, i) => (
          <DayCard
            key={d.date}
            day={d}
            index={i}
            isToday={d.date === today}
            highlight={highlight}
          />
        ))}
      </div>
    </div>
  );
}
