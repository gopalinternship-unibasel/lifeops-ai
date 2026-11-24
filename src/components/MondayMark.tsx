import { useId } from "react";

export function MondayMark({ size = 28, hideWordmarkOnPhone = false }: { size?: number; hideWordmarkOnPhone?: boolean }) {
  // Each mark needs its own gradient id. With one fixed id, a page that shows two marks (the
  // login page has one in the desktop panel and one in the phone header) pointed both at the
  // first gradient; on phones that one sits in a hidden panel, is not painted, and the visible
  // mark came out blank white. useId is the same on the server and in the browser, so the
  // server-rendered markup still hydrates.
  const gradientId = `mark-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <div className="flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="oklch(0.52 0.22 275)" />
            <stop offset="100%" stopColor="oklch(0.62 0.18 245)" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="28" height="28" rx="6" fill={`url(#${gradientId})`} />
        <path d="M9 22 V10 L16 18 L23 10 V22" stroke="white" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
      </svg>
      {/* The app header hides the words on phones, where the navigation needs the room. */}
      <div className={`${hideWordmarkOnPhone ? "hidden sm:flex" : "flex"} flex-col leading-none`}>
        <span className="text-[15px] font-semibold tracking-tight">MONDAY</span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-0.5">LifeOps AI</span>
      </div>
    </div>
  );
}
