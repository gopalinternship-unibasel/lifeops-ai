// 对比两个 NVIDIA NIM 模型在 LifeOS 真实工作负载上的表现。
// 用法：
//   1. 在 .env.local 里设好 NVIDIA_API_KEY
//   2. node scripts/compare-models.mjs
//
// 评估维度：
//   - 首 token 延迟 (TTFB)
//   - 总耗时
//   - 输出 token 数
//   - 是否产出可解析的 ```json``` 计划
//   - 是否守住"· 思考行 + JSON"输出协议
//   - 输出片段（人工肉眼判断质量）

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 极简 .env.local 加载
function loadEnv() {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const API_KEY = process.env.NVIDIA_API_KEY;
if (!API_KEY) {
  console.error("缺少 NVIDIA_API_KEY，请在 .env.local 中设置");
  process.exit(1);
}
const BASE_URL = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";

// 两个候选
const CANDIDATES = [
  {
    id: "mistralai/mistral-medium-3.5-128b",
    extra: { reasoning_effort: "high", top_p: 1.0 },
  },
  {
    id: "minimaxai/minimax-m2.7",
    extra: { top_p: 1.0 },
  },
];

const SYSTEM = `你是 LifeOS，一个温柔克制的生活助理。用户用一段自然语言描述下周想做的事，你要把它编排成一份具体的周计划。

输出协议（必须严格遵守）：
1. 先用自然中文输出 3-5 行简短的"思考过程"。每行不超过 20 个汉字，每行单独一行，前面加 "· " 圆点。
2. 思考结束后，输出一个 JSON 代码块，必须用 \`\`\`json 和 \`\`\` 包裹，可被 JSON.parse 直接解析。
3. JSON 之外（除上面的思考流）不要有任何其他文字。

JSON 结构：
{
  "theme": "本周主题，一句中文",
  "rationale": "为什么这样安排，2-4 句话，有人情味",
  "days": [
    { "date": "YYYY-MM-DD", "weekday": "周一",
      "focus": "今日重点一句话",
      "events": [
        {"id":"u1","emoji":"📚","title":"背单词","type":"habit","startTime":"08:00","endTime":"08:20"}
      ]
    }
  ]
}

7 天必须使用：2026-05-04 (周一) ~ 2026-05-10 (周日)，按顺序。每天 3-5 件事。`;

const USER =
  "下周我要准备产品面试，周一周三晚有健身课，每天想背30个单词，周六想约老朋友吃饭，周日希望睡到自然醒读读书。";

async function run(candidate) {
  console.log(`\n=== 模型: ${candidate.id} ===`);
  const t0 = Date.now();
  let firstByteAt = null;
  let contentText = "";
  let reasoningText = "";

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: candidate.id,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      temperature: 0.75,
      max_tokens: 16384,
      stream: true,
      ...candidate.extra,
    }),
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    console.log(`✗ HTTP ${res.status}: ${txt.slice(0, 300)}`);
    return null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = Date.now() - t0;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const j = JSON.parse(payload);
        const d = j?.choices?.[0]?.delta;
        if (d?.reasoning_content) reasoningText += d.reasoning_content;
        if (d?.content) contentText += d.content;
      } catch {
        // ignore
      }
    }
  }

  const total = Date.now() - t0;

  // 解析
  const fence = contentText.match(/```json\s*([\s\S]*?)```/i);
  let plan = null;
  let parseErr = null;
  if (fence) {
    try {
      plan = JSON.parse(fence[1]);
    } catch (e) {
      parseErr = e.message;
    }
  }

  const dotLines = contentText
    .split("\n")
    .filter((l) => /^[·•\-\*]/.test(l.trim())).length;

  const okJson = !!plan && Array.isArray(plan?.days) && plan.days.length === 7;
  const okFormat = dotLines >= 3 && okJson;

  const result = {
    model: candidate.id,
    ttfbMs: firstByteAt,
    totalMs: total,
    contentChars: contentText.length,
    reasoningChars: reasoningText.length,
    dotThinkingLines: dotLines,
    daysParsed: plan?.days?.length ?? 0,
    formatPass: okFormat,
    parseError: parseErr,
  };

  console.log(JSON.stringify(result, null, 2));
  console.log("--- 输出片段（前 800 字）---");
  console.log(contentText.slice(0, 800));
  if (reasoningText) {
    console.log(`\n--- (内部 reasoning ${reasoningText.length} 字，省略) ---`);
  }
  return result;
}

const results = [];
for (const c of CANDIDATES) {
  try {
    const r = await run(c);
    if (r) results.push(r);
  } catch (e) {
    console.error(`✗ ${c.id}:`, e.message);
  }
}

console.log("\n\n========== 总结 ==========");
console.table(
  results.map((r) => ({
    model: r.model,
    "TTFB(ms)": r.ttfbMs,
    "Total(ms)": r.totalMs,
    "Content字数": r.contentChars,
    "Reasoning字数": r.reasoningChars,
    "思考行": r.dotThinkingLines,
    "解析days": r.daysParsed,
    "协议达标": r.formatPass ? "✓" : "✗",
  })),
);

// 推荐
const passing = results.filter((r) => r.formatPass);
if (passing.length === 1) {
  console.log(`\n推荐: ${passing[0].model}（只有它产出合规的 7 天 JSON）`);
} else if (passing.length === 2) {
  // 两者都合规，选 TTFB 短的
  passing.sort((a, b) => a.ttfbMs - b.ttfbMs);
  console.log(
    `\n推荐: ${passing[0].model}（首字节快 ${passing[1].ttfbMs - passing[0].ttfbMs}ms，对 streaming UX 更友好）`,
  );
} else {
  console.log("\n两个模型都没达标，可能需要调 prompt 或换模型。");
}
