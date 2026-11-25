#!/usr/bin/env node
/**
 * Smoke test of the "lifeops-api" Edge Function, local (Deno) or deployed. See PAGES_DEPLOYMENT.md.
 *
 *   node scripts/pages/smoke-edge.mjs --url http://localhost:8000/lifeops-api            CORS and routing only
 *   node scripts/pages/smoke-edge.mjs --url https://<ref>.supabase.co/functions/v1/lifeops-api --demo-user
 *
 * --demo-user signs in a new anonymous demo user (needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in
 * the environment, both public values) and calls real server functions with its token. It fails
 * when the dashboard shows the planner offline or no AI provider set up on the function (a
 * missing secret), without making an AI call. A planner that only timed out (a cold start) gets
 * one more read after 5 s. Anonymous users are removed by the project's nightly clean-up job.
 * --chat also runs one chat turn (needs the AI settings on the function; uses the AI allowance).
 */
import { createHash } from "node:crypto";
import { dashboardSmokeChecks } from "./smoke-checks.mjs";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (arg("--url") ?? "").replace(/\/+$/, "");
const appBase = `/${(arg("--app-base") ?? "lifeops-ai").replace(/^\/+|\/+$/g, "")}`;
const origin = arg("--origin") ?? "https://gopalinternship-unibasel.github.io";
const demoUser = args.includes("--demo-user");
const chat = args.includes("--chat");
if (!base) {
  console.error("usage: node scripts/pages/smoke-edge.mjs --url <function url> [--demo-user] [--chat]");
  process.exit(2);
}

// seroval: the serializer TanStack Start uses for server-function payloads (installed with the app).
const { toJSONAsync } = await import(new URL("../../node_modules/seroval/dist/index.js", import.meta.url).href);

/**
 * Reads a seroval JSON tree well enough for a smoke test: strings, numbers, constants, arrays and
 * plain objects. TanStack's plugin nodes (t: 25, e.g. errors) are kept as they are; plain seroval
 * cannot decode them without TanStack's plugins.
 */
const CONSTANTS = [null, undefined, true, false, -0, Infinity, -Infinity, NaN];
function readLoose(node) {
  if (!node || typeof node !== "object") return node;
  switch (node.t) {
    case 0:
      return node.s;
    case 1:
      // seroval stores strings JavaScript-escaped (\" \\ \n \x3C ...): turn \xHH into \u00HH and \'
      // into ' so that JSON can read them.
      return typeof node.s === "string"
        ? JSON.parse(`"${node.s.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1").replace(/\\'/g, "'")}"`)
        : node.s;
    case 2:
      return CONSTANTS[node.s];
    case 9:
      return (node.a ?? []).map(readLoose);
    case 10:
    case 11: {
      const out = {};
      (node.p?.k ?? []).forEach((key, i) => (out[key] = readLoose(node.p.v[i])));
      return out;
    }
    case 25:
      return { plugin: node.c ?? true, message: readLoose(node.s?.message) };
    default:
      return node;
  }
}

