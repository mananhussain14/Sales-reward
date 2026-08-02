import { SignOutButton } from "@/components/auth/sign-out-button";
import { BrandLockup } from "@/components/ui/brand";

/**
 * The Claim Review denial surface.
 *
 * A SEPARATE component from @/components/ui/access-denied-card, and deliberately so.
 * That card is shared by the Vendor and Retailer denial routes and is required to stay
 * a no-prop, fixed, neutral component: parameterising it would put two behaviours in
 * one place and make surface-specific copy reachable from a path that had not earned
 * it. An existing contract test enforces exactly that, and this milestone respects it
 * rather than relaxing it — the same way the staff-lifecycle milestone added
 * LifecycleNoticeCard instead of adding props here.
 *
 * ============================================================================
 * IT NAMES THE SURFACE, NEVER THE MISSING CONDITION
 * ============================================================================
 * The copy says Claim Review access is absent, because someone who typed /review
 * deserves to know which door refused them. It does NOT say which role, permission,
 * membership or organization state was missing.
 *
 * This card is rendered identically for: a signed-in user with no reviewer role, an
 * inactive profile, an inactive membership, an inactive organization, an inactive
 * CLAIM_REVIEWER role, a removed role assignment, a Retailer-only account, a Vendor
 * account without reviewer access, a user qualifying for zero Vendors, and a user
 * ambiguously qualifying for MORE THAN ONE. Naming the failing condition would tell an
 * unauthorized (possibly hostile) account exactly what to acquire next, and the
 * ambiguous multi-Vendor case must not hint that a second Vendor exists.
 *
 * It does not mention any other product surface, and it offers no cross-portal link:
 * an automatic redirect elsewhere would disclose what else the signed-in account
 * holds. The sign-out control is the way out, exactly as on the shared card.
 *
 * Presentation only. It decides nothing — app/review-access-denied/page.tsx performs
 * its own server-side access check, and the (review) layout performs another.
 */
export function ReviewAccessDeniedCard() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <main className="w-full max-w-md">
        {/* Branding — mirrors the login lockup so every entry point reads as one product. */}
        <div className="mb-8 flex justify-center">
          <BrandLockup size={40} idSuffix="-review-denied" />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
          <div className="flex flex-col items-center text-center">
            <span
              className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-100"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-7 w-7"
              >
                <path d="M12 3l7.5 3v5.25c0 4.28-3.2 8.28-7.5 9.75-4.3-1.47-7.5-5.47-7.5-9.75V6L12 3z" />
                <path d="M12 9v3.75M12 16.5h.008" />
              </svg>
            </span>

            <h1 className="mt-5 text-xl font-semibold tracking-tight text-slate-900">
              Claim Review access required
            </h1>

            <p className="mt-2 text-sm text-slate-500">
              You are signed in, but this account does not have Claim Review
              access.
            </p>

            <p className="mt-3 text-sm text-slate-500">
              Use the navigation available to your account, or sign in with a
              different account.
            </p>

            {/* Lets the user sign out and return to /login with another account. */}
            <div className="mt-6 w-full">
              <SignOutButton variant="card" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
