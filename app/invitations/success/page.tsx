import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { LANDING_ROUTES } from "@/lib/auth/landing-decision";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { InvitationShell } from "@/components/ui/invitation-shell";
import { buttonClasses } from "@/components/ui/button";
import { CheckCircleIcon, InboxIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Account activated · SalesReward",
};

/**
 * A safe FALLBACK boundary for a completed invitation.
 *
 * The primary completion path no longer stops here: after
 * accept_retailer_owner_invitation() commits, app/invitations/complete/actions.ts
 * redirects straight to /retailer. This page is what a refresh, an old bookmark,
 * a re-clicked email, or a manual visit lands on — so it must be correct for a
 * user who is ALREADY a fully-activated owner, and safe for everyone else.
 *
 * It resolves Retailer Owner access at its own server boundary rather than
 * trusting how the caller arrived, and routes on the result:
 *   * authorized      -> /retailer (the portal), since acceptance now produces an
 *                        ACTIVE profile + membership. This is a redirect to a
 *                        DIFFERENT route, so there is no loop with this page.
 *   * unauthenticated -> /login (this person has a password and can sign in).
 *   * unauthorized    -> a generic activated-but-no-workspace card. Reached by a
 *                        signed-in non-owner (e.g. a Vendor admin who wandered
 *                        here); it reveals nothing about invitations or
 *                        membership and offers only sign-out.
 *   * unavailable     -> a generic retry-safe card, NOT a denial: an operational
 *                        failure must not read as "you don't have access".
 *
 * The outdated "the retailer workspace is not enabled yet" copy is gone — the
 * portal exists and an activated owner is sent into it.
 *
 * Reveals no invitation or membership internals: no id, email, token, Retailer
 * name, or status. The authorized branch redirects before rendering anything, and
 * the two rendered branches are fixed text.
 */
export default async function InvitationSuccessPage() {
  const access = await getRetailerOwnerPortalAccess();

  if (access.status === "unauthenticated") {
    redirect(LANDING_ROUTES.login);
  }

  if (access.status === "authorized") {
    // A fully-activated owner: send them into the portal they now have access to.
    redirect(LANDING_ROUTES.retailer);
  }

  // access.status is "unauthorized" or "unavailable" — both render a safe card
  // below. They are distinguished only by wording (denial-neutral vs
  // retry-safe); neither exposes why.
  const isUnavailable = access.status === "unavailable";

  if (isUnavailable) {
    return (
      <InvitationShell
        icon={<InboxIcon className="h-6 w-6" />}
        iconTone="amber"
        title="Something went wrong"
        description="We couldn’t load your workspace just now. This is usually temporary."
      >
        {/* A plain retry into the portal, which re-runs the access check.
            No id or state is carried; it is a fixed internal route. */}
        <Link
          href={LANDING_ROUTES.retailer}
          className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true })}
        >
          Try again
        </Link>
      </InvitationShell>
    );
  }

  return (
    <InvitationShell
      icon={<CheckCircleIcon className="sr-animate-pop h-7 w-7" />}
      iconTone="emerald"
      title="You’re signed in"
      // Deliberately generic. This branch is a signed-in caller who is not an
      // authorized Retailer Owner; it must not confirm or deny any invitation or
      // membership.
      description="This account doesn’t currently have access to a retailer workspace. If you believe this is a mistake, please contact the person who invited you."
    >
      <SignOutButton variant="card" />
    </InvitationShell>
  );
}
