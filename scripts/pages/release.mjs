#!/usr/bin/env node
/**
 * Release the GitHub Pages edition from one commit: the Edge Function and the Pages site together.
 * See PAGES_DEPLOYMENT.md.
 *
 *   npm run release:pages
 *
 * 1. Checks that the working tree is clean, the commit is pushed to GitHub and CI passed for it
 *    (--skip-ci-check skips the last check).
 * 2. Builds and deploys the function with its settings (scripts/pages/deploy-function.mjs), then
 *    runs the smoke test against it.
 * 3. Starts the Pages workflow for the same branch, which publishes the browser files of that commit.
 *
 * The public build values come from the environment or else from the repository variables
 * SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (read with gh). Needs git, gh and the Supabase CLI.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const skipCi = process.argv.includes("--skip-ci-check");

function out(command, args) {
  const res = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: false });
  if (res.error || res.status !== 0) {
    console.error(`release:pages: ${command} ${args.join(" ")} failed\n${res.stderr ?? res.error}`);
    process.exit(1);
  }
  return res.stdout.trim();
}
function step(label, command, args, env) {
  console.log(`release:pages: ${label}`);
  const res = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false, env: { ...process.env, ...env } });
  if (res.error || res.status !== 0) {
    console.error(`release:pages: ${label} failed`);
    process.exit(res.status ?? 1);
  }
}
function fail(message) {
  console.error(`release:pages: ${message}`);
  process.exit(1);
}

// 1. Same commit everywhere
if (out("git", ["status", "--porcelain"])) fail("the working tree has changes; commit or stash them first");
const branch = out("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const sha = out("git", ["rev-parse", "HEAD"]);
out("git", ["fetch", "--quiet", "origin", branch]);
if (out("git", ["rev-parse", `origin/${branch}`]) !== sha) fail(`HEAD ${sha.slice(0, 7)} is not the pushed origin/${branch}; push first`);
if (!skipCi) {
  const runs = JSON.parse(out("gh", ["run", "list", "--workflow", "ci.yml", "--commit", sha, "--json", "status,conclusion,url", "--limit", "5"]));
  const passed = runs.some((r) => r.status === "completed" && r.conclusion === "success");
  if (!passed) {
    const state = runs.map((r) => `${r.status}/${r.conclusion || "-"}`).join(", ") || "no run";
    fail(`CI has not passed for ${sha.slice(0, 7)} (${state}); wait for it or use --skip-ci-check`);
  }
}

// 2. Function
const repoVar = (name) => out("gh", ["variable", "get", name]);
const supabaseUrl = (process.env.VITE_SUPABASE_URL || repoVar("SUPABASE_URL")).replace(/\/+$/, "");
const env = {
  VITE_SUPABASE_URL: supabaseUrl,
  VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY || repoVar("SUPABASE_PUBLISHABLE_KEY"),
  VITE_SERVER_FN_ORIGIN: process.env.VITE_SERVER_FN_ORIGIN || `${supabaseUrl}/functions/v1/lifeops-api`,
};
step("build and deploy the function", process.execPath, [path.join(root, "scripts", "pages", "deploy-function.mjs")], env);
step("smoke test of the deployed function", process.execPath, [
  path.join(root, "scripts", "pages", "smoke-edge.mjs"),
  "--url",
  env.VITE_SERVER_FN_ORIGIN,
]);

// 3. Pages site
out("gh", ["workflow", "run", "pages.yml", "--ref", branch]);
console.log(`release:pages: Pages workflow started for ${branch} (${sha.slice(0, 7)}). Follow it with: gh run watch`);
