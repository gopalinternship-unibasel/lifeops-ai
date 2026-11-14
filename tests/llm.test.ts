import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRequestBody,
  callAI,
  extractJsonObject,
  normalizeToolCompletion,
  providerErrorDetail,
  providerName,
  resolveLLMConfig,
  type AITool,
} from "@/server/ai/llm.server";

const TOOL: AITool = {
  type: "function",
  function: {
    name: "respond",
    description: "Reply to the user.",
    parameters: { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] },
  },
};
const FORCE = { type: "function" as const, function: { name: "respond" } };

function completion(message: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function setEnv(values: Record<string, string>) {
  for (const key of [
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_MODEL_CHAT",
    "LLM_FALLBACK_MODEL",
    "LLM_STRUCTURED_OUTPUT",
    "LLM_TIMEOUT_MS",
    "LLM_MAX_TOKENS",
    "HUGGINGFACE_API_KEY",
  ]) {
    vi.stubEnv(key, values[key] ?? "");
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("resolveLLMConfig", () => {
  it("defaults to local Ollama with llama3.1:8b when nothing is configured", () => {
    const config = resolveLLMConfig("chat", {});
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.provider).toBe("Ollama");
    expect(config.model).toBe("llama3.1:8b");
    expect(config.apiKey).toBeNull();
    expect(config.fallbackModel).toBeNull();
    expect(config.structuredOutput).toBe("tools");
  });

  it("keeps the original Hugging Face setup when only HUGGINGFACE_API_KEY is set", () => {
    const config = resolveLLMConfig("chat", { HUGGINGFACE_API_KEY: "hf_test" });
    expect(config.baseUrl).toBe("https://router.huggingface.co/v1");
    expect(config.apiKey).toBe("hf_test");
    expect(config.model).toBe("meta-llama/Llama-3.1-8B-Instruct");
    expect(config.fallbackModel).toBe("meta-llama/Meta-Llama-3-8B-Instruct");
  });

  it("switches provider with env vars only and supports a model per role", () => {
    const env = {
      LLM_BASE_URL: "https://api.openai.com/v1/",
      LLM_API_KEY: "sk-test",
      LLM_MODEL: "gpt-4o-mini",
      LLM_MODEL_PLAN: "gpt-4o",
      LLM_TIMEOUT_MS: "900000",
      LLM_MAX_TOKENS_PLAN: "2500",
      LLM_STRUCTURED_OUTPUT: "json_schema",
    };
    const chat = resolveLLMConfig("chat", env);
    const plan = resolveLLMConfig("plan", env);
    expect(chat.baseUrl).toBe("https://api.openai.com/v1");
    expect(chat.provider).toBe("OpenAI");
    expect(chat.model).toBe("gpt-4o-mini");
    expect(plan.model).toBe("gpt-4o");
    expect(plan.maxTokens).toBe(2500);
    expect(chat.timeoutMs).toBe(900000);
    expect(chat.structuredOutput).toBe("json_schema");
  });
});

describe("structured output", () => {
  it("json_schema mode sends response_format and folds the instruction into the system prompt", () => {
    const config = resolveLLMConfig("chat", { LLM_STRUCTURED_OUTPUT: "json_schema" });
    const body = buildRequestBody({
      config,
      model: config.model,
      messages: [
        { role: "system", content: "You are MONDAY." },
        { role: "user", content: "hi" },
      ],
      tools: [TOOL],
      toolChoice: FORCE,
    });
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "respond", schema: TOOL.function.parameters, strict: false },
    });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("You are MONDAY.");
    expect(messages[0].content).toContain('"respond" function');
  });

  it("tools mode sends OpenAI function calling with a forced tool choice", () => {
    const config = resolveLLMConfig("chat", {});
    const body = buildRequestBody({ config, model: "m", messages: [], tools: [TOOL], toolChoice: FORCE });
    expect(body.tools).toEqual([TOOL]);
    expect(body.tool_choice).toEqual(FORCE);
    expect(body.response_format).toBeUndefined();
  });

  it("tools_required mode sends only the forced tool with tool_choice required", () => {
    const other: AITool = {
      type: "function",
      function: { name: "other", description: "Another tool.", parameters: { type: "object" } },
    };
    const config = resolveLLMConfig("chat", { LLM_STRUCTURED_OUTPUT: "tools_required" });
    expect(config.structuredOutput).toBe("tools_required");
    const body = buildRequestBody({
      config,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [other, TOOL],
      toolChoice: FORCE,
    });
    expect(body.tools).toEqual([TOOL]);
    expect(body.tool_choice).toBe("required");
    expect(body.response_format).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);

    // Exactly one tool and no tool choice also counts as forcing that tool.
    const single = buildRequestBody({ config, model: "m", messages: [], tools: [TOOL] });
    expect(single.tools).toEqual([TOOL]);
    expect(single.tool_choice).toBe("required");
  });

  it("tools_required mode leaves a request that forces nothing unchanged", () => {
    const other: AITool = {
      type: "function",
      function: { name: "other", description: "Another tool.", parameters: { type: "object" } },
    };
    const required = resolveLLMConfig("chat", { LLM_STRUCTURED_OUTPUT: "tools_required" });
    const plain = resolveLLMConfig("chat", {});
    const opts = { model: "m", messages: [], tools: [other, TOOL], toolChoice: "auto" as const };
    const body = buildRequestBody({ ...opts, config: required });
    expect(body).toEqual(buildRequestBody({ ...opts, config: plain }));
    expect(body.tools).toEqual([other, TOOL]);
    expect(body.tool_choice).toBe("auto");

    const noTools = buildRequestBody({ config: required, model: "m", messages: [] });
    expect(noTools.tools).toBeUndefined();
    expect(noTools.tool_choice).toBeUndefined();
  });

  it("an unknown LLM_STRUCTURED_OUTPUT value falls back to tools", () => {
    expect(resolveLLMConfig("chat", { LLM_STRUCTURED_OUTPUT: "required" }).structuredOutput).toBe(
      "tools",
    );
    expect(resolveLLMConfig("chat", { LLM_STRUCTURED_OUTPUT: "TOOLS_REQUIRED" }).structuredOutput).toBe(
      "tools",
    );
  });

  it("turns a JSON answer in content into the tool-call shape callers read", () => {
    const normalized = normalizeToolCompletion(
      { choices: [{ message: { content: '```json\n{"reply":"Hello"}\n```' } }] },
      "respond",
    );
    const call = normalized.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe("respond");
    expect(JSON.parse(call?.function?.arguments ?? "{}")).toEqual({ reply: "Hello" });
  });

  it("unwraps a function call that Llama wrote as text", () => {
    const normalized = normalizeToolCompletion(
      { choices: [{ message: { content: '{"name":"respond","parameters":{"reply":"Hi"}}' } }] },
      "respond",
    );
    expect(JSON.parse(normalized.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ?? "{}")).toEqual({
      reply: "Hi",
    });
  });

  it("extractJsonObject ignores prose around the object and rejects non-objects", () => {
    expect(extractJsonObject('Sure! {"a": 1} Hope that helps')).toEqual({ a: 1 });
    expect(extractJsonObject("[1,2]")).toBeNull();
    expect(extractJsonObject("no json")).toBeNull();
  });
});

