import { isRecord } from "@/lib/errors";
import { isHostedDeployment } from "@/server/deployment.server";

/**
 * Provider-agnostic LLM gateway. Server-only.
 *
 * Every provider is reached through the OpenAI-compatible
 * `POST {LLM_BASE_URL}/chat/completions` API, so switching provider is an env change:
 *
 *   Local Ollama (default    LLM_BASE_URL=http://localhost:11434/v1        LLM_MODEL=llama3.1:8b
 *    for a local run only)
 *   Cloudflare Workers AI    LLM_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1
 *     (hosted demo)          LLM_MODEL=@cf/zai-org/glm-4.7-flash  LLM_STRUCTURED_OUTPUT=tools_required
 *                            LLM_FALLBACK_MODEL=@cf/google/gemma-4-26b-a4b-it
 *                            LLM_API_KEY = a Workers AI API token (not yet run against the API)
 *   Hugging Face router      LLM_BASE_URL=https://router.huggingface.co/v1 LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
 *   OpenAI                   LLM_BASE_URL=https://api.openai.com/v1        LLM_MODEL=gpt-4o-mini
 *   Groq (alternative)       LLM_BASE_URL=https://api.groq.com/openai/v1  LLM_MODEL=llama-3.3-70b-versatile
 *   Any other OpenAI-compatible host works the same way: set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY.
 *   (A free Google Gemini key may not be used for an app offered to users in the EEA, Switzerland or UK.)
 *
 * Backwards compatibility: when LLM_BASE_URL is not set but HUGGINGFACE_API_KEY is, the
 * original Hugging Face router setup is used (Llama 3.1 8B with Llama 3 8B as fallback).
 *
 * Structured output: the app describes each structured answer as a function ("tool").
 *   LLM_STRUCTURED_OUTPUT=tools        → OpenAI function calling with a forced tool choice.
 *   LLM_STRUCTURED_OUTPUT=tools_required → for providers that do not accept a named function in
 *                                        tool_choice (Cloudflare Workers AI): a forced call sends
 *                                        only that one tool with `tool_choice: "required"`.
 *   LLM_STRUCTURED_OUTPUT=json_schema  → `response_format: json_schema` (constrained decoding);
 *                                        the JSON answer is returned in the same tool-call shape.
 * Callers always read `choices[0].message.tool_calls[0].function.arguments`.
 *
 * LLM_EXTRA_BODY: optional JSON object whose fields are added to every request, for switches only
 * one provider knows. On Cloudflare Workers AI `{"chat_template_kwargs":{"enable_thinking":false}}`
 * turns the model's thinking off (measured 17 Nov 2026: about 1.2 s instead of 3 to 6 s for a short
 * answer). The app's own fields (model, messages, tools, ...) are never overwritten by it.
 */

/** The hosted demo has no AI provider set; the message is meant for visitors. */
export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "The AI assistant is not set up on this site yet, so this request could not be answered.",
    );
    this.name = "AiNotConfiguredError";
  }
}

export const HF_ROUTER_BASE_URL = "https://router.huggingface.co/v1";
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_MODEL = "meta-llama/Llama-3.1-8B-Instruct";
// Llama 3 8B is the fallback when the primary Hugging Face model is unavailable.
export const FALLBACK_MODEL = "meta-llama/Meta-Llama-3-8B-Instruct";
export const DEFAULT_LOCAL_MODEL = "llama3.1:8b";

export type LLMRole = "chat" | "plan" | "draft" | "backend";
export type StructuredOutputMode = "tools" | "tools_required" | "json_schema";

export interface LLMConfig {
  /**
   * False when this is the hosted demo and no AI provider is set (no LLM_BASE_URL and no legacy
   * HUGGINGFACE_API_KEY): the localhost Ollama default is only meant for a local run, so callAI
   * refuses at once instead of trying it. Also false on the hosted demo when LLM_BASE_URL is the
   * Hugging Face router and neither LLM_API_KEY nor HUGGINGFACE_API_KEY is set.
   */
  configured: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  fallbackModel: string | null;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  structuredOutput: StructuredOutputMode;
  /** Extra request-body fields for every call (LLM_EXTRA_BODY). */
  extraBody?: Record<string, unknown> | null;
}

