/**
 * Where the browser sends server-function calls.
 *
 * On Vercel and locally the server functions run on the page's own origin, so the relative URL
 * TanStack Start builds ("/_serverFn/<id>") is used as it is. The GitHub Pages build has no
 * server: it is built with VITE_SERVER_FN_ORIGIN set to the Supabase Edge Function that runs the
 * same server code (https://<project>.supabase.co/functions/v1/lifeops-api), and every
 * server-function URL is prefixed with it.
 */
export function normalizeServerFnOrigin(raw: string | undefined | null): string | undefined {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return undefined;
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`VITE_SERVER_FN_ORIGIN must start with http:// or https:// (got "${value}")`);
  }
  return value;
}

export function toServerFnUrl(input: RequestInfo | URL, origin: string | undefined): RequestInfo | URL {
  if (!origin) return input;
  // TanStack Start passes the relative URL as a string ("/lifeops-ai/_serverFn/<id>[?payload=...]").
  if (typeof input === "string" && input.startsWith("/") && !input.startsWith("//")) return origin + input;
  return input;
}
