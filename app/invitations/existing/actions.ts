"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LANDING_ROUTES } from "@/lib/auth/landing-decision";
import {
  clearExistingUserInviteCookie,
  readExistingUserInviteHash,
} from "@/lib/invitations/existing-user-cookie";
import { acceptExistingUserInvitation } from "@/lib/invitations/existing-user-acceptance";
import type { AcceptExistingState } from "@/app/invitations/existing/accept-state";

/**
 * Server Action for accepting an existing-user Retailer Owner invitation.
 *
 * THE HASH COMES ONLY FROM THE HttpOnly COOKIE — never from form data. This form
 * posts no token and no hash; a hand-crafted POST carrying either is ignored,
 * because this action never reads a form field. Acceptance is authorized entirely
 * by the database RPC, which resolves auth.uid(), requires a verified matching Auth
 * email, and refuses every other case with one generic error.
 *
 * On success the cookie is cleared and the new owner is sent to the Retailer portal
 * (LANDING_ROUTES.retailer) — never to a Vendor Admin route. Every refusal maps to
 * one generic, safe message.
 */

/** Shown for any refusal — wrong account, expired, revoked, active owner, etc. */
const GENERIC_ERROR =
  "This invitation can no longer be accepted. Please ask the person who invited you to send a new one.";

/** Shown for a transient failure where retrying is worthwhile. */
const RETRY_ERROR = "Something went wrong. Please try again.";

export async function acceptExistingUserInvitationAction(
  _prevState: AcceptExistingState,
  _formData: FormData,
): Promise<AcceptExistingState> {
  // The hash is read server-side from the HttpOnly cookie. No FormData is consulted.
  const tokenHash = await readExistingUserInviteHash();
  if (!tokenHash) {
    return { error: GENERIC_ERROR };
  }

  // Require a verified session for clean UX; the RPC also fails closed without one.
  const supabase = await createClient();
  let hasSession = false;
  try {
    const { data } = await supabase.auth.getClaims();
    hasSession = Boolean(data?.claims?.sub);
  } catch {
    hasSession = false;
  }

  // Outside any try/catch: redirect() signals by throwing NEXT_REDIRECT.
  if (!hasSession) {
    redirect("/login?next=/invitations/existing");
  }

  const result = await acceptExistingUserInvitation(tokenHash);

  if (result.status === "unavailable") {
    return { error: RETRY_ERROR };
  }
  if (result.status === "refused") {
    return { error: GENERIC_ERROR };
  }

  // Accepted: the caller now satisfies the Retailer Owner chain (ACTIVE profile,
  // ACTIVE membership, RETAILER_OWNER role). Clear the single-use cookie and drop
  // any stale render, then land in the portal.
  await clearExistingUserInviteCookie();
  revalidatePath("/", "layout");

  // A FIXED internal literal — never a Vendor route, never a caller-supplied path.
  redirect(LANDING_ROUTES.retailer);
}

/**
 * Signs the wrong-account visitor out and returns them to the sign-in page with a
 * safe internal `next` that brings them back to the acceptance page — where the
 * invitation hash cookie (untouched by sign-out) is still waiting, so signing in as
 * the invited address resolves the invitation. The raw token is not in `next`.
 *
 * On failure it surfaces one generic message; the session it ends is identified
 * solely by the request's own cookies, so it reads no FormData.
 */
export async function signOutForExistingInvitationAction(
  _prevState: AcceptExistingState,
  _formData: FormData,
): Promise<AcceptExistingState> {
  const supabase = await createClient();
  try {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) return { error: RETRY_ERROR };
  } catch {
    return { error: RETRY_ERROR };
  }

  revalidatePath("/", "layout");
  // Fixed internal literal; the safe `next` is a constant, not a caller value.
  redirect("/login?next=/invitations/existing");
}
