import type { WeekPlan } from "./types";
import { buildSevenDaysFrom, nextMondayFrom, toISODate, type Locale } from "./date-utils";

export const DEMO_USER_INPUT_ZH =
  "下周我要准备产品面试，周一周三晚有健身课，每天想背30个单词，周六想约老朋友吃饭，周日希望睡到自然醒读读书。";

export const DEMO_USER_INPUT_EN =
  "Next week I'm prepping for a product interview, gym class on Monday and Wednesday evenings, want to learn 30 vocab words a day, dinner with old friends on Saturday, and Sunday I want to sleep in and read.";

export const DEMO_USER_INPUT = DEMO_USER_INPUT_ZH;

export function getDemoUserInput(locale: Locale): string {
  return locale === "en" ? DEMO_USER_INPUT_EN : DEMO_USER_INPUT_ZH;
}

export function buildMockPlan(currentDateISO: string, locale: Locale = "zh"): WeekPlan {
  if (locale === "en") return buildMockPlanEN(currentDateISO);
  const monday = nextMondayFrom(currentDateISO);
  const days = buildSevenDaysFrom(toISODate(monday), "zh");

  const make = (i: number) => {
    const base = days[i];
    switch (i) {
      case 0:
        return {
          ...base,
          focus: "把面试自我介绍打磨到 90 秒以内。",
          events: [
            { id: "m0-1", emoji: "📚", title: "背 30 个单词", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m0-2", emoji: "🎯", title: "梳理面试自我介绍", type: "task" as const, startTime: "10:00", endTime: "11:30" },
            { id: "m0-3", emoji: "🥗", title: "简餐 + 散步", type: "rest" as const, startTime: "12:30", endTime: "13:30" },
            { id: "m0-4", emoji: "💪", title: "健身课（核心）", type: "appointment" as const, startTime: "19:30", endTime: "20:30" },
          ],
        };
      case 1:
        return {
          ...base,
          focus: "梳理 STAR 模板，写两个项目案例。",
          events: [
            { id: "m1-1", emoji: "📚", title: "背 30 个单词", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m1-2", emoji: "🧠", title: "STAR 模板 + 项目复盘", type: "task" as const, startTime: "09:30", endTime: "12:00" },
            { id: "m1-3", emoji: "☕", title: "咖啡 + 短走", type: "rest" as const, startTime: "15:00", endTime: "15:30" },
            { id: "m1-4", emoji: "📝", title: "写两个项目案例", type: "task" as const, startTime: "20:00", endTime: "21:30" },
          ],
        };
      case 2:
        return {
          ...base,
          focus: "练 mock 面试，重点在表达节奏。",
          events: [
            { id: "m2-1", emoji: "📚", title: "背 30 个单词", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m2-2", emoji: "🎤", title: "Mock 面试（自我录音）", type: "task" as const, startTime: "10:00", endTime: "11:00" },
            { id: "m2-3", emoji: "🍜", title: "午餐", type: "rest" as const, startTime: "12:00", endTime: "13:00" },
            { id: "m2-4", emoji: "💪", title: "健身课（下肢）", type: "appointment" as const, startTime: "19:30", endTime: "20:30" },
          ],
        };
      case 3:
        return {
          ...base,
          focus: "把不擅长的题刷一遍，补漏。",
          events: [
            { id: "m3-1", emoji: "📚", title: "背 30 个单词", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m3-2", emoji: "📐", title: "刷面试题（产品 sense）", type: "task" as const, startTime: "10:00", endTime: "12:00" },
            { id: "m3-3", emoji: "🚶", title: "户外散步 30 分钟", type: "rest" as const, startTime: "16:00", endTime: "16:30" },
            { id: "m3-4", emoji: "📝", title: "整理疑难点笔记", type: "task" as const, startTime: "20:00", endTime: "21:00" },
          ],
        };
      case 4:
        return {
          ...base,
          focus: "节奏放慢，整理整体表达逻辑。",
          events: [
            { id: "m4-1", emoji: "📚", title: "背 30 个单词", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m4-2", emoji: "🗂️", title: "总览所有面试笔记", type: "task" as const, startTime: "10:00", endTime: "11:30" },
            { id: "m4-3", emoji: "🍣", title: "午餐 + 小憩", type: "rest" as const, startTime: "12:00", endTime: "14:00" },
            { id: "m4-4", emoji: "🎤", title: "再做一次完整 mock", type: "task" as const, startTime: "20:00", endTime: "21:00" },
          ],
        };
      case 5:
        return {
          ...base,
          focus: "和老朋友吃饭，让脑子换个频道。",
          events: [
            { id: "m5-1", emoji: "📚", title: "背 30 个单词", type: "habit" as const, startTime: "10:00", endTime: "10:20" },
            { id: "m5-2", emoji: "🥘", title: "和老朋友吃饭", type: "appointment" as const, startTime: "12:00", endTime: "14:30" },
            { id: "m5-3", emoji: "🎬", title: "看一部轻松电影", type: "rest" as const, startTime: "20:00", endTime: "22:00" },
          ],
        };
      default:
        return {
          ...base,
          focus: "睡到自然醒，给自己一段读书时间。",
          events: [
            { id: "m6-1", emoji: "🛏️", title: "自然醒", type: "rest" as const, startTime: "09:00", endTime: "09:30" },
            { id: "m6-2", emoji: "📖", title: "阅读：《被讨厌的勇气》", type: "rest" as const, startTime: "10:00", endTime: "11:30" },
            { id: "m6-3", emoji: "📚", title: "背 30 个单词", type: "habit" as const, startTime: "15:00", endTime: "15:20" },
            { id: "m6-4", emoji: "📝", title: "为下周列三件最重要的事", type: "task" as const, startTime: "20:30", endTime: "21:00" },
          ],
        };
    }
  };

  return {
    theme: "专注面试冲刺，但留出和朋友、和自己喘息的时间",
    rationale:
      "这一周的主轴是面试，所以把上午的高能时段都留给最难的事；周一三晚上你已经约好了健身课，我没动它，作为一周的支点。每天清晨都是 30 个单词，习惯只有固定时段才能稳。周六留给老朋友，周日完全松开，这样冲刺才不至于把人压垮。",
    days: [make(0), make(1), make(2), make(3), make(4), make(5), make(6)],
    createdAt: new Date().toISOString(),
  };
}

function buildMockPlanEN(currentDateISO: string): WeekPlan {
  const monday = nextMondayFrom(currentDateISO);
  const days = buildSevenDaysFrom(toISODate(monday), "en");

  const make = (i: number) => {
    const base = days[i];
    switch (i) {
      case 0:
        return {
          ...base,
          focus: "Tighten the self-intro to under 90 seconds.",
          events: [
            { id: "m0-1", emoji: "📚", title: "30 vocab words", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m0-2", emoji: "🎯", title: "Polish interview self-intro", type: "task" as const, startTime: "10:00", endTime: "11:30" },
            { id: "m0-3", emoji: "🥗", title: "Light lunch + walk", type: "rest" as const, startTime: "12:30", endTime: "13:30" },
            { id: "m0-4", emoji: "💪", title: "Gym class (core)", type: "appointment" as const, startTime: "19:30", endTime: "20:30" },
          ],
        };
      case 1:
        return {
          ...base,
          focus: "Two project case write-ups using STAR.",
          events: [
            { id: "m1-1", emoji: "📚", title: "30 vocab words", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m1-2", emoji: "🧠", title: "STAR template + project recap", type: "task" as const, startTime: "09:30", endTime: "12:00" },
            { id: "m1-3", emoji: "☕", title: "Coffee + short walk", type: "rest" as const, startTime: "15:00", endTime: "15:30" },
            { id: "m1-4", emoji: "📝", title: "Write two project cases", type: "task" as const, startTime: "20:00", endTime: "21:30" },
          ],
        };
      case 2:
        return {
          ...base,
          focus: "Mock interview, focus on pacing.",
          events: [
            { id: "m2-1", emoji: "📚", title: "30 vocab words", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m2-2", emoji: "🎤", title: "Mock interview (record yourself)", type: "task" as const, startTime: "10:00", endTime: "11:00" },
            { id: "m2-3", emoji: "🍜", title: "Lunch", type: "rest" as const, startTime: "12:00", endTime: "13:00" },
            { id: "m2-4", emoji: "💪", title: "Gym class (lower body)", type: "appointment" as const, startTime: "19:30", endTime: "20:30" },
          ],
        };
      case 3:
        return {
          ...base,
          focus: "Drill the weak spots, plug the gaps.",
          events: [
            { id: "m3-1", emoji: "📚", title: "30 vocab words", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m3-2", emoji: "📐", title: "Practice product-sense problems", type: "task" as const, startTime: "10:00", endTime: "12:00" },
            { id: "m3-3", emoji: "🚶", title: "Outdoor walk 30 min", type: "rest" as const, startTime: "16:00", endTime: "16:30" },
            { id: "m3-4", emoji: "📝", title: "Note hard spots", type: "task" as const, startTime: "20:00", endTime: "21:00" },
          ],
        };
      case 4:
        return {
          ...base,
          focus: "Slow down, tie the whole story together.",
          events: [
            { id: "m4-1", emoji: "📚", title: "30 vocab words", type: "habit" as const, startTime: "08:00", endTime: "08:20" },
            { id: "m4-2", emoji: "🗂️", title: "Review all interview notes", type: "task" as const, startTime: "10:00", endTime: "11:30" },
            { id: "m4-3", emoji: "🍣", title: "Lunch + nap", type: "rest" as const, startTime: "12:00", endTime: "14:00" },
            { id: "m4-4", emoji: "🎤", title: "One full mock again", type: "task" as const, startTime: "20:00", endTime: "21:00" },
          ],
        };
      case 5:
        return {
          ...base,
          focus: "Dinner with friends, switch gears.",
          events: [
            { id: "m5-1", emoji: "📚", title: "30 vocab words", type: "habit" as const, startTime: "10:00", endTime: "10:20" },
            { id: "m5-2", emoji: "🥘", title: "Dinner with old friends", type: "appointment" as const, startTime: "12:00", endTime: "14:30" },
            { id: "m5-3", emoji: "🎬", title: "Easy movie night", type: "rest" as const, startTime: "20:00", endTime: "22:00" },
          ],
        };
      default:
        return {
          ...base,
          focus: "Sleep in, give yourself a reading hour.",
          events: [
            { id: "m6-1", emoji: "🛏️", title: "Sleep in", type: "rest" as const, startTime: "09:00", endTime: "09:30" },
            { id: "m6-2", emoji: "📖", title: "Read: The Courage to Be Disliked", type: "rest" as const, startTime: "10:00", endTime: "11:30" },
            { id: "m6-3", emoji: "📚", title: "30 vocab words", type: "habit" as const, startTime: "15:00", endTime: "15:20" },
            { id: "m6-4", emoji: "📝", title: "List the 3 most important things for next week", type: "task" as const, startTime: "20:30", endTime: "21:00" },
          ],
        };
    }
  };

  return {
    theme: "Interview sprint with room to breathe",
    rationale:
      "The spine of this week is the interview, so high-energy mornings go to the hardest work. Your gym class on Mon and Wed is the anchor — I left it alone. Vocabulary at the same morning slot every day, because habits only stick at fixed times. Saturday is yours to be with old friends; Sunday is fully off, so the sprint doesn't crush you.",
    days: [make(0), make(1), make(2), make(3), make(4), make(5), make(6)],
    createdAt: new Date().toISOString(),
  };
}
