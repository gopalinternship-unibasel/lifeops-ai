import { createFileRoute, Link } from "@tanstack/react-router";
import { MondayMark } from "@/components/MondayMark";
import { isStaticShellBuild } from "@/lib/static-shell";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});

/**
 * What the app does with a visitor's data, including Google user data when a Google account is
 * connected. Every statement here must match the code: the Gmail fields and the 4,000-character
 * body limit (src/server/google/gmail.server.ts), the 21 days of calendar (chat-turn.server.ts
 * CALENDAR_DAYS), draft-only email (no send call anywhere), token encryption
 * (token-crypto.server.ts), revocation on disconnect (google.functions.ts disconnectGoogle) and
 * the 7-day removal of unused demo accounts (supabase/hosted/cleanup_anonymous_users.sql).
 */
export const PRIVACY_CONTACT = "gopal.krishna.developer@gmail.com";

function PrivacyPage() {
  return (
    <div className="min-h-screen">
      <header className="px-8 py-6 flex items-center justify-between">
        <Link to="/" aria-label="Home">
          <MondayMark />
        </Link>
        <Link to="/login" className="text-sm font-medium text-foreground/80 hover:text-foreground transition">
          Sign in
        </Link>
      </header>
      <main className="px-6 pb-24 max-w-2xl mx-auto text-sm leading-relaxed text-foreground/90">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Privacy</h1>
        <p className="mt-4 text-muted-foreground">
          LifeOps AI (MONDAY) is a portfolio project. This page says what it stores, what it reads from Google
          when you connect a Google account, and who processes it.
        </p>

        <Section title="Demo sessions">
          <p>
            &ldquo;Try the live demo&rdquo; starts an anonymous session with a sample inbox and a demo calendar.
            MONDAY stores the goals in your profile, your chat messages and its replies, plans, tasks and the demo
            calendar&apos;s events for that session. Unused demo sessions and all their data are deleted after 7 days,
            and a demo session cannot connect a Google account.
          </p>
        </Section>

        <Section title="Accounts">
          <p>
            If you create an account, MONDAY also stores your email address for signing in. Everything else is
            the same as for a demo session.
          </p>
        </Section>

        <Section title="Google data, when you connect a Google account">
          {isStaticShellBuild ? (
            <p>
              This GitHub Pages copy cannot connect a Google account; only the main site,{" "}
              <a className="text-primary hover:underline" href="https://lifeops-ai-sigma.vercel.app">
                lifeops-ai-sigma.vercel.app
              </a>
              , can. While the app is in Google&apos;s testing phase, only Google accounts the owner has added as testers
              can connect there. When you connect one, MONDAY:
            </p>
          ) : (
            <p>
              While the app is in Google&apos;s testing phase, only Google accounts the owner has added as testers can
              connect. When you connect one, MONDAY:
            </p>
          )}
          <ul className="mt-3 list-disc pl-5 space-y-1.5">
            <li>
              reads the sender, recipients, subject, date and text (up to the first 4,000 characters) of your unread and recent
              Gmail messages, to find tasks and say what needs a reply;
            </li>
            <li>reads your Google Calendar events from today up to 21 days ahead, to know when you are busy;</li>
            <li>
              creates calendar events and Gmail drafts only when you click Save or Approve. It has no way to send
              email: drafts stay in your Gmail until you send them yourself.
            </li>
          </ul>
          <p className="mt-3">
            MONDAY keeps the Google access and refresh tokens, encrypted, so that it can do this. It does not copy your
            mailbox or calendar into its database; only what you see in the app is kept, such as your chat history,
            priorities, plans and tasks, which can mention an email or an event.
          </p>
        </Section>

        <Section title="Who processes the data">
          <p>
            {isStaticShellBuild
              ? "GitHub Pages serves this copy's files and its server code runs in a Supabase Edge Function. Vercel (Frankfurt) runs the planner service behind the dashboard. "
              : "Vercel (Frankfurt) runs the app and the planner service behind the dashboard. "}
            Supabase (Frankfurt) holds the database and the sign-in. Cloudflare Workers AI runs the language model: the
            text MONDAY needs for an answer, which can include the email and calendar details above, is sent to it for
            that answer.
          </p>
        </Section>

        <Section title="Google API Services User Data Policy">
          <p>
            LifeOps AI&apos;s use and transfer to any other app of information received from Google APIs will adhere to
            the{" "}
            <a
              className="text-primary hover:underline"
              href="https://developers.google.com/terms/api-services-user-data-policy"
              rel="noreferrer"
              target="_blank"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. MONDAY does not sell this data, does not use it for advertising
            and does not use it to train AI models.
          </p>
        </Section>

        <Section title="Your choices">
          <p>
            Disconnect Google at any time under Profile, &ldquo;Manage Google connection&rdquo;: MONDAY revokes its
            access with Google and deletes the stored tokens. You can also remove its access in your Google Account under
            Security, &ldquo;Your connections to third-party apps and services&rdquo;. To have your account and its data
            deleted, write to{" "}
            <a className="text-primary hover:underline" href={`mailto:${PRIVACY_CONTACT}`}>
              {PRIVACY_CONTACT}
            </a>
            .
          </p>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}
