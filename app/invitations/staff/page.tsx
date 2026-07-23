import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LANDING_ROUTES } from "@/lib/auth/landing-decision";
import { resolveAuthenticatedLanding } from "@/lib/auth/authenticated-landing";
import { readStaffInviteHash } from "@/lib/staff/staff-invite-cookie";
import { resolveStaffInvitation } from "@/lib/staff/staff-acceptance";
import { getStaffRegistrationView } from "@/lib/staff/staff-registration";
import {
  AcceptInvitationTransition,
  ActivateStaffAccountForm,
  StaffInvitationSignInPrompt,
  WrongAccountSwitch,
} from "@/app/invitations/staff/accept-forms";
import { InvitationShell } from "@/components/ui/invitation-shell";
import {
  InboxIcon,
  KeyIcon,
  MailIcon,
  UsersIcon,
} from "@/components/ui/icons";

/**
 * The CLEAN staff invitation page — no token in the URL. It was exchanged for an
 * HttpOnly hash cookie by /invitations/staff/enter, which then redirected here.
 *
 * `referrer: no-referrer` so this page never leaks its URL onward. `robots noindex`
 * because an invitation page should never be indexed.
 */
export const metadata: Metadata = {
  title: "Accept invitation · SalesReward",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * WHAT THIS PAGE MAY REVEAL, AND WHEN.
 *
 *   Signed OUT      one bit only, decided on the server: does the invited address
 *                   already have an account? That chooses between a password-only
 *                   activation form and a sign-in prompt. NOTHING else is revealed —
 *                   not the Retailer, role, shops, expiry, or the invited email, which
 *                   never leaves the server. Unknown, malformed, expired, revoked,
 *                   accepted or stale tokens, and no cookie, all render one screen.
 *   Signed IN       the recipient RPC decides, in SQL. It returns a match ONLY when the
 *                   caller's confirmed email exactly equals the invitation's canonical
 *                   address; on a match the page renders a data-free transition that
 *                   accepts automatically. Every other case — wrong account, unverified
 *                   email, unknown, expired, revoked, already accepted, inactive
 *                   Retailer/role, invalid shop — returns nothing and renders the
 *                   account-switch screen. The page never learns which, so it never
 *                   says.
 *   Signed IN,      no invitation to act on. The caller is sent to their own authorized
 *   no cookie       landing (or the neutral access-denied), which is also what stops the
 *                   Back button returning to a completed invitation's form.
 *
 * The token hash is read from the HttpOnly cookie server-side and is never rendered,
 * never placed in a prop, and never written to client state. NO DATABASE MUTATION
 * happens during this GET render — acceptance is a POST from the transition component.
 *
 * No invitation table is queried directly — everything flows through the SECURITY
 * DEFINER RPCs wrapped in @/lib/staff/staff-acceptance and @/lib/staff/staff-registration.
 */

/**
 * The single generic screen for an unavailable invitation when the visitor is signed
 * OUT and there is nothing to offer. Reveals nothing; identical for a fabricated token.
 */
function UnavailableScreen() {
  return (
    <InvitationShell
      icon={<InboxIcon className="h-6 w-6" />}
      iconTone="amber"
      title="This invitation isn’t available"
      description="It may have expired, been withdrawn, already been accepted, or been sent to a different email address. Ask the person who invited you to send a new one."
    />
  );
}

/**
 * Resolves where a signed-in caller with no invitation to act on should go. Never
 * reveals anything about an invitation — it is purely "given who you are, where do you
 * belong". "unauthorized"/"unavailable" fall back to the neutral access-denied.
 */
async function landingDestinationForSignedInCaller(): Promise<string> {
  try {
    const landing = await resolveAuthenticatedLanding();
    switch (landing.kind) {
      case "vendor":
      case "retailer":
      case "retailerStaff":
      case "salesStaff":
        return landing.destination;
      case "unauthenticated":
        return LANDING_ROUTES.login;
      default:
        return LANDING_ROUTES.accessDenied;
    }
  } catch {
    return LANDING_ROUTES.accessDenied;
  }
}

export default async function StaffInvitationPage() {
  const supabase = await createClient();

  // getClaims() cryptographically verifies the JWT rather than trusting the cookie the
  // way getSession() would — the same check every other route in this codebase makes.
  let signedIn = false;
  try {
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can carry
    // token material.
    signedIn = false;
  }

  // ---------------------------------------------------------------------------
  // Signed OUT — decide between activation and sign-in, revealing nothing else.
  // ---------------------------------------------------------------------------
  if (!signedIn) {
    const tokenHash = await readStaffInviteHash();
    const view = tokenHash ? await getStaffRegistrationView(tokenHash) : "unavailable";

    if (view === "unavailable") {
      return <UnavailableScreen />;
    }

    if (view === "sign-in") {
      return (
        <InvitationShell
          icon={<MailIcon className="h-6 w-6" />}
          steps={["Invitation", "Sign in", "Done"]}
          activeStep={1}
          title="You already have a SalesReward account"
          description="Sign in to continue. You’ll come straight back here, and your invitation will be accepted automatically."
        >
          <StaffInvitationSignInPrompt />
        </InvitationShell>
      );
    }

    // view === "register": no account yet. Password and confirmation only — the address
    // is derived from the invitation on the server.
    return (
      <InvitationShell
        icon={<KeyIcon className="h-6 w-6" />}
        steps={["Invitation", "Set password", "Done"]}
        activeStep={1}
        title="Set your password"
        description="You’ve been invited to join a Retailer on SalesReward. Choose a password to activate your account."
      >
        <ActivateStaffAccountForm />
      </InvitationShell>
    );
  }

  // ---------------------------------------------------------------------------
  // Signed IN.
  // ---------------------------------------------------------------------------
  const tokenHash = await readStaffInviteHash();

  // No cookie: the invitation was already completed (its cookie was cleared on
  // acceptance) or was never present. Send the signed-in caller to their own authorized
  // landing rather than a stale invitation page — this is also what stops the Back
  // button returning to an actionable form.
  if (!tokenHash) {
    redirect(await landingDestinationForSignedInCaller());
  }

  // The recipient RPC is the authority: a match requires the caller's confirmed email to
  // equal the invitation's canonical address exactly. It never returns another
  // Retailer's data or a foreign email.
  const resolved = await resolveStaffInvitation(tokenHash);

  if (resolved.status === "unavailable") {
    // Wrong account, or a genuinely dead invitation — the RPC does not distinguish them,
    // so neither does this. Offer the account switch, which is the remedy for the
    // common (wrong-account) case and harmless for the rare (dead) one.
    return (
      <InvitationShell
        icon={<UsersIcon className="h-6 w-6" />}
        iconTone="amber"
        title="Continue with the invited account"
        description="Another SalesReward account is currently signed in. Continuing will sign out that account so you can use this invitation."
      >
        <WrongAccountSwitch />
      </InvitationShell>
    );
  }

  // Match. Render a data-free transition that accepts automatically and redirects to the
  // correct role landing. No Retailer, role, shop, email, token, hash or id is passed to
  // it — the acceptance action re-reads the cookie server-side.
  return (
    <InvitationShell
      icon={<InboxIcon className="h-6 w-6" />}
      iconTone="emerald"
      steps={["Invitation", "Set up", "Joining"]}
      activeStep={2}
      title="Joining your Retailer…"
      description="Hold on a moment while we finish setting up your access."
    >
      <AcceptInvitationTransition />
    </InvitationShell>
  );
}
