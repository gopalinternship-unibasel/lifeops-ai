#!/usr/bin/env node
/**
 * Deploy the "lifeops-api" Edge Function (the server side of the GitHub Pages build) with its
 * non-secret settings. See PAGES_DEPLOYMENT.md; `npm run release:pages` runs this and then publishes
 * the Pages site from the same commit.
 *
 *   npm run deploy:pages-function                                build, apply settings.env, deploy
 *   npm run deploy:pages-function -- --skip-build                use the existing server.mjs
 *   npm run deploy:pages-function -- --allow-missing-secrets     deploy without the three secrets
 *   npm run deploy:pages-function -- --prune=NAME,NAME           also unset these settings removed from settings.env
 *
 * 1. Warns when the working tree has changes or the branch is not main (release:pages refuses both).
 * 2. Lists the project's secrets (names only) and stops when LLM_BASE_URL, LLM_API_KEY or
 *    LIFEOPS_BACKEND_TOKEN is missing: settings.env never holds them, and without them visitors get
 *    no AI answers and "Plan it" cannot use the planner. Also stops when --prune names anything but
 *    a project secret that settings.env no longer lists, or names nothing.
 * 3. Builds, then applies settings.env (`supabase secrets set --env-file`, which adds and overwrites
 *    names but never removes one).
 * 4. Names the project secrets that settings.env no longer lists: they keep their last value until
 *    they are unset. --prune=NAME,NAME unsets the ones named. Secrets belong to the whole project,
 *    so a secret of another function would be listed too; that is why the names must be written
 *    out. The three secrets and Supabase's own names are never unset.
 * 5. Deploys the function.
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
import { readEnvText } from "../env-file.mjs";
import { StepError, isMainModule, processIo, runScript } from "./process.mjs";
import {
  isPruneFlag,
  missingRequiredSecrets,
  pruneRequest,
  secretListError,
  secretNamesFromList,
  staleSettingNames,
} from "./secrets.mjs";

const PREFIX = "deploy:pages-function";
const SETTINGS_FILE = path.join("supabase", "functions", "lifeops-api", "settings.env");

export function findCli(env = process.env) {
  if (env.SUPABASE_CLI) return env.SUPABASE_CLI;
  const onPath = spawnSync("supabase", ["--version"], { stdio: "ignore", shell: false });
  if (!onPath.error && onPath.status === 0) return "supabase";
  const local = path.join(homedir(), "tools", "supabase", process.platform === "win32" ? "supabase.exe" : "supabase");
  if (existsSync(local)) return local;
  throw new StepError("Supabase CLI not found; set SUPABASE_CLI to its path");
}

/**
 * The project's secret names (never values), or the CLI's error. JSON output is asked for first;
 * a CLI that does not know the flag gets the plain list (its text table). An answer that is an
 * error in JSON counts as a failure even with exit status 0, so it is never read as "no secrets".
 */
export function listSecretNames(io, cli, ref) {
  let last;
  for (const extra of [["--output-format", "json"], []]) {
    const res = io.capture(cli, ["secrets", "list", `--remote=${ref}`, ...extra]);
    const reported = secretListError(res.stdout);
    if (res.status === 0 && reported === null) return { names: secretNamesFromList(res.stdout) };
    last = reported === null ? res : { ...res, stderr: `${res.stderr ?? ""}\n${reported}`, stdout: "" };
  }
  const detail = `${last?.stderr ?? ""}\n${last?.stdout ?? ""}`.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
  return { error: detail || "the CLI gave no reason" };
}

