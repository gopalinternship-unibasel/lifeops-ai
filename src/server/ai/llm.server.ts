import { isRecord } from "@/lib/errors";

/**
 * Provider-agnostic LLM gateway. Server-only.
 *
 * Every provider is reached through the OpenAI-compatible
 * `POST {LLM_BASE_URL}/chat/completions` API, so switching provider is an env change:
 *
 *   Local Ollama (default)   LLM_BASE_URL=http://localhost:11434/v1        LLM_MODEL=llama3.1:8b
 *   Hugging Face router      LLM_BASE_URL=https://router.huggingface.co/v1 LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
 *   OpenAI                   LLM_BASE_URL=https://api.openai.com/v1        LLM_MODEL=gpt-4o-mini
 *   Google Gemini            LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai  LLM_MODEL=gemini-2.0-flash
 *
 * Backwards compatibility: when LLM_BASE_URL is not set but HUGGINGFACE_API_KEY is, the
 * original Hugging Face router setup is used (Llama 3.1 8B with Llama 3 8B as fallback).
 *
 * Structured output: the app describes each structured answer as a function ("tool").
 *   LLM_STRUCTURED_OUTPUT=tools        → OpenAI function calling with a forced tool choice.
 *   LLM_STRUCTURED_OUTPUT=json_schema  → `response_format: json_schema` (constrained decoding);
 *                                        the JSON answer is returned in the same tool-call shape.
 * Callers always read `choices[0].message.tool_calls[0].function.arguments`.
 */

export const HF_ROUTER_BASE_URL = "https://router.huggingface.co/v1";
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_MODEL = "meta-llama/Llama-3.1-8B-Instruct";
// Llama 3 8B is the fallback when the primary Hugging Face model is unavailable.
export const FALLBACK_MODEL = "meta-llama/Meta-Llama-3-8B-Instruct";
export const DEFAULT_LOCAL_MODEL = "llama3.1:8b";

export type LLMRole = "chat" | "plan" | "draft" | "backend";
export type StructuredOutputMode = "tools" | "json_schema";

export interface LLMConfig {
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  fallbackModel: string | null;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  structuredOutput: StructuredOutputMode;
}

class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

function errorStatus(error: unknown): number | undefined {
  if (error instanceof HttpStatusError) return error.status;
  if (isRecord(error) && typeof error.status === "number") return error.status;
  return undefined;
}

export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface AIChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

export interface AITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type ToolChoice = "auto" | { type: "function"; function: { name: string } };

type Env = Record<string, string | undefined>;

