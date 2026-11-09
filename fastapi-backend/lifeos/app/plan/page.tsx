"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WeekPlanView } from "@/components/WeekPlanView";
import { loadPlan } from "@/lib/storage";
import type { WeekPlan } from "@/lib/types";
import { useLocale } from "@/lib/i18n";

export default function PlanPage() {
  const router = useRouter();
  const { t } = useLocale();
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [highlight, setHighlight] = useState<Set<string> | undefined>();

  useEffect(() => {
    const p = loadPlan();
    if (!p) {
      router.replace("/");
      return;
    }
    setPlan(p);

    try {
      const raw = sessionStorage.getItem("lifeos:last-diff");
      if (raw) {
        const ids = JSON.parse(raw) as string[];
        setHighlight(new Set(ids));
        sessionStorage.removeItem("lifeos:last-diff");
        setTimeout(() => setHighlight(undefined), 6000);
      }
    } catch {
      // ignore
    }
  }, [router]);

  if (!plan) {
    return (
      <main className="flex min-h-screen items-center justify-center text-ink/40">
        {t.openingPlan}
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <WeekPlanView plan={plan} highlight={highlight} />
    </main>
  );
}
