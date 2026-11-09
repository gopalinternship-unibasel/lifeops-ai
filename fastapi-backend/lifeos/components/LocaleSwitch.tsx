"use client";

import { Languages } from "lucide-react";
import { useLocale } from "@/lib/i18n";

export function LocaleSwitch({ className }: { className?: string }) {
  const { locale, toggle } = useLocale();
  return (
    <button
      type="button"
      onClick={toggle}
      title={locale === "zh" ? "Switch to English" : "切换为中文"}
      className={
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-white/70 px-3 py-1.5 text-xs text-moss/80 transition-colors hover:bg-moss-50 " +
        (className ?? "")
      }
    >
      <Languages className="h-3.5 w-3.5" />
      <span className="font-medium">
        {locale === "zh" ? "EN" : "中"}
      </span>
    </button>
  );
}
