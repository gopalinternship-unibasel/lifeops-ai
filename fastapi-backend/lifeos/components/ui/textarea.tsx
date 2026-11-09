"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full resize-none rounded-card border border-line bg-white/70 px-6 py-5 text-[15px] leading-relaxed text-ink",
        "placeholder:text-ink/40 outline-none transition-all duration-200",
        "focus:border-moss/50 focus:bg-white focus:shadow-card",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
