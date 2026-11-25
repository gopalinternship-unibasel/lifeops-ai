/**
 * Small process helpers shared by the Pages release scripts. The scripts take these as arguments
 * (an "io" object), so the tests can replace git, gh and the Supabase CLI with fakes.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** A step that cannot go on; the script prints the message and exits with `exitCode`. */
export class StepError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "StepError";
    this.exitCode = exitCode;
  }
}

/** True when the module at `metaUrl` is the script node was started with. */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const self = path.resolve(fileURLToPath(metaUrl));
  const started = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === started.toLowerCase() : self === started;
}

/** Real process runners for `cwd`: `capture` collects output, `run` shows it as it comes. */
export function processIo(cwd) {
  return {
    capture(command, args, env) {
      const res = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        shell: false,
        env: env ? { ...process.env, ...env } : process.env,
      });
      return { status: res.error ? null : res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? String(res.error ?? "") };
    },
    run(command, args, env) {
      const res = spawnSync(command, args, {
        cwd,
        stdio: "inherit",
        shell: false,
        env: env ? { ...process.env, ...env } : process.env,
      });
      if (res.error) throw res.error;
      return res.status;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
  };
}

/** Runs `main` and turns a StepError into its message and exit code. */
export async function runScript(prefix, main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof StepError) {
      console.error(`${prefix}: ${error.message}`);
      process.exit(error.exitCode);
    }
    throw error;
  }
}
