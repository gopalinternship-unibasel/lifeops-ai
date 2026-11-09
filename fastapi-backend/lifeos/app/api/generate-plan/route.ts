import { NextRequest } from "next/server";
import { callLLMStream, extractJSON } from "@/lib/llm";
import { generatePlanSystemPrompt } from "@/lib/prompts";
import { buildMockPlan } from "@/lib/mock-plan";
import type { WeekPlan } from "@/lib/types";
import { todayISO } from "@/lib/date-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  userInput: string;
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
  const userInput = (body.userInput || "").trim();
  if (!userInput) return new Response("empty input", { status: 400 });
  const currentDate = body.currentDate || todayISO();
  const locale = body.locale === "en" ? "en" : "zh";

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const done = () => controller.close();

      const tDeepThink =
        locale === "en"
          ? "Thinking deeply about your week…"
          : "模型正在深度思考你的下周…";
      const tNoJson =
        locale === "en"
          ? "Model didn't return a structured result — falling back to a sample plan."
          : "模型这次没给出结构化结果，先用一份示例计划保底。";
      const tApiErr = (msg: string) =>
        locale === "en" ? `LLM call failed: ${msg}` : `调用 LLM 失败：${msg}`;

      try {
        const sys = generatePlanSystemPrompt(currentDate, locale);

        // 状态机：边吐 token 边把"· "开头的思考行抽出来
        let buffer = "";
        let inThinking = true;
        let thinkBuf = "";
        let fullText = "";

        const flushThinkLine = (line: string) => {
          const t = line.replace(/^[·•\-\*\s]+/, "").trim();
          if (t) send({ type: "thinking", text: t });
        };

        const iter = callLLMStream({
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userInput },
          ],
          temperature: 0.3,
          maxTokens: 16384,
        });

        let reasoningAnnounced = false;
        for await (const delta of iter) {
          if (delta.kind === "reasoning") {
            if (!reasoningAnnounced) {
              reasoningAnnounced = true;
              send({ type: "thinking", text: tDeepThink });
            }
            continue;
          }
          const chunk = delta.text;
          fullText += chunk;
          if (inThinking) {
            thinkBuf += chunk;
            // 一旦看到 ```json 即结束思考阶段
            if (/```json/i.test(thinkBuf)) {
              const cutIdx = thinkBuf.search(/```json/i);
              const beforeFence = thinkBuf.slice(0, cutIdx);
              // 处理剩余思考行
              const lines = beforeFence.split("\n");
              for (const ln of lines) {
                const t = ln.trim();
                if (!t) continue;
                if (t.startsWith("·") || t.startsWith("•") || t.startsWith("-") || t.startsWith("*")) {
                  flushThinkLine(t);
                }
              }
              inThinking = false;
              buffer = thinkBuf.slice(cutIdx);
              thinkBuf = "";
            } else {
              // 按行 flush
              let nl: number;
              while ((nl = thinkBuf.indexOf("\n")) >= 0) {
                const line = thinkBuf.slice(0, nl).trim();
                thinkBuf = thinkBuf.slice(nl + 1);
                if (!line) continue;
                if (line.startsWith("·") || line.startsWith("•") || line.startsWith("-") || line.startsWith("*")) {
                  flushThinkLine(line);
                }
              }
            }
          } else {
            buffer += chunk;
          }
        }

        // 把仍残留在 buffer / thinkBuf 的部分都视作完整文本，从中提 JSON
        const text = (buffer || "") + (thinkBuf || "") + (buffer || thinkBuf ? "" : fullText);
        const parsed = extractJSON<WeekPlan>(text || fullText);

        if (parsed && Array.isArray(parsed.days) && parsed.days.length > 0) {
          send({ type: "plan", plan: parsed });
        } else {
          send({ type: "thinking", text: tNoJson });
          send({ type: "plan", plan: buildMockPlan(currentDate, locale) });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : (locale === "en" ? "unknown error" : "未知错误");
        try {
          send({ type: "thinking", text: tApiErr(msg) });
          send({ type: "plan", plan: buildMockPlan(currentDate, locale) });
        } catch {
          // ignore
        }
      } finally {
        done();
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
