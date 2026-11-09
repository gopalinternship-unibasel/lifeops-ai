import { NextRequest } from "next/server";
import { callLLMStream, extractJSON } from "@/lib/llm";
import { adjustPlanSystemPrompt } from "@/lib/prompts";
import type { CheckinRecord, WeekPlan } from "@/lib/types";
import { todayISO } from "@/lib/date-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  currentPlan: WeekPlan;
  checkin: CheckinRecord;
  currentDate?: string;
  locale?: "zh" | "en";
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("invalid body", { status: 400 });
  }
  const { currentPlan, checkin } = body;
  const currentDate = body.currentDate || todayISO();
  const locale = body.locale === "en" ? "en" : "zh";
  if (!currentPlan || !checkin) {
    return new Response("missing fields", { status: 400 });
  }

  const encoder = new TextEncoder();

  const userMessage = buildUserMessage(currentPlan, checkin, locale);

  const tDeep = locale === "en" ? "Thinking deeply about adjustments…" : "模型正在深度思考要怎么调整…";
  const tLooking = locale === "en" ? "Looking at how today went…" : "正在看你今天的完成情况…";
  const tComparing = locale === "en" ? "Comparing the rest of the week…" : "在比对剩下几天的安排…";
  const tParseFail = locale === "en"
    ? "The adjustment result was off — keeping your original plan."
    : "模型这次调整结果有点问题，先保留你原来的计划。";
  const tFail = (msg: string) =>
    locale === "en" ? `Adjust failed: ${msg}, keeping original plan.` : `调整失败：${msg}，保留原计划。`;
  const tDefaultMsg = locale === "en"
    ? "Adjusted the rest of your week."
    : "已为你调整后续几天。";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const close = () => controller.close();

      try {
        send({ type: "thinking", text: tLooking });
        send({ type: "thinking", text: tComparing });

        const sys = adjustPlanSystemPrompt(currentDate, locale);

        let full = "";
        const iter = callLLMStream({
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userMessage },
          ],
          temperature: 0.7,
          maxTokens: 16384,
        });
        let reasoningAnnounced = false;
        for await (const delta of iter) {
          if (delta.kind === "reasoning") {
            if (!reasoningAnnounced) {
              reasoningAnnounced = true;
              send({ type: "thinking", text: tDeep });
            }
            continue;
          }
          full += delta.text;
        }

        // 提取 message（JSON 之前的自然语言段）+ JSON
        const jsonStart = full.search(/```json/i);
        let message = "";
        if (jsonStart > 0) {
          message = full.slice(0, jsonStart).trim();
        } else {
          const firstNL = full.indexOf("\n\n");
          message = firstNL > 0 ? full.slice(0, firstNL).trim() : tDefaultMsg;
        }
        if (message) send({ type: "message", text: message });

        const parsed = extractJSON<WeekPlan>(full);
        if (parsed && Array.isArray(parsed.days) && parsed.days.length === currentPlan.days.length) {
          // 强制保留今天及之前的天数原样（避免模型乱改）
          const merged = mergePreserveTodayAndBefore(currentPlan, parsed, currentDate);
          send({ type: "plan", plan: merged });
        } else {
          send({ type: "thinking", text: tParseFail });
          send({ type: "plan", plan: currentPlan });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : (locale === "en" ? "unknown error" : "未知错误");
        send({ type: "thinking", text: tFail(msg) });
        send({ type: "plan", plan: body.currentPlan });
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function buildUserMessage(plan: WeekPlan, c: CheckinRecord, locale: "zh" | "en"): string {
  const day = plan.days.find((d) => d.date === c.date);
  if (locale === "en") {
    const eventLines = (day?.events || [])
      .map((ev) => {
        const s = c.eventStatuses.find((x) => x.eventId === ev.id)?.status || "skip";
        const label = s === "done" ? "✅ done" : s === "partial" ? "⚠️ partial" : "❌ skipped";
        return `- ${ev.emoji} ${ev.title} (${ev.startTime}-${ev.endTime}): ${label}`;
      })
      .join("\n");
    return `Here is the current week plan (JSON):
\`\`\`json
${JSON.stringify(plan)}
\`\`\`

Today is ${c.date} (${day?.weekday || ""}). Status:
${eventLines}

User note: ${c.userNote || "(none)"}

Adjust the days AFTER ${c.date} per the system rules, and write a short warm message to me.`;
  }

  const eventLines = (day?.events || [])
    .map((ev) => {
      const s = c.eventStatuses.find((x) => x.eventId === ev.id)?.status || "skip";
      const label = s === "done" ? "✅ 完成" : s === "partial" ? "⚠️ 部分完成" : "❌ 没做";
      return `- ${ev.emoji} ${ev.title} (${ev.startTime}-${ev.endTime}): ${label}`;
    })
    .join("\n");

  return `这是当前的周计划（JSON）：
\`\`\`json
${JSON.stringify(plan)}
\`\`\`

今天是 ${c.date}（${day?.weekday || ""}），完成情况：
${eventLines}

用户补充：${c.userNote || "（无）"}

请按系统指令调整 ${c.date} 之后的几天，并写一段贴心的话给我。`;
}

function mergePreserveTodayAndBefore(
  prev: WeekPlan,
  next: WeekPlan,
  today: string,
): WeekPlan {
  const merged: WeekPlan = {
    theme: next.theme || prev.theme,
    rationale: next.rationale || prev.rationale,
    createdAt: prev.createdAt,
    days: prev.days.map((p) => {
      if (p.date <= today) return p;
      const n = next.days.find((d) => d.date === p.date);
      return n || p;
    }),
  };
  return merged;
}