/** LLM_EXTRA_BODY: a JSON object, or null when unset or not an object. */
export function parseExtraBody(value: string | undefined): Record<string, unknown> | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The provider's own error text, one readable line (never raw JSON), or "". */
    readonly detail: string = "",
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/**
 * The provider answered (HTTP 200) but the answer could not be read: not JSON, or JSON of an
 * unexpected shape. Kept apart from network failures, so the user is not told the provider
 * "could not be reached" when it did answer, and so the fallback model can be tried.
 */
export class UnreadableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableAnswerError";
  }
}

/** The provider's name at the start of a sentence ("the AI provider" for an unknown host). */
function sentenceName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** A model server on this machine (local Ollama, a test double), not a hosted provider. */
export function isLocalBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(:\d+)?(\/|$)/i.test(
    baseUrl.trim(),
  );
}

/**
 * Whether error messages may carry developer detail (the model address, setting names, docker
 * hints): only on a local run against a model on this machine, where the reader is the person who
 * runs it. A hosted site, or any hosted provider, gets plain sentences for its users, and the
 * detail goes to the server log. A hosted provider's address can also hold an account id (the
 * Cloudflare one does), which must not reach users.
 */
export function developerWording(baseUrl: string, hosted: boolean = isHostedDeployment()): boolean {
  return !hosted && isLocalBaseUrl(baseUrl);
}

