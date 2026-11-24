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
