import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { getMyLifecycleAccessState } from "@/lib/staff/my-lifecycle-access-state";
import { resolveLifecycleNotice } from "@/lib/staff/lifecycle-access-state";
import { AccessDeniedCard } from "@/components/ui/access-denied-card";
import { LifecycleNoticeCard } from "@/components/ui/lifecycle-notice-card";

export const metadata: Metadata = {
  title: "Access denied · SalesReward",
  description: "This account does not have access to this page.",
};

/**
 * Shown to an authenticated user who is not an authorized Retailer Owner.
 *
 * It lives OUTSIDE the (retailer) route group deliberately. Inside it, the group
 * layout's own authorization check would redirect every unauthorized visitor
 * straight back here, producing a redirect loop — the page has to sit where the
 * guard does not run.
 *
 * The access check runs again at this server boundary rather than trusting that
 * the layout redirected here: this page is directly addressable, so its state
 * must be established from the verified session, not from how the caller
 * arrived.
 *
 * The copy is deliberately vague about WHY access was denied, matching
 * /access-denied. This page is reached identically by an inactive profile, an
 * INVITED or inactive membership, an inactive Retailer, a missing or inactive
 * RETAILER_OWNER role, a missing permission, a Vendor Super Admin with no
 * Retailer Owner membership, a user qualifying for zero Retailers, and a user
 * ambiguously qualifying for more than one. Naming the failing condition would
 * tell an unauthorized (possibly hostile) account exactly what to acquire next.
 *
 * The ambiguous case matters most here: it must NOT list the candidate
 * Retailers, or even hint that more than one exists. It reads exactly like every
 * other denial.
 *
 * A Vendor Super Admin who lands here is NOT redirected into the Vendor Admin.
 * That would be an automatic cross-portal redirect based on a failed check in a
 * different product surface — it would tell any visitor whether the signed-in
 * account holds Vendor access, and it would bounce someone who typed /retailer
 * deliberately. The sign-out control is the way out, exactly as on
 * /access-denied.
 */
export default async function RetailerAccessDeniedPage() {
  const access = await getRetailerOwnerPortalAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // An authorized owner has no reason to see this page — send them to the
  // portal. This keeps the page self-correcting: once access is granted, a stale
  // bookmark stops being a dead end.
  if (access.status === "authorized") {
    redirect("/retailer");
  }

  // "unavailable" deliberately falls through to the same generic card below.
  // The caller could not be evaluated, so the honest thing is to show no more
  // than the denial does — inventing a distinct "try again" state here would
  // reveal that the check reached the database and failed, rather than that it
  // denied.

  // ------------------------------------------------------------------------
  // The self-only lifecycle diagnostic — read AFTER the refusal, never before.
  // ------------------------------------------------------------------------
  // ⚠️ THIS IS NOT AN AUTHORIZATION GATE, AND IT DOES NOT GRANT ANYTHING. Access
  // was already decided above, and by the layout, and by every protected RPC —
  // each from auth.uid(), independently. This call happens only once that
  // decision is a refusal, and its single-word answer chooses a SENTENCE. No
  // branch below admits a request; `ACTIVE` renders the ordinary denial exactly
  // like every other unexplained case.
  //
  // WHY IT IS SAFE TO ASK. The RPC takes ZERO arguments and derives its subject
  // solely from auth.uid(), so this page cannot ask about anybody else and a
  // visitor cannot make it. It returns one word from a closed vocabulary and no
  // id, name, email, role, organization, raw status, timestamp or database
  // message — nothing that is not already the caller's own knowledge about
  // their own account.
  //
  // WHY NOT A QUERY STRING. A `?reason=` parameter would be attacker-controlled
  // text deciding what a page says about an account, which is a disclosure
  // primitive and a phishing surface. Nothing about this page's state is read
  // from the URL — the state comes from the signed-in session, or it does not
  // come at all.
  //
  // NO REDIRECT LOOP IS POSSIBLE. This page sits outside the (retailer) route
  // group, so the group layout's guard never runs for it, and nothing below
  // redirects: every path from here renders a card with a sign-out control.
  const lifecycle = await getMyLifecycleAccessState();

  const notice = resolveLifecycleNotice(
    lifecycle.status === "ok" ? lifecycle.accessState : null,
  );

  // A lifecycle cause that has something specific and safe to say: the caller's
  // membership, their Retailer, or their profile is inactive, or their account
  // resolves ambiguously. Everything else — including ACTIVE (some other
  // condition refused them), NO_SUPPORTED_ACCESS (the ordinary "not for you"
  // case, whose distinct copy would disclose that they hold no Retailer
  // membership at all), and an unreadable or unrecognized diagnostic — keeps the
  // existing neutral card unchanged.
  if (notice !== null) {
    return (
      <LifecycleNoticeCard title={notice.title} message={notice.message} />
    );
  }

  return <AccessDeniedCard />;
}
