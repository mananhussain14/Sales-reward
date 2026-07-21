"use client";

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
 * authorized owner whose read failed, which is why "try again" is offered at
 * all — retrying a denial would be pointless and misleading.
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
  return (
    <div className="mx-auto w-full max-w-2xl py-8">
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <span
          className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <path d="M12 9v3.75m0 3.75h.008M10.34 3.94l-8.02 13.5A1.5 1.5 0 003.6 19.5h16.8a1.5 1.5 0 001.28-2.06l-8.02-13.5a1.5 1.5 0 00-2.58 0z" />
          </svg>
        </span>

        <h2 className="mt-4 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Something went wrong
        </h2>

        {/* Generic by design — see the note above. */}
        <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
          We could not load your retailer portal just now. This is usually
          temporary — please try again in a moment.
        </p>

        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className="inline-flex w-full items-center justify-center rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:w-auto dark:focus-visible:ring-offset-zinc-950"
          >
            Try again
          </button>

          {/* A plain anchor, not <Link>: after a render failure the router's
              client state is the thing that just broke, so a full document load
              is the more reliable escape. */}
          <a
            href="/retailer"
            className="inline-flex w-full items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:w-auto dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:ring-offset-zinc-950"
          >
            Back to overview
          </a>
        </div>
      </div>
    </div>
  );
}
