import { SignOutButton } from "@/components/auth/sign-out-button";
import { BrandLockup } from "@/components/ui/brand";
import { ShieldIcon } from "@/components/ui/icons";

/**
 * The shared, role-neutral "Access denied" card.
 *
 * Both the Vendor and the Retailer access-denied routes render this identical
 * surface, so the wording, the shield motif, and the only-way-out sign-out
 * control stay in one place. The copy is fixed and neutral here — it names no
 * role, organization, or failing condition — precisely because the two callers
 * must be indistinguishable to a signed-in but unauthorized (possibly hostile)
 * account. Each page keeps its own server-side access check; this component is
 * presentation only and decides nothing.
 */
export function AccessDeniedCard() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <main className="w-full max-w-md">
        {/* Branding — mirrors the login lockup so every entry point reads as one product. */}
        <div className="mb-8 flex justify-center">
          <BrandLockup size={40} idSuffix="-denied" />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
          <div className="flex flex-col items-center text-center">
            <span
              className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-100"
              aria-hidden="true"
            >
              <ShieldIcon className="h-7 w-7" />
            </span>

            <h1 className="mt-5 text-xl font-semibold tracking-tight text-slate-900">
              Access denied
            </h1>

            <p className="mt-2 text-sm text-slate-500">
              You are signed in, but this account does not have access to this
              page.
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
