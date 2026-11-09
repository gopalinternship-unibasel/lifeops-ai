"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThinkingStream } from "@/components/ThinkingStream";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { savePlan, pushHistory } from "@/lib/storage";
import { todayISO } from "@/lib/date-utils";
import { getDemoUserInput, buildMockPlan } from "@/lib/mock-plan";
import type { WeekPlan } from "@/lib/types";
import { useLocale } from "@/lib/i18n";

export default function DemoPage() {
  const router = useRouter();
  const { locale, t } = useLocale();
  const [thinking, setThinking] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const demoInput = getDemoUserInput(locale);

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    setThinking([]);
    pushHistory(demoInput);

    try {
      const res = await fetch("/api/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userInput: demoInput, currentDate: todayISO(), locale }),
      });
      if (!res.ok || !res.body) throw new Error(`${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let plan: WeekPlan | null = null;

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
            else if (evt.type === "plan") plan = evt.plan as WeekPlan;
          } catch {
            // ignore
          }
        }
      }

      if (!plan) plan = buildMockPlan(todayISO(), locale);
      savePlan(plan);
      router.push("/plan");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "fail";
      setError(msg);
      const plan = buildMockPlan(todayISO(), locale);
      savePlan(plan);
      setTimeout(() => router.push("/plan"), 800);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="absolute right-6 top-6">
        <LocaleSwitch />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="w-full max-w-2xl"
      >
        <div className="mb-3 text-center text-[13px] tracking-[0.18em] text-amber">
          {t.demoKicker}
        </div>
        <h1 className="text-center font-serif text-3xl leading-snug text-ink md:text-4xl">
          {t.demoTitle}
        </h1>

        <div className="mt-10 rounded-card border border-line bg-white/70 px-6 py-5 text-[15px] leading-relaxed text-ink/80">
          “{demoInput}”
        </div>

        <div className="mt-6 rounded-card border border-line bg-white/60 px-6 py-5 min-h-[140px]">
          <ThinkingStream lines={thinking} done={!running} />
          {!running && thinking.length === 0 && (
            <div className="text-sm text-ink/50">{t.demoStarting}</div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <Link href="/" className="text-sm text-ink/50 hover:text-moss">
            {t.demoSelfInput}
          </Link>
          <Button onClick={run} disabled={running}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t.runningTag}
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                {t.demoReplay}
              </>
            )}
          </Button>
        </div>

        {error && (
          <div className="mt-4 text-center text-xs text-ink/50">
            {t.demoApiErrTpl(error)}
          </div>
        )}
      </motion.div>
    </main>
  );
}
