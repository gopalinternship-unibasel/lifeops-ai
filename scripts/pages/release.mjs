#!/usr/bin/env node
/**
 * Release the GitHub Pages edition from one commit of main: the Edge Function and the Pages site
 * together. See PAGES_DEPLOYMENT.md.
 *
 *   npm run release:pages
 *   npm run release:pages -- --skip-ci-check            do not require a passed CI run
 *   npm run release:pages -- --allow-missing-secrets    passed on to deploy-function.mjs
 *   npm run release:pages -- --prune                    passed on to deploy-function.mjs
 *   npm run release:pages -- --no-wait                  start the Pages workflow and do not wait for it
 *
 * 1. Checks that the working tree is clean, the branch is main (GitHub Pages publishes from main
 *    only, so a release from another branch would deploy its server code and then fail to publish
 *    the site), the commit is pushed and CI passed for it.
 * 2. Builds and deploys the function with its settings (scripts/pages/deploy-function.mjs, which
 *    also checks the function's secrets), then runs the smoke test against it as a new demo user,
 *    which fails while the function cannot use the planner or has no AI provider set up (it makes
 *    no AI call, so a wrong AI key shows only with smoke-edge.mjs --chat).
 * 3. Starts the Pages workflow for exactly that commit (input `sha`), waits for it and fails when
 *    it fails, because the function and the site are then out of step.
 *
 * The public build values come from the environment or else from the repository variables
 * SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (read with gh). Needs git, gh and the Supabase CLI.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { StepError, isMainModule, processIo, runScript } from "./process.mjs";

const PREFIX = "release:pages";
/** Flags release:pages hands on to deploy-function.mjs. */
const DEPLOY_FLAGS = ["--allow-missing-secrets", "--prune"];

/** Why a release from `branch` is refused, or null for main. */
export function releaseBlocker(branch) {
  if (branch === "main") return null;
  // `git rev-parse --abbrev-ref HEAD` prints "HEAD" when no branch is checked out.
  const where = !branch || branch === "HEAD" ? "a detached HEAD" : branch;
  return `release from main (this is ${where}). GitHub Pages publishes only from main, so a release from another branch would deploy its server code to the function and then fail to publish the site. To try a branch's server code, use npm run deploy:pages-function.`;
}

/** The run `gh workflow run` names in its output (".../actions/runs/<id>"; newer gh prints it), if any. */
export function runFromOutput(output) {
  const match = /(\S*\/actions\/runs\/(\d+))/.exec(String(output ?? ""));
  return match ? { databaseId: Number(match[2]), url: match[1] } : null;
}

/** The newest run in `after` that was not in `before` (lists from `gh run list --json databaseId,...`). */
export function findNewRun(before, after) {
  const known = new Set(before.map((run) => run.databaseId));
  return after.find((run) => !known.has(run.databaseId)) ?? null;
}