function envValue(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerName(baseUrl: string): string {
  const url = baseUrl.toLowerCase();
  if (url.includes("huggingface.co")) return "Hugging Face";
  if (url.includes("api.openai.com")) return "OpenAI";
  if (url.includes("generativelanguage.googleapis.com")) return "Google Gemini";
  if (url.includes("lovable")) return "Lovable AI gateway";
  if (url.includes(":11434")) return "Ollama";
  return "the AI provider";
}

/** Resolve the provider settings for one role from environment variables. */
export function resolveLLMConfig(role: LLMRole = "chat", env: Env = process.env): LLMConfig {
  const roleKey = role.toUpperCase();
  const explicitBaseUrl = envValue(env, "LLM_BASE_URL");
  const hfKey = envValue(env, "HUGGINGFACE_API_KEY");
  const useLegacyHf = !explicitBaseUrl && !!hfKey;

  const baseUrl = (explicitBaseUrl ?? (useLegacyHf ? HF_ROUTER_BASE_URL : OLLAMA_BASE_URL)).replace(/\/+$/, "");
  const isHf = baseUrl.includes("huggingface.co");
  const apiKey = envValue(env, "LLM_API_KEY") ?? (isHf ? hfKey : undefined) ?? null;

  const defaultModel = isHf ? DEFAULT_MODEL : DEFAULT_LOCAL_MODEL;
  const model = envValue(env, `LLM_MODEL_${roleKey}`) ?? envValue(env, "LLM_MODEL") ?? defaultModel;
  const fallbackSetting = envValue(env, "LLM_FALLBACK_MODEL");
  const fallbackModel =
    fallbackSetting === "none"
      ? null
      : (fallbackSetting ?? (isHf && model !== FALLBACK_MODEL ? FALLBACK_MODEL : null));

  const structured = envValue(env, "LLM_STRUCTURED_OUTPUT");
  const temperature = Number.parseFloat(envValue(env, "LLM_TEMPERATURE") ?? "");

  return {
    provider: providerName(baseUrl),
    baseUrl,
    apiKey,
    model,
    fallbackModel: fallbackModel && fallbackModel !== model ? fallbackModel : null,
    timeoutMs: positiveInt(envValue(env, "LLM_TIMEOUT_MS"), 120_000),
    maxTokens: positiveInt(
      envValue(env, `LLM_MAX_TOKENS_${roleKey}`) ?? envValue(env, "LLM_MAX_TOKENS"),
      4000,
    ),
    temperature: Number.isFinite(temperature) ? temperature : 0.4,
    structuredOutput: structured === "json_schema" ? "json_schema" : "tools",
  };
}

/** Strip ```json fences and return the first JSON object found in a model's text answer. */
export function extractJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const candidates = [unfenced];
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Llama models sometimes answer a forced function call with the call written as text,
 * e.g. {"name":"respond","parameters":{...}}. Unwrap that to the arguments object.
 */
function unwrapToolEnvelope(value: Record<string, unknown>, toolName: string): Record<string, unknown> {
  if (value.name === toolName) {
    const inner = value.parameters ?? value.arguments;
    if (isRecord(inner)) return inner;
    if (typeof inner === "string") return extractJsonObject(inner) ?? value;
  }
  return value;
}

/** Ensure the completion carries the structured answer as a tool call for `toolName`. */
export function normalizeToolCompletion(completion: AIChatCompletion, toolName: string): AIChatCompletion {
  const choice = completion.choices?.[0];
  const message = choice?.message;
  const existing = message?.tool_calls?.find((call) => call.function?.arguments);
  if (existing?.function?.arguments) {
    const parsed = extractJsonObject(existing.function.arguments);
    if (!parsed) return completion;
    const args = unwrapToolEnvelope(parsed, toolName);
    return {
      ...completion,
      choices: [
        {
          ...choice,
          message: {
            ...message,
            tool_calls: [{ function: { name: toolName, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    };
  }
  const fromContent = extractJsonObject(message?.content);
  if (!fromContent) return completion;
  const args = unwrapToolEnvelope(fromContent, toolName);
  return {
    ...completion,
    choices: [
      {
        ...choice,
        message: {
          content: typeof args.reply === "string" ? args.reply : null,
          tool_calls: [{ function: { name: toolName, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function forcedToolName(tools: AITool[] | undefined, toolChoice: ToolChoice | undefined): string | null {
  if (!tools || tools.length === 0) return null;
  if (toolChoice && toolChoice !== "auto") return toolChoice.function.name;
  return tools.length === 1 ? tools[0].function.name : null;
}

/** Build the request body for one chat-completions call. Exported for tests. */
export function buildRequestBody(opts: {
  config: LLMConfig;
  model: string;
  messages: ChatMsg[];
  tools?: AITool[];
  toolChoice?: ToolChoice;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.config.temperature,
    max_tokens: opts.config.maxTokens,
  };
  const toolName = forcedToolName(opts.tools, opts.toolChoice);
  const tool = toolName ? opts.tools?.find((candidate) => candidate.function.name === toolName) : undefined;

  if (opts.config.structuredOutput === "json_schema" && tool) {
    // Constrained decoding: the provider must return a JSON object matching the schema.
    body.response_format = {
      type: "json_schema",
      json_schema: { name: tool.function.name, schema: tool.function.parameters, strict: false },
    };
    const instruction = `OUTPUT FORMAT: answer with one JSON object only (no prose, no code fences). It is the argument object of the "${tool.function.name}" function: ${tool.function.description}`;
    const [first, ...rest] = opts.messages;
    body.messages =
      first?.role === "system"
        ? [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest]
        : [{ role: "system", content: instruction }, ...opts.messages];
    return body;
  }

  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  return body;
}

async function singleCall(opts: {
  config: LLMConfig;
  model: string;
  messages: ChatMsg[];
  tools?: AITool[];
  toolChoice?: ToolChoice;
}): Promise<AIChatCompletion> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.config.apiKey) headers.Authorization = `Bearer ${opts.config.apiKey}`;

  const startedAt = Date.now();
  const res = await fetch(`${opts.config.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(opts)),
    signal: AbortSignal.timeout(opts.config.timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpStatusError(`${opts.config.provider} ${res.status}: ${text.slice(0, 240)}`, res.status);
  }

  const completion = (await res.json()) as AIChatCompletion & {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  console.info(
    `[llm] ${opts.config.provider} ${opts.model}: ${completion.usage?.prompt_tokens ?? "?"} prompt + ${completion.usage?.completion_tokens ?? "?"} completion tokens in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
  );
  const toolName = forcedToolName(opts.tools, opts.toolChoice);
  return toolName ? normalizeToolCompletion(completion, toolName) : completion;
}

export async function callAI(opts: {
  messages: ChatMsg[];
  tools?: AITool[];
  toolChoice?: ToolChoice;
  model?: string;
  role?: LLMRole;
}) {
  const config = resolveLLMConfig(opts.role ?? "chat");
  if (config.provider === "Hugging Face" && !config.apiKey) {
    throw new Error("HUGGINGFACE_API_KEY (or LLM_API_KEY) is not configured");
  }
  const primary = opts.model ?? config.model;

  try {
    return await singleCall({ ...opts, config, model: primary });
  } catch (e: unknown) {
    const status = errorStatus(e);
    // 401/403 = gated/unauthorized for the primary model → try the fallback.
    // 404 = model not available. 503 = cold-start; try fallback once.
    const fallback = config.fallbackModel;
    const shouldFallback =
      !!fallback && primary !== fallback && (status === 401 || status === 403 || status === 404 || status === 503);
    if (shouldFallback && fallback) {
      console.warn(`[llm] ${primary} failed (${status}); falling back to ${fallback}`);
      try {
        return await singleCall({ ...opts, config, model: fallback });
      } catch (e2: unknown) {
        throw friendly(e2, config);
      }
    }
    throw friendly(e, config);
  }
}

export function friendly(e: unknown, config: Pick<LLMConfig, "provider" | "baseUrl" | "timeoutMs">): Error {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return new Error(
      `${config.provider} did not answer within ${Math.round(config.timeoutMs / 1000)} s. A local model on CPU can be slow; raise LLM_TIMEOUT_MS or try again.`,
    );
  }
  const status = errorStatus(e);
  if (status === undefined && e instanceof TypeError) {
    return new Error(
      `Could not reach ${config.provider} at ${config.baseUrl}. Is it running? (For local Ollama: docker ps shows the Ollama container on port 11434.)`,
    );
  }
  if (status === 429) return new Error(`${config.provider} rate limit reached. Please wait a moment and try again.`);
  if (status === 401 || status === 403)
    return new Error(
      config.provider === "Hugging Face"
        ? "Hugging Face rejected the API key. Make sure HUGGINGFACE_API_KEY is valid and that you've accepted the Llama 3.1 license at https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct."
        : `${config.provider} rejected the API key (LLM_API_KEY).`,
    );
  if (status === 402) return new Error(`${config.provider} credits exhausted for this token.`);
  if (status === 404) return new Error(`${config.provider} does not serve the configured model (LLM_MODEL).`);
  return e instanceof Error ? e : new Error(String(e));
}
