#!/usr/bin/env node
/**
 * Build LifeOps for GitHub Pages (see PAGES_DEPLOYMENT.md).
 *
 *   node scripts/pages/build.mjs            client files + Edge Function bundle
 *   node scripts/pages/build.mjs --client   client files only (the Pages workflow)
 *
 * 1. `vite build` with LIFEOPS_PAGES=1: TanStack Start SPA mode under /lifeops-ai/ writes
 *    dist-pages/client (static files) and dist-pages/server (the same server code as on Vercel).
 * 2. Pages files: _shell.html becomes index.html and 404.html (GitHub Pages serves 404.html for
 *    deep links such as /lifeops-ai/app/plan, and the router then shows the right page), plus
 *    .nojekyll.
 * 3. Edge Function: dist-pages/server/server.js and everything it imports are bundled into one
 *    ES module, supabase/functions/lifeops-api/server.mjs, that Deno can load: only node: built-ins
 *    stay external.
 *
 * Settings (environment; the VITE_ ones are public values that end up in the browser files):
 *   VITE_SERVER_FN_ORIGIN           required, e.g. https://<ref>.supabase.co/functions/v1/lifeops-api
 *   VITE_SUPABASE_URL               required
 *   VITE_SUPABASE_PUBLISHABLE_KEY   required (publishable key, never the secret key)
 *   VITE_ENABLE_ANONYMOUS_DEMO, VITE_ENABLE_GOOGLE_SIGNIN, VITE_HOSTED_DEMO
 *                                   default "true", "false", "true" (as on Vercel)
 *   LIFEOPS_PAGES_BASE              default "lifeops-ai" (the GitHub repository name)
 */
import { spawn } from "node:child_process";
import { builtinModules } from "node:module";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = path.join(root, "dist-pages");
const clientDir = path.join(outDir, "client");
const serverEntry = path.join(outDir, "server", "server.js");
const edgeBundle = path.join(root, "supabase", "functions", "lifeops-api", "server.mjs");
const clientOnly = process.argv.includes("--client");

function fail(message) {
  console.error(`build:pages: ${message}`);
  process.exit(1);
}

