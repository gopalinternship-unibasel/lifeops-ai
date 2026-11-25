/**
 * What users read when an AI call fails, and which failures try the fallback model.
 *
 * Both hosted editions call Cloudflare Workers AI; their visitors must never see the model
 * address (it holds the Cloudflare account id), setting names, docker hints or "local model"
 * advice. A local run against a model on this machine keeps the developer wording.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiNotConfiguredError,
  callAI,
  developerWording,
  friendly,
  isLocalBaseUrl,
  normalizeToolCompletion,
  providerErrorDetail,
  providerName,
  resolveLLMConfig,
  type AITool,
} from "@/server/ai/llm.server";

const ACCOUNT = "abc123def456";
const CLOUDFLARE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`;
const cloudflare = { provider: providerName(CLOUDFLARE), baseUrl: CLOUDFLARE, timeoutMs: 40_000 };
const ollama = { provider: "Ollama", baseUrl: "http://localhost:11434/v1", timeoutMs: 120_000 };

/** Developer wording that must never reach a visitor. */
const DEVELOPER_TEXT =
  /LLM_|HUGGINGFACE_|docker|Ollama|local model|localhost|11434|Node's|api\.cloudflare\.com|abc123def456|https?:\/\//;

function timeoutError() {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

function headersTimeout() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
  });
}

/** Every kind of failure friendly() turns into a sentence. */
function failures(): unknown[] {
  return [
    timeoutError(),
    headersTimeout(),
    new TypeError("fetch failed"),
    Object.assign(new Error("x"), { status: 401 }),
    Object.assign(new Error("x"), { status: 403 }),
    Object.assign(new Error("x"), { status: 404 }),
    new RangeError("Invalid time value"),
  ];
}

const TOOL: AITool = {
  type: "function",
  function: {
    name: "respond",
    description: "Reply to the user.",
    parameters: { type: "object", properties: { reply: { type: "string" } } },
  },
};
const FORCE = { type: "function" as const, function: { name: "respond" } };

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

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllEnvs());

describe("which runs get developer wording", () => {
  it("only a local run against a model on this machine", () => {
    expect(isLocalBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalBaseUrl("http://127.0.0.1:55328/v1")).toBe(true);
    expect(isLocalBaseUrl("http://host.docker.internal:11434/v1")).toBe(true);
    expect(isLocalBaseUrl(CLOUDFLARE)).toBe(false);
    expect(isLocalBaseUrl("https://localhost.example.com/v1")).toBe(false);
    expect(developerWording("http://localhost:11434/v1", false)).toBe(true);
    expect(developerWording("http://localhost:11434/v1", true)).toBe(false);
    expect(developerWording(CLOUDFLARE, false)).toBe(false);
  });
});

describe("an unconfigured hosted site is not 'Ollama'", () => {
  it("has a neutral provider label and no address a call could reach", () => {
    const config = resolveLLMConfig("chat", { LLM_MODEL: "@cf/zai-org/glm-4.7-flash" }, true);
    expect(config.configured).toBe(false);
    expect(config.provider).not.toBe("Ollama");
    expect(config.baseUrl).toBe("");
    // A configured hosted site and a local run are unchanged.
    expect(resolveLLMConfig("chat", { LLM_BASE_URL: CLOUDFLARE }, true).provider).toBe(
      "Cloudflare Workers AI",
    );
    expect(resolveLLMConfig("chat", {}, false).provider).toBe("Ollama");
  });
});

describe("friendly() on a hosted site", () => {
  it("never shows developer text, and logs it for the operator", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const error of failures()) {
      const message = friendly(error, cloudflare, true).message;
      expect(message, String(error)).not.toMatch(DEVELOPER_TEXT);
      expect(message.length).toBeGreaterThan(10);
    }
    // Even a local address on a hosted site gets visitor wording (the provider keeps its name).
    for (const error of failures()) {
      expect(friendly(error, ollama, true).message).not.toMatch(
        /LLM_|docker|local model|localhost|11434|Node's/,
      );
    }
    const logged = log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(logged).toContain("LLM_API_KEY");
    expect(logged).toContain("LLM_MODEL");
    expect(logged).toContain("LLM_TIMEOUT_MS");
  });

  it("names the provider and says what to do", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(friendly(new TypeError("fetch failed"), cloudflare, true).message).toBe(
      "Cloudflare Workers AI could not be reached. Please try again in a moment.",
    );
    expect(friendly(timeoutError(), cloudflare, true).message).toBe(
      "Cloudflare Workers AI did not answer within 40 s. Please try again in a moment.",
    );
    expect(friendly(Object.assign(new Error("x"), { status: 401 }), cloudflare, true).message).toBe(
      "The AI assistant is not set up correctly on this site right now. Please try again later.",
    );
  });
});

