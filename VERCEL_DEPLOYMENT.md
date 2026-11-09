# Deploying MONDAY to Vercel

MONDAY is a **TanStack Start full-stack application**. It is not a static Vite SPA, so do not configure a static `dist` output directory and do not add a catch-all SPA rewrite.

## 1. Requirements

Use:

- Node.js 22.x
- npm 10.x
- A GitHub repository
- A Supabase project
- A Hugging Face account/token
- A Google Cloud OAuth client when Gmail and Google Calendar are enabled

The project already declares Node 22 and npm 10.9.2 in `package.json`.

## 2. Prepare the project locally

From the folder containing `package.json`:

```bash
copy .env.example .env.local
npm install
npm run format
npm run check
```

On macOS/Linux, use:

```bash
cp .env.example .env.local
```

`npm install` must generate `package-lock.json`. Commit it so Vercel installs the exact dependency tree you tested:

```bash
git add package.json package-lock.json
git commit -m "Prepare MONDAY for Vercel"
```

Do not commit `.env.local`.

## 3. Create and configure Supabase

### 3.1 Create the project

Create a Supabase project and record:

- Project URL, for example `https://abcxyz.supabase.co`
- Publishable key, normally beginning with `sb_publishable_`
- Secret key, normally beginning with `sb_secret_`

The browser and server publishable-key variables should contain the **same publishable key value**. They have different names only because Vite exposes variables beginning with `VITE_` to browser code.

Never use the secret key in a `VITE_` variable.

### 3.2 Apply migrations

Apply every SQL file in `supabase/migrations` in filename order. With the Supabase CLI:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Alternatively, copy each migration into the Supabase SQL Editor in filename order and run it.

### 3.3 Configure authentication

In **Supabase Dashboard → Authentication**:

- Enable Email authentication.
- Enable Google authentication for the app's login button when desired.
- Enable Anonymous Sign-Ins only when using the controlled demo mode.
- Set the Site URL to the final production domain.
- Add redirect URLs for local development, production, and Vercel previews.

Recommended Supabase redirect allow-list entries:

```text
http://localhost:3000/**
http://localhost:5173/**
https://YOUR_PRODUCTION_DOMAIN/**
https://*-YOUR_VERCEL_TEAM_SLUG.vercel.app/**
```

Keep the local URL that `npm run dev` actually prints.

## 4. Configure Google Cloud

This project uses two Google integrations:

1. Supabase Google login
2. MONDAY's direct Gmail/Calendar connector

Create or select a Google Cloud project, then enable:

- Gmail API
- Google Calendar API

Configure the OAuth consent screen. During testing, add each Google account that will connect as a test user.

Create a **Web application** OAuth client and add exact authorised redirect URIs:

```text
https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
http://localhost:3000/api/public/google/callback
http://localhost:5173/api/public/google/callback
https://YOUR_PRODUCTION_DOMAIN/api/public/google/callback
```

You only need the local callback matching the port you use.

Google connector callbacks do not support a wildcard preview URL. For a Vercel preview, either register that exact preview callback temporarily or use a stable staging domain.

The connector requests:

```text
openid
userinfo.email
userinfo.profile
gmail.readonly
gmail.compose
calendar.events
```

Because Gmail scopes are restricted, a public production launch can require Google OAuth verification and possibly further security review.

## 5. Configure Hugging Face

Create a Hugging Face access token that can call the configured models through the Hugging Face inference router.

Make sure:

- The token has inference permission.
- The account can access any gated model used by the application.
- Billing/credits are available if the selected provider requires them.

## 6. Push the project to GitHub

From the project folder:

```bash
git init
git add .
git commit -m "Deploy MONDAY"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

If the repository already exists, use its normal commit/push workflow instead.

## 7. Import the repository into Vercel

1. Open Vercel.
2. Select **Add New → Project**.
3. Import the GitHub repository.
4. If Vercel asks you to install its GitHub integration, install it and grant access to this repository.
5. Set **Root Directory**:
   - Leave it empty when `package.json` is at the repository root.
   - Set it to the application subfolder only when MONDAY is inside a monorepo.
6. Let Vercel detect the framework automatically.
7. Keep the build command as `npm run build`.
8. Do not set an Output Directory.
9. Use Node.js 22.x.

The project uses `@lovable.dev/vite-tanstack-config` `^2.6.2`, which provides the Vercel-compatible TanStack Start configuration.

## 8. Add Vercel environment variables

Open **Project Settings → Environment Variables** and add the following.

### Public browser variables

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_ENABLE_ANONYMOUS_DEMO=false
```

