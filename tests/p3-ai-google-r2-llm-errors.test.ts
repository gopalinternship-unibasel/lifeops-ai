/**
 * Round 2 of the AI error wording (src/server/ai/llm.server.ts).
 *
 * Finding 34: the provider's own error text is shown to users, and Cloudflare's routing error
 * (code 7003) quotes the request path, which holds the account id. Users of a hosted site (and of
 * any hosted provider) must get it without addresses, paths and ids; a local run against a model on
 * this machine keeps the text as it came.
 *
 * Finding 6: HTTP 402 ("credits exhausted for this token") is operator wording; visitors get a
 * plain sentence, the detail goes to the server log.
 *
 * Finding 45 (round-2 review): a hosted site whose LLM_BASE_URL is the Hugging Face router without
 * a key is "not configured", so callers that check that first record no use for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callAI,
  friendly,
  providerErrorDetail,
  providerName,
  resolveLLMConfig,
  visitorDetail,
} from "@/server/ai/llm.server";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CLOUDFLARE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`;
const cloudflare = { provider: providerName(CLOUDFLARE), baseUrl: CLOUDFLARE, timeoutMs: 40_000 };
const ollama = { provider: "Ollama", baseUrl: "http://localhost:11434/v1", timeoutMs: 120_000 };

/** Cloudflare's v4 answer for a request path it cannot route (an account id that is wrong). */
const ROUTING_ERROR = JSON.stringify({
  result: null,
  success: false,
  errors: [
    {
      code: 7003,
      message: `Could not route to /client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions, perhaps your object identifier is invalid?`,
    },
  ],
  messages: [],
});

