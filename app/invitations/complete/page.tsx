import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CompleteInvitationForm } from "@/app/invitations/complete/complete-form";
import { resolveAuthenticatedLanding } from "@/lib/auth/authenticated-landing";
import { InvitationShell } from "@/components/ui/invitation-shell";
import { KeyIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Activate your account · SalesReward",
};

/**
 * Where a verified invitee with no Retailer invitation and no portal is sent.
 *
 * A fixed internal literal, never assembled from a query parameter, a header or a
 * database value — the same discipline every other redirect target in this flow
 * follows, and what makes an open redirect impossible here.
 */
const GENERIC_ACCOUNT_SETUP_PATH = "/invitations/account-setup";

/**
 * Password completion for an invited Retailer Owner.
 *
 * Reached only from /invitations/accept, which has just verified the emailed
 * token and established a session. This page is where the invitee actually
 * becomes an account: they set a password, and only then does the Server Action
 * accept the invitation and flip their membership from INVITED to ACTIVE.
 *
 * REQUIRES A SESSION. Deliberately NOT on the proxy's public allowlist — unlike
 * /invitations/accept, which must be reachable without one. The check below is the
 * real boundary regardless: per the Next.js guidance this codebase follows
 * throughout, Proxy is an optimistic pre-filter and every route verifies for
 * itself.
 *
 * WHAT IT DISPLAYS, AND WHAT IT REFUSES TO
 *   The Retailer's name, and nothing else. That single value comes from
 *   public.get_my_pending_retailer_invitation(), a zero-argument SECURITY DEFINER
 *   function that resolves the invitation from auth.uid() alone. There is no
 *   invitation id, Auth user id, profile id, membership id, role id, organization
 *   id, email address, or token anywhere in this page or the payload it produces —
 *   the function does not return them, so there is nothing here to leak.
 *
 *   The invitee's own email is deliberately absent even though they obviously know
 *   it: rendering it would put an address into an RSC payload and a server-rendered
 *   HTML document for no benefit, on a page anyone holding a valid token can reach.
 */
export default async function CompleteInvitationPage() {
  const supabase = await createClient();

  // getClaims() verifies the JWT signature rather than trusting the cookie the way
  // getSession() would — the same check the login page, the admin layout, and the
  // Server Action all make.
  let hasSession: boolean;
  try {
    const { data } = await supabase.auth.getClaims();
    hasSession = Boolean(data?.claims?.sub);
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can
    // carry token material.
    hasSession = false;
  }

  if (!hasSession) {
    // To the invitation error page, not /login. Someone who arrived here without a
    // session followed a bad or expired link, and a sign-in form is useless to a
    // person who has never set a password.
    redirect("/invitations/error");
  }

  // The one database read. Zero arguments: the caller cannot nominate whose
  // invitation is looked up.
  //
  // Promise.resolve() because the PostgREST builder is a thenable, not a real
  // Promise, matching the shape used throughout this codebase.
  const result = await Promise.resolve(
    supabase.rpc("get_my_pending_retailer_invitation"),
  ).catch(() => null);

  // A THROW OR A REPORTED ERROR IS AN OPERATIONAL FAILURE, and it is separated from
  // "zero rows" deliberately. Both used to land on the same generic error page, which
  // was safe when that page was the only outcome. It is not safe now: below, zero rows
  // becomes a decision about where this session belongs, and treating a transient
  // PostgREST fault as "this person has no invitation" would route a genuine Retailer
  // invitee into generic account setup and leave their invitation unaccepted.
  //
  // The error is never bound or logged: a PostgREST error names tables, columns,
  // functions, and policies.
  if (result === null || result.error) {
    redirect("/invitations/error");
  }

  const rows = (result.data ?? []) as {
    retailer_name: string;
    expires_at: string;
  }[];

  const invitation = rows[0];

  // ---------------------------------------------------------------------------
  // A. RETAILER INVITATION — unchanged
  // ---------------------------------------------------------------------------
  // Everything below this branch is new; everything inside it is exactly what this
  // page has always done. The Retailer path did not move, did not lose a check, and
  // did not gain one.
  if (!invitation || typeof invitation.retailer_name !== "string") {
    // -------------------------------------------------------------------------
    // B. NO PENDING RETAILER INVITATION
    // -------------------------------------------------------------------------
    // Zero rows is the ordinary case for: never invited, already accepted, expired,
    // revoked, the Retailer suspended since, finalization never having completed —
    // AND, the case this milestone exists for, an invited Vendor-side user who never
    // had a Retailer invitation row at all. The function does not distinguish them,
    // and neither does this page: what follows asks a different question entirely —
    // "what is this verified session actually authorized for?" — and answers it from
    // the existing resolvers rather than from the invitation lookup.
    //
    // resolveAuthenticatedLanding() takes NO arguments and reads only auth.uid()
    // through the same resolvers the login action uses. No email, query-string role
    // or browser-supplied organization id influences it, so no caller can steer this
    // choice.
    const landing = await resolveAuthenticatedLanding();

    switch (landing.kind) {
      // An already-configured user. They have a portal, so they do not belong in
      // generic account setup — send them where they normally land. `destination` is
      // a literal from LANDING_ROUTES, never a caller-supplied value.
      case "vendor":
      case "retailer":
      case "retailerStaff":
      case "salesStaff":
      case "claimReviewer":
        redirect(landing.destination);

      // Unreachable: the session was verified at the top of this page. Handled
      // anyway, and never by falling through into account setup.
      case "unauthenticated":
        redirect("/invitations/error");

      // An operational failure inside a resolver. NOT a denial, and specifically not
      // evidence that the caller has no portal — so it must not become generic setup,
      // which would ask a configured user to reset their password during an outage.
      case "unavailable":
        return (
          <InvitationShell
            icon={<KeyIcon className="h-6 w-6" />}
            title="We couldn’t finish setting up your account"
            description="Something went wrong on our side. Please refresh this page to try again."
          />
        );

      // Portal context is NONE: a verified account with no Vendor, Retailer or
      // reviewer access. This is the generic invitee. Setting a password is the only
      // thing they can usefully do, and it grants them nothing.
      case "unauthorized":
        redirect(GENERIC_ACCOUNT_SETUP_PATH);
    }
  }

  return (
    <InvitationShell
      icon={<KeyIcon className="h-6 w-6" />}
      steps={["Invitation", "Set password", "Done"]}
      activeStep={1}
      title="Activate your account"
      description={
        <>
          You have been invited as the owner of{" "}
          <span className="font-medium text-slate-700">
            {invitation.retailer_name}
          </span>
          . Choose a password to finish setting up your account.
        </>
      }
    >
      <CompleteInvitationForm />
    </InvitationShell>
  );
}
