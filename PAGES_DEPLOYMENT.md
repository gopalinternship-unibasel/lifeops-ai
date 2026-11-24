# GitHub Pages edition

LifeOps also runs at **<https://gopalinternship-unibasel.github.io/lifeops-ai/>**, next to the Vercel
deployment (`VERCEL_DEPLOYMENT.md`). It is the same code, the same Supabase project (same data and
sign-in) and the same planner.

GitHub Pages serves only static files, and LifeOps needs a server: its 28 server functions run with
server-only secrets (the AI key, the Supabase secret key, the planner token). So the Pages edition has
two halves:

| Part                   | Where                                                                     | Released by                                                       |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Pages and browser code | GitHub Pages, project site `/lifeops-ai/`                                 | `.github/workflows/pages.yml`, started by `npm run release:pages` |
| Server functions       | Supabase Edge Function `lifeops-api` in the app's Supabase project (Deno) | `npm run release:pages` (from a computer)                         |
| Database and sign-in   | The same Supabase project as the Vercel deployment                        | (unchanged)                                                       |
| Planner (FastAPI)      | The same Vercel project `lifeops-planner`, called with its own token      | (unchanged)                                                       |
| AI model               | Cloudflare Workers AI, the same account and models                        | (unchanged)                                                       |

## How a request travels

1. The browser loads the static files from GitHub Pages. Deep links such as `/lifeops-ai/app/plan` are
   served by `404.html`, a copy of the app shell, and the router then shows the right page.
2. Sign-in talks to Supabase directly, as on Vercel (anonymous demo sign-in, email and password).
3. A server-function call (for example a chat message) goes to
   `https://<project>.supabase.co/functions/v1/lifeops-api/lifeops-ai/_serverFn/<id>` instead of the
   page's own origin. `src/start.ts` prefixes the URL when the build has `VITE_SERVER_FN_ORIGIN`;
   `src/lib/auth-context.tsx` adds the user's Supabase token, and only to the app's own server-function
   URLs.
4. The function (`supabase/functions/lifeops-api/`) answers the browser's CORS preflight, refuses every
   Origin except `https://gopalinternship-unibasel.github.io`, removes its own path prefix and hands
   the call to the TanStack Start server code as a same-origin request. That code is the same as on
   Vercel, bundled for Deno; it checks the user's token (`requireSupabaseAuth`) and does the work.
5. The answer goes back with the CORS headers, including `x-tss-serialized` and `x-tss-raw`, which the
   TanStack client must be able to read.

## Building

```bash
# public values only; the publishable key is the one every browser receives
VITE_SUPABASE_URL=https://<project>.supabase.co \
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
VITE_SERVER_FN_ORIGIN=https://<project>.supabase.co/functions/v1/lifeops-api \
npm run build:pages
```

`scripts/pages/build.mjs` runs `vite build` with `LIFEOPS_PAGES=1`. `vite.config.ts` then switches on
TanStack Start's SPA mode under the base path `/lifeops-ai/` (no nitro) and writes:

- `dist-pages/client/`: the Pages files. `_shell.html` is copied to `index.html` and `404.html`, and an
  empty `.nojekyll` is added.
- `supabase/functions/lifeops-api/server.mjs`: `dist-pages/server` and its packages bundled with
  esbuild into one file Deno can load (about 1.6 MB; only `node:` built-ins stay external; local file
  paths are made relative). Not in git.

The script refuses a function URL that is not `https://` (except localhost), and stops when `.env`,
`.env.local` or `.env.production*` define a `VITE_` value that is not set in the environment, because
every `VITE_` value ends up in the public files. `--client` skips the function bundle (the Pages
workflow uses it). `VITE_ENABLE_ANONYMOUS_DEMO`, `VITE_ENABLE_GOOGLE_SIGNIN` and `VITE_HOSTED_DEMO`
default to `true`, `false` and `true`, as on Vercel.

The other builds are unchanged: `npm run build` (CI, local) and `NITRO_PRESET=vercel npm run build`
(Vercel) do not set `LIFEOPS_PAGES` and keep server functions on their own origin.

