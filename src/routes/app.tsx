import { createFileRoute, Link, Outlet, useNavigate, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { signOutWarning, useAuth } from "@/lib/auth-context";
import { MondayMark } from "@/components/MondayMark";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, LogOut } from "lucide-react";

export const Route = createFileRoute("/app")({
  component: AppLayout,
});

function AppLayout() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Set while the Sign out button runs. The guard below cannot tell a deliberate sign-out from
  // an expired session: it sent the user on to /login and overrode the handler's own move to
  // the landing page.
  const signingOut = useRef(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!loading && !user && !signingOut.current) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  // On a phone the navigation scrolls sideways; keep the current page's link in view (also once
  // the header first appears, when the session has loaded).
  const ready = !loading && Boolean(user);
  useEffect(() => {
    if (!ready) return;
    navRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [location.pathname, ready]);

  if (loading || !user) {
    return <div className="min-h-screen grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const navItems = [
    { to: "/app", label: "Workspace" },
    { to: "/app/dashboard", label: "Dashboard" },
    { to: "/app/plan", label: "Plan" },
    { to: "/app/calendar", label: "Calendar" },
    { to: "/app/profile", label: "Profile" },
  ] as const;

  const finishSignOut = async () => {
    signingOut.current = true;
    try {
      await signOut();
    } finally {
      navigate({ to: "/" });
    }
  };

  const demoSignOutWarning = signOutWarning(user);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Below the sm breakpoint the header used to be one ~606 px row that pushed every signed-in
          page sideways on a phone. There the words beside the logo and on the Sign out button
          are hidden, and the links scroll inside the header instead of widening the page. */}
      <header className="h-14 border-b border-border flex items-center justify-between gap-2 px-3 sm:px-6 bg-card/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="flex h-full min-w-0 items-center gap-3 sm:gap-10">
          <Link to="/app" aria-label="MONDAY workspace" className="shrink-0">
            <MondayMark size={24} hideWordmarkOnPhone />
          </Link>
          <nav
            ref={navRef}
            className="flex h-full min-w-0 items-stretch gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {navItems.map((item) => {
              const active = location.pathname === item.to ||
                (item.to !== "/app" && location.pathname.startsWith(item.to));
              const isExact = location.pathname === item.to;
              const current = item.to === "/app" ? isExact : active;
              return (
                <Link
                  key={item.to} to={item.to}
                  // Workspace (/app) is the parent of the other pages: mark it current only on
                  // itself, as the underline does.
                  activeOptions={{ exact: item.to === "/app" }}
                  data-active={current ? "true" : "false"}
                  className={`relative flex shrink-0 items-center whitespace-nowrap px-2 sm:px-3 text-sm font-medium rounded-md transition ${
                    current ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                  {/* Inside the link's full-height box, so the nav's sideways scrolling does not clip it. */}
                  {current && (
                    <span className="absolute bottom-0 left-2 right-2 sm:left-3 sm:right-3 h-[2px] bg-gradient-brand rounded-full" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* From lg up only, and cut short: a long address beside the links left the
              navigation a sliver at tablet widths. */}
          <span className="text-xs text-muted-foreground hidden lg:block max-w-[16rem] truncate" title={user.email}>{user.email}</span>
          <button
            type="button"
            onClick={() => {
              if (demoSignOutWarning) setConfirmingSignOut(true);
              else void finishSignOut();
            }}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>
      {/* A demo session cannot be reopened after signing out, so ask first. */}
      <AlertDialog open={confirmingSignOut} onOpenChange={setConfirmingSignOut}>
        <AlertDialogContent className="w-[calc(100%-2rem)] rounded-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of the demo?</AlertDialogTitle>
            <AlertDialogDescription>{demoSignOutWarning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay in the demo</AlertDialogCancel>
            <AlertDialogAction onClick={() => void finishSignOut()}>Sign out</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <main className="flex-1 min-h-0">
        <Outlet />
      </main>
    </div>
  );
}
