// The server-side status middleware (src/lib/server-fn-errors.ts) inside TanStack Start's real
// request handler, as the Vercel build and the Pages Edge Function run it. The handler loads its
// app through virtual modules that only the build provides, so it runs in a child Node process
// with a loader hook that supplies small stand-ins: one server function ("good") and the start
// options with or without the middleware (as src/start.ts sets them).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { SERVER_FN_MESSAGES } from "@/lib/server-fn-errors";

const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));
const fileUrl = (...parts: string[]) => pathToFileURL(join(...parts)).href;

const dir = mkdtempSync(join(tmpdir(), "lifeops-start-handler-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, text: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return pathToFileURL(path).href;
}

// The module under test, compiled to JavaScript so any Node version can load it.
const errorsSource = readFileSync(new URL("../src/lib/server-fn-errors.ts", import.meta.url), "utf8");
const errorsUrl = write(
  "server-fn-errors.mjs",
  ts.transpileModule(errorsSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText,
);
const clientCore = fileUrl(pkgDir("@tanstack/start-client-core"), "dist", "esm", "index.js");
const resolverUrl = write(
  "resolver.mjs",
  `export async function getServerFnById(id) {
  if (id !== "good") throw new Error("Server function info not found for " + id);
  return async (opts) => {
    if (opts.data === "throw") throw new Error("The AI assistant is not available right now.");
    return { result: { ok: true, got: opts.data } };
  };
}
`,
);
const routerUrl = write("router-entry.mjs", `export function getRouter() { throw new Error("no pages in this test"); }\n`);
const startUrl = write(
  "start-entry.mjs",
  `import { createCsrfMiddleware, createMiddleware } from ${JSON.stringify(clientCore)};
import { serverFnStatusHandler } from ${JSON.stringify(errorsUrl)};
const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });
const status = createMiddleware().server((ctx) => serverFnStatusHandler(ctx));
const requestMiddleware = process.env.WITH_STATUS_MIDDLEWARE === "1" ? [csrf, status] : [csrf];
export const startInstance = { getOptions: () => ({ requestMiddleware }) };
`,
);
const hooksUrl = write(
  "hooks.mjs",
  `const map = ${JSON.stringify({
    "#tanstack-start-entry": startUrl,
    "#tanstack-router-entry": routerUrl,
    "#tanstack-start-server-fn-resolver": resolverUrl,
  })};
export async function resolve(specifier, context, next) {
  if (map[specifier]) return { url: map[specifier], shortCircuit: true };
  return next(specifier, context);
}
`,
);
const runPath = join(dir, "run.mjs");
write(
  "run.mjs",
  `import { register } from "node:module";
register(${JSON.stringify(hooksUrl)});
const { createStartHandler } = await import(${JSON.stringify(fileUrl(pkgDir("@tanstack/start-server-core"), "dist", "esm", "index.js"))});
const { toJSONAsync } = await import(${JSON.stringify(fileUrl(pkgDir("seroval"), "dist", "index.js"))});
console.error = () => {};
console.warn = () => {};
const handler = createStartHandler(() => new Response("page"));
const origin = "https://x.test";
const headers = { origin, "x-tsr-serverFn": "true", "content-type": "application/json" };
const body = async (data) => JSON.stringify(await toJSONAsync({ data }));
const cases = {
  unknownId: ["nosuchid", await body("hi")],
  notJson: ["good", "not json"],
  notSeroval: ["good", "{}"],
  good: ["good", await body("hi")],
  ownError: ["good", await body("throw")],
};
const out = {};
for (const [name, [id, payload]] of Object.entries(cases)) {
  const res = await handler(new Request(origin + "/lifeops-ai/_serverFn/" + id, { method: "POST", headers, body: payload }));
  out[name] = { status: res.status, serialized: res.headers.get("x-tss-serialized"), body: await res.text() };
}
const evil = await handler(new Request(origin + "/lifeops-ai/_serverFn/good", {
  method: "POST",
  headers: { ...headers, origin: "https://evil.test" },
  body: await body("hi"),
}));
out.crossOrigin = { status: evil.status };
process.stdout.write(JSON.stringify(out));
`,
);

type Answer = { status: number; serialized: string | null; body: string };
/**
 * How long one child run may take. Alone, a run took well under a second on the development PC;
 * with two runs of the whole suite at once, one took more than vitest's default 5 s per test and
 * failed. So each test gets the child's own limit.
 */
const RUN_TIMEOUT_MS = 60_000;
function runHandler(withMiddleware: boolean): Record<string, Answer> {
  const res = spawnSync(process.execPath, [runPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      TSS_DEV_SERVER: "true",
      TSS_SERVER_FN_BASE: "/lifeops-ai/_serverFn/",
      WITH_STATUS_MIDDLEWARE: withMiddleware ? "1" : "",
    },
    timeout: RUN_TIMEOUT_MS,
  });
  if (res.status !== 0) throw new Error(`the handler run failed (${res.status}): ${res.stderr}`);
  return JSON.parse(res.stdout) as Record<string, Answer>;
}

describe("TanStack Start's request handler", () => {
  it("without the middleware answers 500 for an unknown id and an unreadable payload (the defect)", () => {
    const out = runHandler(false);
    expect(out.unknownId.status).toBe(500);
    expect(JSON.parse(out.unknownId.body)).toMatchObject({ unhandled: true, message: "HTTPError" });
    expect(out.notSeroval.status).toBe(500);
    expect(out.notSeroval.body).toContain("Seroval Error (step: 3)");
  }, RUN_TIMEOUT_MS);

  it("with the middleware answers 404 and 400 with sentences, and leaves real answers alone", () => {
    const out = runHandler(true);
    expect(out.unknownId).toMatchObject({ status: 404, serialized: null, body: SERVER_FN_MESSAGES.outdated });
    expect(out.notJson).toMatchObject({ status: 400, serialized: null, body: SERVER_FN_MESSAGES.unreadable });
    expect(out.notSeroval).toMatchObject({ status: 400, serialized: null, body: SERVER_FN_MESSAGES.unreadable });
    expect(out.good.status).toBe(200);
    expect(out.good.serialized).toBe("true");
    expect(out.good.body).toContain('"got"');
    // A server function's own error keeps its status and its serialized message.
    expect(out.ownError.status).toBe(500);
    expect(out.ownError.serialized).toBe("true");
    expect(out.ownError.body).toContain("The AI assistant is not available right now.");
    // The CSRF check still runs first.
    expect(out.crossOrigin.status).toBe(403);
  }, RUN_TIMEOUT_MS);
});
