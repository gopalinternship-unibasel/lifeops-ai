#!/usr/bin/env node
/**
 * Deploy the "lifeops-api" Edge Function (the server side of the GitHub Pages build) with its
 * non-secret settings. See PAGES_DEPLOYMENT.md; `npm run release:pages` runs this and then publishes
 * the Pages site from the same commit.
 *
 *   npm run deploy:pages-function                 build, apply settings.env, deploy
 *   npm run deploy:pages-function -- --skip-build use the existing server.mjs
 *
 * Needs the Supabase CLI signed in (SUPABASE_CLI may point to supabase.exe; otherwise `supabase` on
 * the PATH or %USERPROFILE%\tools\supabase\supabase.exe), and for the build the same VITE_ values as
 * `npm run build:pages`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ref = process.env.SUPABASE_PROJECT_REF ?? "tqgbgpchxbzzuofxjdaj";
const skipBuild = process.argv.includes("--skip-build");

function findCli() {
  if (process.env.SUPABASE_CLI) return process.env.SUPABASE_CLI;
  const onPath = spawnSync("supabase", ["--version"], { stdio: "ignore", shell: false });
  if (!onPath.error && onPath.status === 0) return "supabase";
  const local = path.join(homedir(), "tools", "supabase", process.platform === "win32" ? "supabase.exe" : "supabase");
  if (existsSync(local)) return local;
  console.error("deploy:pages-function: Supabase CLI not found; set SUPABASE_CLI to its path");
  process.exit(1);
}

function run(command, args, label) {
  console.log(`deploy:pages-function: ${label}`);
  const res = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    console.error(`deploy:pages-function: ${label} failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

const cli = findCli();
if (!skipBuild) run(process.execPath, [path.join(root, "scripts", "pages", "build.mjs")], "build (client files and function bundle)");

// Settings first, so the demo limits are in place before the function answers.
run(
  cli,
  ["secrets", "set", "--env-file", path.join("supabase", "functions", "lifeops-api", "settings.env"), `--remote=${ref}`, "--yes"],
  "apply supabase/functions/lifeops-api/settings.env",
);
// --use-api: bundled by Supabase, no Docker needed (5 MB limit; the bundle is about 1.6 MB).
run(
  cli,
  ["functions", "deploy", "lifeops-api", `--remote=${ref}`, "--no-verify-jwt", "--use-api", "--yes"],
  "supabase functions deploy lifeops-api",
);
console.log(`deploy:pages-function: done. Function URL: https://${ref}.supabase.co/functions/v1/lifeops-api`);
