/**
 * Request handling of the Supabase Edge Function "lifeops-api" (see PAGES_DEPLOYMENT.md).
 *
 * The function runs the LifeOps server code for the GitHub Pages build of the app. It is the
 * server-function endpoint only: the Pages site sends every TanStack Start server-function call
 * here (src/start.ts), and this handler
 *   1. answers the browser's CORS preflight and refuses any Origin that is not allowed,
 *   2. strips the function's own path prefix so the server code sees /<app base>/_serverFn/<id>,
 *   3. hands the call on as a same-origin request (TanStack Start's CSRF check expects that; the
 *      Origin was checked in step 1), and
 *   4. adds the CORS headers to the answer, including the TanStack headers the client must read.
 *
 * No Deno APIs here, so the Node tests in tests/pages-edge-handler.test.ts can import it.
 */

export interface FetchApp {
  fetch(request: Request): Response | Promise<Response>;
}

export interface HandlerOptions {
  /** The function's name, the first path segment Supabase routes to it ("lifeops-api"). */
  functionName: string;
  /** The app's base path the server code was built with, without a trailing slash ("/lifeops-ai"). */
  appBase: string;
  /** Exact Origin values allowed to call the function. */
  allowedOrigins: ReadonlySet<string>;
  /** Loads the TanStack Start server (once). */
  loadApp: () => Promise<FetchApp>;
  log?: (message: string, error?: unknown) => void;
}

/** Request headers the browser sends: the app's bearer token plus TanStack's own headers. */
export const ALLOW_HEADERS = "authorization, apikey, x-client-info, content-type, accept, x-tsr-serverfn";
/** Response headers the client must be able to read across origins (serverFnFetcher checks them). */
export const EXPOSE_HEADERS = "x-tss-serialized, x-tss-raw, content-type";

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Expose-Headers": EXPOSE_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function normalizeAppBase(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "";
}

export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

/**
 * The path the server code expects, or null when the request is not a server-function call.
 * Supabase hands the function "/<name>/rest"; "/functions/v1/<name>/rest" is accepted as well.
 */
export function serverFnPath(pathname: string, functionName: string, appBase: string): string | null {
  let path = pathname;
  for (const prefix of [`/functions/v1/${functionName}`, `/${functionName}`]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length) || "/";
      break;
    }
  }
  const expected = `${appBase}/_serverFn/`;
  if (!path.startsWith(expected) || path.length === expected.length) return null;
  return path;
}

function withCors(response: Response, origin: string): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(corsHeaders(origin))) out.headers.set(name, value);
  return out;
}

export function createHandler(opts: HandlerOptions): (request: Request) => Promise<Response> {
  const log = opts.log ?? ((message: string, error?: unknown) => console.error(message, error ?? ""));

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const allowed = origin !== null && opts.allowedOrigins.has(origin);

    if (request.method === "OPTIONS") {
      return allowed ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
    }
    // Browsers always send Origin on these cross-origin calls; anything else is not the Pages app.
    if (!allowed) return new Response("Origin not allowed", { status: 403 });
    if (request.method !== "GET" && request.method !== "POST") {
      return withCors(new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST, OPTIONS" } }), origin);
    }

    const url = new URL(request.url);
    const path = serverFnPath(url.pathname, opts.functionName, opts.appBase);
    if (!path) return withCors(new Response("Not found", { status: 404 }), origin);
    url.pathname = path;

    // Same-origin request for TanStack Start's CSRF check (the real Origin was allow-listed above).
    const headers = new Headers(request.headers);
    headers.delete("sec-fetch-site");
    headers.delete("referer");
    headers.set("origin", url.origin);
    const hasBody = request.method === "POST";
    const inner = new Request(url, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      signal: request.signal,
      ...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
    });

    let response: Response;
    try {
      const app = await opts.loadApp();
      response = await app.fetch(inner);
    } catch (error) {
      if (error instanceof Response) {
        response = error;
      } else {
        log("lifeops-api: request failed", error);
        response = new Response("Internal Server Error", { status: 500 });
      }
    }
    return withCors(response, origin);
  };
}
