# GitHub Pages edition

LifeOps also runs at **<https://gopalinternship-unibasel.github.io/lifeops-ai/>**, next to the Vercel
deployment (`VERCEL_DEPLOYMENT.md`). It is the same code, the same Supabase project (same data and
sign-in) and the same planner.

GitHub Pages serves only static files, and LifeOps needs a server: its 28 server functions run with
server-only secrets (the AI key, the Supabase secret key, the planner token). So the Pages edition has
two halves:

| Part                   | Where                                                                     | Released by                                                                                     |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Pages and browser code | GitHub Pages, project site `/lifeops-ai/`                                 | `.github/workflows/pages.yml`, started by `npm run release:pages`                               |
| Server functions       | Supabase Edge Function `lifeops-api` in the app's Supabase project (Deno) | `npm run release:pages` (from a computer, on `main`)                                            |
| Database and sign-in   | The same Supabase project as the Vercel deployment                        | (unchanged)                                                                                     |
| Planner (FastAPI)      | The same Vercel project `lifeops-planner`, called with its own token      | (unchanged once the function's `LIFEOPS_BACKEND_TOKEN` is set and accepted; see below)         |
| AI model               | Cloudflare Workers AI, the same account and models                        | (unchanged once the function's `LLM_BASE_URL` and `LLM_API_KEY` are set; see below)            |

The function reaches the planner and the AI model only once its three secrets are set ("Settings and
secrets of the function" below). `npm run release:pages` checks that they exist
before it deploys, and its smoke test fails while the function cannot use the planner or has no AI
provider set up (a wrong AI key shows only in an AI call, for example with the smoke test's `--chat`).

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
6. An error the TanStack client cannot read by itself, such as the Supabase gateway's 546 or 504 in
   JSON, becomes a short sentence in the browser (`src/lib/server-fn-errors.ts`, installed by
   `src/start.ts` in every build, Vercel included). Without that check TanStack took such an answer for
   the function's result: "Plan it", for example, cleared the text and showed no error. On the server,
   a call to a server function the build does not have answers 404 and an unreadable payload 400,
   instead of TanStack's 500.

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

`scripts/pages/release.mjs` releases both halves from one commit of `main`, because the Pages client
calls the function's server functions by an id made from their file path and export name. Run it from
`main`. It:

1. stops unless the working tree is clean, the branch is `main`, `HEAD` is pushed and CI passed for it
   (`--skip-ci-check` skips the CI check). The `github-pages` environment publishes from `main` only, so
   a release from another branch would deploy that branch's server code and then fail to publish the
   site;
2. runs `scripts/pages/deploy-function.mjs`, which lists the project's secrets (names only) and stops
   while `LLM_BASE_URL`, `LLM_API_KEY` or `LIFEOPS_BACKEND_TOKEN` is missing (`--allow-missing-secrets`
   deploys anyway), builds, applies `supabase/functions/lifeops-api/settings.env`
   (`supabase secrets set --env-file`), names project secrets that `settings.env` no longer lists
   (`--prune=NAME,NAME` unsets the ones named; see below) and deploys the function
   (`supabase functions deploy lifeops-api --no-verify-jwt --use-api`: bundled by Supabase, no Docker,
   limit 5 MB);
3. runs the smoke test against the function as a new anonymous demo user (`--demo-user`, see "Checks"),
   which also fails while the function cannot use the planner or has no AI provider set up. The
   function is deployed by then: the script says so and how to publish the same commit once the cause
   is fixed;
4. starts the Pages workflow on `main` for exactly that commit
   (`gh workflow run pages.yml --ref main -f sha=<commit>`), so a push to `main` in the meantime does not
   change what is published, then waits for the run (`gh run watch --exit-status`). If the workflow
   fails, the script fails too and says so: the function then runs the new commit and the site the old
   one until the workflow passes (`gh run rerun <id>`, or a new release from `main`). `--no-wait` only
   starts the workflow.

When `supabase/migrations` has new files, apply them to the shared project before the release, in the
order of `VERCEL_DEPLOYMENT.md`, section 5.1, and release the planner and both editions together, the
planner first (same section): the server code expects them. Without the migrations of 24 Nov 2026, for example, the new code refuses every AI request
while an `AI_*` limit is set ("The demo's usage limits could not be checked right now. Please try again
in a moment.").

The workflow checks that the commit it builds is on `main`; started by hand without `sha`, it builds
the head of `main`. The script reads the public build values from the environment or from the
repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. `npm run deploy:pages-function`
runs step 2 alone and warns when the branch is not `main` or the working tree has changes, because the
site is then not on the same commit as the function. The Supabase CLI is found on the PATH, in
`SUPABASE_CLI`, or in `~/tools/supabase/`.

JWT verification by the Supabase gateway is off for this function (`verify_jwt = false` in
`supabase/config.toml` and `--no-verify-jwt`): the CORS preflight carries no token, and the function's
code checks the token of every call.

## First-time setup

1. Repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (they exist for `smoke.yml`), and
   GitHub Pages with "GitHub Actions" as its source
   (`gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow`).
2. The function's three secrets (below) and the planner's extra token, then a redeploy of the planner.
   `npm run release:pages` stops while one of the three is missing.
3. Merge to `main`, wait for CI, run `npm run release:pages` on `main`.
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

Deleting a line from `settings.env` does not remove the setting: `supabase secrets set --env-file`
adds and overwrites names but never removes one, so the old value stays in force on the project. The
deploy names such settings (they are on the project but not in the file); remove them with
`supabase secrets unset NAME --remote=<project>`, or deploy with `--prune=NAME,NAME`, which unsets the
names given. Function secrets belong to the whole Supabase project, not to one function, so a secret
that another function of the project uses would be named too: that is why `--prune` takes the names
(only `lifeops-api` exists today). A bare `--prune`, or a name that is not on the list, stops the
deploy before anything changes. The three secrets below and Supabase's own `SUPABASE_` names are
never unset that way.

Three secrets are set separately and never written to the repository:

| Secret                  | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| `LLM_API_KEY`           | the Cloudflare Workers AI token (the same as on Vercel)          |
| `LLM_BASE_URL`          | `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1` |
| `LIFEOPS_BACKEND_TOKEN` | a token of its own for the planner                               |

Set them with `supabase secrets set --env-file <file> --remote=<project>` from a file outside the
repository (delete it afterwards), or in the Supabase dashboard (Edge Functions, Secrets). The function
reads a new secret at once, without a redeploy (Supabase's secrets guide, read 24 Nov 2026);
`supabase secrets list --remote=<project>` shows which names are set. The planner accepts the
function's token through `LIFEOPS_BACKEND_EXTRA_TOKENS` in the Vercel project `lifeops-planner`
(`vercel env add LIFEOPS_BACKEND_EXTRA_TOKENS --environment production --sensitive`), next to the web
app's `LIFEOPS_BACKEND_TOKEN`; redeploy the planner after changing it, and add the token there before
the function starts sending it. Either token can then be replaced without the other.

What visitors get while a secret is missing (the function also names the missing ones in its log
when a worker starts: `lifeops-api: function secrets not set: ...`):

| Missing                                                | Visitors see                                                                                                                                                                                                                 | The function's log says                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LLM_BASE_URL`                                         | Chat, week plans and reply drafts answer "The AI assistant is not set up on this site yet, so this request could not be answered." The dashboard's AI badge says "AI not set up on this site". No local model is tried. | `[llm] No AI provider is set on this hosted deployment (LLM_BASE_URL is empty); the request was not sent.` (a `[plan]` line that starts the same way for week plans) |
| `LLM_API_KEY`, or a wrong one                          | "The AI assistant is not set up correctly on this site right now. Please try again later." (when Cloudflare refuses the key with 401 or 403)                                                                             | `[llm] Cloudflare Workers AI rejected the API key (HTTP 401); check LLM_API_KEY.`                           |
| `LIFEOPS_BACKEND_TOKEN`, or one the planner does not accept | The dashboard's planner badge "Planner service unavailable — in-app assistant" and "The planner service is not set up correctly for this site."; "Plan it" answers with the in-app assistant instead.           | `[lifeops] planner GET /api/dashboard: HTTP 401: ...` (no token is sent while the secret is unset)          |

`SUPABASE_URL` and the project's keys are injected by Supabase. Names starting with `SUPABASE_` are
reserved there, so `index.ts` derives the `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` the
server code reads from `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` (or the legacy names).
Function secrets belong to the whole Supabase project, so every function deployed there could read them;
today `lifeops-api` is the only one.

## Differences from the Vercel deployment

- **Time per request.** Supabase answers 504 when a request sends nothing for 150 s (the request idle
  timeout, on every plan). Separately, a function worker lives at most 150 s on the Free plan and 400 s
  on paid plans (the wall clock, counted per worker), and one worker can serve several requests in that
  time (Supabase's limits page, read 24 Nov 2026). Vercel allows 300 s per request. So `LLM_TIMEOUT_MS`
  is 40000 (Vercel: 60000), `LIFEOPS_BACKEND_TIMEOUT_MS` is 55000 (the planner's own model timeout is
  45 s; the request asks the planner to stop a few seconds before 55 s, and a plan it finishes later is
  not stored, so "Plan it" then answers with the in-app assistant without leaving a second set of
  proposals), and `LIFEOPS_MAX_REQUEST_MS` is 160000, so a request Supabase cut off shows as interrupted
  after 160 s instead of up to 5 minutes later. The longest "Plan it" request the code allows is about
  55 s for the planner, then a chat turn of up to 40 s (plus 40 s on the fallback model after a 401,
  403, 404, 429 or 503), plus database work: that stays under the 150 s idle timeout. The wall clock is
  not bounded this way: a long request that lands on a worker that is already warm may be cut short with
  546 ("wall clock time limit reached") sooner, however short the timeouts are. It then shows as
  interrupted and can be tried again. Answer times measured on the Vercel edition with the same model
  (November 2026): about 30 s for a week plan, about 27 s for the first-visit briefing and 2 to 6 s for
  other chat turns, so a week plan has about 10 s to spare under the 40 s model timeout. 60000 as on
  Vercel would give more room, but the longest "Plan it" could then pass 150 s.
- **CPU time.** Supabase allows 2 s of CPU per worker (waiting for the model or the database does not
  count). Very heavy requests would show as `CPU Time exceeded` in the function's logs.
- **Shared origin.** All GitHub Pages sites of one account share the origin
  `https://gopalinternship-unibasel.github.io`, so the Origin check lets every one of them call the
  function, and the browser's stored Supabase session is readable by scripts of those sites. Host only
  trusted pages on this account, or give the Pages edition its own domain.
- **Google.** Connecting Gmail and Google Calendar is not set up on either deployment; both use the demo
  inbox and calendar. The Google OAuth callback is a server route that the Pages edition does not serve.
- **Shared limits.** The demo limits (`AI_*`) are counted in the shared database (see
  `VERCEL_DEPLOYMENT.md`, section 4), so a user's requests on both editions count together. Both
  editions use the same Cloudflare daily allowance.
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
calls real server functions. It also fails when the dashboard shows that the function cannot use the
planner (offline, token refused or too slow: `FAIL planner reachable from the function`) or has no AI
provider set up (`FAIL AI provider configured on the function`), without making an AI call: the
dashboard itself answers 200 in both cases. A planner that was idle needs a cold start and can miss the
dashboard's 10 s (`LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS`), so when the planner only timed out, the
smoke test prints a `WAIT` line and reads the dashboard once more 5 s later; a second timeout fails.
Every other planner problem (switched off, not set up, token refused, unreachable, a server error)
fails at once. A wrong `LLM_API_KEY` passes this check; only an AI call
(`--chat`) shows it. `npm run release:pages` and the daily `smoke.yml` use `--demo-user`.
`--chat` adds one chat turn (uses the AI allowance). CI (on every push to `main` and every pull request
to it) builds the Pages edition, type-checks the function with Deno and runs the local Deno check (job
`pages` in `ci.yml`); that local check runs without the secrets and without `--demo-user`.

## Common errors

The sentences in quotes are what visitors read; the function's logs are in the Supabase dashboard
(Edge Functions, `lifeops-api`, Logs).

| What you see                                                                                                                         | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every action fails with "Could not reach MONDAY. Check your connection and try again." (the browser's "Failed to fetch")             | The page's Origin is not in `LIFEOPS_ALLOWED_ORIGINS` (the function answers 403 without CORS headers), or the network is down. A function that is not deployed may show this row or the next one, depending on how the gateway answers the browser's preflight (not checked).                                                                                                                                                                                                                                                                                                                                                              |
| Every action fails with "The server is not available right now. Please try again in a moment."                                       | The function could not start (503; its log says `lifeops-api: start-up failed` and why), the gateway answered 502 or 503, or the function is not deployed (the gateway's 404). Deploy with `npm run release:pages`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| "Not found" from the function                                                                                                        | The client and the function were built with different app paths (`LIFEOPS_PAGES_BASE` / `LIFEOPS_APP_BASE`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| "MONDAY may have been updated since this page was opened. Reload the page and try again."                                            | The page called a server function this build of the function does not have (HTTP 404; the log says `Server function info not found for <id>`). Usually a tab opened before a release in which a server function was renamed, moved or removed: reloading fixes it. If it stays after a reload, the function and the Pages site come from different commits: run `npm run release:pages` on `main`. A function built from a commit before this 404 existed (one without `src/lib/server-fn-errors.ts`) answers with HTTP 500 instead, and the page then shows "Something went wrong on the server. Please try again."; the fix is the same. |
| Validation errors or wrong data after a release                                                                                      | Same cause as the row above when a server function's input changed: reload, and if it stays, release both halves again from `main`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| "Missing Supabase environment variable(s)"                                                                                           | The function could not derive the Supabase keys; check the function's logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| "The AI assistant is not set up on this site yet, so this request could not be answered." and the badge "AI not set up on this site" | `LLM_BASE_URL` is not set as a function secret. Set it, and `LLM_API_KEY`, as in "Settings and secrets of the function"; no redeploy is needed. Check with `supabase secrets list --remote=<project>`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| "Could not reach Ollama at http://localhost:11434/v1 ..." in a chat                                                                  | A message stored before the hosted sites stopped falling back to a local model (old chat history keeps it). If a new request shows it, the function bundle was built without `VITE_HOSTED_DEMO=true` (the default of `scripts/pages/build.mjs`): rebuild and deploy with the default, or add `LIFEOPS_HOSTED=1` to `settings.env`.                                                                                                                                                                                                                                                                                                         |
| "The AI assistant is not set up correctly on this site right now. Please try again later."                                           | Cloudflare refused the key or the model: `LLM_API_KEY` is missing or wrong, or `LLM_MODEL` / `LLM_FALLBACK_MODEL` is not served. The function's log names which.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The planner badge "Planner service unavailable — in-app assistant" and "The planner service is not set up correctly for this site."  | The planner refused the function's token (HTTP 401 in the log): the secret `LIFEOPS_BACKEND_TOKEN` is not set on the function (then no token is sent at all), or it is not in the planner's `LIFEOPS_BACKEND_EXTRA_TOKENS`, or the planner was not redeployed after that changed.                                                                                                                                                                                                                                                                                                                                                          |
| The planner badge "Planner service offline — in-app assistant" and "The planner service could not be reached."                       | `LIFEOPS_BACKEND_URL` in `settings.env` is wrong, or the planner is down (open its address: `/` answers `status: ok`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| "The server took too long to answer. Please try again in a moment." (546 or 504 in the browser's network tab)                        | The gateway's idle timeout, the worker's wall clock or the CPU limit was reached (see "Time per request"); the function's logs say which (`wall clock time limit reached`, `CPU Time exceeded`).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| "Something went wrong on the server. Please try again."                                                                              | The function failed while handling the request (HTTP 500; its log says `lifeops-api: request failed` and why). Other error answers the page cannot read by itself, such as a gateway's error page, show the same sentence; the browser console then has a line `[lifeops] A server function answered HTTP <status>: ...` with what the server sent. A Pages site released ahead of an older function shows it too, in place of the reload sentence (see that row).                                                                                                                                                                         |
| "This request is too large for the server. Please shorten what you entered and try again." (413 or 414)                              | The gateway refused a request body or address that was too large for it; the browser console line `[lifeops] A server function answered HTTP <status>: ...` shows what it sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `release:pages` or `deploy:pages-function` stops: "the function secrets ... are not set"                                             | Set them (above), or pass `--allow-missing-secrets` to deploy anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The smoke test reports `FAIL planner reachable from the function` or `FAIL AI provider configured on the function`                   | See the planner and AI rows above; the smoke test prints what the dashboard returned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