## Releasing

```bash
npm run release:pages
```

`scripts/pages/release.mjs` releases both halves from one commit, because the Pages client calls the
function's server functions by an id made from their file path and export name. It:

1. stops unless the working tree is clean, `HEAD` is pushed and CI passed for it (`--skip-ci-check`
   skips the CI check);
2. builds, applies `supabase/functions/lifeops-api/settings.env` (`supabase secrets set --env-file`),
   deploys the function (`supabase functions deploy lifeops-api --no-verify-jwt --use-api`: bundled by
   Supabase, no Docker, limit 5 MB) and runs the smoke test against it;
3. starts the Pages workflow for the same branch (`gh workflow run pages.yml`), which builds and
   publishes the browser files.

It reads the public build values from the environment or from the repository variables
`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. `npm run deploy:pages-function` runs step 2 alone. The
Supabase CLI is found on the PATH, in `SUPABASE_CLI`, or in `~/tools/supabase/`.

JWT verification by the Supabase gateway is off for this function (`verify_jwt = false` in
`supabase/config.toml` and `--no-verify-jwt`): the CORS preflight carries no token, and the function's
code checks the token of every call.

## First-time setup

1. Repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (they exist for `smoke.yml`), and
   GitHub Pages with "GitHub Actions" as its source
   (`gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow`).
2. The function's three secrets (below) and the planner's extra token, then a redeploy of the planner.
3. Merge to `main`, wait for CI, run `npm run release:pages`.
4. Optional: the repository variable `PAGES_URL` (`https://gopalinternship-unibasel.github.io/lifeops-ai/`)
   so the daily `smoke.yml` checks the Pages site and the function too.
5. Optional: in Supabase, Authentication, URL Configuration, add the redirect URL
   `https://gopalinternship-unibasel.github.io/lifeops-ai/**`. It is only used by email confirmation
   and Google sign-in, which are both off in the demo. Do not add the whole origin with a wildcard
   (`https://gopalinternship-unibasel.github.io/**`): every Pages site of the account shares it.

### Settings and secrets of the function

`supabase/functions/lifeops-api/settings.env` holds the non-secret settings: the allowed Origin and
app path, the models, the timeouts, the planner's URL and the demo limits (the same values as on
Vercel except the timeouts below).

Three secrets are set separately and never written to the repository:

| Secret                  | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| `LLM_API_KEY`           | the Cloudflare Workers AI token (the same as on Vercel)          |
| `LLM_BASE_URL`          | `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1` |
| `LIFEOPS_BACKEND_TOKEN` | a token of its own for the planner                               |

Set them with `supabase secrets set --env-file <file> --remote=<project>` from a file outside the
repository (delete it afterwards), or in the Supabase dashboard (Edge Functions, Secrets). The planner
accepts the function's token through `LIFEOPS_BACKEND_EXTRA_TOKENS` in the Vercel project
`lifeops-planner` (`vercel env add LIFEOPS_BACKEND_EXTRA_TOKENS --environment production --sensitive`),
next to the web app's `LIFEOPS_BACKEND_TOKEN`; redeploy the planner after changing it, and add the token
there before the function starts sending it. Either token can then be replaced without the other.

`SUPABASE_URL` and the project's keys are injected by Supabase. Names starting with `SUPABASE_` are
reserved there, so `index.ts` derives the `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` the
server code reads from `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` (or the legacy names).
Function secrets belong to the whole Supabase project, so every function deployed there could read them;
today `lifeops-api` is the only one.

## Differences from the Vercel deployment

