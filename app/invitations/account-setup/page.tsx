import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AccountSetupForm } from "@/app/invitations/account-setup/account-setup-form";
import { resolveAuthenticatedLanding } from "@/lib/auth/authenticated-landing";
import { InvitationShell } from "@/components/ui/invitation-shell";
import { KeyIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Set your password · SalesReward",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/** Where a visitor with no usable session is sent. The generic invitation failure. */
const FAILURE_PATH = "/invitations/error";

/**
 * GENERIC account setup — the completion screen for an invited account that has no
 * application identity yet.
 *
 * ============================================================================
 * WHY THIS PAGE EXISTS
 * ============================================================================
 * /invitations/accept verifies an emailed invitation token and establishes a
 * session; that part always worked. It then hands off to /invitations/complete,
 * which assumed every invitee has a pending Retailer invitation row and sent
 * everyone else to /invitations/error — so an invited Vendor-side user saw
 * "This invitation link cannot be used" even though their token had just been
 * accepted successfully. This page is the missing destination.
 *
 * It is deliberately ROLE-NEUTRAL and reusable: it says nothing about Claim
 * Reviewer or any other role, because it is reached by whichever invited account
 * happens to have no portal, and the page has no basis for a guess.
 *
 * ============================================================================
 * REQUIRES A SESSION, AND GRANTS NOTHING
 * ============================================================================
 * Deliberately NOT on the proxy's public allowlist — unlike /invitations/accept,
 * which must be reachable without a session because establishing one is its whole
 * purpose. A visitor who arrives here without a verified session gets the generic
 * failure page. The Server Action re-checks independently: a page guard is not a
 * security boundary for an endpoint a browser can POST to directly.
 *
 * Reaching this page and completing the form grants NO application access. No
 * profile, membership, role or audit row is created anywhere in this route, and no
 * service-role client is imported. With no public.profiles row, every portal
 * resolver in the database returns zero rows for this account. Access arrives later
 * through a separately approved administrative process.
 */
export default async function AccountSetupPage() {
  const supabase = await createClient();

  // 1. The session. getClaims() cryptographically verifies the JWT rather than
  //    trusting the cookie the way getSession() would — the same check every other
  //    route in this codebase makes.
  let hasSession = false;

  try {
    const { data } = await supabase.auth.getClaims();
    hasSession = Boolean(data?.claims?.sub);
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can carry
    // token material.
    hasSession = false;
  }

  if (!hasSession) {
    // A direct visit, an expired link, or a session signed out in another tab. One
    // destination for all of them, so nothing about which is distinguishable.
    redirect(FAILURE_PATH);
  }

  // 2. The account must ALREADY be verified. This page never confirms an address and
  //    never sets one — it only lets someone whose invitation was already accepted
  //    choose a credential. getUser() re-validates with the Auth server rather than
  //    reading a cached claim, so an unconfirmed account cannot slip through.
  //
  //    The user object is otherwise untouched: nothing from it is rendered, returned
  //    or logged, so no email or id reaches the page payload.
  const userResult = await Promise.resolve(supabase.auth.getUser()).catch(
    () => null,
  );

  if (
    userResult === null ||
    userResult.error ||
    !userResult.data?.user?.email_confirmed_at
  ) {
    // Includes the transport-failure case. The error is never bound or logged.
    redirect(FAILURE_PATH);
  }

  // 3. An already-configured user does not belong here. Someone with a portal has an
  //    ordinary signed-in session and must change their password through the normal
  //    route, not through an invitation endpoint that ends by signing them out.
  //
  //    Takes no arguments and reads only auth.uid() through the existing resolvers,
  //    so no query parameter, email or browser-supplied organization id can steer it.
  //    "unavailable" is refused as well: during a resolver outage a configured user
  //    is indistinguishable from a generic one, and the fail-closed direction is to
  //    refuse rather than to offer a password reset.
  const landing = await resolveAuthenticatedLanding();

  switch (landing.kind) {
    case "vendor":
    case "retailer":
    case "retailerStaff":
    case "salesStaff":
    case "claimReviewer":
      redirect(landing.destination);
    case "unauthenticated":
    case "unavailable":
      redirect(FAILURE_PATH);
    case "unauthorized":
      // Portal context is NONE — the generic invitee this page exists for.
      break;
  }

  return (
    <InvitationShell
      icon={<KeyIcon className="h-6 w-6" />}
      steps={["Invitation", "Set password", "Done"]}
      activeStep={1}
      title="Set your password"
      description="Your invitation has been confirmed. Choose a password for your SalesReward account. An administrator will finish setting up your access before you can use the application."
    >
      <AccountSetupForm />
    </InvitationShell>
  );
}
