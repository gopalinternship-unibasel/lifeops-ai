"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Sparkles, Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ThinkingStream } from "@/components/ThinkingStream";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { savePlan, pushHistory } from "@/lib/storage";
import { todayISO } from "@/lib/date-utils";
import type { WeekPlan } from "@/lib/types";
import { buildMockPlan } from "@/lib/mock-plan";
import { useLocale } from "@/lib/i18n";

export default function HomePage() {
  const router = useRouter();
  const { locale, t } = useLocale();
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function onGenerate() {
    if (!input.trim() || loading) return;
    setLoading(true);
    setError(null);
    setThinking([]);
    pushHistory(input);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userInput: input, currentDate: todayISO(), locale }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`${res.status}`);
      }

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
            if (evt.type === "thinking") {
              setThinking((prev) => [...prev, evt.text]);
            } else if (evt.type === "plan") {
              plan = evt.plan as WeekPlan;
            } else if (evt.type === "error") {
              throw new Error(evt.message || "fail");
            }
          } catch {
            // ignore non-JSON keepalive
          }
        }
      }

      if (!plan) {
        plan = buildMockPlan(todayISO(), locale);
      }
      savePlan(plan);
      router.push("/plan");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "fail";
      setError(msg);
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function onUseMock() {
    const plan = buildMockPlan(todayISO(), locale);
    savePlan(plan);
    router.push("/plan");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="absolute right-6 top-6">
        <LocaleSwitch />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-2xl"
      >
        <div className="mb-3 text-center text-[13px] tracking-[0.18em] text-moss/70">
          {t.homeKicker}
        </div>
        <h1 className="text-center font-serif text-4xl leading-snug text-ink md:text-5xl">
          {t.homeHeadline}
        </h1>

        <div className="mt-10">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.homePlaceholder}
            rows={5}
            disabled={loading}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onGenerate();
            }}
          />
          <div className="mt-5 flex items-center justify-between gap-3">
            <div className="text-xs text-ink/40">{t.homeKeyHint}</div>
            <Button onClick={onGenerate} size="lg" disabled={loading || !input.trim()}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t.homeBtnGenerating}
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  {t.homeBtnGenerate}
                </>
              )}
            </Button>
          </div>
        </div>

        {(thinking.length > 0 || error) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-10 rounded-card border border-line bg-white/60 px-6 py-5"
          >
            <ThinkingStream lines={thinking} done={!loading} />
            {error && (
              <div className="mt-4 border-t border-line pt-4 text-sm text-ink/70">
                <div>
                  {t.homeErrorPrefix}
                  {error}
                </div>
                <button
                  onClick={onUseMock}
                  className="mt-2 text-amber underline-offset-4 hover:underline"
                >
                  {t.homeUseMock}
                </button>
              </div>
            )}
          </motion.div>
        )}
      </motion.div>
    </main>
  );
}
