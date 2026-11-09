/**
 * IBM-inspired backdrop: faint grid + floating gradient shapes.
 * Place at the top of any page-level container with `relative overflow-hidden`.
 */
export function GeometricBackdrop({ variant = "default" }: { variant?: "default" | "subtle" }) {
  const opacity = variant === "subtle" ? 0.5 : 1;
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      <div className="absolute inset-0 bg-grid" style={{ opacity }} />
      {/* gradient blobs */}
      <div
        className="absolute -top-40 -right-40 h-[480px] w-[480px] rounded-full blur-3xl"
        style={{ background: "var(--gradient-brand)", opacity: 0.18 }}
      />
      <div
        className="absolute -bottom-48 -left-32 h-[420px] w-[420px] rounded-full blur-3xl"
        style={{ background: "var(--gradient-brand)", opacity: 0.12 }}
      />
      {/* geometric accent triangle */}
      <svg
        className="absolute right-12 bottom-12 h-32 w-32 opacity-70"
        viewBox="0 0 100 100"
        fill="none"
      >
        <defs>
          <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="oklch(0.52 0.22 275)" />
            <stop offset="100%" stopColor="oklch(0.62 0.18 245)" />
          </linearGradient>
        </defs>
        <rect x="10" y="10" width="40" height="40" stroke="url(#bg-grad)" strokeWidth="1" />
        <rect x="35" y="35" width="40" height="40" stroke="url(#bg-grad)" strokeWidth="1" opacity="0.6" />
        <circle cx="70" cy="20" r="6" fill="url(#bg-grad)" opacity="0.5" />
      </svg>
    </div>
  );
}
