import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  REQUEST_FAILED_MESSAGE,
  REQUIRED_SECRETS,
  STARTUP_FAILED_MESSAGE,
  createHandler,
  missingSecrets,
  missingSecretsWarning,
} from "../supabase/functions/lifeops-api/handler.ts";

const PAGES = "https://gopalinternship-unibasel.github.io";
const URL_FN = `https://x.supabase.co/lifeops-api/lifeops-ai/_serverFn/${"a".repeat(64)}`;

describe("function secrets at start-up", () => {
  it("names the missing secrets, blank ones included, in a fixed order", () => {
    const env: Record<string, string | undefined> = { LLM_API_KEY: "  ", LIFEOPS_BACKEND_TOKEN: "t" };
    expect(missingSecrets((name) => env[name])).toEqual(["LLM_BASE_URL", "LLM_API_KEY"]);
    expect(missingSecrets(() => "set")).toEqual([]);
    expect(REQUIRED_SECRETS).toEqual(["LLM_BASE_URL", "LLM_API_KEY", "LIFEOPS_BACKEND_TOKEN"]);
  });

  it("logs one line that says what each missing secret breaks, and nothing when all are set", () => {
    expect(missingSecretsWarning([])).toBeNull();
    const line = missingSecretsWarning(["LLM_BASE_URL", "LIFEOPS_BACKEND_TOKEN"]);
    expect(line).toContain("function secrets not set: LLM_BASE_URL, LIFEOPS_BACKEND_TOKEN");
    expect(line).toContain("assistant is not set up");
    expect(line).toContain('"Plan it" uses the in-app assistant');
    expect(line).toContain("PAGES_DEPLOYMENT.md");
  });

  it("index.ts logs the warning and never sends the start-up error's text to callers", () => {
    const source = readFileSync(new URL("../supabase/functions/lifeops-api/index.ts", import.meta.url), "utf8");
    expect(source).toContain("missingSecretsWarning(missingSecrets(env))");
    expect(source).toContain("new Response(STARTUP_FAILED_MESSAGE");
    expect(source).not.toMatch(/could not start: \$\{/);
    expect(STARTUP_FAILED_MESSAGE).not.toMatch(/lifeops-api|Error|env/i);
  });
});

describe("a failure the server code did not answer itself", () => {
  it("gets a sentence for the visitor with CORS, and the cause goes to the log", async () => {
    const log = vi.fn();
    const handler = createHandler({
      functionName: "lifeops-api",
      appBase: "/lifeops-ai",
      allowedOrigins: new Set([PAGES]),
      loadApp: async () => {
        throw new TypeError("Cannot find module ./server.mjs");
      },
      log,
    });
    const res = await handler(new Request(URL_FN, { method: "POST", headers: { origin: PAGES } }));
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toBe(REQUEST_FAILED_MESSAGE);
    expect(body).not.toContain("server.mjs");
    expect(log).toHaveBeenCalledWith("lifeops-api: request failed", expect.any(TypeError));
  });
});
