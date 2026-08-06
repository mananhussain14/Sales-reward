import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveSafeNextPath } from "@/lib/auth/safe-next-path";
import { LoginForm } from "@/app/login/login-form";
import { BrandLockup } from "@/components/ui/brand";
import { AuthBrandPanel } from "@/components/ui/auth-brand-panel";

export const metadata: Metadata = {
  title: "Sign in · SalesReward",
  description: "Sign in to SalesReward.",
};

/**
 * The single recognised `?notice=` value, set by the generic account-setup action
 * after it signs a newly invited person out.
 *
 * Compared as an exact literal and never echoed, so the query string can select this
 * one message and nothing else.
 */
const ACCOUNT_READY_NOTICE = "account-ready";

/**
 * The UNIVERSAL sign-in page — one route for every role.
 *
 * Vendor Super Admins, Retailer Owners, Retailer Managers and Sales Staff all sign in
 * here. Nothing on this page names a role, and nothing on it decides one: the wording
 * is role-neutral because the page genuinely cannot know who is signing in until Auth
 * has verified them, and where they go afterwards is resolved on the SERVER from their
 * actual authorization (see resolveAuthenticatedLanding, called by the sign-in action).
 *
 * WHY NO ROLE TEXT AT ALL. A page that said "Vendor Admin sign in" was not merely
 * unwelcoming to the other three roles — it was a claim about the visitor that the page
 * has no basis for, and a hint about which credentials are worth trying. The neutral
 * wording removes both.
 *
 * A validated `next` path is honoured so someone sent here mid-flow (an invitation, a
 * deep link) returns to exactly that page. It is filtered by resolveSafeNextPath here,
 * and re-filtered by the sign-in action on receipt, so an open redirect is impossible
 * even from a hand-crafted request.
 *
 * Deliberately absent: self-service sign-up (invited staff activate through their
 * invitation link, which proves which address they are), forgot-password, social
 * login, and any demo or default credentials.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();

  // A post-login destination, validated to a same-origin internal path. Anything
  // unsafe (external URL, scheme, control chars) collapses to null. Used both to
  // route an already-authenticated visitor and, via a hidden field, to tell the
  // sign-in action where to return an authenticating one.
  const { next: rawNext, notice: rawNotice } = await searchParams;
  const nextParam = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  const safeNext =
    typeof nextParam === "string" ? resolveSafeNextPath(nextParam) : null;

  // A one-of-a-kind post-setup notice, matched against a single exact literal.
  //
  // The parameter's VALUE is never rendered — it only selects a message authored in
  // this file. A caller who invents any other value gets no notice at all, so this
  // cannot be turned into a way to display arbitrary text on the sign-in page, and
  // it discloses nothing: anyone can append it to the URL themselves.
  const noticeParam = Array.isArray(rawNotice) ? rawNotice[0] : rawNotice;
  const showAccountReadyNotice = noticeParam === ACCOUNT_READY_NOTICE;

  // Same verified check the admin layout performs, in the opposite direction:
  // an already-authenticated user has no business seeing the login form.
  // getClaims() verifies the token rather than trusting the cookie the way
  // getSession() would.
  const { data } = await supabase.auth.getClaims();

  if (data?.claims) {
    // Honor a safe `next` so an authenticated visitor who followed an invitation
    // link lands on that page (which enforces its own access), not the default.
    redirect(safeNext ?? "/");
  }

  return (
    <div className="min-h-screen bg-white lg:grid lg:grid-cols-2">
      {/* Marketing panel — wide screens only, role-neutral. */}
      <AuthBrandPanel />

      {/* Sign-in panel. On mobile it is the whole page; the form leads. */}
      <div className="flex min-h-screen flex-col justify-center bg-slate-50 px-4 py-12 sm:px-6 lg:bg-white lg:px-12">
        <main className="mx-auto w-full max-w-sm">
          {/* Compact brand header — shown on mobile, where the panel is hidden. */}
          <div className="mb-8 lg:hidden">
            <BrandLockup size={40} idSuffix="-login-mobile" />
          </div>

          {showAccountReadyNotice ? (
            <div
              role="status"
              className="mb-6 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-100"
            >
              Your account has been confirmed. An administrator must finish
              setting up your access before you can sign in to SalesReward.
            </div>
          ) : null}

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8 lg:border-0 lg:p-0 lg:shadow-none">
            <div className="mb-6">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                Welcome back
              </h1>
              <p className="mt-1.5 text-sm text-slate-500">
                Sign in to your SalesReward account to continue.
              </p>
            </div>

            <LoginForm next={safeNext} />
          </div>

          <p className="mt-8 text-center text-xs text-slate-400">
            Secure sign-in · SalesReward
          </p>
        </main>
      </div>
    </div>
  );
}
