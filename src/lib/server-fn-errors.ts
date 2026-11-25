/**
 * Server-function answers that are not TanStack Start's own, handled the same way in every build
 * (Vercel, local, GitHub Pages). Both halves are installed in src/start.ts.
 *
 * In the browser (guardServerFnResponse): TanStack Start's client (serverFnFetcher) returns any
 * JSON answer that lacks its `x-tss-serialized` header as the function's result, whatever the HTTP
 * status. An error in JSON, such as the Supabase gateway's 546 WORKER_LIMIT or 504, or h3's 500
 * `{ unhandled: true }`, therefore "succeeded": the page got an object without the fields it
 * expected, and "Plan it" for example cleared the user's text and showed no error. The guard turns
 * such answers into a plain-text error with a short sentence (messageForStatus), which
 * serverFnFetcher throws as an Error, so the page's own error handling shows it and keeps what the
 * user typed. A server without serverFnStatusHandler (a build from before it existed) also sends
 * that 500 for a server function it does not have; servers with it answer with a 404 instead.
 *
 * On the server (serverFnStatusHandler): TanStack answers a call to a server function the build
 * does not have, and a payload it cannot read, with HTTP 500. Both are the caller's fault (an
 * out-of-date page after an update, or a hand-made request), so they get 404 and 400 with a
 * sentence an out-of-date page can show as it is: pages built before the guard above existed throw
 * a plain-text error body as an Error too.
 *
 * No Node or Deno APIs here: the module runs in the browser, on Vercel and in the Edge Function.
 */

/** Sentences for the visitor; none names a setting, an address or an internal error. */
export const SERVER_FN_MESSAGES = {
  outdated: "MONDAY may have been updated since this page was opened. Reload the page and try again.",
  unreadable: "This request could not be read. Reload the page and try again.",
  slow: "The server took too long to answer. Please try again in a moment.",
  unavailable: "The server is not available right now. Please try again in a moment.",
  busy: "The server is busy. Please wait a moment and try again.",
  tooLarge: "This request is too large for the server. Please shorten what you entered and try again.",
  failed: "Something went wrong on the server. Please try again.",
} as const;

const SERIALIZED_HEADER = "x-tss-serialized";
const RAW_HEADER = "x-tss-raw";

/**
 * Statuses that only a gateway or the hosting platform sends for a server-function call (bad
 * gateway, unavailable, gateway timeout, Supabase's 546 for a worker that hit its time or
 * resource limit, and the platform's refusals of a request body, address or headers that are too
 * large). The app never answers with them, so their bodies are never a sentence the app wrote.
 */
const PLATFORM_STATUSES = new Set([413, 414, 431, 502, 503, 504, 546]);

/**
 * Vercel's own error answers, whatever their status. Vercel names the error in an
 * `x-vercel-error` header and ends its plain-text body with the request id, which starts with the
 * region, for example (a 414 from the live site, 24 Nov 2026):
 * "An error occurred\n\nURI_TOO_LONG\n\nfra1::bfdqb-1795559271982-f774878aeac9". Its 500 for a
 * crashed function (FUNCTION_INVOCATION_FAILED) would otherwise reach a toast as it is, because a
 * plain-text 500 is also how the app sends its own sentences. The app never sets that header or
 * writes such an id, so its own plain-text errors still pass unchanged.
 */
