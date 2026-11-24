/**
 * LIFEOPS_MAX_REQUEST_MS: the longest one request can run on the host.
 *
 * Unfinished chat turns and plan requests are shown as interrupted once a window has passed in
 * which they would have finished (for example twice the model timeout plus database work). When
 * the host ends requests earlier than that window, a request it cut off would show as still running
 * until the window ends. The GitHub Pages edition's Supabase Edge Function ends requests after
 * 150 s, so it sets this to a little more than that. Unset (Vercel, local): no cap from this
 * setting. Vercel Hobby itself ends functions after 300 s; the only longer window, the dashboard's
 * "Plan it", is capped at that on hosted sites (planRequestWindowMs in lifeops-backend.server.ts).
 */
export function capToHostLimit(ms: number, env: Record<string, string | undefined> = process.env): number {
  const cap = Number.parseInt(env.LIFEOPS_MAX_REQUEST_MS ?? "", 10);
  return Number.isFinite(cap) && cap > 0 ? Math.min(ms, cap) : ms;
}