const required = ["VITE_SERVER_FN_ORIGIN", "VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) fail(`set ${missing.join(", ")} first (see PAGES_DEPLOYMENT.md)`);
if (/^sb_secret_/.test(process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "")) {
  fail("VITE_SUPABASE_PUBLISHABLE_KEY holds a secret key; use the publishable key");
}

/** An absolute http(s) URL without a trailing slash (https unless it is a local address). */
function checkedUrl(name) {
  let url;
  try {
    url = new URL(process.env[name].trim());
  } catch {
    fail(`${name} is not a URL: "${process.env[name]}"`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) fail(`${name} must be an https:// URL`);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url.toString().replace(/\/+$/, "");
}
const serverFnOrigin = checkedUrl("VITE_SERVER_FN_ORIGIN");
const supabaseUrl = checkedUrl("VITE_SUPABASE_URL");

// Vite (through the Lovable wrapper) also inlines VITE_ values from .env files, and the Pages files
// are public. Every VITE_ value such a file defines must therefore be set here explicitly.
const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"];
const setHere = new Set([
  ...Object.keys(process.env).filter((name) => name.startsWith("VITE_")),
  "VITE_ENABLE_ANONYMOUS_DEMO",
  "VITE_ENABLE_GOOGLE_SIGNIN",
  "VITE_HOSTED_DEMO",
]);
for (const file of envFiles) {
  let text;
  try {
    text = await readFile(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  const names = [...text.matchAll(/^\s*(?:export\s+)?(VITE_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
  const unset = names.filter((name) => !setHere.has(name));
  if (unset.length) fail(`${file} defines ${unset.join(", ")}, which would go into the public Pages files; set them in the environment`);
}

const env = {
  ...process.env,
  VITE_SERVER_FN_ORIGIN: serverFnOrigin,
  VITE_SUPABASE_URL: supabaseUrl,
  LIFEOPS_PAGES: "1",
  NODE_ENV: "production",
  VITE_ENABLE_ANONYMOUS_DEMO: process.env.VITE_ENABLE_ANONYMOUS_DEMO ?? "true",
  VITE_ENABLE_GOOGLE_SIGNIN: process.env.VITE_ENABLE_GOOGLE_SIGNIN ?? "false",
  VITE_HOSTED_DEMO: process.env.VITE_HOSTED_DEMO ?? "true",
};
// A Vercel or nitro target must not leak into this build.
delete env.NITRO_PRESET;
delete env.VERCEL;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`))));
  });
}

await rm(outDir, { recursive: true, force: true });
console.log("build:pages: vite build (LIFEOPS_PAGES=1)");
await run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"]);

// ---- Pages files
const shell = path.join(clientDir, "_shell.html");
try {
  await stat(shell);
} catch {
  fail(`no SPA shell at ${shell}; did TanStack Start's SPA mode run?`);
}
await copyFile(shell, path.join(clientDir, "index.html"));
await copyFile(shell, path.join(clientDir, "404.html"));
await writeFile(path.join(clientDir, ".nojekyll"), "");
const shellHtml = await readFile(shell, "utf8");
const base = `/${(process.env.LIFEOPS_PAGES_BASE ?? "lifeops-ai").replace(/^\/+|\/+$/g, "")}/`;
if (!shellHtml.includes(`${base}assets/`)) fail(`the shell does not load its assets from ${base}assets/`);
console.log(`build:pages: client files in ${path.relative(root, clientDir)} (index.html, 404.html, .nojekyll)`);

if (clientOnly) process.exit(0);

// ---- Edge Function bundle
const esbuild = await import("esbuild");
const builtins = new Set(builtinModules.filter((name) => !name.startsWith("_")));
const nodeBuiltins = {
  name: "node-builtins",
  setup(build) {
    // Deno resolves only "node:" specifiers for built-ins (the edge runtime turns bare ones off).
    build.onResolve({ filter: /^[a-z0-9_/]+$/ }, (args) =>
      builtins.has(args.path) ? { path: `node:${args.path}`, external: true } : undefined,
    );
    build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
  },
};
await mkdir(path.dirname(edgeBundle), { recursive: true });
const result = await esbuild.build({
  entryPoints: [serverEntry],
  outfile: edgeBundle,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["deno", "worker", "module"],
  plugins: [nodeBuiltins],
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  // Vite's server chunks keep bare `import "pkg"` lines for packages that declare
  // "sideEffects": false; dropping them is what those packages ask for (Rollup does the same).
  logOverride: { "ignored-bare-import": "silent" },
  metafile: true,
  banner: { js: "// Generated by scripts/pages/build.mjs from dist-pages/server. Do not edit." },
});
const imports = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imp of output.imports) imports.add(imp.path);
}
const unexpected = [...imports].filter((spec) => !spec.startsWith("node:"));
if (unexpected.length) fail(`the Edge Function bundle still imports ${unexpected.join(", ")}`);

// TanStack's route manifest keeps absolute file paths of this computer; make them relative.
const rootClean = root.replace(/[\\/]+$/, "");
const rootForward = rootClean.replace(/\\/g, "/");
const rootEscaped = rootClean.replace(/\\/g, "\\\\"); // as it appears inside a JS string literal
let bundleText = await readFile(edgeBundle, "utf8");
const before = bundleText.length;
bundleText = bundleText.split(`${rootForward}/`).join("").split(`${rootEscaped}\\\\`).join("");
if (bundleText.length !== before) await writeFile(edgeBundle, bundleText);
if (bundleText.includes(rootForward) || bundleText.includes(rootEscaped)) fail("the bundle still contains this computer's project path");

const { size } = await stat(edgeBundle);
console.log(
  `build:pages: Edge Function bundle ${path.relative(root, edgeBundle)} (${(size / 1024 / 1024).toFixed(2)} MB; imports ${[...imports].join(", ") || "none"})`,
);
if (size > 4.5 * 1024 * 1024) {
  console.warn("build:pages: the bundle is close to the 5 MB limit of `supabase functions deploy --use-api`");
}
