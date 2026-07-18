import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "@/app/login/login-form";

export const metadata: Metadata = {
  title: "Sign in · SalesReward Admin",
  description: "Sign in to the SalesReward Vendor Admin.",
};

/**
 * Public sign-in page.
 *
 * Deliberately absent, per the current milestone: sign-up, invitations,
 * forgot-password, social login, and any demo/default credentials.
 */
export default async function LoginPage() {
  const supabase = await createClient();

  // Same verified check the admin layout performs, in the opposite direction:
  // an already-authenticated user has no business seeing the login form.
  // getClaims() verifies the token rather than trusting the cookie the way
  // getSession() would.
  const { data } = await supabase.auth.getClaims();

  if (data?.claims) {
    redirect("/");
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
              Vendor Admin sign in
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Enter your credentials to access the admin.
            </p>
          </div>

          <LoginForm />
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
          Vendor Admin · v0.1
        </p>
      </main>
    </div>
  );
}
