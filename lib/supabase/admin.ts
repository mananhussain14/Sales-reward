// SERVER-ONLY MODULE. THE ONLY SERVICE-ROLE CLIENT IN THIS CODEBASE.
//
// Read this header before importing anything from here.
//
// Every other Supabase client in this project (lib/supabase/client.ts,
// lib/supabase/server.ts, lib/supabase/proxy.ts) uses the PUBLISHABLE key and is
// therefore subject to Row Level Security. Three separate modules in this
// codebase state, in comments, that "service_role is not used here or anywhere in
// this codebase". This module is the deliberate, single, reviewed exception to
// that rule, and it exists for exactly one reason:
//
//   Creating a Supabase Auth user on behalf of SOMEBODY ELSE is only possible
//   through the Auth Admin API, which requires the secret/service-role key. There
//   is no publishable-key path that invites another person. `signUp()` registers
//   the CURRENT browser, which is a different operation, is reachable by anonymous
//   callers, and cannot be authorized against the Vendor.
//
// WHAT THIS KEY IS
//   It bypasses Row Level Security entirely and can read and write every table in
//   the database. It is equivalent to full database access. It must therefore
//   never reach a browser, a log line, an error message, a URL, a client
//   component, or a git commit.
//
// THE RULES THIS MODULE ENFORCES, AND WHY EACH ONE IS HERE
//   1. The env var is NOT prefixed NEXT_PUBLIC_. Next.js statically inlines every
//      NEXT_PUBLIC_* value into the client bundle at build time, so that prefix
//      would publish the key to every visitor.
//   2. A runtime browser guard throws on module evaluation if this ever loads in
//      a browser. lib/supabase/server.ts gets this guarantee for free by importing
//      `next/headers`, which fails the build if it reaches the client. An Auth
//      Admin client needs no cookies and therefore has no such import to rely on,
//      so the guard is explicit. (The `server-only` package would state this more
//      directly; it is not installed and no dependency is added for it.)
//   3. The client is constructed LAZILY, inside the function, not at module
//      scope. A missing key then produces a controlled error at the one call site
//      that needs it, rather than crashing any route that transitively imports
//      this file.
//   4. Sessions are fully disabled. An admin client that persisted or refreshed a
//      session could write auth cookies onto a response and hand a visitor
//      service-role credentials.
//   5. Nothing here ever returns, exports, logs, or interpolates the key. The
//      error messages below name the VARIABLE, never the value.

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env/supabase";

/**
 * Rule 2. Evaluated at module scope so the failure is immediate and total rather
 * than deferred to whichever call happens to run first in the browser.
 *
 * This is a guard against a mistake (someone importing this from a Client
 * Component), not a security boundary against an attacker — by the time code runs
 * in a browser, anything bundled into it is already public. The real protection is
 * that the key is never NEXT_PUBLIC_ and so is never bundled at all; this turns
 * the resulting `undefined` into a loud error instead of a silent misbehaviour.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "lib/supabase/admin.ts was imported into browser code. This module holds service-role credentials and must only ever run on the server.",
  );
}

/**
 * The secret key's environment variable.
 *
 * Named SUPABASE_SERVICE_ROLE_KEY per the batch brief. Note that this project uses
 * Supabase's NEW API key scheme (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY rather than
 * the legacy ANON_KEY), whose counterpart is the SECRET key — an `sb_secret_…`
 * value rather than a legacy `service_role` JWT. Either form works in this
 * variable; the secret key is the one to prefer for a project on the new scheme.
 *
 * Deliberately NOT read through lib/env/supabase.ts. That module's docblock states
 * it "must NEVER read or reference a service-role / secret key", and it is
 * imported by the browser client — so a secret read there would sit one careless
 * refactor away from the client bundle. The public URL still comes from it,
 * because that value genuinely is public.
 */
const SERVICE_ROLE_KEY_VAR = "SUPABASE_SERVICE_ROLE_KEY";

/**
 * Thrown when the service-role key is absent or unusable.
 *
 * A distinct class so callers can recognize a CONFIGURATION failure without
 * inspecting a message, and map it to their own generic user-facing text. The
 * message names the variable so an operator can fix it; it never contains, hints
 * at, or partially prints the value.
 */
export class SupabaseAdminConfigurationError extends Error {}

/**
 * Builds the Supabase Auth Admin client.
 *
 * NOT exported as a module-level singleton and not memoized: constructing it is
 * cheap, and a shared instance would outlive the request that justified creating
 * it. Callers should hold it for the duration of one operation and let it go.
 *
 * @throws {SupabaseAdminConfigurationError} when the key is missing or blank.
 */
export function createAdminClient(): SupabaseClient {
  // Rule 3: read and validate at call time.
  //
  // Referenced as a literal property rather than through the SERVICE_ROLE_KEY_VAR
  // constant. Next.js only performs static replacement on literal
  // `process.env.FOO` expressions; a dynamic lookup would silently read undefined
  // in some build configurations. The constant is used for MESSAGES only.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (typeof serviceRoleKey !== "string" || serviceRoleKey.trim().length === 0) {
    // Fails CLOSED. The caller cannot proceed without this, and there is no
    // fallback to a lesser key: silently degrading to the publishable key would
    // turn a configuration error into a confusing authorization error much
    // further downstream.
    throw new SupabaseAdminConfigurationError(
      `Missing ${SERVICE_ROLE_KEY_VAR}. Add it to .env.local (server-only, never NEXT_PUBLIC_) and restart the dev server.`,
    );
  }

  // The URL is public and already validated (shape and presence) by the shared
  // env module.
  const { url } = getSupabaseEnv();

  return createSupabaseClient(url, serviceRoleKey, {
    auth: {
      // Rule 4. Each of these is load-bearing:
      //
      //   persistSession    — without it the client writes the service-role
      //                       session into whatever storage it can find. On the
      //                       server that is a module-level object shared across
      //                       requests and users.
      //   autoRefreshToken  — starts a background timer that would keep running
      //                       after the request ends, in a serverless environment
      //                       that may be frozen or reused between users.
      //   detectSessionInUrl— only meaningful in a browser, and would have this
      //                       client adopt a session from a URL fragment. There is
      //                       no scenario in which an admin client should take its
      //                       identity from a URL.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// Deliberately NOT exported: the key itself, any accessor for it, any
// pre-constructed client instance, and any helper that returns raw Auth errors.
// The only export surface is the factory above and the configuration error type.