const PLATFORM_ERROR_HEADER = "x-vercel-error";
const PLATFORM_REQUEST_ID = /^[a-z]{3}\d(?:::[a-z]{3}\d)*::[a-z0-9]+-\d+-[0-9a-f]+\s*$/m;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textResponse(status: number, message: string, statusText = ""): Response {
  return new Response(message, {
    status,
    statusText,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * The sentence for a failed answer that carries no message meant for the visitor.
 *
 * A 500 gets the "failed" sentence, also h3's JSON answer `{ unhandled: true }` to an error thrown
 * outside a server function's own handler. That answer used to mean an unknown function id (an
 * out-of-date page), but serverFnStatusHandler now answers an unknown id with a plain-text 404 and
 * the reload sentence on both editions (the same server bundle), so on a current server it means
 * a real failure, for example in a request middleware, which a reload does not fix.
 */
export function messageForStatus(status: number): string {
  if (status === 504 || status === 546) return SERVER_FN_MESSAGES.slow;
  if (status === 429) return SERVER_FN_MESSAGES.busy;
  if (status === 413 || status === 414) return SERVER_FN_MESSAGES.tooLarge;
  // A 404 in JSON comes from a gateway (the Supabase gateway when the function is not deployed);
  // TanStack's own JSON 404 (notFound()) is passed on before this is asked.
  if (status === 502 || status === 503 || status === 404) return SERVER_FN_MESSAGES.unavailable;
  return SERVER_FN_MESSAGES.failed;
}

/**
 * Checks one server-function answer in the browser and replaces an error the TanStack client
 * would misread (see the top of this file). Everything TanStack understands passes unchanged:
 * successful answers, serialized results and errors, raw responses, its notFound() and redirect
 * answers, and plain-text errors the app wrote ("Unauthorized: ..." from the sign-in check, which
 * the pages recognise as a signed-out state, or "Chat session not found"). A plain-text answer
 * from the hosting platform itself (see PLATFORM_ERROR_HEADER) gets a sentence instead.
 */
export async function guardServerFnResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  if (response.headers.get(SERIALIZED_HEADER) || response.headers.get(RAW_HEADER) === "true") return response;

  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const isJson = type.includes("json");
  const isHtml = type.includes("text/html");
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  const fromPlatform =
    PLATFORM_STATUSES.has(response.status) ||
    response.headers.has(PLATFORM_ERROR_HEADER) ||
    PLATFORM_REQUEST_ID.test(text);
  if (type && !isJson && !isHtml && !fromPlatform) return response;

  let body: unknown;
  if (isJson) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (isRecord(body) && (body.isNotFound === true || body.isSerializedRedirect === true)) return response;

  const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
  console.warn(`[lifeops] A server function answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  return textResponse(response.status, messageForStatus(response.status), response.statusText);
}

/* ------------------------------------------------------------------------------------------
 * Server side
 * ---------------------------------------------------------------------------------------- */

/**
 * The errors TanStack Start's generated resolver (getServerFnById) throws for an id the build
 * does not serve to browsers. It runs outside the server function's own error handling, so the
 * error reaches the request middleware.
 */
const UNKNOWN_SERVER_FN =
  /^Server function (?:info not found|module not resolved|module export not resolved|not accessible from client)\b/;

/** 404 with the "reload" sentence for an unknown server-function id, otherwise null. */
export function unknownServerFnResponse(error: unknown): Response | null {
  if (!(error instanceof Error) || !UNKNOWN_SERVER_FN.test(error.message)) return null;
  console.warn(`[lifeops] ${error.message} (an out-of-date page or a hand-made request); answered 404`);
  return textResponse(404, SERVER_FN_MESSAGES.outdated);
}

/**
 * 400 when the request's payload is not JSON at all, otherwise null. TanStack parses the payload
 * of a GET from `?payload=` and of a POST from a JSON body (the browser sends no body, and no
 * content type, when a function has no input). The body is read from a copy, so TanStack can
 * still read the original.
 */
export async function unreadablePayloadResponse(request: Request): Promise<Response | null> {
  let raw: string | null = null;
  if (request.method === "GET") {
    raw = new URL(request.url).searchParams.get("payload") || null;
  } else if (request.method === "POST" && (request.headers.get("content-type") ?? "").includes("application/json")) {
    raw = await request.clone().text();
  }
  if (raw === null) return null;
  try {
    JSON.parse(raw);
    return null;
  } catch {
    console.warn("[lifeops] A server-function call sent a payload that is not JSON; answered 400");
    return textResponse(400, SERVER_FN_MESSAGES.unreadable);
  }
}

/**
 * The messages seroval (TanStack's serializer) gives every failure to turn the request's JSON
 * back into values: its production build says "step: 3" (deserialization), its development build
 * (vite dev) says it in words. It wraps all its specific errors in this one. Only the request
 * payload is deserialized on the server, so a server function's own errors never carry it.
 */
const PAYLOAD_NOT_READABLE = [
  "Seroval Error (step: 3)",
  "Seroval caught an error during the deserialization process",
];

/** 400 when TanStack answered 500 because it could not read a JSON payload, otherwise null. */
export async function unreadablePayloadAnswer(response: Response): Promise<Response | null> {
  if (response.status !== 500 || !response.headers.get(SERIALIZED_HEADER)) return null;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return null;
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  if (!PAYLOAD_NOT_READABLE.some((marker) => text.includes(marker))) return null;
  console.warn("[lifeops] A server-function call sent a payload that could not be read; answered 400");
  return textResponse(400, SERVER_FN_MESSAGES.unreadable);
}

/**
 * The body of the request middleware in src/start.ts. It leaves page requests and every real
 * server-function answer (results and the functions' own errors) as they are.
 */
export async function serverFnStatusHandler<T extends { response: Response }>(ctx: {
  request: Request;
  handlerType: "serverFn" | "router";
  next: () => T | Promise<T>;
}): Promise<T | Response> {
  if (ctx.handlerType !== "serverFn") return ctx.next();
  const refused = await unreadablePayloadResponse(ctx.request);
  if (refused) return refused;
  let result: T;
  try {
    result = await ctx.next();
  } catch (error) {
    const response = unknownServerFnResponse(error);
    if (response) return response;
    throw error;
  }
  const answer = result.response instanceof Response ? await unreadablePayloadAnswer(result.response) : null;
  return answer ?? result;
}
