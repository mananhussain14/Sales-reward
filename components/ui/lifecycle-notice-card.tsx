import { SignOutButton } from "@/components/auth/sign-out-button";
import { BrandLockup } from "@/components/ui/brand";
import { ShieldIcon } from "@/components/ui/icons";

/**
 * The access-refused card for a caller whose own LIFECYCLE explains the refusal.
 *
 * A sibling of <AccessDeniedCard />, not a replacement for it. That card stays exactly as
 * it was — same wording, same shield, same sign-out — and remains what BOTH the Vendor and
 * Retailer routes render for an ordinary denial. Vendor behaviour is untouched by this
 * milestone.
 *
 * ============================================================================
 * WHY A SECOND CARD RATHER THAN A PROP ON THE FIRST
 * ============================================================================
 * The two say deliberately different things, and the difference is a security decision.
 * <AccessDeniedCard /> is fixed and neutral BECAUSE it must be indistinguishable across
 * every ordinary refusal — it names no role, organization or failing condition, so a
 * signed-in but unauthorized (possibly hostile) account learns nothing from it.
 *
 * This card is only ever rendered from a state the database volunteered about the CALLER
 * THEMSELVES, via a zero-argument self-only RPC. It discloses nothing a person does not
 * already know about their own account, and it exists because "you do not have access to
 * this page" is the wrong sentence for someone whose account was deactivated this morning.
 *
 * Making the neutral card conditionally non-neutral would have put both behaviours in one
 * component and made it possible to reach the specific copy from a path that had not
 * earned it.
 *
 * ============================================================================
 * WHAT MAY CROSS INTO IT
 * ============================================================================
 * A title and a message, both FIXED LOCAL LITERALS chosen by
 * resolveLifecycleNotice() in @/lib/staff/lifecycle-access-state. Nothing interpolated,
 * because there is nothing to interpolate: the RPC behind it returns one word from a closed
 * vocabulary and no id, name, email, role, organization, raw status, timestamp, SQLSTATE or
 * database message.
 *
 * This component decides nothing. The page keeps its own server-side access check, and the
 * diagnostic is read only AFTER that check has already refused.
 */
export function LifecycleNoticeCard({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <main className="w-full max-w-md">
        {/* Branding — mirrors the login lockup so every entry point reads as one product. */}
        <div className="mb-8 flex justify-center">
          <BrandLockup size={40} idSuffix="-lifecycle" />
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
              {title}
            </h1>

            <p className="mt-2 text-sm text-slate-500">{message}</p>

            <p className="mt-3 text-sm text-slate-500">
              If this changes, sign in again to pick up your access.
            </p>

            {/* The only way out, exactly as on the ordinary access-denied card. */}
            <div className="mt-6 w-full">
              <SignOutButton variant="card" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
