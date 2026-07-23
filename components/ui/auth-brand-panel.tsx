import { BrandMark } from "@/components/ui/brand";
import { CheckIcon, ShieldIcon } from "@/components/ui/icons";

/**
 * The marketing panel shown beside the sign-in form on wide screens.
 *
 * A restrained indigo→violet gradient carrying the brand, a one-line value
 * statement, an abstract "verified sales growth" illustration built entirely
 * from inline SVG (no asset, no request), and three concise benefits. It is
 * role-neutral by design: the sign-in page cannot know who is signing in, so
 * nothing here names a role. Hidden below `lg`, where the form stands alone.
 *
 * Motion is decorative and OPT-IN to movement: the sales line draws once and the
 * reward spark floats gently, both gated on `motion-safe` / the global
 * reduced-motion rule so a reader who prefers reduced motion sees the finished,
 * still artwork.
 */
const BENEFITS = [
  "Track verified sales",
  "Reward staff performance",
  "Connect Vendors and Retailers",
];

export function AuthBrandPanel() {
  return (
    <div className="relative hidden overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-800 lg:flex lg:flex-col lg:justify-between lg:p-12">
      {/* Subtle grid, faded toward the edges for depth. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.15]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage:
            "radial-gradient(ellipse 80% 80% at 50% 40%, black 40%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 80% at 50% 40%, black 40%, transparent 100%)",
        }}
      />
      {/* Ambient glows behind the artwork, layered for depth. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-violet-400/30 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-20 -left-12 h-72 w-72 rounded-full bg-indigo-400/25 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-1/4 top-1/3 h-40 w-40 rounded-full bg-fuchsia-400/20 blur-3xl"
      />

      <div className="relative flex items-center gap-3">
        <BrandMark size={44} idSuffix="-login-panel" />
        <span className="text-lg font-semibold tracking-tight text-white">
          SalesReward
        </span>
      </div>

      <div className="relative">
        {/* Abstract growth illustration. */}
        <svg
          viewBox="0 0 320 200"
          fill="none"
          className="mb-10 h-auto w-full max-w-md"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="sr-auth-area" x1="0" y1="0" x2="0" y2="200" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFFFFF" stopOpacity="0.35" />
              <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M12 170 L70 140 L120 150 L170 96 L220 110 L280 44 L308 30 L308 188 L12 188 Z"
            fill="url(#sr-auth-area)"
          />
          <path
            className="sr-draw-line"
            d="M12 170 L70 140 L120 150 L170 96 L220 110 L280 44 L308 30"
            stroke="#FFFFFF"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {[
            [70, 140],
            [170, 96],
            [280, 44],
          ].map(([cx, cy]) => (
            <circle key={`${cx}`} cx={cx} cy={cy} r="5" fill="#FFFFFF" />
          ))}
          {/* Reward spark near the peak — floats gently. */}
          <path
            className="sr-animate-float"
            style={{ transformOrigin: "300px 30px" }}
            d="M300 18 L303 27 L312 30 L303 33 L300 42 L297 33 L288 30 L297 27 Z"
            fill="#FBBF24"
          />
        </svg>

        <h2 className="max-w-md text-2xl font-semibold leading-snug text-white">
          The retail incentive platform that turns verified sales into rewards.
        </h2>

        <ul className="mt-8 space-y-3">
          {BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-center gap-3 text-indigo-50">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 ring-1 ring-inset ring-white/25">
                <CheckIcon className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-sm font-medium">{benefit}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Trust indicator — a small, neutral reassurance, not a marketing claim. */}
      <div className="relative flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-indigo-50 ring-1 ring-inset ring-white/15">
          <ShieldIcon className="h-3.5 w-3.5" />
          Secure multi-tenant platform
        </span>
      </div>
    </div>
  );
}