/** TanStack Start's production id of a server function (start-plugin-core compiler). */
function fnId(file, name) {
  return createHash("sha256").update(`src/functions/${file}--${name}_createServerFn_handler`).digest("hex");
}
const fnUrl = (file, name) => `${base}${appBase}/_serverFn/${fnId(file, name)}`;

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` | ${detail}` : ""}`);
}

async function call(file, name, { data, token, method = "POST", from = origin } = {}) {
  const headers = { "x-tsr-serverFn": "true", accept: "application/x-tss-framed, application/x-ndjson, application/json" };
  if (from) headers.origin = from;
  if (token) headers.authorization = `Bearer ${token}`;
  let url = fnUrl(file, name);
  let body;
  if (data !== undefined) {
    const payload = JSON.stringify(await toJSONAsync({ data }));
    if (method === "GET") url += `?payload=${encodeURIComponent(payload)}`;
    else {
      body = payload;
      headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  // A serialized answer is { result, error, context }; a server function that throws still
  // answers 200 with the error inside.
  let value;
  let error;
  if (res.headers.get("x-tss-serialized")) {
    try {
      const decoded = readLoose(JSON.parse(text));
      if (decoded && typeof decoded === "object" && "result" in decoded) {
        value = decoded.result;
        error = decoded.error ?? undefined;
      } else value = decoded;
    } catch (e) {
      error = new Error(`could not decode the answer: ${e}`);
    }
  }
  const ok = res.status === 200 && Boolean(res.headers.get("x-tss-serialized")) && !error;
  const detail = error ? `error: ${error.message ?? JSON.stringify(error)}` : `status ${res.status}`;
  return { res, text, value, error, ok, detail };
}

// ---- CORS and routing
{
  const pre = await fetch(fnUrl("chat.functions.ts", "ensureChatSession"), {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, x-tsr-serverfn" },
  });
  check("preflight from the Pages origin", pre.status === 204 && pre.headers.get("access-control-allow-origin") === origin, `status ${pre.status}`);
  const expose = (pre.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  check("preflight exposes x-tss-serialized and x-tss-raw", expose.includes("x-tss-serialized") && expose.includes("x-tss-raw"), expose);
  const evil = await fetch(fnUrl("chat.functions.ts", "ensureChatSession"), { method: "OPTIONS", headers: { origin: "https://example.com" } });
  check("preflight from another origin is refused", evil.status === 403, `status ${evil.status}`);
  const evilPost = await call("chat.functions.ts", "ensureChatSession", { from: "https://example.com" });
  check("call from another origin is refused", evilPost.res.status === 403, `status ${evilPost.res.status}`);
  const noOrigin = await call("chat.functions.ts", "ensureChatSession", { from: null });
  check("call without Origin is refused", noOrigin.res.status === 403, `status ${noOrigin.res.status}`);
  const wrongPath = await fetch(`${base}/not-a-server-function`, { method: "POST", headers: { origin } });
  check("unknown path gives 404 with CORS", wrongPath.status === 404 && wrongPath.headers.get("access-control-allow-origin") === origin, `status ${wrongPath.status}`);
  const anon = await call("chat.functions.ts", "ensureChatSession");
  check(
    "server code runs: a call without a token gets 401 from requireSupabaseAuth",
    anon.res.status === 401 && anon.res.headers.get("access-control-allow-origin") === origin,
    `status ${anon.res.status} ${anon.text.slice(0, 80)}`,
  );
}

// ---- Real calls as a new anonymous demo user
if (demoUser) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    console.error("--demo-user needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY");
    process.exit(2);
  }
  const { createClient } = await import(new URL("../../node_modules/@supabase/supabase-js/dist/index.mjs", import.meta.url).href);
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signIn, error } = await supabase.auth.signInAnonymously();
  check("anonymous demo sign-in", !error && signIn.session, error?.message ?? "");
  const token = signIn?.session?.access_token;
  if (token) {
    const session = await call("chat.functions.ts", "ensureChatSession", { token });
    const sessionId = session.value?.sessionId ?? session.value?.id;
    check("ensureChatSession", session.ok && typeof sessionId === "string", `${session.detail} session ${sessionId}`);
    const cal = await call("chat.functions.ts", "fetchCalendar", { token, data: { timeZone: "Europe/Zurich" } });
    const events = cal.value?.events ?? cal.value;
    check("fetchCalendar (demo calendar)", cal.ok, `${cal.detail}${Array.isArray(events) ? `, ${events.length} events` : ""}`);
    const status = await call("google.functions.ts", "getGoogleConnectionStatus", { token, method: "GET" });
    check("getGoogleConnectionStatus (GET, secret key on the server)", status.ok, `${status.detail} ${JSON.stringify(status.value ?? "").slice(0, 100)}`);
    // A planner that only timed out (a cold start after an idle period) gets a second read.
    const dashboard = await dashboardSmokeChecks(
      () => call("dashboard.functions.ts", "fetchDashboard", { token, data: { timeZone: "Europe/Zurich" } }),
      { log: (message) => console.log(`WAIT ${message}`) },
    );
    for (const item of dashboard) check(item.label, item.ok, item.detail);
    if (chat && typeof sessionId === "string") {
      const started = Date.now();
      const turn = await call("chat.functions.ts", "processChat", {
        token,
        data: { sessionId, message: "Block 8 to 9 am on Saturday for a morning run.", timeZone: "Europe/Zurich" },
      });
      check(
        "processChat (one chat turn with the AI model)",
        turn.ok,
        `${turn.detail} in ${((Date.now() - started) / 1000).toFixed(1)} s ${JSON.stringify(turn.value ?? "").slice(0, 200)}`,
      );
    } else if (chat) {
      check("processChat needs a session id", false, JSON.stringify(session.value).slice(0, 120));
    }
  }
}

console.log(failures ? `${failures} CHECK(S) FAILED` : "ALL CHECKS PASS");
process.exit(failures ? 1 : 0);
