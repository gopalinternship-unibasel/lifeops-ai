export function MondayMark({ size = 28 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
        <defs>
          <linearGradient id="mark-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="oklch(0.52 0.22 275)" />
            <stop offset="100%" stopColor="oklch(0.62 0.18 245)" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="28" height="28" rx="6" fill="url(#mark-grad)" />
        <path d="M9 22 V10 L16 18 L23 10 V22" stroke="white" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
      </svg>
      <div className="flex flex-col leading-none">
        <span className="text-[15px] font-semibold tracking-tight">MONDAY</span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-0.5">LifeOps AI</span>
      </div>
    </div>
  );
}
