#!/usr/bin/env node
// Writes the local-development values into .env.local (gitignored) without printing secrets.
//
// - Reads URLs and keys of the LOCAL Supabase stack from `supabase status -o env`.
// - Generates GOOGLE_OAUTH_STATE_SECRET once (kept on later runs).
// - Adds local AI-provider defaults (Ollama, OpenAI-compatible) only when they are missing.
// - Writes fastapi-backend/.env with the same AI-provider defaults when it is missing values.
// Every other line already in .env.local is preserved, so hand-made changes survive.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, readEnvText, upsertEnvFile } from "./env-file.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supabaseExe =
  process.env.SUPABASE_CLI ??
  (existsSync(join(homedir(), "tools", "supabase", "supabase.exe"))
    ? join(homedir(), "tools", "supabase", "supabase.exe")
    : "supabase");

// Optional changes on the command line (written without a BOM, unlike PowerShell 5.1):
//   --model <name>           LLM_MODEL in .env.local AND fastapi-backend/.env
//   --set KEY=VALUE          any key in .env.local (repeatable)
//   --backend-set KEY=VALUE  any key in fastapi-backend/.env (repeatable)
// Qwen 2.5 7B with 4 CPU threads and an 8192-token context (ollama/qwen2.5-7b-4threads.Modelfile).
// Chosen on correctness (RUNNING.md, "The AI model"): replaying MONDAY's real briefing, move and
// planner requests it answered 6 of 6 correctly, Qwen 2.5 3B none (9 Nov 2026). 4 threads: this
// 8-core PC has 4 low-power cores, and all 8 threads made llama.cpp about ten times slower.
const LOCAL_DEFAULT_MODEL = "qwen2.5-7b-4threads";
// A 7B answer takes 2-7 minutes here when the shared Ollama is free and several times that when
// other work uses it; pages wait safely (reloads lose nothing), so give a request 30 minutes.
const LOCAL_TIMEOUT_SECONDS = 1800;

const frontendOverrides = {};
const backendOverrides = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = args[i + 1];
  if (flag === "--model" && value) {
    frontendOverrides.LLM_MODEL = value;
    backendOverrides.LLM_MODEL = value;
    i++;
  } else if ((flag === "--set" || flag === "--backend-set") && value && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
    const eq = value.indexOf("=");
    (flag === "--set" ? frontendOverrides : backendOverrides)[value.slice(0, eq)] = value.slice(eq + 1);
    i++;
  } else {
    console.error(`Unknown or incomplete option: ${flag}`);
    console.error("Usage: node scripts/write-local-env.mjs [--model NAME] [--set KEY=VALUE]... [--backend-set KEY=VALUE]...");
    process.exit(2);
  }
}

let statusText;
try {
  statusText = execFileSync(supabaseExe, ["status", "-o", "env"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  console.error("Could not read `supabase status`. Start the local stack first (supabase start).");
  process.exit(1);
}
const status = parseEnv(statusText);
const apiUrl = status.get("API_URL");
const publishable = status.get("PUBLISHABLE_KEY") || status.get("ANON_KEY");
const secret = status.get("SECRET_KEY") || status.get("SERVICE_ROLE_KEY");
if (!apiUrl || !publishable || !secret) {
  console.error("`supabase status` did not return API_URL and keys. Is the stack running?");
  process.exit(1);
}

const envLocal = join(root, ".env.local");
const existing = parseEnv(readEnvText(envLocal));
const keepIfSet = new Set([
  "GOOGLE_OAUTH_STATE_SECRET",
  "VITE_ENABLE_ANONYMOUS_DEMO",
  "VITE_ENABLE_GOOGLE_SIGNIN",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_TIMEOUT_MS",
  "LLM_MAX_TOKENS",
  "LLM_MAX_TOKENS_PLAN",
  "LLM_STRUCTURED_OUTPUT",
  "LIFEOPS_BACKEND_URL",
  "LIFEOPS_BACKEND_TOKEN",
]);
const backendToken = existing.get("LIFEOPS_BACKEND_TOKEN") || randomBytes(24).toString("base64url");
upsertEnvFile(
  envLocal,
  {
    VITE_SUPABASE_URL: apiUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: publishable,
    VITE_ENABLE_ANONYMOUS_DEMO: "true",
    VITE_ENABLE_GOOGLE_SIGNIN: "false",
    SUPABASE_URL: apiUrl,
    SUPABASE_PUBLISHABLE_KEY: publishable,
    SUPABASE_SECRET_KEY: secret,
    GOOGLE_OAUTH_STATE_SECRET: randomBytes(48).toString("base64url"),
    // Local, free, OpenAI-compatible model served by Ollama. See RUNNING.md to switch providers.
    // The intended model is Llama 3.1 8B (llama3.1:8b here, meta-llama/Llama-3.1-8B-Instruct on
    // Hugging Face). The local default is Qwen 2.5 7B (4 threads, see above), which answered
    // MONDAY's requests correctly on this CPU where Llama 3.1 8B and Qwen 2.5 3B did not; switch
    // with --model llama3.1:8b (or a hosted provider, see RUNNING.md).
    LLM_BASE_URL: "http://localhost:11434/v1",
    LLM_API_KEY: "ollama",
    LLM_MODEL: LOCAL_DEFAULT_MODEL,
    LLM_TIMEOUT_MS: String(LOCAL_TIMEOUT_SECONDS * 1000),
    LLM_MAX_TOKENS: "1200",
    // A 7-day plan is longer than a chat answer; 1500 prompt + 2400 answer tokens fit the
    // model's 8192-token context (and Ollama's default of 4096 for other models).
    LLM_MAX_TOKENS_PLAN: "2400",
    LLM_STRUCTURED_OUTPUT: "json_schema",
    LIFEOPS_BACKEND_URL: "http://127.0.0.1:8010",
    LIFEOPS_BACKEND_TOKEN: backendToken,
  },
  { onlyIfMissing: keepIfSet },
);

const backendEnv = join(root, "fastapi-backend", ".env");
upsertEnvFile(
  backendEnv,
  {
    FRONTEND_ORIGIN: "http://localhost:5190",
    DATABASE_URL: "sqlite:///./lifeops.db",
    ENV: "local",
    LLM_BASE_URL: "http://localhost:11434/v1",
    LLM_API_KEY: "ollama",
    LLM_MODEL: LOCAL_DEFAULT_MODEL,
    LLM_TIMEOUT_SECONDS: String(LOCAL_TIMEOUT_SECONDS),
    LLM_MAX_TOKENS: "1200",
    LIFEOPS_BACKEND_TOKEN: backendToken,
  },
  {
    onlyIfMissing: new Set([
      "FRONTEND_ORIGIN",
      "DATABASE_URL",
      "ENV",
      "LLM_BASE_URL",
      "LLM_API_KEY",
      "LLM_MODEL",
      "LLM_TIMEOUT_SECONDS",
      "LLM_MAX_TOKENS",
    ]),
  },
);

// Explicit command-line changes win over everything above.
if (Object.keys(frontendOverrides).length > 0) upsertEnvFile(envLocal, frontendOverrides);
if (Object.keys(backendOverrides).length > 0) upsertEnvFile(backendEnv, backendOverrides);
const changed = [...new Set([...Object.keys(frontendOverrides), ...Object.keys(backendOverrides)])];

console.log(
  `Wrote .env.local and fastapi-backend/.env (values not shown)${changed.length ? `; set ${changed.join(", ")}` : ""}.`,
);
