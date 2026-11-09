"use client";

import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { useLocale } from "@/lib/i18n";

interface Props {
  lines: string[];
  className?: string;
  done?: boolean;
}

export function ThinkingStream({ lines, className, done }: Props) {
  const { t } = useLocale();
  return (
    <div className={cn("space-y-2.5 text-[15px] leading-relaxed text-moss", className)}>
      <AnimatePresence initial={false}>
        {lines.map((l, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="flex items-start gap-2 font-serif"
          >
            <span className="mt-[7px] inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber" />
            <span>{l}</span>
          </motion.div>
        ))}
      </AnimatePresence>
      {!done && lines.length > 0 && (
        <div className="flex items-center gap-1.5 pl-4 pt-1 text-moss/50">
          <span className="h-1.5 w-1.5 animate-soft-pulse rounded-full bg-moss/60" />
          <span className="text-xs tracking-widest">{t.streaming}</span>
        </div>
      )}
    </div>
  );
}
