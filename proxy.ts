import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Next.js 16 Proxy (the renamed middleware convention — a middleware.ts file
 * here would be the deprecated spelling).
 *
 * Its job is to keep Supabase auth cookies fresh on every navigation. It also
 * redirects unauthenticated traffic optimistically, but that is not the
 * security boundary: app/(admin)/layout.tsx and app/login/page.tsx each verify
 * claims independently at the server render boundary.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  /**
   * Run on everything EXCEPT:
   *   - _next/static      build assets
   *   - _next/image       image optimization requests
   *   - favicon.ico       the tab icon
   *   - common image files by extension
   *
   * Without a matcher, Proxy runs on every request including static assets —
   * which would mean a token-refresh round trip per CSS/JS/image fetch, and
   * (given the redirect above) unauthenticated asset requests bouncing to
   * /login instead of loading.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)",
  ],
};
