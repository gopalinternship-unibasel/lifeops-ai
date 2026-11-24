/**
 * Whether this server runs as the public hosted demo (Vercel, or the Supabase Edge Function behind
 * the GitHub Pages edition) rather than a local run.
 *
 * Visitors of the hosted demo are end users: messages shown to them must not contain developer
 * instructions (environment variable names, localhost addresses, docker commands). Those details go
 * to the server log instead. A local run keeps the developer wording, because the person reading it
 * is the one who can fix the setting.
 *
 * Both hosted builds set VITE_HOSTED_DEMO=true (Vercel project settings; scripts/pages/build.mjs),
 * and Vite inlines it into the server code as well. LIFEOPS_HOSTED=1 at run time also counts.
 */
export function isHostedDeployment(
  hostedDemoFlag: string | undefined = import.meta.env?.VITE_HOSTED_DEMO as string | undefined,
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): boolean {
  return hostedDemoFlag?.trim() === "true" || env.LIFEOPS_HOSTED?.trim() === "1";
}