### Server-only variables

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
HUGGINGFACE_API_KEY=hf_...
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_STATE_SECRET=...
```

The values should satisfy:

```text
VITE_SUPABASE_URL == SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY == SUPABASE_PUBLISHABLE_KEY
```

The variable names differ because one pair is embedded in the browser and the other pair is available to server functions.

`SUPABASE_SECRET_KEY`, `HUGGINGFACE_API_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_STATE_SECRET` must remain server-only and must never begin with `VITE_`.

The code also accepts the legacy `SUPABASE_SERVICE_ROLE_KEY` as a fallback, but new deployments should use `SUPABASE_SECRET_KEY`.

Generate the OAuth state secret with at least 32 random characters. For example:

```bash
openssl rand -base64 48
```

Add variables to **Production**. Add them to **Preview** and **Development** only when those deployments should use the same external services. For safer testing, use separate Supabase/Google credentials for Preview.

## 9. Deploy

Click **Deploy** in Vercel.

The equivalent CLI workflow is:

```bash
npm install -g vercel
vercel link
vercel
vercel --prod
```

## 10. Complete the URL configuration after the first deployment

After Vercel provides the production URL:

1. Set the URL as the Supabase Site URL.
2. Add `https://YOUR_DOMAIN/**` to Supabase's redirect allow list.
3. Add `https://YOUR_DOMAIN/api/public/google/callback` to the Google OAuth client.
4. Confirm the same production URL is used consistently; scheme, host, path, port, and trailing slash must match exactly.
5. Redeploy after changing Vercel environment variables.

A custom domain is strongly recommended for stable Google OAuth callbacks.

## 11. Production verification

Test in an incognito window:

- Email signup, confirmation, login, and logout
- Supabase Google login
- Anonymous demo when enabled
- Profile create/update
- Direct loading of `/app`, `/app/plan`, and `/app/calendar`
- Google connector authorization
- Gmail inbox listing
- Gmail reply suggestion
- Saving an edited reply as a Gmail draft without sending it
- Calendar list/create/update/delete
- Demo calendar list/create/update/delete when Google is not connected
- Weekly-plan generation and approval in both Google and demo modes
- AI chat responses
- Time-zone correctness around midnight and daylight-saving changes
- Isolation between two different user accounts
- Vercel function logs for missing variables, OAuth errors, or provider errors

## 12. Common errors

### Vercel says “Install the GitHub integration first”

Install/configure the Vercel GitHub App for the correct personal account or organisation and grant it access to the repository. An organisation administrator may need to approve it.

### Vercel builds the wrong folder

Set **Root Directory** to the folder that directly contains MONDAY's `package.json`. Leave it empty for this standalone archive.

### Framework is not detected

Confirm `package.json` contains:

```json
"@lovable.dev/vite-tanstack-config": "^2.6.2"
```

Then redeploy without the old build cache. Do not manually add duplicate TanStack/React/Tailwind Vite plugins.

### Lockfile error or inconsistent dependencies

Run locally with Node 22:

```bash
rm -rf node_modules package-lock.json
npm install
npm run check
```

On Windows PowerShell:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item package-lock.json -ErrorAction SilentlyContinue
npm install
npm run check
```

Commit the resulting `package-lock.json`.

### Missing Supabase environment variables

Check that all five relevant values are present:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
```

Redeploy after adding or changing them.

### `redirect_uri_mismatch`

Copy the callback shown in the Google error and add that exact callback to the Web OAuth client. The production connector callback is:

```text
https://YOUR_DOMAIN/api/public/google/callback
```

### Google connector works in production but not preview

Google requires an exact callback. Register the exact preview URL or use a stable staging domain.

### Gmail/Calendar shows `not_connected`

Connect Google through MONDAY's connector onboarding. Supabase Google login by itself does not create the separate Gmail/Calendar connector token.

### Hugging Face returns 401/403/402/model errors

Verify the token, inference permissions, model access, provider availability, and account credits. Then inspect the Vercel function log for the full provider response.
