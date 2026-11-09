import { isRecord } from "@/lib/errors";

/**
 * Hugging Face LLM gateway. Server-only.
 *
 * Uses the HF Router (OpenAI-compatible chat completions) so we can keep our
 * existing tool-calling pattern. Default model is Llama 3.1 8B Instruct;
 * Llama 3 8B Instruct is used as an automatic fallback when the primary model is gated or unavailable.
 */
const HF_URL = "https://router.huggingface.co/v1/chat/completions";
const HF_TIMEOUT_MS = 45_000;

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

export const DEFAULT_MODEL = "meta-llama/Llama-3.1-8B-Instruct";
// Llama 3 8B is the fallback when the primary model is unavailable.
export const FALLBACK_MODEL = "meta-llama/Meta-Llama-3-8B-Instruct";

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

async function singleCall(opts: {
  messages: ChatMsg[];
  tools?: AITool[];
  toolChoice?: "auto" | { type: "function"; function: { name: string } };
  model: string;
  apiKey: string;
}): Promise<AIChatCompletion> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: 0.4,
    max_tokens: 4000,
  };
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;

  const res = await fetch(HF_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HF_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpStatusError(`HF ${res.status}: ${text.slice(0, 240)}`, res.status);
  }

  return (await res.json()) as AIChatCompletion;
}

export async function callAI(opts: {
  messages: ChatMsg[];
  tools?: AITool[];
  toolChoice?: "auto" | { type: "function"; function: { name: string } };
  model?: string;
}) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) throw new Error("HUGGINGFACE_API_KEY is not configured");

  const primary = opts.model ?? DEFAULT_MODEL;

  try {
    return await singleCall({ ...opts, model: primary, apiKey });
  } catch (e: unknown) {
    const status = errorStatus(e);
    // 401/403 = gated/unauthorized for the primary model → try the fallback.
    // 404 = model not on the router. 503 = cold-start; try fallback once.
    const shouldFallback =
      primary !== FALLBACK_MODEL && (status === 401 || status === 403 || status === 404 || status === 503);
    if (shouldFallback) {
      console.warn(`[hf] ${primary} failed (${status}); falling back to ${FALLBACK_MODEL}`);
      try {
        return await singleCall({ ...opts, model: FALLBACK_MODEL, apiKey });
      } catch (e2: unknown) {
        throw friendly(e2);
      }
    }
    throw friendly(e);
  }
}

function friendly(e: unknown): Error {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return new Error("The AI provider timed out. Please try again.");
  }
  const status = errorStatus(e);
  if (status === 429) return new Error("Hugging Face rate limit reached. Please wait a moment and try again.");
  if (status === 401 || status === 403)
    return new Error(
      "Hugging Face rejected the API key. Make sure HUGGINGFACE_API_KEY is valid and that you've accepted the Llama 3.1 license at https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct.",
    );
  if (status === 402) return new Error("Hugging Face credits exhausted for this token.");
  return e instanceof Error ? e : new Error(String(e));
}
