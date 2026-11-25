import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { GeometricBackdrop } from "@/components/GeometricBackdrop";
import { MondayMark } from "@/components/MondayMark";
import { ArrowRight, Sparkles, Calendar, Brain } from "lucide-react";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  component: Landing,
});

/**
 * The hosted sites (Vercel, GitHub Pages) have no Google sign-in: every visitor works with the
 * sample inbox and the app's own demo calendar, so the page says so instead of claiming to read
 * the visitor's email. A local install with Google set up keeps the wording for real accounts.
 */
const HOSTED_DEMO = import.meta.env.VITE_HOSTED_DEMO === "true";

function Landing() {
  const { user, loading } = useAuth();

  // If signed in, send to workspace
  useEffect(() => {
    if (!loading && user) {
      window.location.href = `${import.meta.env.BASE_URL}app`;
    }
  }, [user, loading]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <GeometricBackdrop />
      <header className="px-8 py-6 flex items-center justify-between">
        <MondayMark />
        <Link
          to="/login"
          className="text-sm font-medium text-foreground/80 hover:text-foreground transition"
        >
          Sign in
        </Link>
      </header>

      <main className="px-8 pt-16 pb-24 max-w-6xl mx-auto">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur-sm px-3 py-1 text-xs font-medium text-muted-foreground mb-8">
            <span className="h-1.5 w-1.5 rounded-full bg-gradient-brand" />
            {HOSTED_DEMO ? "Public demo with a sample inbox and calendar" : "Demo"}
          </div>
          <h1 className="text-5xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Your AI <span className="text-gradient-brand">Chief of Staff</span>,
            <br />actively running your day.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl leading-relaxed">
            {HOSTED_DEMO
              ? "MONDAY reads an inbox and a calendar, prioritizes what matters, and rewires your schedule through conversation. In this public demo it works with a sample inbox and a demo calendar of its own, so nothing connects to your real email or calendar."
              : "MONDAY connects to your inbox and calendar, prioritizes what matters, and rewires your schedule through conversation."}{" "}
            Not a chatbot. Not a to-do list. A decision and execution layer.
          </p>
          <div className="mt-10 flex items-center gap-4">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 rounded-md bg-gradient-brand px-6 py-3 text-sm font-medium text-primary-foreground shadow-elev transition hover:opacity-95"
            >
              Get started <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#how" className="text-sm font-medium text-foreground/80 hover:text-foreground">
              How it works →
            </a>
          </div>
        </div>

        <div id="how" className="mt-32 grid md:grid-cols-3 gap-px bg-border rounded-lg overflow-hidden border border-border">
          <Feature
            icon={<Brain className="h-5 w-5" />}
            title="Reasons over your context"
            body={
              HOSTED_DEMO
                ? "Reads the sample inbox, the demo calendar and the goals in your profile. Generates ranked priorities with explicit reasoning."
                : "Reads emails, calendar, and goals. Generates ranked priorities with explicit reasoning."
            }
          />
          <Feature
            icon={<Sparkles className="h-5 w-5" />}
            title="Reorders on command"
            body="Override priorities in chat. The plan is worked out again with new rationale."
          />
          <Feature
            icon={<Calendar className="h-5 w-5" />}
            title="Writes back to your day"
            body="Block time for the gym, dinner, or meeting prep. MONDAY proposes it and puts it on the calendar once you approve."
          />
        </div>
      </main>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-card p-8">
      <div className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-gradient-brand text-primary-foreground mb-4">
        {icon}
      </div>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}
