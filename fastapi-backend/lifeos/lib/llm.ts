// 极简 LLM 适配层。当前默认走 NVIDIA NIM (OpenAI 兼容协议)。
// 之后切换到 Anthropic 时只需替换 callLLMStream 内的 provider 分支。

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMStreamOptions {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
}

export type LLMDelta =
  | { kind: "content"; text: string }
  | { kind: "reasoning"; text: string };

type Provider = "nvidia" | "anthropic";

function activeProvider(): Provider {
  const p = (process.env.LLM_PROVIDER || "nvidia").toLowerCase();
  if (p === "anthropic") return "anthropic";
  return "nvidia";
}

/**
 * 返回一个异步可迭代器，逐 chunk 吐出 delta（区分 content 与 reasoning）。
 * 调用方根据 kind 决定是拼接为最终文本还是仅作为 UI 进度提示。
 */
export async function* callLLMStream(
  opts: LLMStreamOptions,
): AsyncGenerator<LLMDelta, void, unknown> {
  const provider = activeProvider();
  if (provider === "nvidia") {
    yield* nvidiaStream(opts);
  } else {
    throw new Error("Anthropic provider not implemented yet; set LLM_PROVIDER=nvidia in .env");
  }
}

async function* nvidiaStream(
  opts: LLMStreamOptions,
): AsyncGenerator<LLMDelta, void, unknown> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("missing env var NVIDIA_API_KEY");
  }
  const baseURL = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
  const model = process.env.NVIDIA_MODEL || "mistralai/mistral-medium-3.5-128b";
  const reasoningEffort = process.env.NVIDIA_REASONING_EFFORT;

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
    top_p: 1.0,
    max_tokens: opts.maxTokens ?? 16384,
    stream: true,
  };
  if (reasoningEffort && reasoningEffort !== "none") {
    body.reasoning_effort = reasoningEffort;
  }

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`NVIDIA API call failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload);
          const d = json?.choices?.[0]?.delta;
          const reasoning: string | undefined = d?.reasoning_content;
          if (reasoning) yield { kind: "reasoning", text: reasoning };
          const content: string | undefined = d?.content;
          if (content) yield { kind: "content", text: content };
        } catch {
          // 忽略偶发非 JSON keepalive
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 从混合文本（含思考流 + ```json``` 代码块）里提取并解析 JSON。
 * 找不到合法 JSON 时返回 null。
 */
export function extractJSON<T = unknown>(text: string): T | null {
  // 优先匹配 ```json ... ``` 块
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      // fallthrough
    }
  }
  // 退而求其次：抓最外层 { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}