function setEnv(values: Record<string, string>) {
  for (const key of [
    "LIFEOPS_HOSTED",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_MODEL_CHAT",
    "LLM_FALLBACK_MODEL",
    "LLM_STRUCTURED_OUTPUT",
    "LLM_TIMEOUT_MS",
    "HUGGINGFACE_API_KEY",
  ]) {
    vi.stubEnv(key, values[key] ?? "");
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("the provider's error text without addresses, paths and ids (finding 34)", () => {
  it("Cloudflare's routing error on a hosted site shows no account id or request path", async () => {
    setEnv({
      LIFEOPS_HOSTED: "1",
      LLM_BASE_URL: CLOUDFLARE,
      LLM_API_KEY: "k",
      LLM_MODEL: "@cf/zai-org/glm-4.7-flash",
      LLM_FALLBACK_MODEL: "none",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ROUTING_ERROR, { status: 400 })),
    );
    const failure = callAI({ messages: [{ role: "user", content: "hi" }] });
    await expect(failure).rejects.toThrow(
      "Cloudflare Workers AI could not process the request (HTTP 400: Could not route to …, perhaps your object identifier is invalid?).",
    );
    await expect(failure).rejects.not.toThrow(
      /0123456789abcdef|accounts|client\/v4|chat\/completions/,
    );
    // The operator still finds the whole answer in the server log.
    expect(log.mock.calls.map((call) => call.map(String).join(" ")).join("\n")).toContain(ACCOUNT);
  });

  it("a local run against a hosted provider gets the same text (developer wording needs a local model)", async () => {
    setEnv({
      LLM_BASE_URL: CLOUDFLARE,
      LLM_API_KEY: "k",
      LLM_MODEL: "m",
      LLM_FALLBACK_MODEL: "none",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ROUTING_ERROR, { status: 400 })),
    );
    const failure = callAI({ messages: [{ role: "user", content: "hi" }] });
    await expect(failure).rejects.toThrow("(HTTP 400: Could not route to …, perhaps");
    await expect(failure).rejects.not.toThrow(/0123456789abcdef|accounts/);
  });

  it("every status that shows the detail keeps ids out of it on a hosted site", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [400, 409, 413, 422, 500, 502, 503, 504]) {
      setEnv({
        LIFEOPS_HOSTED: "1",
        LLM_BASE_URL: CLOUDFLARE,
        LLM_API_KEY: "k",
        LLM_MODEL: "m",
        LLM_FALLBACK_MODEL: "none",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(ROUTING_ERROR, { status })),
      );
      const message = await callAI({ messages: [{ role: "user", content: "hi" }] }).then(
        () => "resolved",
        (error: unknown) => String((error as Error).message),
      );
      expect(message, `HTTP ${status}`).toMatch(new RegExp(`HTTP ${status}`));
      expect(message, `HTTP ${status}`).not.toMatch(/0123456789abcdef|accounts|\/client\//);
    }
  });

  it("a local run against a model on this machine keeps the provider's text as it came", async () => {
    setEnv({
      LLM_BASE_URL: "http://127.0.0.1:55328/v1",
      LLM_MODEL: "test",
      LLM_FALLBACK_MODEL: "none",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ROUTING_ERROR, { status: 400 })),
    );
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      `Could not route to /client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`,
    );
  });

  it("visitorDetail removes addresses, paths, uuids, long hex ids and token-like words", () => {
    expect(
      visitorDetail(
        `Could not route to /client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions, perhaps your object identifier is invalid?`,
      ),
    ).toBe("Could not route to …, perhaps your object identifier is invalid?");
    expect(visitorDetail(`Unknown endpoint ${CLOUDFLARE}/chat/completions`)).toBe(
      "Unknown endpoint …",
    );
    expect(visitorDetail(`No such account: accounts/${ACCOUNT}`)).toBe("No such account: …");
    expect(visitorDetail(`account ${ACCOUNT} is disabled`)).toBe("account … is disabled");
    expect(visitorDetail("request 123e4567-e89b-12d3-a456-426614174000 failed")).toBe(
      "request … failed",
    );
    expect(visitorDetail("bad key abcDEF123456ghiJKL789012mnoP")).toBe("bad key …");
    // Nothing readable left: no detail at all.
    expect(visitorDetail(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`)).toBe("");
    expect(visitorDetail("")).toBe("");
  });

  it("visitorDetail keeps ordinary provider messages, model names included", () => {
    for (const text of [
      "AiError: bad input",
      "internal",
      "invalid response_format",
      "model @cf/google/gemma-4-26b-a4b-it is not available",
      "Input too long: 9000 tokens and/or 3 images (max 8192)",
      "upstream answered HTTP/1.1 502",
      "Capacity temporarily exceeded, please try again.",
    ]) {
      expect(visitorDetail(text)).toBe(text);
    }
  });

  it("an id cut by the length limit leaves no part of itself", () => {
    // providerErrorDetail cuts at 160 characters; here the cut falls inside the account id.
    const body = JSON.stringify({
      errors: [{ message: `${"x ".repeat(70)}account ${ACCOUNT} gone` }],
    });
    const detail = providerErrorDetail(body);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail).toContain(ACCOUNT.slice(0, 8));
    const shown = visitorDetail(detail);
    expect(shown).not.toMatch(/0123|[0-9a-f]{6,}/);
    expect(shown.endsWith("account …")).toBe(true);
  });
});

describe("HTTP 402 in plain words (finding 6)", () => {
  it("visitors of a hosted site read a sentence without 'token'; the log keeps the detail", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = friendly(
      Object.assign(new Error("x"), { status: 402 }),
      cloudflare,
      true,
    ).message;
    expect(message).toBe(
      "The AI assistant has used up its allowance for now. Please try again later.",
    );
    expect(message).not.toMatch(/token|credits|Cloudflare|HTTP/);
    expect(log.mock.calls.map((call) => call.map(String).join(" ")).join("\n")).toMatch(
      /Cloudflare Workers AI answered HTTP 402: the API token's credits are used up/,
    );
  });

  it("the same through callAI on a hosted site", async () => {
    setEnv({ LIFEOPS_HOSTED: "1", LLM_BASE_URL: CLOUDFLARE, LLM_API_KEY: "k", LLM_MODEL: "m" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("payment required", { status: 402 })),
    );
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "The AI assistant has used up its allowance for now. Please try again later.",
    );
  });

  it("a local run against a model on this machine keeps the token wording", () => {
    expect(friendly(Object.assign(new Error("x"), { status: 402 }), ollama, false).message).toBe(
      "Ollama credits exhausted for this token.",
    );
  });
});

describe("a provider's own trailing '…' (finding 34, round-2 review)", () => {
  it("a short text the provider ended with '…' keeps its last word", () => {
    expect(visitorDetail("Model is loading…")).toBe("Model is loading…");
    expect(visitorDetail("Request queued, retrying…")).toBe("Request queued, retrying…");
  });

  it("a text cut at the length limit still loses the cut word", () => {
    const detail = providerErrorDetail(`${"word ".repeat(31)}abcdefghij more`);
    expect(detail).toHaveLength(160);
    expect(detail.endsWith("…")).toBe(true);
    expect(visitorDetail(detail).endsWith("word …")).toBe(true);
  });
});

describe("the Hugging Face router without a key on a hosted site (finding 45, round-2 review)", () => {
  // Callers check `configured` before they record a use (enforceAiAllowance), so a provider that
  // callAI would refuse without sending must not count as configured.
  it("is not configured, so no caller records a use for a request that is never sent", () => {
    const hf = { LLM_BASE_URL: "https://router.huggingface.co/v1" };
    expect(resolveLLMConfig("draft", hf, true)).toMatchObject({
      configured: false,
      provider: "the AI provider",
      baseUrl: "",
    });
    expect(resolveLLMConfig("chat", hf, true).configured).toBe(false);
    expect(resolveLLMConfig("plan", hf, true).configured).toBe(false);
    expect(
      resolveLLMConfig("chat", { LLM_BASE_URL: "https://api-inference.huggingface.co/v1" }, true)
        .configured,
    ).toBe(false);
  });

  it("is configured with a key, or on a local run (which still names the missing setting)", () => {
    const hf = { LLM_BASE_URL: "https://router.huggingface.co/v1" };
    expect(resolveLLMConfig("chat", { ...hf, LLM_API_KEY: "k" }, true).configured).toBe(true);
    expect(resolveLLMConfig("chat", { ...hf, HUGGINGFACE_API_KEY: "hf_x" }, true).configured).toBe(
      true,
    );
    expect(resolveLLMConfig("chat", { HUGGINGFACE_API_KEY: "hf_x" }, true).configured).toBe(true);
    expect(resolveLLMConfig("chat", hf, false)).toMatchObject({
      configured: true,
      provider: "Hugging Face",
    });
    // Other hosted providers without a key are left to the provider's own answer, as before.
    expect(
      resolveLLMConfig("chat", { LLM_BASE_URL: "https://api.example.test/v1" }, true).configured,
    ).toBe(true);
  });

  it("callAI on such a hosted site refuses with the visitor sentence and sends nothing", async () => {
    setEnv({ LIFEOPS_HOSTED: "1", LLM_BASE_URL: "https://router.huggingface.co/v1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "The AI assistant is not set up on this site yet, so this request could not be answered.",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toMatch(
      /Hugging Face router without HUGGINGFACE_API_KEY or LLM_API_KEY/,
    );
  });
});
