// The deployment docs quote what visitors and operators see. These checks tie the quotes that
// live in this repository's code to the docs, so a wording change in one shows up in the other.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiNotConfiguredError } from "@/server/ai/llm.server";
import { SERVER_FN_MESSAGES } from "@/lib/server-fn-errors";
import { STARTUP_FAILED_MESSAGE } from "../supabase/functions/lifeops-api/handler.ts";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const pages = read("PAGES_DEPLOYMENT.md");
const vercel = read("VERCEL_DEPLOYMENT.md");
const settings = read("supabase/functions/lifeops-api/settings.env");

/** Sentences of a text, with Markdown line breaks and "#" comment markers joined away. */
function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.replace(/^\s*#\s?/gm, "").replace(/\s+/g, " "))
    .flatMap((block) => block.split(/(?<=[.!?])\s+(?=[A-Z("`])/));
}

describe("PAGES_DEPLOYMENT.md", () => {
  it("quotes the sentences visitors get from this code", () => {
    expect(pages).toContain(new AiNotConfiguredError().message);
    expect(pages).toContain(SERVER_FN_MESSAGES.outdated);
    expect(pages).toContain(SERVER_FN_MESSAGES.slow);
    expect(pages).toContain(SERVER_FN_MESSAGES.unavailable);
    expect(STARTUP_FAILED_MESSAGE).toBe(SERVER_FN_MESSAGES.unavailable);
  });

  it("covers the old local-model error and a missing function secret", () => {
    expect(pages).toContain("Could not reach Ollama at http://localhost:11434/v1");
    const plannerRow = pages.split("\n").find((line) => line.includes("Planner service unavailable") && line.startsWith("| The planner badge"));
    expect(plannerRow).toBeDefined();
    expect(plannerRow).toMatch(/`LIFEOPS_BACKEND_TOKEN` is not set on the function/);
    expect(pages).not.toContain("Server function info not found for ...\", validation errors");
    expect(pages).toContain("(unchanged once the function's `LLM_BASE_URL` and `LLM_API_KEY` are set");
  });

  it("says that the release runs from main for one commit and that removed settings stay set", () => {
    expect(pages).toContain("gh workflow run pages.yml --ref main -f sha=<commit>");
    expect(pages).toMatch(/Deleting a line from `settings.env` does not remove the setting/);
    expect(pages).toContain("`--prune`");
  });
});

describe("the wall clock", () => {
  it("is described as a limit per worker wherever it is mentioned", () => {
    for (const text of [pages, settings]) {
      const mentions = sentences(text).filter((sentence) => /wall clock/i.test(sentence));
      expect(mentions.length).toBeGreaterThan(0);
      for (const sentence of mentions) expect(sentence, sentence).toMatch(/worker/i);
    }
  });
});

/** Every source file under src/, joined (for quotes whose code lives in other modules). */
function sourceText(dir = new URL("../src/", import.meta.url)): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) =>
      entry.isDirectory()
        ? sourceText(new URL(`${entry.name}/`, dir))
        : /\.(ts|tsx)$/.test(entry.name)
          ? readFileSync(new URL(entry.name, dir), "utf8")
          : "",
    )
    .join("\n");
}

/**
 * Sentences and badges the docs quote whose code comes with the dashboard, AI and error-wording
 * changes made alongside this one (src/lib/dashboard-view.ts, src/server/lifeops-backend.server.ts,
 * src/server/ai/llm.server.ts, src/lib/errors.ts). Before those changes are merged the check is
 * skipped; afterwards it fails when a quote and the code no longer agree.
 */
const QUOTED_ELSEWHERE = [
  "Planner service unavailable — in-app assistant",
  "Planner service offline — in-app assistant",
  "AI not set up on this site",
  "The planner service is not set up correctly for this site.",
  "The planner service could not be reached.",
  "The planner service did not answer within",
  "The AI assistant is not set up correctly on this site right now.",
  "Could not reach MONDAY. Check your connection and try again.",
];
const merged = existsSync(new URL("../src/lib/dashboard-view.ts", import.meta.url));

describe("quotes from the code of the other changes", () => {
  it("are in the docs", () => {
    const docs = `${pages}\n${vercel}`;
    for (const quote of QUOTED_ELSEWHERE) expect(docs, quote).toContain(quote);
  });

  it.skipIf(!merged)("match the code once it is merged", () => {
    const source = sourceText();
    for (const quote of QUOTED_ELSEWHERE) expect(source, quote).toContain(quote);
  });
});

describe("VERCEL_DEPLOYMENT.md", () => {
  it("gives the stale windows the code uses", () => {
    expect(vercel).not.toContain("(`LLM_TIMEOUT_MS` plus 2 minutes)");
    expect(vercel).toContain("twice `LLM_TIMEOUT_MS`");
    expect(vercel).toMatch(/360 s, which the app caps at Vercel\s+Hobby's 300 s/);
  });

  it("agrees with the root vercel.json about the region", () => {
    const config = JSON.parse(read("vercel.json")) as { regions?: string[] };
    expect(config.regions).toContain("fra1");
    // Line breaks joined: the old sentence wrapped between "no" and the file name.
    expect(vercel.replace(/\s+/g, " ")).not.toContain("has no `vercel.json`");
  });

  it("no longer says that parallel requests pass the caps or that the planner is 'stopped'", () => {
    expect(vercel).not.toContain("can pass a cap by a few");
    expect(read("RUNNING.md")).not.toContain("can pass a cap by a few");
    expect(vercel).not.toContain("The dashboard says the planner is stopped");
    expect(vercel).toContain(new AiNotConfiguredError().message);
  });
});
