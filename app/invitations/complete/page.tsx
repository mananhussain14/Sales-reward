import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CompleteInvitationForm } from "@/app/invitations/complete/complete-form";
import { InvitationShell } from "@/components/ui/invitation-shell";
import { KeyIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Activate your account · SalesReward",
};

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

  // A throw, a reported error, or zero rows all land here. Zero rows is the
  // ordinary case for: never invited, already accepted, expired, revoked, the
  // Retailer suspended since, or finalization never having completed. The function
  // does not distinguish them and neither does this page — sending them all to one
  // generic destination is what stops this route being an oracle for whether a
  // given session has a live invitation.
  //
  // The error is never bound or logged: a PostgREST error names tables, columns,
  // functions, and policies.
  const rows = (result?.error ? null : result?.data) as
    | { retailer_name: string; expires_at: string }[]
    | null
    | undefined;

  const invitation = rows?.[0];

  if (!invitation || typeof invitation.retailer_name !== "string") {
    redirect("/invitations/error");
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
