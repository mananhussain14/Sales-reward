import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { formatOwnerTimestamp } from "@/lib/retailers/owner-status-normalization";
import { readStaffInviteHash } from "@/lib/staff/staff-invite-cookie";
import { resolveStaffInvitation } from "@/lib/staff/staff-acceptance";
import { getStaffRegistrationView } from "@/lib/staff/staff-registration";
import { retailerRoleDisplayName } from "@/lib/staff/staff-roles";
import {
  AcceptStaffInvitationForm,
  ActivateStaffAccountForm,
  SignOutForStaffInvitationForm,
  StaffInvitationSignInPrompt,
} from "@/app/invitations/staff/accept-forms";

/**
 * The CLEAN staff acceptance page — no token in the URL. It was exchanged for an
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
 *   Signed OUT      one bit only, and it is decided on the server: does the invited
 *                   address already have an account? That chooses between a
 *                   password-only activation form and a sign-in prompt. NOTHING else
 *                   is revealed — not the Retailer, the role, the shops, the expiry,
 *                   or the invited email itself, which never leaves the server. An
 *                   unknown, malformed, expired, revoked, accepted or stale token, and
 *                   a visitor with no cookie, all render one identical screen.
 *   Signed IN       the resolver decides, in SQL. It returns rows ONLY when the
 *                   caller's Auth email is CONFIRMED and exactly equals the
 *                   invitation's canonical address; every other case — wrong account,
 *                   unverified email, unknown, malformed, expired, revoked, already
 *                   accepted, inactive Retailer or role, an intended shop that is no
 *                   longer valid — returns zero rows and lands on ONE generic screen.
 *                   This page never learns which, so it can never say.
 *
 * The token hash is read from the HttpOnly cookie server-side and is never rendered,
 * never placed in a prop, and never written to client state or localStorage.
 *
 * No invitation table is queried directly — everything flows through the two SECURITY
 * DEFINER RPCs wrapped in @/lib/staff/staff-acceptance, under the caller's own token.
 */

/** Centered card shell shared by every state below. Mirrors the owner flow's. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-900">
      <main className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600 text-base font-bold text-white">
            SR
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            SalesReward
          </span>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
          {children}
        </div>
      </main>
    </div>
  );
}

const headingClasses =
  "text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50";
const bodyClasses = "mt-2 text-sm text-zinc-500 dark:text-zinc-400";

/**
 * The single generic screen for every unavailable case.
 *
 * It offers a way forward — sign out and use a different account — because the most
 * common innocent cause is being signed in as the wrong person. Offering it discloses
 * nothing: the screen and the offer are identical for a fabricated token.
 */