/** The first message-like string in a parsed error body ({"error":{"message":...}} and similar). */
function findErrorText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) return findErrorText(value[0], depth + 1);
  if (isRecord(value)) {
    // "errors" is the Cloudflare v4 envelope: {"success":false,"errors":[{"code":..,"message":..}]}.
    for (const key of [
      "message",
      "error",
      "errors",
      "detail",
      "error_description",
      "msg",
      "title",
    ]) {
      const found = findErrorText(value[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** The length providerErrorDetail cuts a provider's error text to (the last character is "…"). */
const PROVIDER_DETAIL_MAX = 160;

/**
 * The provider's error text from an error response body, as one short readable line: the
 * message inside a JSON error object, or plain text. JSON without a message, HTML error pages
 * and anything that still looks like JSON give "" so users never see a raw provider body.
 */
export function providerErrorDetail(body: string, max = PROVIDER_DETAIL_MAX): string {
  const text = (body ?? "").trim();
  if (!text) return "";
  let detail: string | undefined;
  try {
    detail = findErrorText(JSON.parse(text) as unknown) ?? "";
  } catch {
    detail = text;
  }
  const line = detail.replace(/\s+/g, " ").trim();
  if (!line || /^[[{<]/.test(line)) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Characters that end an address or a path inside a sentence. */
const END = String.raw`[^\s,;()[\]"'<>]`;

/**
 * A provider's error text (see providerErrorDetail) as users of a hosted site may read it:
 * addresses, request paths and long ids are replaced by "…". The provider quotes them as it sees
 * them, and they can hold the operator's account: Cloudflare's routing error (code 7003) quotes the
 * request path, which carries the account id. Returns "" when nothing readable is left.
 */
export function visitorDetail(detail: string): string {
  // A word cut off by providerErrorDetail's length limit may be the start of an id. A shorter
  // text was not cut, so a "…" the provider wrote itself keeps its word.
  const cut = detail.length >= PROVIDER_DETAIL_MAX && detail.endsWith("…");
  const shown = (cut ? detail.replace(/\S*…$/u, "…") : detail)
    .replace(new RegExp(String.raw`\b[a-z][a-z0-9+.-]*://${END}*`, "gi"), "…")
    .replace(new RegExp(String.raw`(^|[\s(["'=:])/${END}+`, "g"), "$1…")
    .replace(new RegExp(String.raw`${END}*accounts?/${END}*`, "gi"), "…")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "…")
    .replace(/\b[0-9a-f]{24,}\b/gi, "…")
    // Token-like words: 24 or more letters, digits or "_", with a digit and a letter. (Model names
    // such as gemma-4-26b-a4b-it are split by their hyphens and stay readable.)
    .replace(/\b(?=\w*\d)(?=\w*[a-z])\w{24,}\b/gi, "…")
    .replace(/…(?:\s*…)+/gu, "…")
    .trim();
  return /^[\s….,;:!?-]*$/u.test(shown) ? "" : shown;
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

/** Hosted providers, recognised by their API host so messages name the one that was called. */
const HOSTED_PROVIDERS: Array<[host: string, name: string]> = [
  ["huggingface.co", "Hugging Face"],
  ["api.openai.com", "OpenAI"],
  ["generativelanguage.googleapis.com", "Google Gemini"],
  ["api.cloudflare.com", "Cloudflare Workers AI"],
  ["api.groq.com", "Groq"],
  ["api.cerebras.ai", "Cerebras"],
  ["openrouter.ai", "OpenRouter"],
  ["api.together.xyz", "Together AI"],
  ["api.mistral.ai", "Mistral"],
];

export function providerName(baseUrl: string): string {
  const url = baseUrl.toLowerCase();
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  for (const [suffix, name] of HOSTED_PROVIDERS) {
    if (host ? host === suffix || host.endsWith(`.${suffix}`) : url.includes(suffix)) return name;
  }
  if (url.includes("lovable")) return "Lovable AI gateway";
  if (url.includes(":11434")) return "Ollama";
  return "the AI provider";
}

/** Resolve the provider settings for one role from environment variables. */
export function resolveLLMConfig(
  role: LLMRole = "chat",
  env: Env = process.env,
  hosted: boolean = isHostedDeployment(undefined, env),
): LLMConfig {
  const roleKey = role.toUpperCase();
  const explicitBaseUrl = envValue(env, "LLM_BASE_URL");
  const hfKey = envValue(env, "HUGGINGFACE_API_KEY");
  const useLegacyHf = !explicitBaseUrl && !!hfKey;

  const baseUrl = (explicitBaseUrl ?? (useLegacyHf ? HF_ROUTER_BASE_URL : OLLAMA_BASE_URL)).replace(
    /\/+$/,
    "",
  );
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
  const provider = providerName(baseUrl);
  // The Hugging Face router answers nothing without a key, so callAI refuses before sending; on a
  // hosted site that is "not set up" too, and callers that check `configured` first record no use.
  const configured =
    (!!explicitBaseUrl || useLegacyHf || !hosted) &&
    !(hosted && provider === "Hugging Face" && !apiKey);

  return {
    configured,
    // A hosted site without a provider has no model server at all: it is not "Ollama" (the
    // localhost default is for a local run), and no address is kept that a call could reach.
    provider: configured ? provider : "the AI provider",
    baseUrl: configured ? baseUrl : "",
    apiKey,
    model,
    fallbackModel: fallbackModel && fallbackModel !== model ? fallbackModel : null,
    timeoutMs: positiveInt(envValue(env, "LLM_TIMEOUT_MS"), 120_000),
    maxTokens: positiveInt(
      envValue(env, `LLM_MAX_TOKENS_${roleKey}`) ?? envValue(env, "LLM_MAX_TOKENS"),
      4000,
    ),
    temperature: Number.isFinite(temperature) ? temperature : 0.4,
    structuredOutput:
      structured === "json_schema" || structured === "tools_required" ? structured : "tools",
    extraBody: parseExtraBody(envValue(env, "LLM_EXTRA_BODY")),
  };
}

/** Strip ```json fences and return the first JSON object found in a model's text answer. */
export function extractJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  // The answer is parsed JSON from the provider, so a "string" field can hold anything.
  if (typeof text !== "string" || !text) return null;
  const unfenced = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
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
function unwrapToolEnvelope(
  value: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  if (value.name === toolName) {
    const inner = value.parameters ?? value.arguments;
    if (isRecord(inner)) return inner;
    if (typeof inner === "string") return extractJsonObject(inner) ?? value;
  }
  return value;
}

/**
 * Tool-call arguments as the JSON string callers expect. Some providers (Cloudflare's native
 * format) send the arguments as an object instead of a string.
 */
function argumentsText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (isRecord(value)) return JSON.stringify(value);
  return undefined;
}

/** Ensure the completion carries the structured answer as a tool call for `toolName`. */
export function normalizeToolCompletion(
  completion: AIChatCompletion,
  toolName: string,
): AIChatCompletion {
  // The completion is parsed JSON from the provider: check each level instead of trusting the type.
  const choice = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
  const calls: unknown[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const existingArguments = calls
    .map((call) =>
      isRecord(call) && isRecord(call.function)
        ? argumentsText(call.function.arguments)
        : undefined,
    )
    .find((text): text is string => !!text);
  if (existingArguments) {
    const parsed = extractJsonObject(existingArguments);
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
  const fromContent = extractJsonObject(
    typeof message?.content === "string" ? message.content : null,
  );
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

function forcedToolName(
  tools: AITool[] | undefined,
  toolChoice: ToolChoice | undefined,
): string | null {
  if (!tools || tools.length === 0) return null;
  if (toolChoice && toolChoice !== "auto") return toolChoice.function.name;
  return tools.length === 1 ? tools[0].function.name : null;
}

/**
 * Replace lone UTF-16 surrogates (half of an emoji, left when real email text is cut to a length)
 * with U+FFFD in every string of a request body. JSON.stringify writes them as "\ud83d" escapes,
 * which Cloudflare Workers AI rejects with HTTP 400 ("TextEncodeInput must be ...", or "Invalid
 * JSON" for tool arguments): measured 26 Nov 2026 with a real Gmail inbox; the demo inbox never had
 * one. Exported for tests.
 */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD") as T;
  }
  if (Array.isArray(value)) return value.map((item) => wellFormedDeep(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = wellFormedDeep(item);
    return out as T;
  }
  return value;
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
    // Provider-specific extras come first, so the app's own fields below always win.
    ...(opts.config.extraBody ?? {}),
    model: opts.model,
    messages: opts.messages,
    temperature: opts.config.temperature,
    max_tokens: opts.config.maxTokens,
  };
  const toolName = forcedToolName(opts.tools, opts.toolChoice);
  const tool = toolName
    ? opts.tools?.find((candidate) => candidate.function.name === toolName)
    : undefined;

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

  if (opts.config.structuredOutput === "tools_required" && tool) {
    // Some providers (Cloudflare Workers AI) accept tool_choice none/auto/required only, not a
    // named function. Sending just the forced tool with "required" leaves the model no other choice.
    body.tools = [tool];
    body.tool_choice = "required";
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
    body: JSON.stringify(wellFormedDeep(buildRequestBody(opts))),
    signal: AbortSignal.timeout(opts.config.timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // The raw body goes to the server log only; users get a sentence from friendly().
    console.error(
      `[llm] ${opts.config.provider} ${opts.model}: HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
    const detail = providerErrorDetail(text);
    throw new HttpStatusError(
      `${opts.config.provider} answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
      detail,
    );
  }

  const responseText = await res.text();
  return readCompletion(responseText, opts, startedAt);
}

/** Every tool call's arguments as a JSON string, whatever form the provider sent them in. */
function withStringArguments(completion: Record<string, unknown>): AIChatCompletion {
  if (!Array.isArray(completion.choices)) return completion as AIChatCompletion;
  const choices = completion.choices.map((choice: unknown) => {
    if (
      !isRecord(choice) ||
      !isRecord(choice.message) ||
      !Array.isArray(choice.message.tool_calls)
    ) {
      return choice;
    }
    const toolCalls = choice.message.tool_calls.map((call: unknown) => {
      if (!isRecord(call) || !isRecord(call.function) || !isRecord(call.function.arguments))
        return call;
      return {
        ...call,
        function: { ...call.function, arguments: JSON.stringify(call.function.arguments) },
      };
    });
    return { ...choice, message: { ...choice.message, tool_calls: toolCalls } };
  });
  return { ...completion, choices } as AIChatCompletion;
}

/**
 * Read a 200 answer. Anything that goes wrong here happens after the provider answered, so it
 * becomes an UnreadableAnswerError, never a TypeError that would read as "could not be reached".
 */
function readCompletion(
  responseText: string,
  opts: { config: LLMConfig; model: string; tools?: AITool[]; toolChoice?: ToolChoice },
  startedAt: number,
): AIChatCompletion {
  const who = sentenceName(opts.config.provider);
  const label = `[llm] ${opts.config.provider} ${opts.model}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.error(`${label}: answer is not JSON: ${responseText.slice(0, 300)}`);
    throw new UnreadableAnswerError(
      `${who} sent an answer that is not valid JSON. Try again in a moment.`,
    );
  }
  const unreadable = () =>
    new UnreadableAnswerError(
      `${who} sent an answer the app could not read. Try again in a moment.`,
    );
  if (!isRecord(parsed)) {
    console.error(`${label}: answer is not a JSON object: ${responseText.slice(0, 300)}`);
    throw unreadable();
  }
  try {
    const usage = isRecord(parsed.usage) ? parsed.usage : {};
    console.info(
      `${label}: ${String(usage.prompt_tokens ?? "?")} prompt + ${String(usage.completion_tokens ?? "?")} completion tokens in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
    );
    const completion = withStringArguments(parsed);
    const toolName = forcedToolName(opts.tools, opts.toolChoice);
    return toolName ? normalizeToolCompletion(completion, toolName) : completion;
  } catch (error) {
    console.error(
      `${label}: answer of an unexpected shape (${String(error)}): ${responseText.slice(0, 300)}`,
    );
    throw unreadable();
  }
}

export async function callAI(opts: {
  messages: ChatMsg[];
  tools?: AITool[];
  toolChoice?: ToolChoice;
  model?: string;
  role?: LLMRole;
}) {
  const config = resolveLLMConfig(opts.role ?? "chat");
  if (!config.configured) {
    console.warn(
      "[llm] No AI provider is set on this hosted deployment (LLM_BASE_URL is empty, or it is the Hugging Face router without HUGGINGFACE_API_KEY or LLM_API_KEY); the request was not sent.",
    );
    throw new AiNotConfiguredError();
  }
  if (config.provider === "Hugging Face" && !config.apiKey) {
    // The setting names are for the person running the server, not for visitors of a hosted site.
    if (!isHostedDeployment())
      throw new Error("HUGGINGFACE_API_KEY (or LLM_API_KEY) is not configured");
    console.warn(
      "[llm] HUGGINGFACE_API_KEY (or LLM_API_KEY) is not set; the request was not sent.",
    );
    throw new AiNotConfiguredError();
  }
  const primary = opts.model ?? config.model;

  try {
    return await singleCall({ ...opts, config, model: primary });
  } catch (e: unknown) {
    const status = errorStatus(e);
    // 401/403 = gated/unauthorized for the primary model → try the fallback.
    // 404 = model not available. 429 = rate limit: hosted providers count it per model, so the
    // fallback model can still answer. 500/502/503/504 = the model's server failed or is starting
    // (cold start); another model may be served by a healthy one. An answer that could not be
    // read is tried once more with the other model. Timeouts are not retried: the time is spent.
    const fallback = config.fallbackModel;
    const shouldFallback =
      !!fallback &&
      primary !== fallback &&
      (e instanceof UnreadableAnswerError ||
        status === 401 ||
        status === 403 ||
        status === 404 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504);
    if (shouldFallback && fallback) {
      console.warn(
        `[llm] ${primary} failed (${status ?? "unreadable answer"}); falling back to ${fallback}`,
      );
      try {
        return await singleCall({ ...opts, config, model: fallback });
      } catch (e2: unknown) {
        throw friendly(e2, config);
      }
    }
    throw friendly(e, config);
  }
}

/** Error code of a failed fetch (Node/undici put it on `cause`), e.g. "UND_ERR_HEADERS_TIMEOUT". */
function fetchCauseCode(e: unknown): string | undefined {
  const cause = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  return isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
}

/** What users of a hosted site read when the provider refuses the site's key or model setting. */
const NOT_SET_UP_CORRECTLY =
  "The AI assistant is not set up correctly on this site right now. Please try again later.";

/**
 * The sentence a user reads for a failed AI call. Its message reaches users as-is (chat history,
 * plan banners, toasts), so it never names an address, a setting or a command unless this is a
 * local run against a model on this machine (see developerWording); the detail is logged instead.
 */
export function friendly(
  e: unknown,
  config: Pick<LLMConfig, "provider" | "baseUrl" | "timeoutMs">,
  hosted: boolean = isHostedDeployment(),
): Error {
  const who = sentenceName(config.provider);
  const developer = developerWording(config.baseUrl, hosted);
  /** The developer sentence on a local run; otherwise the visitor sentence, with `log` logged. */
  const pick = (developerText: string, visitorText: string, log: string = developerText): Error => {
    if (developer) return new Error(developerText);
    console.error(`[llm] ${log}`);
    return new Error(visitorText);
  };

  if (e instanceof UnreadableAnswerError) return new Error(e.message);
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    const seconds = Math.round(config.timeoutMs / 1000);
    return pick(
      `${who} did not answer within ${seconds} s. A local model on CPU can be slow; raise LLM_TIMEOUT_MS or try again.`,
      `${who} did not answer within ${seconds} s. Please try again in a moment.`,
      `${config.provider} did not answer within LLM_TIMEOUT_MS (${seconds} s).`,
    );
  }
  const causeCode = fetchCauseCode(e);
  if (causeCode === "UND_ERR_HEADERS_TIMEOUT" || causeCode === "UND_ERR_BODY_TIMEOUT") {
    // Node's own fetch limit (5 minutes without response headers), not LLM_TIMEOUT_MS. The dev
    // server lifts it (vite.config.ts); other Node hosts need the same Agent settings.
    return pick(
      `${who} took longer than Node's 5-minute fetch limit to start answering (it may be busy or still loading the model). Try again in a moment.`,
      `${who} took too long to start answering. Please try again in a moment.`,
      `${config.provider} hit Node's 5-minute fetch limit (${causeCode}).`,
    );
  }
  const status = errorStatus(e);
  if (status === undefined && e instanceof TypeError) {
    // Only fetch itself throws a TypeError here: answers are read in readCompletion, which turns
    // every failure into an UnreadableAnswerError.
    return pick(
      `Could not reach ${config.provider} at ${config.baseUrl}. Is it running? (For local Ollama: docker ps shows the Ollama container on port 11434.)`,
      `${who} could not be reached. Please try again in a moment.`,
      `Could not reach ${config.provider} at ${config.baseUrl}: ${e.message}${causeCode ? ` (${causeCode})` : ""}`,
    );
  }
  if (status === 429)
    return new Error(`${who} rate limit reached. Please wait a moment and try again.`);
  if (status === 401 || status === 403)
    return pick(
      config.provider === "Hugging Face"
        ? "Hugging Face rejected the API key. Make sure HUGGINGFACE_API_KEY is valid and that you've accepted the Llama 3.1 license at https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct."
        : `${who} rejected the API key (LLM_API_KEY).`,
      NOT_SET_UP_CORRECTLY,
      `${config.provider} rejected the API key (HTTP ${status}); check ${config.provider === "Hugging Face" ? "HUGGINGFACE_API_KEY or " : ""}LLM_API_KEY.`,
    );
  if (status === 402)
    return pick(
      `${who} credits exhausted for this token.`,
      "The AI assistant has used up its allowance for now. Please try again later.",
      `${config.provider} answered HTTP 402: the API token's credits are used up.`,
    );
  if (status === 404)
    return pick(
      `${who} does not serve the configured model (LLM_MODEL).`,
      NOT_SET_UP_CORRECTLY,
      `${config.provider} does not serve the configured model (HTTP 404); check LLM_MODEL and LLM_FALLBACK_MODEL.`,
    );
  if (status !== undefined) {
    // Every other HTTP status: a sentence with the provider's own message (never its raw body).
    // Users of a hosted site get it without addresses, paths and ids (the raw body is logged).
    const raw = e instanceof HttpStatusError ? e.detail : "";
    const detail = developer ? raw : visitorDetail(raw);
    const code = `HTTP ${status}${detail ? `: ${detail}` : ""}`;
    if (status === 413)
      return new Error(`${who} refused the request as too large (${code}). Try a shorter message.`);
    if (status >= 500) {
      return new Error(`${who} is not available right now (${code}). Try again in a moment.`);
    }
    return new Error(`${who} could not process the request (${code}).`);
  }
  // A plain Error carries a sentence written for users; anything else (a RangeError, a thrown
  // object) is an internal fault whose text is only for the log.
  if (e instanceof Error && e.name === "Error" && e.message) return e;
  if (developer) return e instanceof Error ? e : new Error(String(e));
  console.error(`[llm] ${config.provider}: unexpected error:`, e);
  return new Error(`${who} could not answer this request. Please try again in a moment.`);
}
