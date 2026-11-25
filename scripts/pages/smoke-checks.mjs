/**
 * Checks of a fetchDashboard answer for scripts/pages/smoke-edge.mjs --demo-user. A dashboard
 * answers 200 even when the planner refuses the function's calls or no AI provider is set, so the
 * HTTP status alone said nothing about either; these two checks make no AI call.
 */

/** True when the dashboard's AI field names a configured provider that is not on the function's own machine. */
export function aiProviderConfigured(ai) {
  if (!ai || typeof ai !== "object") return false;
  // { configured, label, local } (newer server code) or { provider, model } (older).
  if (ai.configured === false || ai.local === true) return false;
  const text = [ai.provider, ai.label, ai.model].filter((part) => typeof part === "string").join(" ");
  // A local model (the development default) can never answer inside the hosted function.
  if (/ollama|localhost|127\.0\.0\.1/i.test(text)) return false;
  return ai.configured === true || (typeof ai.provider === "string" && ai.provider.trim() !== "");
}

/** The planner and AI checks for one decoded fetchDashboard result: [{ label, ok, detail }]. */
export function dashboardChecks(value) {
  const planner = value?.planner;
  const ai = value?.workspace?.aiProvider;
  const plannerOnline = planner?.online === true;
  return [
    {
      label: "planner reachable from the function",
      ok: plannerOnline,
      detail: plannerOnline ? "online" : JSON.stringify(planner ?? null).slice(0, 200),
    },
    {
      label: "AI provider configured on the function",
      ok: aiProviderConfigured(ai),
      detail: JSON.stringify(ai ?? null).slice(0, 200),
    },
  ];
}

/**
 * A planner that was idle needs a cold start, and the dashboard waits only
 * LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS (10 s) for it, so the first read after an idle period can
 * report the planner offline with the reason "timeout" although the planner works: that read
 * itself starts it. Only this reason is worth a second read. "off" (not set up or switched off),
 * "rejected" (the token is missing or refused), "unreachable" and "failed" stay failures at once.
 */
export function plannerTimedOut(value) {
  const planner = value?.planner;
  return planner?.online === false && planner.reason === "timeout";
}

/** How long smoke-edge.mjs waits before it reads the dashboard again after a planner timeout. */
export const PLANNER_RETRY_WAIT_MS = 5000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The fetchDashboard checks of smoke-edge.mjs --demo-user: [{ label, ok, detail }]. `fetchOnce`
 * reads the dashboard once and resolves to smoke-edge's call result ({ ok, detail, value }). When
 * the planner only timed out, the dashboard is read once more after `waitMs` and that read
 * decides: a planner that times out twice fails the check.
 */
export async function dashboardSmokeChecks(fetchOnce, { waitMs = PLANNER_RETRY_WAIT_MS, sleep = pause, log = () => {} } = {}) {
  let dash = await fetchOnce();
  let retried = false;
  if (dash.ok && plannerTimedOut(dash.value)) {
    const said = typeof dash.value.planner.error === "string" ? ` (${dash.value.planner.error})` : "";
    log(`the planner timed out${said}; a planner that was idle starts slowly, so the dashboard is read again in ${Math.round(waitMs / 1000)} s`);
    await sleep(waitMs);
    dash = await fetchOnce();
    retried = true;
  }
  const checks = [{ label: "fetchDashboard", ok: dash.ok, detail: retried ? `${dash.detail}, second read` : dash.detail }];
  return dash.ok ? [...checks, ...dashboardChecks(dash.value)] : checks;
}
