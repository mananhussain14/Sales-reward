// This module imports `next/headers`, which is server-only. Importing it into a
// Client Component throws at build time — that error is our guard against this
// server client (and its cookie access) accidentally reaching the browser.
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/env/supabase";

/**
 * Creates a Supabase client for Server Components, Server Actions, and Route
 * Handlers, wired to the request's cookies via the Next.js 16 async `cookies()`
 * API. Uses only the public URL + publishable key — never a service-role key.
 *
 * Authorization decisions must use `supabase.auth.getUser()` (revalidates with
 * the Auth server), not the cookie-trusting `getSession()`.
 */
export async function createClient() {
  const { url, publishableKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` was called from a Server Component, which cannot write
          // cookies. This is safe to ignore: once the login module exists,
          // proxy.ts will refresh the session cookies on each request.
        }
      },
    },
  });
}
