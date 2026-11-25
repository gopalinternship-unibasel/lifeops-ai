/**
 * LIFEOPS_MAX_REQUEST_MS: the longest one request can run on the host.
 *
 * Unfinished chat turns and plan requests are shown as interrupted once a window has passed in
 * which they would have finished (for example twice the model timeout plus database work). When
 * the host ends requests earlier than that window, a request it cut off would show as still running
 * until the window ends. So each window is capped at the host's limit:
 *   - GitHub Pages edition: the Supabase Edge Function ends requests after 150 s, so its settings
 *     set LIFEOPS_MAX_REQUEST_MS a little above that (160000).
 *   - Vercel: functions end after 300 s on the Hobby plan. Vercel sets VERCEL=1 for its functions,
 *     so 300000 applies there when LIFEOPS_MAX_REQUEST_MS is not set (a plan with a longer limit
 *     sets LIFEOPS_MAX_REQUEST_MS to it).
 *   - Local run: no cap.
 */
export const VERCEL_MAX_REQUEST_MS = 300_000;

export function capToHostLimit(ms: number, env: Record<string, string | undefined> = process.env): number {
  const cap = Number.parseInt(env.LIFEOPS_MAX_REQUEST_MS ?? "", 10);
  if (Number.isFinite(cap) && cap > 0) return Math.min(ms, cap);
  if (env.VERCEL?.trim() === "1") return Math.min(ms, VERCEL_MAX_REQUEST_MS);
  return ms;
}