- **Time per request.** Supabase answers 504 when a function sends nothing for 150 s (request idle
  timeout, every plan; the wall clock is 150 s on the Free plan and 400 s on paid plans). Vercel allows
  300 s. So `LLM_TIMEOUT_MS` is 40000 (Vercel: 60000), `LIFEOPS_BACKEND_TIMEOUT_MS` is 55000 (the
  planner's own model timeout is 45 s; a slower planner answer turns into the in-app fallback), and
  `LIFEOPS_MAX_REQUEST_MS` is 160000, so a request Supabase cut off shows as interrupted after 160 s
  instead of up to 5 minutes later. The longest "Plan it" request the code allows is about 55 s for the
  planner, then a chat turn of up to 40 s (plus 40 s on the fallback model after a fast 401, 403, 404,
  429 or 503), plus database work: it should stay under 150 s, and with the usual answer times of a few
  seconds the limit does not come up.
- **CPU time.** Supabase allows 2 s of CPU per worker (waiting for the model or the database does not
  count). Very heavy requests would show as `CPU Time exceeded` in the function's logs.
- **Shared origin.** All GitHub Pages sites of one account share the origin
  `https://gopalinternship-unibasel.github.io`, so the Origin check lets every one of them call the
  function, and the browser's stored Supabase session is readable by scripts of those sites. Host only
  trusted pages on this account, or give the Pages edition its own domain.
- **Google.** Connecting Gmail and Google Calendar is not set up on either deployment; both use the demo
  inbox and calendar. The Google OAuth callback is a server route that the Pages edition does not serve.
- **Shared limits.** The demo limits (`AI_*`) count rows in the shared database, so a user's messages on
  both editions count together. Both editions use the same Cloudflare daily allowance.
- **Pages are drawn in the browser.** Every address gets the same static shell with an empty slot for
  the page, so the Pages build marks every route client-only (`src/router.tsx`, `src/lib/static-shell.ts`)
  and the page appears right after the shell is hydrated. Without that, the landing page logged React
  error #418 (hydration mismatch) and was redrawn. Vercel renders pages on the server as before.
- **Unknown addresses.** An address the app does not have (for example `/lifeops-ai/no-such-page` or
  `/lifeops-ai/index.html`) shows the app's "Page not found" screen, as on Vercel, but logs React error
  #418 once in the browser console. The not-found screen is drawn where the shell has the landing
  route's placeholders; React redraws it and nothing visible is wrong. A catch-all route would remove the
  message but would also change how Vercel answers unknown addresses, so it was left as it is.

## Checks

```bash
npm test                                          # unit tests, incl. tests/pages-edge-handler.test.ts
npm run build:pages                               # build both halves
node scripts/pages/serve-edge-local.mjs           # run the function under Deno 2.1.4 (port 8000), no Docker
node scripts/pages/smoke-edge.mjs --url http://localhost:8000/lifeops-api
node scripts/pages/smoke-edge.mjs --url https://<project>.supabase.co/functions/v1/lifeops-api --demo-user --chat
```

`smoke-edge.mjs` checks the preflight, the Origin allow-list, routing and that the server code answers.
`--demo-user` signs in a new anonymous user (needs `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`) and
calls real server functions; `--chat` adds one chat turn (uses the AI allowance). CI (on every push to
`main` and every pull request to it) builds the Pages edition, type-checks the function with Deno and
runs the local Deno check (job `pages` in `ci.yml`).

## Common errors

| What you see                                                              | Cause and fix                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every action fails with "Failed to fetch"                                 | The function is not deployed, or the page's Origin is not in `LIFEOPS_ALLOWED_ORIGINS`.                                                                            |
| "Not found" from the function                                             | The client and the function were built with different app paths (`LIFEOPS_PAGES_BASE` / `LIFEOPS_APP_BASE`).                                                       |
| "Server function info not found for ...", validation errors or wrong data | The function and the Pages site come from different commits (a server function was added, renamed or moved, or its input changed): run `npm run release:pages`.    |
| "Missing Supabase environment variable(s)"                                | The function could not derive the Supabase keys; check the function's logs in the Supabase dashboard.                                                              |
| The dashboard says the planner is unavailable                             | The function's `LIFEOPS_BACKEND_TOKEN` is not among the planner's accepted tokens, or the planner was not redeployed after `LIFEOPS_BACKEND_EXTRA_TOKENS` changed. |
| 546 or 504 from the function                                              | The time or CPU limit was reached; see the function's logs.                                                                                                        |