describe("callAI", () => {
  it("posts to {LLM_BASE_URL}/chat/completions with the key and returns the tool arguments", async () => {
    setEnv({ LLM_BASE_URL: "http://llm.test/v1", LLM_API_KEY: "k-123", LLM_MODEL: "test-model", LLM_STRUCTURED_OUTPUT: "json_schema" });
    const fetchMock = vi.fn(async () => completion({ content: '{"reply":"Planned."}' }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callAI({ messages: [{ role: "user", content: "plan" }], tools: [TOOL], toolChoice: FORCE });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://llm.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k-123");
    expect(JSON.parse(String(init.body)).model).toBe("test-model");
    expect(JSON.parse(result.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ?? "{}")).toEqual({
      reply: "Planned.",
    });
  });

  it("does not send an Authorization header to a keyless local provider", async () => {
    setEnv({});
    const fetchMock = vi.fn(async () => completion({ content: "plain text" }));
    vi.stubGlobal("fetch", fetchMock);
    await callAI({ messages: [{ role: "user", content: "hi" }] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("falls back to the second model when the first is unavailable (404)", async () => {
    setEnv({ HUGGINGFACE_API_KEY: "hf_test" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("model not found", { status: 404 }))
      .mockResolvedValueOnce(completion({ content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callAI({ messages: [{ role: "user", content: "hi" }] });
    expect(result.choices?.[0]?.message?.content).toBe("ok");
    const models = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).model);
    expect(models).toEqual(["meta-llama/Llama-3.1-8B-Instruct", "meta-llama/Meta-Llama-3-8B-Instruct"]);
  });

  it("tries the fallback model when the first one hits its rate limit (429)", async () => {
    setEnv({
      LLM_BASE_URL: "https://api.groq.com/openai/v1",
      LLM_API_KEY: "test-key",
      LLM_MODEL: "big-model",
      LLM_FALLBACK_MODEL: "small-model",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"rate limit"}}', { status: 429 }))
      .mockResolvedValueOnce(completion({ content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callAI({ messages: [{ role: "user", content: "hi" }] });
    expect(result.choices?.[0]?.message?.content).toBe("ok");
    const models = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).model);
    expect(models).toEqual(["big-model", "small-model"]);
  });

  it("names the provider in the message when both models are rate limited", async () => {
    setEnv({ LLM_BASE_URL: "https://api.groq.com/openai/v1", LLM_MODEL: "a", LLM_FALLBACK_MODEL: "b" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "Groq rate limit reached. Please wait a moment and try again.",
    );
  });

  it("explains exhausted credits (HTTP 402) and an unreachable provider", async () => {
    setEnv({ HUGGINGFACE_API_KEY: "hf_test", LLM_FALLBACK_MODEL: "none" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("payment required", { status: 402 })));
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "Hugging Face credits exhausted for this token.",
    );

    setEnv({});
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /Could not reach Ollama at http:\/\/localhost:11434\/v1/,
    );
  });

  it("names Node's 5-minute fetch limit instead of claiming the provider is down", async () => {
    // This is what Node's fetch throws when response headers take more than 300 s.
    setEnv({});
    const headersTimeout = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(headersTimeout)));
    const failure = callAI({ messages: [{ role: "user", content: "hi" }] });
    await expect(failure).rejects.toThrow(/Node's 5-minute fetch limit/);
    await expect(failure).rejects.not.toThrow(/Could not reach/);
  });
});

describe("provider errors are sentences, never raw provider JSON", () => {
  it("providerErrorDetail keeps the message inside a JSON error body and drops everything else", () => {
    expect(providerErrorDetail('{"error":{"message":"QA double: model unavailable"}}')).toBe("QA double: model unavailable");
    expect(providerErrorDetail(`{"error":"model 'x' not found"}`)).toBe("model 'x' not found");
    expect(providerErrorDetail('{"detail":[{"msg":"field required"}]}')).toBe("field required");
    expect(providerErrorDetail("Service Unavailable")).toBe("Service Unavailable");
    expect(providerErrorDetail('{"code":503,"retry":true}')).toBe(""); // JSON without a message
    expect(providerErrorDetail("<html><body>502 Bad Gateway</body></html>")).toBe("");
    expect(providerErrorDetail("")).toBe("");
    expect(providerErrorDetail("x".repeat(400)).length).toBeLessThanOrEqual(160);
  });

  it("HTTP 503 and 500 from the model read as 'not available right now' with the provider's message", async () => {
    setEnv({ LLM_BASE_URL: "http://127.0.0.1:55328/v1", LLM_MODEL: "test" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":{"message":"QA double: model unavailable"}}', { status: 503 })),
    );
    const failure = callAI({ messages: [{ role: "user", content: "hi" }] });
    await expect(failure).rejects.toThrow(
      "The AI provider is not available right now (HTTP 503: QA double: model unavailable). Try again in a moment.",
    );
    await expect(failure).rejects.not.toThrow(/[{}"]/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"code":500}}', { status: 500 })));
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /^The AI provider is not available right now \(HTTP 500\)\. Try again in a moment\.$/,
    );
  });

  it("a 400 from Ollama and an answer that is not JSON are sentences too", async () => {
    setEnv({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":{"message":"invalid response_format","type":"invalid_request_error"}}', { status: 400 })),
    );
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "Ollama could not process the request (HTTP 400: invalid response_format).",
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>proxy error</html>", { status: 200 })));
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "Ollama sent an answer that is not valid JSON. Try again in a moment.",
    );
  });
});

describe("providerName", () => {
  it("names a hosted provider from the host of its API URL", () => {
    expect(providerName("https://api.groq.com/openai/v1")).toBe("Groq");
    expect(providerName("https://api.cerebras.ai/v1")).toBe("Cerebras");
    expect(providerName("https://openrouter.ai/api/v1")).toBe("OpenRouter");
    expect(providerName("https://api.openai.com/v1")).toBe("OpenAI");
    expect(providerName("https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1")).toBe(
      "Cloudflare Workers AI",
    );
    expect(providerName("http://localhost:11434/v1")).toBe("Ollama");
  });

  it("does not take a name from the path or from a look-alike host", () => {
    expect(providerName("https://example.org/api.groq.com/v1")).toBe("the AI provider");
    expect(providerName("https://api.groq.com.example.org/v1")).toBe("the AI provider");
  });
});
