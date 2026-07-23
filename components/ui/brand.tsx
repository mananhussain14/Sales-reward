import { cn } from "@/components/ui/cn";

/**
 * The SalesReward brand mark.
 *
 * A rounded indigo→violet tile carrying a rising sales bar-chart whose tallest
 * bar becomes an upward arrow, topped with an amber reward spark. It reads as
 * "growth + reward" — trust and commerce, not gaming — and stays legible down to
 * ~20px. Built entirely from inline SVG so it needs no asset, no package, and no
 * network request, and it inherits crispness at any size.
 *
 * `size` is the tile edge in pixels. The gradient id is suffixed so multiple
 * marks on one page (sidebar + empty state) never collide.
 */
export function BrandMark({
  size = 40,
  className,
  idSuffix = "",
}: {
  size?: number;
  className?: string;
  idSuffix?: string;
}) {
  const gradientId = `sr-brand-grad${idSuffix}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      role="img"
      aria-label="SalesReward"
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4F46E5" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill={`url(#${gradientId})`} />
      {/* Rising bars */}
      <rect x="10" y="23" width="3.6" height="7" rx="1.4" fill="#C7D2FE" />
      <rect x="16" y="19" width="3.6" height="11" rx="1.4" fill="#E0E7FF" />
      {/* Tallest bar + upward arrow */}
      <path
        d="M24 30V15.5"
        stroke="#FFFFFF"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <path
        d="M20 18.5L24 14.5L28 18.5"
        stroke="#FFFFFF"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Reward spark */}
      <path
        d="M29.5 9.5L30.4 12.1L33 13L30.4 13.9L29.5 16.5L28.6 13.9L26 13L28.6 12.1L29.5 9.5Z"
        fill="#F59E0B"
      />
    </svg>
  );
}

/**
 * The mark paired with the "SalesReward" wordmark — the standard lockup used in
 * the sidebar, on login, and on onboarding screens so every entry point reads as
 * one product. `context` renders an optional portal caption (e.g. "Vendor
 * Admin") under the wordmark.
 */
export function BrandLockup({
  size = 36,
  context,
  className,
  wordmarkClassName,
  idSuffix,
}: {
  size?: number;
  context?: string;
  className?: string;
  wordmarkClassName?: string;
  idSuffix?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark size={size} idSuffix={idSuffix} />
      <span className="flex flex-col leading-none">
        <span
          className={cn(
            "text-[0.95rem] font-semibold tracking-tight text-slate-900",
            wordmarkClassName,
          )}
        >
          SalesReward
        </span>
        {context ? (
          <span className="mt-1 text-[0.7rem] font-medium uppercase tracking-wide text-slate-500">
            {context}
          </span>
        ) : null}
      </span>
    </span>
  );
}
