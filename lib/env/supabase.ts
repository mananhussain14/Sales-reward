/**
 * Supabase public environment configuration + validation.
 *
 * This module ONLY reads the public, browser-safe values:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 *
 * It must NEVER read or reference a service-role / secret key. The publishable
 * key is designed to be exposed to the browser and relies on Row Level Security
 * for protection.
 *
 * `process.env.NEXT_PUBLIC_*` values are statically inlined by Next.js at build
 * time, so they are referenced directly (not via dynamic keys) below.
 */

export type SupabaseEnv = {
  url: string;
  publishableKey: string;
};

/**
 * Reads and validates the public Supabase environment variables.
 *
 * Validation runs lazily (on call) rather than at import time so that callers —
 * such as the connection-check route — can catch misconfiguration and return a
 * controlled response instead of crashing on module evaluation.
 *
 * @throws {Error} with a clear, secret-free message when configuration is missing or invalid.
 */
export function getSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!publishableKey) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing Supabase environment variable(s): ${missing.join(
        ", ",
      )}. Add them to .env.local and restart the dev server.`,
    );
  }

  try {
    // Validate shape without exposing the value in any error message.
    new URL(url as string);
  } catch {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is set but is not a valid URL. Expected something like https://<project-ref>.supabase.co.",
    );
  }

  return {
    url: url as string,
    publishableKey: publishableKey as string,
  };
}
