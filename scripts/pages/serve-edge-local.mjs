#!/usr/bin/env node
/**
 * Run the "lifeops-api" Edge Function locally under Deno 2.1.4 (the Deno version of Supabase's edge
 * runtime), without Docker. Deno comes from the official npm package through npx; nothing is
 * installed globally. See PAGES_DEPLOYMENT.md.
 *
 *   node scripts/pages/serve-edge-local.mjs        listens on http://localhost:8000/lifeops-api
 *
 * Environment passed to the function (public values only by default):
 *   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY   the app's Supabase project (public values)
 *   LIFEOPS_ALLOWED_ORIGINS                  default https://gopalinternship-unibasel.github.io
 * Like on Supabase, the publishable key is also offered as SUPABASE_PUBLISHABLE_KEYS (JSON) so the
 * function's key mapping is exercised. Server functions that need the secret key or the AI key fail
 * locally unless those are set in your own shell.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = path.join(root, "supabase", "functions", "lifeops-api", "index.ts");
try {
  await stat(path.join(root, "supabase", "functions", "lifeops-api", "server.mjs"));
} catch {
  console.error("serve-edge-local: run `npm run build:pages` first (server.mjs is missing)");
  process.exit(1);
}

const env = { ...process.env };
if (env.SUPABASE_PUBLISHABLE_KEY && !env.SUPABASE_PUBLISHABLE_KEYS) {
  env.SUPABASE_PUBLISHABLE_KEYS = JSON.stringify({ default: env.SUPABASE_PUBLISHABLE_KEY });
  delete env.SUPABASE_PUBLISHABLE_KEY;
}
env.LIFEOPS_ALLOWED_ORIGINS ??= "https://gopalinternship-unibasel.github.io";

// Supabase routes /functions/v1/<name>/... to the function as /<name>/...; Deno.serve sees the
// local URL as it is, so call http://localhost:8000/lifeops-api/...
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(
  npx,
  ["-y", "deno@2.1.4", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "--no-prompt", entry],
  { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
