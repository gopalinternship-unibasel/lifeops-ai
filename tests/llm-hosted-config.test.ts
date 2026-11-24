import { afterEach, describe, expect, it, vi } from "vitest";
import { AiNotConfiguredError, callAI, resolveLLMConfig } from "@/server/ai/llm.server";

describe("resolveLLMConfig on a hosted deployment", () => {
  it("is not configured when no provider is set (no localhost Ollama on a hosted site)", () => {
    expect(resolveLLMConfig("chat", {}, true).configured).toBe(false);
    expect(
      resolveLLMConfig("plan", { LLM_MODEL: "@cf/zai-org/glm-4.7-flash" }, true).configured,
    ).toBe(false);
  });

  it("is configured once LLM_BASE_URL (or the legacy Hugging Face key) is set", () => {
    const cloudflare = { LLM_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/x/ai/v1" };
    expect(resolveLLMConfig("chat", cloudflare, true).configured).toBe(true);
    expect(resolveLLMConfig("chat", { HUGGINGFACE_API_KEY: "hf_x" }, true).configured).toBe(true);
  });

  it("keeps the local Ollama default for a local run", () => {
    const local = resolveLLMConfig("chat", {}, false);
    expect(local.configured).toBe(true);
    expect(local.provider).toBe("Ollama");
  });

  it("reads LIFEOPS_HOSTED=1 from the given env when no flag is passed", () => {
    expect(resolveLLMConfig("chat", { LIFEOPS_HOSTED: "1" }).configured).toBe(false);
  });
});

describe("callAI without a provider on a hosted deployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses at once with a visitor-facing message and never calls fetch", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("HUGGINGFACE_API_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const call = callAI({ messages: [{ role: "user", content: "hello" }] });
    await expect(call).rejects.toBeInstanceOf(AiNotConfiguredError);
    await expect(call).rejects.toThrow(/not set up on this site/);
    await expect(call).rejects.not.toThrow(/localhost|11434|docker|LLM_/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
