import type { Metadata } from "next";
import Link from "next/link";
import { InvitationShell } from "@/components/ui/invitation-shell";
import { InboxIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Invitation unavailable · SalesReward",
};

/**
 * The single failure destination for /invitations/accept.
 *
 * DELIBERATELY REASON-FREE. A missing token, a malformed one, an expired one, an
 * already-consumed one, a forged one, a revoked invitation, an invitation whose
 * Retailer has since been suspended, and a database outage all land here and see
 * exactly this text.
 *
 * That is not laziness about error messages — it is the point. Varying the copy
 * would let anyone holding a guessed or intercepted token learn which of those
 * states applies, turning this page into an oracle for whether a given invitation
 * exists and how far through its lifecycle it is. The RPC behind the callback
 * raises one byte-identical exception for its authorization cases for the same
 * reason; softening it here would undo that.
 *
 * A Server Component with no data access at all: it reads no search parameter, no
 * cookie, no header, and no database row, so there is nothing here to leak and
 * nothing to tamper with. It renders identically for every visitor.
 *
 * The route is listed in PUBLIC_PATHS in lib/supabase/proxy.ts because the people
 * who need it are precisely those who failed to obtain a session.
 */
export default function InvitationErrorPage() {
  return (
    <InvitationShell
      icon={<InboxIcon className="h-6 w-6" />}
      iconTone="amber"
      title="This invitation link cannot be used"
      description="The link may have expired, may already have been used, or may no longer be valid. Please ask the person who invited you to send a new invitation."
    >
      {/*
        No "try again" control and no link back to the callback. Retrying is
        impossible by construction — an invitation token is single-use — so
        offering it would only produce a second identical failure.

        A sign-in link IS offered, because this page has more than one kind of
        visitor. Someone whose link expired has no password and cannot use it —
        hence the wording below, which offers rather than instructs. But someone
        who ALREADY completed their invitation and then re-clicked the old email
        also lands here, and for them signing in is exactly the right next step.
        The two are indistinguishable to this page by design, so it offers the
        action that helps one and merely fails harmlessly for the other.
      */}
      <p className="text-center text-sm text-slate-500">
        Already set up your account?{" "}
        <Link
          href="/login"
          className="rounded-sm font-medium text-indigo-600 underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
        >
          Sign in
        </Link>
      </p>
    </InvitationShell>
  );
}
