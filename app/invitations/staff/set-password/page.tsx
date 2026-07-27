import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StaffSetPasswordForm } from "@/app/invitations/staff/set-password/set-password-form";
import { InvitationShell } from "@/components/ui/invitation-shell";
import { KeyIcon } from "@/components/ui/icons";

/**
 * The set-new-password step of staff account RECOVERY.
 *
 * Reached only from /invitations/staff/recover, which verified the emailed one-time
 * token with the Auth server and established the session this page requires. It is
 * deliberately NOT on the Proxy's public allowlist: a visitor without that session has
 * nothing to do here.
 *
 * WHAT IT REVEALS: nothing. No invited address, no Retailer, role, shop, expiry,
 * invitation id, auth user id, token or hash reaches this page or its form. It renders
 * two password fields and fixed copy, and it is byte-identical for every visitor who
 * holds a recovery session.
 *
 * `referrer: no-referrer` so the page never leaks its URL onward, and `robots noindex`
 * because a recovery page should never be indexed — the same posture as the invitation
 * page itself.
 */
export const metadata: Metadata = {
  title: "Set your password · SalesReward",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/** Where a visitor with no recovery session is sent. The generic invitation failure. */
const FAILURE_PATH = "/invitations/error";

export default async function StaffSetPasswordPage() {
  const supabase = await createClient();

  // getClaims() cryptographically verifies the JWT rather than trusting the cookie the
  // way getSession() would. The Server Action re-checks this independently — a page
  // guard is not a security boundary for an endpoint a browser can POST to directly.
  let signedIn = false;
  try {
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can carry
    // token material.
    signedIn = false;
  }

  if (!signedIn) {
    // An expired or already-consumed recovery link, or a direct visit. One destination
    // for all of them, so nothing about which is distinguishable.
    redirect(FAILURE_PATH);
  }

  return (
    <InvitationShell
      icon={<KeyIcon className="h-6 w-6" />}
      steps={["Invitation", "Set password", "Done"]}
      activeStep={1}
      title="Set your password"
      description="Choose a password for your SalesReward account. You’ll come straight back to your invitation once it’s saved."
    >
      <StaffSetPasswordForm />
    </InvitationShell>
  );
}
