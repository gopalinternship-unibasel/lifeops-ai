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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supabaseExe =
  process.env.SUPABASE_CLI ??
  (existsSync("C:/Users/gopal/tools/supabase/supabase.exe")
    ? "C:/Users/gopal/tools/supabase/supabase.exe"
    : "supabase");

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

/** Update KEY=value lines in place; append keys that are missing. */
function upsertEnvFile(path, updates, { onlyIfMissing = new Set() } = {}) {
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = original ? original.split(/\r?\n/) : [];
  const existing = parseEnv(original);
  const seen = new Set();
  const out = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !(match[1] in updates)) return line;
    const key = match[1];
    seen.add(key);
    if (onlyIfMissing.has(key) && existing.get(key)) return line;
    return `${key}=${updates[key]}`;
  });
  const appended = Object.keys(updates).filter((key) => !seen.has(key));
  if (appended.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    for (const key of appended) out.push(`${key}=${updates[key]}`);
  }
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  writeFileSync(path, text, "utf8");
  return { changed: Object.keys(updates), appended };
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
const existing = existsSync(envLocal) ? parseEnv(readFileSync(envLocal, "utf8")) : new Map();
const keepIfSet = new Set([
  "GOOGLE_OAUTH_STATE_SECRET",
  "VITE_ENABLE_ANONYMOUS_DEMO",
  "VITE_ENABLE_GOOGLE_SIGNIN",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_TIMEOUT_MS",
  "LLM_MAX_TOKENS",
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
    LLM_BASE_URL: "http://localhost:11434/v1",
    LLM_API_KEY: "ollama",
    LLM_MODEL: "llama3.1:8b",
    LLM_TIMEOUT_MS: "900000",
    LLM_MAX_TOKENS: "1200",
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
    LLM_MODEL: "llama3.1:8b",
    LLM_TIMEOUT_SECONDS: "900",
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

console.log("Wrote .env.local and fastapi-backend/.env (values not shown).");
