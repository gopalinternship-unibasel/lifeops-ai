import { createFileRoute, Link, Outlet, useNavigate, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { MondayMark } from "@/components/MondayMark";
import { Loader2, LogOut } from "lucide-react";

export const Route = createFileRoute("/app")({
  component: AppLayout,
});

function AppLayout() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

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

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="h-14 border-b border-border flex items-center justify-between px-6 bg-card/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="flex items-center gap-10">
          <Link to="/app"><MondayMark size={24} /></Link>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => {
              const active = location.pathname === item.to ||
                (item.to !== "/app" && location.pathname.startsWith(item.to));
              const isExact = location.pathname === item.to;
              return (
                <Link
                  key={item.to} to={item.to}
                  className={`relative px-3 py-1.5 text-sm font-medium rounded-md transition ${
                    (item.to === "/app" ? isExact : active)
                      ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                  {(item.to === "/app" ? isExact : active) && (
                    <span className="absolute -bottom-[15px] left-3 right-3 h-[2px] bg-gradient-brand rounded-full" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground hidden sm:inline">{user.email}</span>
          <button
            onClick={async () => {
              await signOut();
              navigate({ to: "/" });
            }}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 min-h-0">
        <Outlet />
      </main>
    </div>
  );
}
