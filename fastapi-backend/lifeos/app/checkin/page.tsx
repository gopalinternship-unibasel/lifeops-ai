"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Check, Minus, X, Loader2, ChevronLeft, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ThinkingStream } from "@/components/ThinkingStream";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { loadPlan, savePlan, saveCheckin } from "@/lib/storage";
import { todayISO, formatHumanDate, weekdayOf } from "@/lib/date-utils";
import type { CheckinRecord, WeekPlan } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/cn";

type Status = "done" | "partial" | "skip";

export default function CheckinPage() {
  const router = useRouter();
  const { locale, t } = useLocale();
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [note, setNote] = useState("");
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState<string[]>([]);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = todayISO();

  useEffect(() => {
    const p = loadPlan();
    if (!p) {
      router.replace("/");
      return;
    }
    setPlan(p);
  }, [router]);

  const todayPlan = useMemo(() => plan?.days.find((d) => d.date === today), [plan, today]);

  if (!plan) {
    return (
      <main className="flex min-h-screen items-center justify-center text-ink/40">
        {t.openingPlan}
      </main>
    );
  }

  const targetDay = todayPlan ?? plan.days[0];

  async function submit() {
    if (running || !plan) return;
    setRunning(true);
    setError(null);
    setThinking([]);
    setAiMessage(null);

    const eventStatuses = targetDay.events.map((ev) => ({
      eventId: ev.id,
      status: (statuses[ev.id] || "skip") as Status,
    }));

    const checkin: CheckinRecord = {
      date: targetDay.date,
      eventStatuses,
      userNote: note.trim(),
      aiResponse: "",
    };

    try {
      const res = await fetch("/api/adjust-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPlan: plan, checkin, currentDate: today, locale }),
      });
      if (!res.ok || !res.body) throw new Error(`${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let nextPlan: WeekPlan | null = null;
      let finalMessage = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "thinking") setThinking((p) => [...p, evt.text]);
            else if (evt.type === "message") finalMessage = evt.text;
            else if (evt.type === "plan") nextPlan = evt.plan as WeekPlan;
          } catch {
            // ignore
          }
        }
      }

      if (nextPlan) {
        const diffIds = computeDiffIds(plan, nextPlan, today);
        savePlan(nextPlan);
        checkin.aiResponse = finalMessage || t.aiResponseFallback;
        saveCheckin(checkin);
        setAiMessage(checkin.aiResponse);

        sessionStorage.setItem("lifeos:last-diff", JSON.stringify(diffIds));
        setTimeout(() => router.push("/plan"), 1400);
      } else {
        throw new Error("no plan returned");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "fail";
      setError(msg);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="flex items-center justify-between">
        <Link
          href="/plan"
          className="inline-flex items-center gap-1 text-sm text-ink/50 transition-colors hover:text-moss"
        >
          <ChevronLeft className="h-4 w-4" />
          {t.backToPlan}
        </Link>
        <LocaleSwitch />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mt-8"
      >
        <div className="text-xs uppercase tracking-[0.2em] text-amber">
          {t.checkinKicker(weekdayOf(targetDay.date, locale), formatHumanDate(targetDay.date, locale))}
        </div>
        <h1 className="mt-2 font-serif text-3xl text-ink">{t.checkinTitle}</h1>
        <p className="mt-3 font-serif text-[15px] leading-loose text-ink/60">
          {t.checkinSub}
        </p>
      </motion.div>

      <div className="mt-10 space-y-3">
        {targetDay.events.map((ev) => {
          const cur = statuses[ev.id];
          return (
            <div
              key={ev.id}
              className="flex items-center gap-4 rounded-card border border-line bg-white/80 px-5 py-4 shadow-card"
            >
              <span className="text-xl">{ev.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] text-ink">{ev.title}</div>
                <div className="text-[11px] text-ink/50">
                  {ev.startTime}–{ev.endTime}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusBtn
                  active={cur === "done"}
                  onClick={() => setStatuses((s) => ({ ...s, [ev.id]: "done" }))}
                  tone="green"
                  icon={<Check className="h-4 w-4" />}
                  label={t.statusDone}
                />
                <StatusBtn
                  active={cur === "partial"}
                  onClick={() => setStatuses((s) => ({ ...s, [ev.id]: "partial" }))}
                  tone="amber"
                  icon={<Minus className="h-4 w-4" />}
                  label={t.statusPartial}
                />
                <StatusBtn
                  active={cur === "skip"}
                  onClick={() => setStatuses((s) => ({ ...s, [ev.id]: "skip" }))}
                  tone="gray"
                  icon={<X className="h-4 w-4" />}
                  label={t.statusSkip}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8">
        <div className="mb-2 text-sm text-ink/60">{t.checkinNoteLabel}</div>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          placeholder={t.checkinNotePlaceholder}
          disabled={running}
        />
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button onClick={submit} disabled={running}>
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.checkinSubmitting}
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              {t.checkinSubmit}
            </>
          )}
        </Button>
      </div>

      {(thinking.length > 0 || aiMessage || error) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-8 rounded-card border border-line bg-white/60 px-6 py-5"
        >
          <ThinkingStream lines={thinking} done={!running} />
          {aiMessage && (
            <div className="mt-4 border-t border-line pt-4 font-serif text-[15px] leading-loose text-ink/80">
              {aiMessage}
            </div>
          )}
          {error && (
            <div className="mt-4 border-t border-line pt-4 text-sm text-ink/70">
              {t.errorPrefix}
              {error}
            </div>
          )}
        </motion.div>
      )}
    </main>
  );
}

function StatusBtn({
  active,
  onClick,
  tone,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  tone: "green" | "amber" | "gray";
  icon: React.ReactNode;
  label: string;
}) {
  const map = {
    green: active ? "bg-moss text-cream border-moss" : "border-line text-moss/70 hover:bg-moss-50",
    amber: active ? "bg-amber text-ink border-amber" : "border-line text-ink/60 hover:bg-amber-soft/40",
    gray: active ? "bg-ink/80 text-cream border-ink/80" : "border-line text-ink/50 hover:bg-cream-2",
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full border transition-all",
        map[tone],
      )}
    >
      {icon}
    </button>
  );
}

function computeDiffIds(prev: WeekPlan, next: WeekPlan, todayISO: string): string[] {
  const prevMap = new Map<string, { title: string; start: string; end: string }>();
  for (const d of prev.days) {
    if (d.date <= todayISO) continue;
    for (const e of d.events) {
      prevMap.set(e.id, { title: e.title, start: e.startTime, end: e.endTime });
    }
  }
  const out: string[] = [];
  for (const d of next.days) {
    if (d.date <= todayISO) continue;
    for (const e of d.events) {
      const prev = prevMap.get(e.id);
      if (!prev) {
        out.push(e.id);
        continue;
      }
      if (prev.title !== e.title || prev.start !== e.startTime || prev.end !== e.endTime) {
        out.push(e.id);
      }
    }
  }
  return out;
}
