"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * The receipt image, served only through the protected route.
 *
 * A Client Component for three reasons and no others: the load/error state of an
 * <img>, the enlarge toggle, and focus management for the enlarged view. It holds
 * no authorization decision and receives no receipt data beyond what the page
 * already renders as text.
 *
 * ============================================================================
 * WHY A PLAIN <img>
 * ============================================================================
 * Not next/image. That component proxies through the Next.js optimizer, which
 * caches derivative files on disk keyed by URL — turning a per-tenant private
 * receipt into a cached artifact served without any reviewer check. The whole
 * point of the route is that every byte passes a fresh authorization, and an
 * optimizer cache defeats exactly that.
 *
 * The `src` is a same-origin path, never a storage URL and never a signed URL.
 * A reviewer who copies it gets a link that still demands their session.
 *
 * `unavailable` covers every refusal the route makes — missing object, foreign
 * receipt, unsupported type, outage — because the route deliberately answers all
 * of them the same way and this component must not invent a distinction the
 * server refused to make.
 */
export function ReceiptImage({
  receiptSubmissionId,
  retailerName,
  submittedAtLabel,
}: {
  receiptSubmissionId: string;
  /** For alternative text only. Already displayed on the page. */
  retailerName: string;
  submittedAtLabel: string;
}) {
  const src = `/review/${receiptSubmissionId}/image`;

  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [enlarged, setEnlarged] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    if (enlarged) dialogRef.current?.focus();
    else openerRef.current?.focus();
  }, [enlarged]);

  useEffect(() => {
    if (!enlarged) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setEnlarged(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enlarged]);

  // Describes the receipt WITHOUT claiming anything about its contents. Nobody
  // has read this image yet — that is the reviewer's job — so alt text asserting
  // an amount or a merchant would be fabricated.
  const alt = `Receipt image submitted by ${retailerName} on ${submittedAtLabel}. Open the enlarged view to inspect it.`;

  if (state === "error") {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
        <Alert tone="warning" title="We couldn’t load this receipt image">
          The image is temporarily unavailable. Refresh this page to try again.
          Do not record a decision until you have been able to see the receipt.
        </Alert>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Receipt image</h2>
        <button
          ref={openerRef}
          type="button"
          onClick={() => setEnlarged(true)}
          disabled={state !== "loaded"}
          aria-haspopup="dialog"
          aria-expanded={enlarged}
          className={buttonClasses({ variant: "secondary", size: "sm" })}
        >
          Enlarge image
        </button>
      </div>

      <div className="relative mt-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
        {state === "loading" && (
          <div
            className="flex h-72 items-center justify-center sm:h-96"
            role="status"
          >
            <span className="text-sm text-slate-500">Loading receipt image…</span>
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element -- see the header:
            next/image would cache this private per-tenant object on disk. */}
        <img
          src={src}
          alt={alt}
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
          className={cn(
            "mx-auto block max-h-[70vh] w-auto max-w-full object-contain",
            state === "loaded" ? "" : "hidden",
          )}
        />
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Served privately through SalesReward. This image is never given a public
        or shareable link.
      </p>

      {enlarged && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-slate-900/70 p-4 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEnlarged(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            tabIndex={-1}
            className="flex max-h-full w-full max-w-4xl flex-col rounded-2xl bg-white shadow-xl outline-none"
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <h2
                id={headingId}
                className="text-base font-semibold text-slate-900"
              >
                Receipt image — enlarged
              </h2>
              <button
                type="button"
                onClick={() => setEnlarged(false)}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                Close enlarged view
              </button>
            </div>
            <div className="overflow-auto p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- as above. */}
              <img
                src={src}
                alt={alt}
                className="mx-auto block h-auto w-auto max-w-full"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
