import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/env/supabase";

/**
 * Creates a Supabase client for use in Client Components (browser).
 *
 * Uses only the public URL + publishable key. No privileged/service-role logic
 * belongs here — anything sensitive must run server-side.
 */
export function createClient() {
  const { url, publishableKey } = getSupabaseEnv();
  return createBrowserClient(url, publishableKey);
}
