import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveSafeNextPath } from "@/lib/auth/safe-next-path";
import { LoginForm } from "@/app/login/login-form";

export const metadata: Metadata = {
  title: "Sign in · SalesReward",
  description: "Sign in to SalesReward.",
};

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
  const { next: rawNext } = await searchParams;
  const nextParam = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  const safeNext =
    typeof nextParam === "string" ? resolveSafeNextPath(nextParam) : null;

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
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-900">
      <main className="w-full max-w-sm">
        {/* Branding — mirrors the sidebar lockup so login and dashboard read as one product. */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600 text-base font-bold text-white">
            SR
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            SalesReward
          </span>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Sign in to SalesReward
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Enter your email and password to continue.
            </p>
          </div>

          <LoginForm next={safeNext} />
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
          SalesReward
        </p>
      </main>
    </div>
  );
}