export async function release({ io, argv, root, env = process.env }) {
  const has = (flag) => argv.includes(flag);
  const out = (command, args) => {
    const res = io.capture(command, args);
    if (res.status !== 0) throw new StepError(`${command} ${args.join(" ")} failed\n${res.stderr}`);
    return res.stdout.trim();
  };
  const step = (label, command, args, stepEnv) => {
    io.log(`${PREFIX}: ${label}`);
    const status = io.run(command, args, stepEnv);
    if (status !== 0) throw new StepError(`${label} failed`, status || 1);
  };

  // 1. One commit of main, pushed and tested
  if (out("git", ["status", "--porcelain"])) throw new StepError("the working tree has changes; commit or stash them first");
  const branch = out("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const blocker = releaseBlocker(branch);
  if (blocker) throw new StepError(blocker);
  const sha = out("git", ["rev-parse", "HEAD"]);
  const short = sha.slice(0, 7);
  out("git", ["fetch", "--quiet", "origin", branch]);
  if (out("git", ["rev-parse", `origin/${branch}`]) !== sha) throw new StepError(`HEAD ${short} is not the pushed origin/${branch}; push first`);
  if (!has("--skip-ci-check")) {
    const runs = JSON.parse(out("gh", ["run", "list", "--workflow", "ci.yml", "--commit", sha, "--json", "status,conclusion,url", "--limit", "5"]));
    const passed = runs.some((r) => r.status === "completed" && r.conclusion === "success");
    if (!passed) {
      const state = runs.map((r) => `${r.status}/${r.conclusion || "-"}`).join(", ") || "no run";
      throw new StepError(`CI has not passed for ${short} (${state}); wait for it or use --skip-ci-check`);
    }
  }

  // 2. Function
  const repoVar = (name) => out("gh", ["variable", "get", name]);
  const supabaseUrl = (env.VITE_SUPABASE_URL || repoVar("SUPABASE_URL")).replace(/\/+$/, "");
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || repoVar("SUPABASE_PUBLISHABLE_KEY");
  const buildEnv = {
    VITE_SUPABASE_URL: supabaseUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    VITE_SERVER_FN_ORIGIN: env.VITE_SERVER_FN_ORIGIN || `${supabaseUrl}/functions/v1/lifeops-api`,
  };
  step(
    "build and deploy the function",
    process.execPath,
    [path.join(root, "scripts", "pages", "deploy-function.mjs"), ...DEPLOY_FLAGS.filter(has)],
    buildEnv,
  );
  // As a new anonymous demo user: real server functions, including the planner and AI checks.
  try {
    step(
      "smoke test of the deployed function",
      process.execPath,
      [path.join(root, "scripts", "pages", "smoke-edge.mjs"), "--url", buildEnv.VITE_SERVER_FN_ORIGIN, "--demo-user"],
      { SUPABASE_URL: supabaseUrl, SUPABASE_PUBLISHABLE_KEY: publishableKey },
    );
  } catch (error) {
    if (!(error instanceof StepError)) throw error;
    // The function is already deployed at this point; the site was not started.
    throw new StepError(
      `${error.message}. The function already runs ${short}, but the Pages site was not published, so the site still has the previous build. Fix what the smoke test reports (PAGES_DEPLOYMENT.md, "Common errors"), then run npm run release:pages again from main, or publish this commit with: gh workflow run pages.yml --ref main -f sha=${sha}`,
      error.exitCode,
    );
  }

  // 3. Pages site, built from this exact commit
  const listRuns = () =>
    JSON.parse(
      out("gh", ["run", "list", "--workflow", "pages.yml", "--branch", "main", "--event", "workflow_dispatch", "--limit", "20", "--json", "databaseId,url,status,conclusion"]),
    );
  const before = listRuns();
  const dispatchArgs = ["workflow", "run", "pages.yml", "--ref", "main", "-f", `sha=${sha}`];
  const started = io.capture("gh", dispatchArgs);
  if (started.status !== 0) throw new StepError(`gh ${dispatchArgs.join(" ")} failed\n${started.stderr}`);
  if (has("--no-wait")) {
    io.log(`${PREFIX}: Pages workflow started for ${short}. Follow it with: gh run watch`);
    return;
  }
  // gh prints the new run's address on one of its outputs when it knows it.
  let run = runFromOutput(`${started.stdout}\n${started.stderr}`);
  for (let attempt = 0; !run && attempt < 20; attempt++) {
    await io.sleep(3000);
    run = findNewRun(before, listRuns());
  }
  if (!run) {
    throw new StepError(
      `the Pages workflow was started for ${short}, but its run did not show up within a minute. Check it with: gh run list --workflow pages.yml. The function already runs ${short}.`,
    );
  }
  const runId = run.databaseId;
  const runUrl = run.url || `run ${runId}`;
  io.log(`${PREFIX}: Pages workflow ${runUrl} is building ${short}; waiting for it`);
  const watched = io.run("gh", ["run", "watch", String(runId), "--exit-status"]);
  if (watched !== 0) {
    throw new StepError(
      `the Pages workflow failed (${runUrl}). The function already runs ${short}, so the site and the function are out of step until the workflow passes: fix the cause, then re-run it with gh run rerun ${runId}, or run npm run release:pages again from main.`,
    );
  }
  io.log(`${PREFIX}: done. The function and the Pages site both run ${short}.`);
}

if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  await runScript(PREFIX, () => release({ io: processIo(root), argv: process.argv.slice(2), root }));
}
