import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const metadata: Metadata = {
  title: "Account activated · SalesReward",
};

/**
 * Where a completed invitation lands.
 *
 * By the time this renders, all of the following are true and committed: the Auth
 * user has a password, the profile exists, the Retailer membership is ACTIVE, the
 * RETAILER_OWNER role is assigned, and the invitation is ACCEPTED with its audit
 * record written in the same transaction.
 *
 * WHY NOT REDIRECT TO "/" — the obvious destination is wrong. "/" lives inside the
 * (admin) route group, whose layout requires an ACTIVE VENDOR_SUPER_ADMIN and
 * correctly refuses a Retailer Owner. Sending a brand-new owner there means the
 * first thing they see immediately after succeeding is /access-denied, which reads
 * as a bug and generates support traffic on day one.
 *
 * This page is therefore the honest destination: it confirms the activation
 * actually worked and states plainly that there is nothing further to use yet. It
 * is NOT the Retailer portal and deliberately contains none of it — no navigation,
 * no organization data, no shops, no members, no actions beyond signing out.
 *
 * REQUIRES A SESSION and is deliberately NOT on the proxy's public allowlist. It
 * reads NO database row — not the profile, not the membership, not the
 * organization — so the text is identical for every visitor and there is nothing
 * here to leak: no id, no email, no token, no Retailer name. Naming the Retailer
 * would mean resolving the owner's organization context, which belongs to the
 * portal work that will actually use it.
 */
export default async function InvitationSuccessPage() {
  const supabase = await createClient();

  // getClaims() verifies the JWT signature rather than trusting the cookie the way
  // getSession() would — the same check every other route in this codebase makes.
  let hasSession: boolean;
  try {
    const { data } = await supabase.auth.getClaims();
    hasSession = Boolean(data?.claims?.sub);
  } catch {
    // Deliberately not bound or logged: auth exceptions can carry token material.
    hasSession = false;
  }

  if (!hasSession) {
    // A signed-out visitor who bookmarked this URL. /login is the right
    // destination now — unlike on the completion page, this person HAS a password.
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-900">
      <main className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600 text-base font-bold text-white">
            SR
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            SalesReward
          </span>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>

          <h1 className="mt-4 text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Your account is activated
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Your password has been set and your retailer owner account is now
            active.
          </p>
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            The retailer workspace is not enabled yet. You will be able to sign in
            and use it as soon as it is ready.
          </p>

          {/*
            The one control. Signing out is genuinely the only useful action
            available — there is no workspace to enter — and leaving an activated
            session open on a shared machine with no way to end it would be worse
            than offering nothing. The "card" variant renders it full-width, the
            same treatment the access-denied page uses for the same reason.
          */}
          <div className="mt-6">
            <SignOutButton variant="card" />
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
          SalesReward · v0.1
        </p>
      </main>
    </div>
  );
}
