"use client";

import { usePathname } from "next/navigation";
import { cardClasses } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { AlertTriangleIcon } from "@/components/ui/icons";

/**
 * Error boundary for the Retailer Owner Portal route group.
 *
 * Catches anything thrown while rendering a portal route — most notably the
 * "unavailable" branches in the layout and pages, which fire when the portal
 * RPCs cannot be read or return a malformed row.
 *
 * WHAT IS NOT SHOWN. The `error` object is never rendered. Next.js already
 * strips server error messages in production, replacing them with a generic
 * message and a digest, but this component does not rely on that: it simply
 * never puts `error.message`, `error.stack`, or `error.digest` on the page. That
 * keeps the behaviour identical in development, where messages are NOT stripped
 * and a leaked PostgREST string would name tables, columns, functions, and
 * policies to whoever is looking at the screen.
 *
 * Error boundaries must be Client Components — that is a React requirement, not
 * a choice here. It is the only client-side code in the portal besides the shell
 * and the shared sign-out button.
 *
 * This is NOT an authorization surface. A user who is not authorized never
 * reaches this boundary: they are redirected to /retailer-access-denied by the
 * server layout before any of this renders. Everything here assumes an
 * AUTHORIZED portal member whose read failed, which is why "try again" is
 * offered at all — retrying a denial would be pointless and misleading.
 *
 * =========================================================================
 * WHY THE SECOND ESCAPE IS THE CURRENT PATH AND NOT /retailer
 * =========================================================================
 * This boundary covers the WHOLE portal, and the portal has three kinds of
 * member. /retailer is the Owner overview: its page resolves owner access for
 * itself and redirects anyone else to /retailer-access-denied. So a Sales Staff
 * member or a Manager who hit a transient fault, saw "Something went wrong" and
 * took the offered way out was sent to a page that told them their account does
 * not have access — a false authorization message caused by a failed read.
 *
 * It is the exact dead end @/components/retailer-portal/retailer-nav-items
 * already refuses to link for those members, and it is how an over-sized receipt
 * upload ended up presenting itself as an access problem.
 *
 * The current path is the only destination that is correct for every kind of
 * member, because it is a page they were already on. It stays a plain anchor
 * rather than <Link> for the original reason: after a render failure the
 * router's client state is the thing that just broke, so a full document load is
 * the more reliable escape.
 *
 * usePathname() returns the in-app path only — never a host, a query string or
 * anything a visitor supplied — so this cannot become an open redirect.
 */
export default function RetailerPortalError({
  reset,
}: {
  /**
   * Declared because Next.js passes it, and deliberately NOT destructured: this
   * component uses nothing from it.
   *
   * Nothing is logged here either. This file is a Client Component, so any
   * console call in it runs in the BROWSER — readable by any extension and
   * captured by session recording — not on the server. Next.js already logs the
   * real error server-side when it is thrown, and the data-access layer has
   * already written its own sanitized category there, so a browser-side log
   * would add no diagnostic value while creating a second place for detail to
   * surface.
   *
   * `digest` is likewise never rendered. It is only a correlation id, but
   * putting it on the page invites users to quote it and turns an internal
   * handle into part of the product's surface.
   */
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="mx-auto w-full max-w-2xl py-8">
      <div className={cardClasses("standard", "p-6 text-center sm:p-8")}>
        <span
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600"
          aria-hidden="true"
        >
          <AlertTriangleIcon className="h-6 w-6" />
        </span>

        <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">
          Something went wrong
        </h2>

        {/* Generic by design — see the note above. */}
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          We could not load your retailer portal just now. This is usually
          temporary — please try again in a moment.
        </p>

        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className={buttonClasses({ variant: "primary", fullWidth: true }, "sm:w-auto")}
          >
            Try again
          </button>

          {/* See the placement note above: the current path, never /retailer. */}
          <a
            href={pathname}
            className={buttonClasses({ variant: "outline", fullWidth: true }, "sm:w-auto")}
          >
            Reload this page
          </a>
        </div>
      </div>
    </div>
  );
}
