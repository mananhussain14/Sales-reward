import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatOwnerTimestamp } from "@/lib/retailers/owner-status-normalization";
import { readExistingUserInviteHash } from "@/lib/invitations/existing-user-cookie";
import { resolveExistingUserInvitation } from "@/lib/invitations/existing-user-acceptance";
import { AcceptExistingInvitationForm } from "@/app/invitations/existing/accept-form";
import { SignOutMismatchForm } from "@/app/invitations/existing/sign-out-form";
import { InvitationShell } from "@/components/ui/invitation-shell";
import { buttonClasses } from "@/components/ui/button";
import {
  BuildingIcon,
  InboxIcon,
  MailIcon,
  UsersIcon,
} from "@/components/ui/icons";

/**
 * The CLEAN existing-user acceptance page (no token in the URL — it was exchanged
 * for an HttpOnly hash cookie by /invitations/existing/enter).
 *
 * `referrer: no-referrer` so this page never leaks its URL onward. `robots
 * noindex` because an invitation page should never be indexed.
 */
export const metadata: Metadata = {
  title: "Accept invitation · SalesReward",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * The acceptance page.
 *
 * Never queries invitation tables directly — everything flows through the two
 * SECURITY DEFINER RPCs (resolver + accept) wrapped in
 * @/lib/invitations/existing-user-acceptance, under the caller's own token. The
 * hash is read from the HttpOnly cookie server-side and never rendered.
 */
export default async function ExistingUserInvitationPage() {
  const supabase = await createClient();

  let signedIn = false;
  try {
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } catch {
    signedIn = false;
  }

  // Signed out: prompt sign-in. The invitation hash cookie survives login; `next`
  // carries only the clean path, never the raw token.
  if (!signedIn) {
    return (
      <InvitationShell
        icon={<MailIcon className="h-6 w-6" />}
        steps={["Invitation", "Sign in", "Done"]}
        activeStep={1}
        title="Sign in to accept your invitation"
        description="You’ve been invited to become a Retailer Owner. Sign in to your existing SalesReward account to accept."
      >
        <Link
          href="/login?next=/invitations/existing"
          className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true })}
        >
          Sign in
        </Link>
      </InvitationShell>
    );
  }

  const tokenHash = await readExistingUserInviteHash();
  if (!tokenHash) {
    return (
      <InvitationShell
        icon={<InboxIcon className="h-6 w-6" />}
        iconTone="amber"
        title="Invitation link not found"
        description="This invitation link is no longer valid. Please open the most recent invitation email again, or ask the person who invited you to send a new one."
      />
    );
  }

  const resolved = await resolveExistingUserInvitation(tokenHash);

  if (resolved.status === "unavailable") {
    return (
      <InvitationShell
        icon={<InboxIcon className="h-6 w-6" />}
        iconTone="amber"
        title="This invitation can no longer be accepted"
        description="The invitation may have expired, been withdrawn, or already been accepted. Please ask the person who invited you to send a new one."
      />
    );
  }

  if (resolved.status === "mismatch") {
    // A valid invitation, but this is the wrong (or unverified) account. Reveal
    // NOTHING about the invited address or Retailer.
    return (
      <InvitationShell
        icon={<UsersIcon className="h-6 w-6" />}
        iconTone="amber"
        title="This invitation is for a different account"
        description="You’re signed in as a different account than the one this invitation was sent to. Sign out and sign in as the invited email address to accept it."
      >
        <SignOutMismatchForm />
      </InvitationShell>
    );
  }

  // Match: the caller&rsquo;s verified email matches the invitation.
  return (
    <InvitationShell
      icon={<BuildingIcon className="h-6 w-6" />}
      steps={["Invitation", "Review", "Done"]}
      activeStep={1}
      title={`Accept ownership of ${resolved.retailerName}`}
      description={
        <>
          Accepting makes you the Retailer Owner of{" "}
          <span className="font-medium text-slate-700">
            {resolved.retailerName}
          </span>{" "}
          on SalesReward.
        </>
      }
    >
      {resolved.expiresAt && (
        <p className="mb-4 text-center text-xs text-slate-400">
          This invitation is valid until {formatOwnerTimestamp(resolved.expiresAt)}.
        </p>
      )}
      <AcceptExistingInvitationForm />
    </InvitationShell>
  );
}