export async function deployFunction({ io, argv, root, ref, cli }) {
  const has = (flag) => argv.includes(flag);
  const allowMissing = has("--allow-missing-secrets");
  const step = (label, command, args) => {
    io.log(`${PREFIX}: ${label}`);
    const status = io.run(command, args);
    if (status !== 0) throw new StepError(`${label} failed (exit ${status})`, status || 1);
  };

  // 1. What is being deployed
  const branch = io.capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status === 0 && branch.stdout.trim() && branch.stdout.trim() !== "main") {
    io.warn(
      `${PREFIX}: warning: deploying from ${branch.stdout.trim()}, not main. The Pages site is published from main only, so the site and the function can now differ; npm run release:pages from main brings them together again.`,
    );
  }
  const changes = io.capture("git", ["status", "--porcelain"]);
  if (changes.status === 0 && changes.stdout.trim()) {
    io.warn(`${PREFIX}: warning: the working tree has uncommitted changes, and they are deployed too.`);
  }

  // 2. The secrets settings.env does not hold
  io.log(`${PREFIX}: check the function secrets of project ${ref} (names only)`);
  const listed = listSecretNames(io, cli, ref);
  if (listed.error !== undefined) {
    const message = `could not list the project's secrets (${listed.error}). Sign in the Supabase CLI (supabase login), or pass --allow-missing-secrets to deploy without this check.`;
    if (!allowMissing) throw new StepError(message);
    io.warn(`${PREFIX}: warning: ${message}`);
  } else {
    const missing = missingRequiredSecrets(listed.names);
    if (missing.length) {
      const what = listed.names.length
        ? `the function secrets ${missing.join(", ")} are not set on project ${ref}`
        : `no function secrets were found on project ${ref} (or the CLI's list could not be read), so ${missing.join(", ")} look unset`;
      const message = `${what}. Without them visitors get no AI answers and "Plan it" cannot use the planner. Set them as PAGES_DEPLOYMENT.md describes ("Settings and secrets of the function"), or pass --allow-missing-secrets to deploy anyway.`;
      if (!allowMissing) throw new StepError(message);
      io.warn(`${PREFIX}: warning: ${message}`);
    }
  }
  // Settings removed from settings.env, and which of them --prune may unset (checked now, before
  // anything is built or changed).
  const stale = listed.names ? staleSettingNames(listed.names, readEnvText(path.join(root, SETTINGS_FILE))) : [];
  let prune = [];
  if (argv.some(isPruneFlag)) {
    if (!listed.names) throw new StepError("--prune needs the project's list of secrets, which could not be read. Nothing was changed.");
    const request = pruneRequest(argv, stale);
    if (request.error) throw new StepError(request.error);
    prune = request.names;
  }

  // 3. Build and settings (settings first, so the demo limits are in place before the function answers)
  if (!has("--skip-build")) {
    step("build (client files and function bundle)", process.execPath, [path.join(root, "scripts", "pages", "build.mjs")]);
  }
  step(`apply ${SETTINGS_FILE.replaceAll("\\", "/")}`, cli, ["secrets", "set", "--env-file", SETTINGS_FILE, `--remote=${ref}`, "--yes"]);

  // 4. Settings removed from settings.env keep their last value until they are unset
  if (prune.length) {
    step(`unset the settings no longer in settings.env: ${prune.join(", ")}`, cli, ["secrets", "unset", ...prune, `--remote=${ref}`, "--yes"]);
  }
  const left = stale.filter((name) => !prune.includes(name));
  if (left.length) {
    io.warn(
      `${PREFIX}: warning: ${left.join(", ")} ${left.length === 1 ? "is" : "are"} set on the project but not in settings.env, so ${left.length === 1 ? "it keeps its" : "they keep their"} last value. Unset with: supabase secrets unset ${left.join(" ")} --remote=${ref} (or deploy with --prune=${left.join(",")}). Secrets belong to the whole project: leave out any that another function uses.`,
    );
  }

  // 5. Function. --use-api: bundled by Supabase, no Docker needed (5 MB limit; the bundle is about 1.6 MB).
  step("supabase functions deploy lifeops-api", cli, ["functions", "deploy", "lifeops-api", `--remote=${ref}`, "--no-verify-jwt", "--use-api", "--yes"]);
  io.log(`${PREFIX}: done. Function URL: https://${ref}.supabase.co/functions/v1/lifeops-api`);
}

if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  await runScript(PREFIX, () =>
    deployFunction({
      io: processIo(root),
      argv: process.argv.slice(2),
      root,
      ref: process.env.SUPABASE_PROJECT_REF ?? "tqgbgpchxbzzuofxjdaj",
      cli: findCli(),
    }),
  );
}