describe("friendly() on a local run", () => {
  it("keeps the account id out of the message for a hosted provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const message = friendly(new TypeError("fetch failed"), cloudflare, false).message;
    expect(message).toMatch(/Cloudflare Workers AI could not be reached/);
    expect(message).not.toContain(ACCOUNT);
    expect(message).not.toMatch(/docker ps|Is it running/);
    for (const error of failures()) {
      expect(friendly(error, cloudflare, false).message).not.toMatch(DEVELOPER_TEXT);
    }
  });

  it("keeps the developer hints for a model on this machine", () => {
    expect(friendly(new TypeError("fetch failed"), ollama, false).message).toMatch(
      /Could not reach Ollama at http:\/\/localhost:11434\/v1\. Is it running\? \(For local Ollama: docker ps/,
    );
    expect(friendly(timeoutError(), ollama, false).message).toMatch(/raise LLM_TIMEOUT_MS/);
    expect(friendly(Object.assign(new Error("x"), { status: 404 }), ollama, false).message).toMatch(
      /\(LLM_MODEL\)/,
    );
  });
});

describe("callAI on a hosted site", () => {
  it("a timeout reads without setting names or 'local model'", async () => {
    setEnv({ LIFEOPS_HOSTED: "1", LLM_BASE_URL: CLOUDFLARE, LLM_API_KEY: "k", LLM_MODEL: "m" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(timeoutError())),
    );
    const failure = callAI({ messages: [{ role: "user", content: "hi" }] });
    await expect(failure).rejects.toThrow(
      "did not answer within 120 s. Please try again in a moment.",
    );
    await expect(failure).rejects.not.toThrow(DEVELOPER_TEXT);
  });

  it("a missing Hugging Face key is 'not set up', without setting names", async () => {
    setEnv({ LIFEOPS_HOSTED: "1", LLM_BASE_URL: "https://router.huggingface.co/v1" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Cloudflare error answers and the fallback model", () => {
  it("reads the message inside Cloudflare's v4 error envelope", () => {
    expect(
      providerErrorDetail(
        '{"result":null,"success":false,"errors":[{"code":5006,"message":"AiError: bad input"}],"messages":[]}',
      ),
    ).toBe("AiError: bad input");
  });

  for (const status of [500, 502, 504]) {
    it(`tries the fallback model after HTTP ${status}`, async () => {
      setEnv({
        LLM_BASE_URL: "https://example.test/v1",
        LLM_API_KEY: "x",
        LLM_MODEL: "m1",
        LLM_FALLBACK_MODEL: "m2",
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('{"errors":[{"message":"internal"}]}', { status }))
        .mockResolvedValueOnce(ok({ choices: [{ message: { content: "ok" } }] }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await callAI({ messages: [{ role: "user", content: "hi" }] });
      expect(result.choices?.[0]?.message?.content).toBe("ok");
      expect(
        fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).model),
      ).toEqual(["m1", "m2"]);
    });
  }

  it("shows Cloudflare's own reason when both models fail", async () => {
    setEnv({ LLM_BASE_URL: "https://example.test/v1", LLM_MODEL: "m1", LLM_FALLBACK_MODEL: "m2" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"success":false,"errors":[{"message":"internal"}]}', { status: 500 }),
      ),
    );
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "The AI provider is not available right now (HTTP 500: internal). Try again in a moment.",
    );
  });

  it("does not retry a timeout (its time is already spent)", async () => {
    setEnv({ LLM_BASE_URL: "https://example.test/v1", LLM_MODEL: "m1", LLM_FALLBACK_MODEL: "m2" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => Promise.reject(timeoutError()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /did not answer/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("answers the app could not read are not 'could not reach'", () => {
  it("accepts tool-call arguments sent as an object", async () => {
    setEnv({
      LLM_BASE_URL: CLOUDFLARE,
      LLM_API_KEY: "k",
      LLM_MODEL: "m",
      LLM_STRUCTURED_OUTPUT: "tools_required",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: "respond", arguments: { reply: "x" } } }],
              },
            },
          ],
        }),
      ),
    );
    const result = await callAI({
      messages: [{ role: "user", content: "hi" }],
      tools: [TOOL],
      toolChoice: FORCE,
    });
    expect(result.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments).toBe(
      '{"reply":"x"}',
    );
  });

  it("turns object arguments into strings when no tool is forced", async () => {
    setEnv({ LLM_BASE_URL: CLOUDFLARE, LLM_API_KEY: "k", LLM_MODEL: "m" });
    const other: AITool = { ...TOOL, function: { ...TOOL.function, name: "other" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          choices: [
            { message: { tool_calls: [{ function: { name: "other", arguments: { a: 1 } } }] } },
          ],
        }),
      ),
    );
    const result = await callAI({
      messages: [{ role: "user", content: "hi" }],
      tools: [TOOL, other],
      toolChoice: "auto",
    });
    expect(result.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments).toBe('{"a":1}');
  });

  it("tool_calls that are not a list do not break the call (read as an answer without a tool call)", async () => {
    setEnv({ LLM_BASE_URL: CLOUDFLARE, LLM_API_KEY: "k", LLM_MODEL: "m" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({ choices: [{ message: { tool_calls: { function: { arguments: "{}" } } } }] }),
      ),
    );
    const result = await callAI({
      messages: [{ role: "user", content: "hi" }],
      tools: [TOOL],
      toolChoice: FORCE,
    });
    expect(Array.isArray(result.choices?.[0]?.message?.tool_calls)).toBe(false);
  });

  for (const [label, body] of [
    ["a null body", "null"],
    ["a list body", "[1,2]"],
  ] as const) {
    it(`${label} reads "could not read", not "could not be reached"`, async () => {
      setEnv({ LLM_BASE_URL: CLOUDFLARE, LLM_API_KEY: "k", LLM_MODEL: "m" });
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 200 })),
      );
      const failure = callAI({
        messages: [{ role: "user", content: "hi" }],
        tools: [TOOL],
        toolChoice: FORCE,
      });
      await expect(failure).rejects.toThrow(
        "Cloudflare Workers AI sent an answer the app could not read. Try again in a moment.",
      );
      await expect(failure).rejects.not.toThrow(/Could not reach|could not be reached|docker/);
    });
  }

  it("tries the fallback model after an answer it could not read", async () => {
    setEnv({
      LLM_BASE_URL: CLOUDFLARE,
      LLM_API_KEY: "k",
      LLM_MODEL: "m1",
      LLM_FALLBACK_MODEL: "m2",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("null", { status: 200 }))
      .mockResolvedValueOnce(ok({ choices: [{ message: { content: "fine" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callAI({ messages: [{ role: "user", content: "hi" }] });
    expect(result.choices?.[0]?.message?.content).toBe("fine");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a real network failure still reads 'could not be reached'", async () => {
    setEnv({ LLM_BASE_URL: CLOUDFLARE, LLM_API_KEY: "k", LLM_MODEL: "m" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    );
    await expect(callAI({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "Cloudflare Workers AI could not be reached. Please try again in a moment.",
    );
  });

  it("normalizeToolCompletion survives shapes the type does not promise", () => {
    const weird = [
      { choices: "x" },
      { choices: [null] },
      { choices: [{ message: { tool_calls: "x", content: 5 } }] },
      { choices: [{ message: { tool_calls: [null, { function: null }] } }] },
    ];
    for (const completion of weird) {
      expect(() => normalizeToolCompletion(completion as never, "respond")).not.toThrow();
    }
  });
});
