// The Pages release tooling (scripts/pages): secret checks, the release from main for one commit,
// and the smoke test's planner and AI checks. git, gh and the Supabase CLI are fakes here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIRED_SECRETS as HANDLER_REQUIRED } from "../supabase/functions/lifeops-api/handler.ts";
import { deployFunction, listSecretNames } from "../scripts/pages/deploy-function.mjs";
import { StepError } from "../scripts/pages/process.mjs";
import { findNewRun, release, releaseBlocker, runFromOutput } from "../scripts/pages/release.mjs";
import {
  REQUIRED_SECRETS,
  missingRequiredSecrets,
  pruneRequest,
  secretListError,
  secretNamesFromList,
  staleSettingNames,
} from "../scripts/pages/secrets.mjs";
import {
  PLANNER_RETRY_WAIT_MS,
  aiProviderConfigured,
  dashboardChecks,
  dashboardSmokeChecks,
  plannerTimedOut,
} from "../scripts/pages/smoke-checks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * A fake for git, gh, node and the Supabase CLI: `answers` maps the start of a command line to
 * { status, stdout, stderr } (or a function returning one). Every call is recorded.
 */
function fakeIo(answers = {}, runStatus = () => 0) {
  const calls = [];
  const logs = [];
  const answer = (line) => {
    const key = Object.keys(answers)
      .filter((prefix) => line.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    const value = key === undefined ? { status: 0, stdout: "" } : answers[key];
    return { status: 0, stdout: "", stderr: "", ...(typeof value === "function" ? value(line) : value) };
  };
  const line = (command, args) => [command.includes("node") || command === process.execPath ? "node" : command, ...args].join(" ");
  return {
    calls,
    logs,
    io: {
      capture(command, args) {
        const text = line(command, args);
        calls.push({ kind: "capture", line: text });
        return answer(text);
      },
      run(command, args, env) {
        const text = line(command, args);
        calls.push({ kind: "run", line: text, env });
        return runStatus(text);
      },
      sleep: async () => {},
      log: (message) => logs.push(message),
      warn: (message) => logs.push(`WARN ${message}`),
    },
  };
}

const ALL_SECRETS = JSON.stringify([
  ...["LLM_BASE_URL", "LLM_API_KEY", "LIFEOPS_BACKEND_TOKEN", "LLM_MODEL", "SUPABASE_URL"].map((name) => ({
    name,
    value: "digest",
  })),
]);

// The exact output of Supabase CLI 3.0.0 (`secrets list --remote=<ref>`), read on 24 Nov 2026 by
// running the CLI against a local stand-in for the Management API (made-up ref and digests).
const CLI_3_JSON =
  '{"secrets":[{"name":"LIFEOPS_BACKEND_URL","value":"3f0c000000000000000000000000000000000000000000000000000000000000","updated_at":"2026-11-20T10:00:00Z"},{"name":"LLM_BASE_URL","value":"9a1b111111111111111111111111111111111111111111111111111111111111","updated_at":"2026-11-20T10:00:00Z"},{"name":"SUPABASE_URL","value":"77aa222222222222222222222222222222222222222222222222222222222222"}],"message":"","target":{"kind":"linked","project_ref":"abcdefghijklmnopqrst","environment":"unverified"}}\n';
const CLI_3_TABLE =
  "\n  \n   NAME                | DIGEST                                                           \n  ---------------------|------------------------------------------------------------------\n   LIFEOPS_BACKEND_URL | 3f0c000000000000000000000000000000000000000000000000000000000000 \n   LLM_BASE_URL        | 9a1b111111111111111111111111111111111111111111111111111111111111 \n   SUPABASE_URL        | 77aa222222222222222222222222222222222222222222222222222222222222 \n\n";
const CLI_3_ERROR =
  '{"target":{"kind":"linked","project_ref":"abcdefghijklmnopqrst","environment":"unverified"},"_tag":"Error","error":{"code":"SecretsListUnexpectedStatusError","message":"unexpected list secrets status 401: {\\"message\\":\\"Invalid access token\\"}"}}\n';

describe("secret names", () => {
  it("keeps one list of required secrets for the deploy check and the function's start-up log", () => {
    expect(REQUIRED_SECRETS).toEqual([...HANDLER_REQUIRED]);
    const settings = read("supabase/functions/lifeops-api/settings.env");
    for (const name of REQUIRED_SECRETS) expect(settings).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
  });

  it("reads the names from JSON, JSON lines and the CLI's table, never the values", () => {
    expect(secretNamesFromList('[{"name":"LLM_MODEL","value":"abc"},{"name":"LLM_API_KEY","value":"def"}]')).toEqual([
      "LLM_MODEL",
      "LLM_API_KEY",
    ]);
    expect(secretNamesFromList('{"secrets":[{"Name":"A_B"}]}')).toEqual(["A_B"]);
    expect(secretNamesFromList('{"name":"ONE","value":"x"}\n{"name":"TWO","value":"y"}')).toEqual(["ONE", "TWO"]);
    const table = [
      "",
      "    NAME                  | DIGEST",
      "  ------------------------|------------------------------------",
      "    LIFEOPS_BACKEND_TOKEN | 3b2c4d",
      "    LLM_MODEL             | 9f8e7d",
      "A new version of Supabase CLI is available",
    ].join("\n");
    expect(secretNamesFromList(table)).toEqual(["LIFEOPS_BACKEND_TOKEN", "LLM_MODEL"]);
    expect(secretNamesFromList("")).toEqual([]);
    expect(secretNamesFromList('[{"name":"X","value":"digest-1"}]')).not.toContain("digest-1");
  });

  it("reads other likely JSON shapes, and JSON with notices around it", () => {
    // A map of name to digest: the keys are the names, the digests never are.
    expect(secretNamesFromList('{"LLM_MODEL":"3b2c","LLM_API_KEY":"9f8e"}')).toEqual(["LLM_MODEL", "LLM_API_KEY"]);
    // A status wrapper's lower-case keys are not taken for names.
    expect(secretNamesFromList('{"status":"ok","secrets":[{"name":"A"}]}')).toEqual(["A"]);
    const pretty = JSON.stringify([{ name: "LLM_MODEL", value: "abc" }, { name: "LIFEOPS_BACKEND_TOKEN", value: "def" }], null, 2);
    expect(secretNamesFromList(`Using profile: supabase\n${pretty}\nA new version of Supabase CLI is available`)).toEqual([
      "LLM_MODEL",
      "LIFEOPS_BACKEND_TOKEN",
    ]);
    // An older CLI's table prints the names as Markdown code.
    expect(secretNamesFromList("  NAME | DIGEST\n  `LLM_API_KEY` | `abc`\n")).toEqual(["LLM_API_KEY"]);
  });

  it("reads the Supabase CLI 3.0.0 output exactly as it prints it", () => {
    const names = ["LIFEOPS_BACKEND_URL", "LLM_BASE_URL", "SUPABASE_URL"];
    expect(secretNamesFromList(CLI_3_JSON)).toEqual(names);
    expect(secretNamesFromList(CLI_3_TABLE)).toEqual(names);
    expect(secretListError(CLI_3_JSON)).toBeNull();
    expect(secretNamesFromList(CLI_3_ERROR)).toEqual([]);
    expect(secretListError(CLI_3_ERROR)).toMatch(/^unexpected list secrets status 401: .*Invalid access token/);
    // A target that names a branch is not a secret.
    const branch = CLI_3_JSON.replace('"kind":"linked"', '"kind":"branch","name":"develop"');
    expect(secretNamesFromList(branch)).toEqual(names);
    expect(secretNamesFromList('{"secrets":[],"message":"","target":{"name":"develop"}}')).toEqual([]);
  });

  it("names the missing required secrets", () => {
    expect(missingRequiredSecrets(["LLM_MODEL", "LLM_BASE_URL"])).toEqual(["LLM_API_KEY", "LIFEOPS_BACKEND_TOKEN"]);
    expect(missingRequiredSecrets(REQUIRED_SECRETS)).toEqual([]);
  });

  it("finds settings removed from settings.env, never the three secrets or Supabase's own names", () => {
    const listed = [
      "LLM_MODEL",
      "LLM_EXTRA_BODY",
      "LLM_API_KEY",
      "LLM_BASE_URL",
      "LIFEOPS_BACKEND_TOKEN",
      "SUPABASE_URL",
      "SUPABASE_SECRET_KEYS",
    ];
    expect(staleSettingNames(listed, "# a comment\nLLM_MODEL=x\n")).toEqual(["LLM_EXTRA_BODY"]);
    expect(staleSettingNames(listed, read("supabase/functions/lifeops-api/settings.env"))).toEqual([]);
  });
});

describe("deploy-function.mjs", () => {
  const ref = "projectref";
  const deploy = (io, argv = ["--skip-build"]) => deployFunction({ io, argv, root, ref, cli: "supabase" });
  const runs = (calls) => calls.filter((c) => c.kind === "run").map((c) => c.line);

  it("stops before anything changes when a required secret is missing", async () => {
    const fake = fakeIo({
      "git rev-parse": { stdout: "main\n" },
      "supabase secrets list": { stdout: JSON.stringify([{ name: "LLM_BASE_URL" }, { name: "LLM_MODEL" }]) },
    });
    await expect(deploy(fake.io, [])).rejects.toThrow(/LLM_API_KEY, LIFEOPS_BACKEND_TOKEN are not set/);
    await expect(deploy(fake.io, [])).rejects.toBeInstanceOf(StepError);
    expect(runs(fake.calls)).toEqual([]);
  });

  it("deploys with --allow-missing-secrets and says what is missing", async () => {
    const fake = fakeIo({ "supabase secrets list": { stdout: "[]" } });
    await deploy(fake.io, ["--skip-build", "--allow-missing-secrets"]);
    expect(runs(fake.calls).at(-1)).toMatch(/^supabase functions deploy lifeops-api/);
    expect(fake.logs.join("\n")).toMatch(/WARN .*no function secrets were found/);
  });

  it("applies settings.env, then deploys, and names settings that settings.env no longer has", async () => {
    const listed = JSON.stringify([...JSON.parse(ALL_SECRETS), { name: "LLM_EXTRA_OLD" }]);
    const fake = fakeIo({ "git rev-parse": { stdout: "main\n" }, "supabase secrets list": { stdout: listed } });
    await deploy(fake.io);
    const done = runs(fake.calls);
    expect(done).toHaveLength(2);
    expect(done[0]).toMatch(/^supabase secrets set --env-file \S*settings\.env --remote=projectref --yes$/);
    expect(done[1]).toBe("supabase functions deploy lifeops-api --remote=projectref --no-verify-jwt --use-api --yes");
    expect(fake.logs.join("\n")).toMatch(/WARN .*LLM_EXTRA_OLD is set on the project but not in settings\.env/);
    expect(fake.logs.join("\n")).toMatch(/deploy with --prune=LLM_EXTRA_OLD\)/);
  });

  // A secret of another function in the same project looks like a removed setting too.
  const withStale = JSON.stringify([...JSON.parse(ALL_SECRETS), { name: "LLM_EXTRA_OLD" }, { name: "OTHER_FUNCTION_KEY" }]);

  it("unsets only the settings named with --prune=, before the deploy", async () => {
    const fake = fakeIo({ "supabase secrets list": { stdout: withStale } });
    await deploy(fake.io, ["--skip-build", "--prune=LLM_EXTRA_OLD"]);
    const done = runs(fake.calls);
    expect(done[1]).toBe("supabase secrets unset LLM_EXTRA_OLD --remote=projectref --yes");
    expect(done[2]).toMatch(/^supabase functions deploy/);
    expect(done.join("\n")).not.toContain("OTHER_FUNCTION_KEY");
    expect(fake.logs.join("\n")).toMatch(/WARN .*OTHER_FUNCTION_KEY is set on the project but not in settings\.env/);
  });

  it("refuses a bare --prune, or a name that is not a removed setting, before anything changes", async () => {
    const fake = fakeIo({ "supabase secrets list": { stdout: withStale } });
    await expect(deploy(fake.io, ["--prune"])).rejects.toThrow(
      /--prune needs the names to unset, as --prune=NAME,NAME.*LLM_EXTRA_OLD, OTHER_FUNCTION_KEY\. Nothing was changed\./,
    );
    await expect(deploy(fake.io, ["--prune=LLM_API_KEY"])).rejects.toThrow(/--prune names LLM_API_KEY, which is not a setting/);
    await expect(deploy(fake.io, ["--prune=SUPABASE_URL,NOT_LISTED"])).rejects.toThrow(/--prune names SUPABASE_URL, NOT_LISTED/);
    expect(runs(fake.calls)).toEqual([]);
    // Without the list there is nothing to check the names against.
    const unreadable = fakeIo({ "supabase secrets list": { status: 1, stderr: "Access token not provided" } });
    await expect(deploy(unreadable.io, ["--allow-missing-secrets", "--prune=LLM_EXTRA_OLD"])).rejects.toThrow(
      /--prune needs the project's list of secrets/,
    );
    expect(runs(unreadable.calls)).toEqual([]);
  });

  it("reads --prune names given in one or several flags", () => {
    const stale = ["A", "B", "C"];
    expect(pruneRequest([], stale)).toEqual({ names: [] });
    expect(pruneRequest(["--prune=A, B", "--prune=B,C"], stale)).toEqual({ names: ["A", "B", "C"] });
    expect(pruneRequest(["--prune="], stale).error).toMatch(/needs the names/);
    expect(pruneRequest(["--prune"], []).error).toMatch(/not in settings\.env: none\./);
  });

  it("falls back to the plain list when the CLI does not know --output-format", () => {
    const fake = fakeIo({
      "supabase secrets list --remote=projectref --output-format": { status: 1, stderr: "unknown flag" },
      "supabase secrets list --remote=projectref": { stdout: "  NAME | DIGEST\n  LLM_API_KEY | abc\n" },
    });
    expect(listSecretNames(fake.io, "supabase", "projectref")).toEqual({ names: ["LLM_API_KEY"] });
  });

  it("reads the CLI 3.0.0 list, and takes its error in JSON for a failure, not for no secrets", () => {
    const ok = fakeIo({ "supabase secrets list --remote=projectref --output-format": { stdout: CLI_3_JSON } });
    expect(listSecretNames(ok.io, "supabase", "projectref")).toEqual({
      names: ["LIFEOPS_BACKEND_URL", "LLM_BASE_URL", "SUPABASE_URL"],
    });
    // An error document with exit status 0 is not an empty list: the plain list is asked next.
    const failed = fakeIo({
      "supabase secrets list --remote=projectref --output-format": { status: 0, stdout: CLI_3_ERROR },
      "supabase secrets list --remote=projectref": { status: 0, stdout: CLI_3_TABLE },
    });
    expect(listSecretNames(failed.io, "supabase", "projectref")).toEqual({
      names: ["LIFEOPS_BACKEND_URL", "LLM_BASE_URL", "SUPABASE_URL"],
    });
    const bothFail = fakeIo({
      "supabase secrets list --remote=projectref --output-format": { status: 1, stdout: CLI_3_ERROR },
      "supabase secrets list --remote=projectref": { status: 0, stdout: CLI_3_ERROR },
    });
    expect(listSecretNames(bothFail.io, "supabase", "projectref").error).toMatch(/Invalid access token/);
  });

  it("stops when the secrets cannot be listed, unless told to go on", async () => {
    const fake = fakeIo({ "supabase secrets list": { status: 1, stderr: "Access token not provided" } });
    await expect(deploy(fake.io)).rejects.toThrow(/could not list the project's secrets \(Access token not provided\)/);
    expect(runs(fake.calls)).toEqual([]);
    await deploy(fake.io, ["--skip-build", "--allow-missing-secrets"]);
    expect(runs(fake.calls).at(-1)).toMatch(/^supabase functions deploy/);
  });

  it("warns when deploying from another branch or with uncommitted changes", async () => {
    const fake = fakeIo({
      "git rev-parse": { stdout: "feature/x\n" },
      "git status": { stdout: " M src/start.ts\n" },
      "supabase secrets list": { stdout: ALL_SECRETS },
    });
    await deploy(fake.io);
    const text = fake.logs.join("\n");
    expect(text).toMatch(/WARN .*deploying from feature\/x, not main/);
    expect(text).toMatch(/WARN .*uncommitted changes/);
  });
});

describe("release.mjs", () => {
  const releaseAnswers = (overrides = {}) => ({
    "git status": { stdout: "" },
    "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    "git rev-parse HEAD": { stdout: `${SHA}\n` },
    "git rev-parse origin/main": { stdout: `${SHA}\n` },
    "gh run list --workflow ci.yml": { stdout: '[{"status":"completed","conclusion":"success","url":"u"}]' },
    "gh run list --workflow pages.yml": { stdout: '[{"databaseId":7,"url":"https://github.com/o/r/actions/runs/7"}]' },
    "gh workflow run pages.yml": { stdout: "https://github.com/o/r/actions/runs/42\n" },
    ...overrides,
  });
  const env = { VITE_SUPABASE_URL: "https://ref.supabase.co/", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" };
  const runRelease = (io, argv = []) => release({ io, argv, root, env });

  it("refuses any branch but main before it deploys anything", async () => {
    expect(releaseBlocker("main")).toBeNull();
    expect(releaseBlocker("feature/x")).toMatch(/release from main \(this is feature\/x\)/);
    expect(releaseBlocker("HEAD")).toMatch(/this is a detached HEAD/);
    const fake = fakeIo(releaseAnswers({ "git rev-parse --abbrev-ref HEAD": { stdout: "feature/x\n" } }));
    await expect(runRelease(fake.io)).rejects.toThrow(/GitHub Pages publishes only from main/);
    expect(fake.calls.filter((c) => c.kind === "run")).toEqual([]);
    expect(fake.calls.some((c) => c.line.startsWith("gh workflow run"))).toBe(false);
  });

  it("deploys, smoke-tests as a demo user, publishes exactly the released commit and waits for it", async () => {
    const fake = fakeIo(releaseAnswers());
    await runRelease(fake.io, ["--prune=LLM_EXTRA_OLD", "--allow-missing-secrets"]);
    const runs = fake.calls.filter((c) => c.kind === "run");
    expect(runs[0].line).toMatch(/deploy-function\.mjs --prune=LLM_EXTRA_OLD --allow-missing-secrets$/);
    expect(runs[0].env.VITE_SERVER_FN_ORIGIN).toBe("https://ref.supabase.co/functions/v1/lifeops-api");
    expect(runs[1].line).toMatch(/smoke-edge\.mjs --url https:\/\/ref\.supabase\.co\/functions\/v1\/lifeops-api --demo-user$/);
    expect(runs[1].env).toEqual({ SUPABASE_URL: "https://ref.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" });
    expect(fake.calls.find((c) => c.line.startsWith("gh workflow run"))?.line).toBe(`gh workflow run pages.yml --ref main -f sha=${SHA}`);
    expect(runs[2].line).toBe("gh run watch 42 --exit-status");
    expect(fake.logs.at(-1)).toMatch(/both run 0123456/);
  });

  it("finds the new run in the list when gh does not print its address", async () => {
    let lists = 0;
    const fake = fakeIo(
      releaseAnswers({
        "gh workflow run pages.yml": { stdout: "" },
        "gh run list --workflow pages.yml": () => {
          lists += 1;
          const runsNow = [{ databaseId: 7, url: "u7" }];
          if (lists > 2) runsNow.unshift({ databaseId: 9, url: "https://github.com/o/r/actions/runs/9" });
          return { stdout: JSON.stringify(runsNow) };
        },
      }),
    );
    await runRelease(fake.io);
    expect(fake.calls.filter((c) => c.kind === "run").at(-1).line).toBe("gh run watch 9 --exit-status");
  });

  it("fails, and says the halves are out of step, when the Pages workflow fails", async () => {
    const fake = fakeIo(releaseAnswers(), (line) => (line.startsWith("gh run watch") ? 1 : 0));
    await expect(runRelease(fake.io)).rejects.toThrow(/Pages workflow failed .*out of step/);
  });

  it("stops when the smoke test fails, before the site is published", async () => {
    const fake = fakeIo(releaseAnswers(), (line) => (line.includes("smoke-edge.mjs") ? 1 : 0));
    const failed = runRelease(fake.io);
    await expect(failed).rejects.toThrow(/smoke test of the deployed function failed/);
    // It says that the function is already deployed and how to publish the same commit later.
    await expect(failed).rejects.toThrow(/function already runs 0123456, but the Pages site was not published/);
    await expect(failed).rejects.toThrow(`gh workflow run pages.yml --ref main -f sha=${SHA}`);
    expect(fake.calls.some((c) => c.line.startsWith("gh workflow run"))).toBe(false);
  });

  it("reads gh's run address and finds new runs", () => {
    expect(runFromOutput("✓ Created workflow_dispatch event\nhttps://github.com/o/r/actions/runs/123\n")).toEqual({
      databaseId: 123,
      url: "https://github.com/o/r/actions/runs/123",
    });
    expect(runFromOutput("")).toBeNull();
    expect(findNewRun([{ databaseId: 1 }], [{ databaseId: 2 }, { databaseId: 1 }])).toEqual({ databaseId: 2 });
    expect(findNewRun([{ databaseId: 1 }], [{ databaseId: 1 }])).toBeNull();
  });
});

describe("process.mjs", () => {
  it("knows when a script is the one node was started with, and not when it is imported", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lifeops-main-module-"));
    try {
      const helper = pathToFileURL(path.join(root, "scripts", "pages", "process.mjs")).href;
      const script = path.join(dir, "script.mjs");
      writeFileSync(script, `import { isMainModule } from ${JSON.stringify(helper)};\nconsole.log(isMainModule(import.meta.url));\n`);
      writeFileSync(path.join(dir, "importer.mjs"), `import ${JSON.stringify(pathToFileURL(script).href)};\n`);
      const started = spawnSync(process.execPath, [script], { encoding: "utf8" });
      expect(started.stdout.trim()).toBe("true");
      const imported = spawnSync(process.execPath, [path.join(dir, "importer.mjs")], { encoding: "utf8" });
      expect(imported.stdout.trim()).toBe("false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pages.yml", () => {
  const workflow = read(".github/workflows/pages.yml");
  it("builds the commit it is given, and only a commit on main", () => {
    expect(workflow).toMatch(/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*sha:/);
    expect(workflow).toContain("ref: ${{ inputs.sha || github.sha }}");
    expect(workflow).toContain("git merge-base --is-ancestor HEAD origin/main");
  });
});

describe("smoke-edge.mjs dashboard checks", () => {
  it("fails while the planner is offline and the AI provider is the local default", () => {
    const checks = dashboardChecks({
      planner: { online: false, error: "x" },
      workspace: { aiProvider: { provider: "Ollama", model: "m" } },
    });
    expect(checks.filter((c) => !c.ok).map((c) => c.label)).toEqual([
      "planner reachable from the function",
      "AI provider configured on the function",
    ]);
  });

  it("passes with the planner online and a hosted provider", () => {
    const checks = dashboardChecks({
      planner: { online: true, data: {} },
      workspace: { aiProvider: { provider: "Cloudflare Workers AI", model: "@cf/zai-org/glm-4.7-flash" } },
    });
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("reads the newer { configured, label, local } shape too", () => {
    expect(aiProviderConfigured({ configured: false, label: "AI not set up on this site", local: false })).toBe(false);
    expect(aiProviderConfigured({ configured: true, label: "Ollama · qwen", local: true })).toBe(false);
    expect(aiProviderConfigured({ configured: true, label: "Cloudflare Workers AI · @cf/x", local: false })).toBe(true);
    expect(aiProviderConfigured(undefined)).toBe(false);
  });
});

describe("smoke-edge.mjs dashboard read after a planner timeout", () => {
  const AI = { configured: true, label: "Cloudflare Workers AI · @cf/zai-org/glm-4.7-flash", local: false };
  const answer = (planner) => ({ ok: true, detail: "status 200", value: { planner, workspace: { aiProvider: AI } } });
  const timedOut = { online: false, reason: "timeout", error: "The planner service did not answer within 10 s." };
  const online = { online: true, data: {} };

  /** dashboardSmokeChecks with canned dashboard answers, one per read; records reads and waits. */
  async function run(...answers) {
    const reads = [];
    const waits = [];
    const logs = [];
    const checks = await dashboardSmokeChecks(
      async () => {
        reads.push(reads.length);
        return answers[Math.min(reads.length - 1, answers.length - 1)];
      },
      { sleep: async (ms) => waits.push(ms), log: (message) => logs.push(message) },
    );
    return { checks, reads: reads.length, waits, logs, failed: checks.filter((c) => !c.ok).map((c) => c.label) };
  }

  it("reads the dashboard once more when the planner only timed out, and passes when it then answers", async () => {
    const result = await run(answer(timedOut), answer(online));
    expect(result.reads).toBe(2);
    expect(result.waits).toEqual([PLANNER_RETRY_WAIT_MS]);
    expect(result.failed).toEqual([]);
    expect(result.checks[0]).toMatchObject({ label: "fetchDashboard", ok: true, detail: "status 200, second read" });
    expect(result.logs.join(" ")).toMatch(/timed out \(The planner service did not answer within 10 s\.\)/);
  });

  it("fails when the planner times out on the second read too", async () => {
    const result = await run(answer(timedOut), answer(timedOut));
    expect(result.reads).toBe(2);
    expect(result.failed).toEqual(["planner reachable from the function"]);
  });

  it("fails at once, without a second read, for a planner that is off, refuses the token or cannot be reached", async () => {
    for (const reason of ["off", "rejected", "unreachable", "failed"]) {
      const result = await run(answer({ online: false, reason, error: "x" }), answer(online));
      expect(result.reads, reason).toBe(1);
      expect(result.waits, reason).toEqual([]);
      expect(result.failed, reason).toEqual(["planner reachable from the function"]);
    }
    // An older server's answer without a reason is not retried either.
    expect((await run(answer({ online: false, error: "x" }), answer(online))).reads).toBe(1);
  });

  it("reads once when the planner answers, and reports a failed call without the planner checks", async () => {
    expect((await run(answer(online))).reads).toBe(1);
    const failedCall = await run({ ok: false, detail: "status 500", value: undefined });
    expect(failedCall.checks).toEqual([{ label: "fetchDashboard", ok: false, detail: "status 500" }]);
  });

  it("knows a timeout from the other reasons", () => {
    expect(plannerTimedOut({ planner: timedOut })).toBe(true);
    expect(plannerTimedOut({ planner: online })).toBe(false);
    expect(plannerTimedOut({ planner: { online: false, reason: "rejected", error: "x" } })).toBe(false);
    expect(plannerTimedOut(undefined)).toBe(false);
  });

  it("is what smoke-edge.mjs runs for fetchDashboard, and what the docs say", () => {
    const script = read("scripts/pages/smoke-edge.mjs");
    expect(script).toContain('import { dashboardSmokeChecks } from "./smoke-checks.mjs";');
    expect(script).toMatch(/dashboardSmokeChecks\(\s*\(\) => call\("dashboard\.functions\.ts", "fetchDashboard"/);
    const seconds = PLANNER_RETRY_WAIT_MS / 1000;
    expect(script.replace(/\s*\*\s*/g, " ")).toContain(`one more read after ${seconds} s`);
    expect(read("PAGES_DEPLOYMENT.md").replace(/\s+/g, " ")).toContain(`reads the dashboard once more ${seconds} s later`);
  });
});
