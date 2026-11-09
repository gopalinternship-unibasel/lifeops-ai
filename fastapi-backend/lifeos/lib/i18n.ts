"use client";

import { useEffect, useState, useCallback } from "react";

export type Locale = "zh" | "en";

export const LOCALE_KEY = "lifeos:locale";

export const DICT = {
  zh: {
    appTitle: "LifeOS · 一句话生成你的一周",
    appDesc: "告诉我你下周想要的生活，我帮你安排好一切。",

    // home
    homeKicker: "告诉我你下周想要的生活，我帮你安排好一切",
    homeHeadline: "一句话，生成你的一周",
    homePlaceholder:
      "下周我要准备产品面试，周一周三晚有健身课，每天想背30个单词，周六想约朋友吃饭...",
    homeKeyHint: "⌘/Ctrl + Enter 直接生成",
    homeBtnGenerate: "生成我的一周",
    homeBtnGenerating: "正在为你安排",
    homeErrorPrefix: "嗯，刚才出了点小问题：",
    homeUseMock: "用一份示例计划继续 →",

    // thinking stream
    streaming: "生成中",

    // plan view
    weekTheme: "本周主题",
    backHome: "重新开始",
    todayCheckin: "今天怎么样？",
    todayBadge: "今天",
    expand: "收起",
    moreCount: (n: number) => `还有 ${n} 件`,
    openingPlan: "正在打开你的一周…",

    // event types
    eventType: {
      task: "任务",
      habit: "习惯",
      appointment: "约会",
      rest: "休息",
    },

    // weekdays (Sun..Sat)
    weekdays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    formatDate: (m: number, d: number) => `${m}月${d}日`,

    // checkin
    checkinKicker: (weekday: string, date: string) => `${weekday} · ${date}`,
    checkinTitle: "今天怎么样？",
    checkinSub:
      "告诉我每件事的完成情况，我帮你把后面几天调整得更舒服。",
    checkinNoteLabel: "还有什么想说的？",
    checkinNotePlaceholder:
      "比如：今天膝盖有点疼，明天想换成室内拉伸…",
    checkinSubmit: "提交并让 AI 调整",
    checkinSubmitting: "正在调整",
    statusDone: "完成",
    statusPartial: "部分",
    statusSkip: "没做",
    backToPlan: "返回周计划",
    aiResponseFallback: "已为你调整后续几天。",
    errorPrefix: "出错了：",

    // demo
    demoKicker: "DEMO MODE · 一键演示",
    demoTitle: "示例：准备产品面试的一周",
    demoSelfInput: "← 自己输入",
    demoReplay: "重新演示一次",
    demoStarting: "准备开始演示…",
    demoApiErrTpl: (msg: string) =>
      `（API 出错：${msg}，已自动用兜底计划继续）`,
    runningTag: "生成中",

    // language toggle
    langLabel: "中文",

    // server / progress thinking strings shown to user
    deepThinkingGenerate: "模型正在深度思考你的下周…",
    deepThinkingAdjust: "模型正在深度思考要怎么调整…",
    fallbackThinkingNoJson:
      "模型这次没给出结构化结果，先用一份示例计划保底。",
    fallbackThinkingApiError: (msg: string) =>
      `调用 LLM 失败：${msg}`,
    adjustLookingAtToday: "正在看你今天的完成情况…",
    adjustComparing: "在比对剩下几天的安排…",
    adjustParseFail:
      "模型这次调整结果有点问题，先保留你原来的计划。",
    adjustFailedKeepPrev: (msg: string) =>
      `调整失败：${msg}，保留原计划。`,
  },
  en: {
    appTitle: "LifeOS · A week from one sentence",
    appDesc: "Tell me what you want next week to feel like — I'll plan it all.",

    homeKicker: "Tell me what you want next week to feel like, I'll plan it all",
    homeHeadline: "One sentence, your whole week",
    homePlaceholder:
      "Next week I'm prepping for a product interview, gym class on Mon and Wed evenings, want to learn 30 new words a day, dinner with old friends on Saturday...",
    homeKeyHint: "⌘/Ctrl + Enter to generate",
    homeBtnGenerate: "Plan my week",
    homeBtnGenerating: "Planning your week",
    homeErrorPrefix: "Hmm, something went wrong: ",
    homeUseMock: "Continue with a sample plan →",

    streaming: "streaming",

    weekTheme: "THIS WEEK",
    backHome: "Start over",
    todayCheckin: "How was today?",
    todayBadge: "Today",
    expand: "Collapse",
    moreCount: (n: number) => `${n} more`,
    openingPlan: "Opening your week…",

    eventType: {
      task: "Task",
      habit: "Habit",
      appointment: "Date",
      rest: "Rest",
    },

    // Sun..Sat
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    formatDate: (m: number, d: number) => {
      const months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
      ];
      return `${months[m - 1]} ${d}`;
    },

    checkinKicker: (weekday: string, date: string) => `${weekday} · ${date}`,
    checkinTitle: "How was today?",
    checkinSub:
      "Tell me how each thing went — I'll tune the rest of the week.",
    checkinNoteLabel: "Anything else on your mind?",
    checkinNotePlaceholder:
      "e.g. My knee is sore today, swap tomorrow's gym for stretching...",
    checkinSubmit: "Submit and let AI adjust",
    checkinSubmitting: "Adjusting",
    statusDone: "Done",
    statusPartial: "Partial",
    statusSkip: "Skip",
    backToPlan: "Back to week plan",
    aiResponseFallback: "Adjusted the rest of your week.",
    errorPrefix: "Error: ",

    demoKicker: "DEMO MODE · One-click",
    demoTitle: "Example: A week prepping for a product interview",
    demoSelfInput: "← Type your own",
    demoReplay: "Run demo again",
    demoStarting: "Starting demo…",
    demoApiErrTpl: (msg: string) =>
      `(API error: ${msg}, falling back to a sample plan)`,
    runningTag: "streaming",

    langLabel: "EN",

    deepThinkingGenerate: "Thinking deeply about your week…",
    deepThinkingAdjust: "Thinking deeply about adjustments…",
    fallbackThinkingNoJson:
      "Model didn't return a structured result — falling back to a sample plan.",
    fallbackThinkingApiError: (msg: string) => `LLM call failed: ${msg}`,
    adjustLookingAtToday: "Looking at how today went…",
    adjustComparing: "Comparing the rest of the week…",
    adjustParseFail:
      "The adjustment result was off — keeping your original plan.",
    adjustFailedKeepPrev: (msg: string) =>
      `Adjust failed: ${msg}, keeping original plan.`,
  },
} as const;

export type Dict = (typeof DICT)["zh"];

export function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "zh";
  const saved = localStorage.getItem(LOCALE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  // browser default
  const lang = navigator.language || "";
  return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function useLocale(): {
  locale: Locale;
  t: Dict;
  setLocale: (l: Locale) => void;
  toggle: () => void;
} {
  const [locale, setLocaleState] = useState<Locale>("zh");

  useEffect(() => {
    setLocaleState(detectInitialLocale());
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOCALE_KEY && (e.newValue === "zh" || e.newValue === "en")) {
        setLocaleState(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    if (typeof window !== "undefined") localStorage.setItem(LOCALE_KEY, l);
  }, []);

  const toggle = useCallback(() => {
    setLocale(locale === "zh" ? "en" : "zh");
  }, [locale, setLocale]);

  return { locale, t: DICT[locale], setLocale, toggle };
}