function UnavailableScreen({ signedIn }: { signedIn: boolean }) {
  return (
    <Shell>
      <h1 className={headingClasses}>This invitation isn&rsquo;t available</h1>
      <p className={bodyClasses}>
        It may have expired, been withdrawn, already been accepted, or been sent to a
        different email address. Ask the person who invited you to send a new one.
      </p>
      {signedIn && (
        <div className="mt-6">
          <SignOutForStaffInvitationForm />
        </div>
      )}
    </Shell>
  );
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
    // token material. An identity we cannot verify is no identity.
    signedIn = false;
  }

  // ---------------------------------------------------------------------------
  // Signed out — decide between activation and sign-in, revealing nothing else.
  // ---------------------------------------------------------------------------
  // The ONLY thing established here is which of two screens to show, and it is
  // established on the SERVER: the hash cookie goes to a service-role RPC that reports
  // "register", "sign-in" or "unavailable" — a discriminant with no email attached, by
  // construction (see @/lib/staff/staff-registration). The invited address therefore
  // cannot reach a prop, the HTML, the RSC payload, client JavaScript, a URL or a log.
  //
  // Neither screen names the Retailer, the role, the shops, the expiry or the address.
  // All of that appears only AFTER sign-in, once the authenticated recipient RPC has
  // verified that the caller's CONFIRMED email matches the invitation exactly.
  //
  // An unknown, malformed, expired, revoked, accepted or stale token — and a visitor
  // with no cookie at all — land on one identical "not available" screen.
  if (!signedIn) {
    const tokenHash = await readStaffInviteHash();
    const view = tokenHash ? await getStaffRegistrationView(tokenHash) : "unavailable";

    if (view === "unavailable") {
      return <UnavailableScreen signedIn={false} />;
    }

    if (view === "sign-in") {
      // The invited address already has a SalesReward account. No password fields:
      // they have a password already, and offering to set another would be a
      // password-reset flow this milestone does not build.
      return (
        <Shell>
          <h1 className={headingClasses}>You already have a SalesReward account</h1>
          <p className={bodyClasses}>
            Sign in to continue. You&rsquo;ll come straight back here to accept your
            invitation.
          </p>
          <div className="mt-6">
            <StaffInvitationSignInPrompt />
          </div>
        </Shell>
      );
    }

    // view === "register": no account yet. Password and confirmation only — the
    // address is derived from the invitation on the server.
    return (
      <Shell>
        <h1 className={headingClasses}>Set your password</h1>
        <p className={bodyClasses}>
          You&rsquo;ve been invited to join a Retailer on SalesReward. Choose a password
          to activate your account.
        </p>
        <div className="mt-6">
          <ActivateStaffAccountForm />
        </div>
      </Shell>
    );
  }

  // ---------------------------------------------------------------------------
  // Signed in — the RPC is the authority for verified-email matching.
  // ---------------------------------------------------------------------------
  const tokenHash = await readStaffInviteHash();

  // No cookie: the link was never opened in this browser, or the hour-long cookie
  // lapsed. Reported on the SAME screen as every other unavailable case, so a visitor
  // cannot distinguish "no token" from "not your invitation".
  if (!tokenHash) {
    return <UnavailableScreen signedIn />;
  }

  const resolved = await resolveStaffInvitation(tokenHash);

  if (resolved.status === "unavailable") {
    return <UnavailableScreen signedIn />;
  }

  // Match: the caller's CONFIRMED email equals the invitation's canonical address.
  // Everything below comes from the RPC's own safe payload — no id of any kind, no
  // token, no hash, no Auth metadata, and no other Retailer's data.
  const { invitation } = resolved;
  const roleName = retailerRoleDisplayName(invitation.roleCode, invitation.roleName);

  return (
    <Shell>
      <h1 className={headingClasses}>Join {invitation.retailerName}</h1>
      <p className={bodyClasses}>
        Hi {invitation.firstName}, you&rsquo;ve been invited to join{" "}
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          {invitation.retailerName}
        </span>{" "}
        on SalesReward.
      </p>

      <dl className="mt-6 divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <dt className="text-zinc-500 dark:text-zinc-400">Role</dt>
          <dd className="text-right font-medium text-zinc-900 dark:text-zinc-100">
            {roleName}
          </dd>
        </div>

        {/* Shops appear only for a Sales Staff invitation — a Retailer Manager
            invitation carries none, and the RPC returns an empty array for it. */}
        {invitation.shopNames.length > 0 && (
          <div className="flex items-start justify-between gap-4 px-4 py-3">
            <dt className="text-zinc-500 dark:text-zinc-400">Shops</dt>
            <dd className="text-right font-medium text-zinc-900 dark:text-zinc-100">
              {invitation.shopNames.join(", ")}
            </dd>
          </div>
        )}

        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <dt className="text-zinc-500 dark:text-zinc-400">Email</dt>
          <dd className="break-all text-right font-medium text-zinc-900 dark:text-zinc-100">
            {invitation.email}
          </dd>
        </div>
      </dl>

      {invitation.expiresAt && (
        <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
          This invitation is valid until {formatOwnerTimestamp(invitation.expiresAt)}.
        </p>
      )}

      <div className="mt-6">
        <AcceptStaffInvitationForm />
      </div>
    </Shell>
  );
}
