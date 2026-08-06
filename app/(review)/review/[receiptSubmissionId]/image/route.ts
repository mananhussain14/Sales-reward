import { NextResponse } from "next/server";
import { getClaimReviewDetail } from "@/lib/review/claim-review-detail";
import { readClaimReviewReceiptImage } from "@/lib/review/claim-review-receipt-object";
import { isReceiptSubmissionId } from "@/lib/review/claim-review-queue-filters";

/**
 * The private receipt image, streamed through the server.
 *
 * GET /review/[receiptSubmissionId]/image
 *
 * ============================================================================
 * THE AUTHORIZATION SEQUENCE — THE ORDER IS THE SECURITY
 * ============================================================================
 *   1. Validate the id's SHAPE. A malformed id never reaches an RPC.
 *   2. Authorize as the ORDINARY SIGNED-IN REVIEWER via getClaimReviewDetail,
 *      which resolves the Vendor from auth.uid() and applies the tenant check.
 *   3. ONLY on `authorized`, use the service-role client to resolve the object
 *      reference and read the bytes.
 *
 * Step 3 must never run before step 2 completes successfully.
 * `get_claim_review_object_reference` performs NO reviewer check of its own — it
 * returns the private bucket and path for any submitted receipt in any Vendor —
 * so this handler's ordering is the only thing standing between a reviewer and
 * somebody else's receipt. Reversing these two calls, or reaching for the bytes
 * on a `not-found`, is a cross-tenant disclosure.
 *
 * ============================================================================
 * NOTHING IS TAKEN FROM THE BROWSER BUT THE ID
 * ============================================================================
 * No bucket, no object path, no MIME type, no filename, no Vendor, no reviewer,
 * no size. The id in the path is an ADDRESS the server re-validates, never a
 * capability. Every other value comes from the database.
 *
 * ============================================================================
 * ONE ANSWER FOR EVERY REFUSAL
 * ============================================================================
 * Malformed, nonexistent, another Vendor's, not-a-reviewer and object-missing
 * all return the SAME bare 404 with no body. A reviewer cannot learn which
 * receipt ids exist elsewhere by watching status codes, and neither can anyone
 * else. `unauthenticated` is the single exception, and only because 401 tells a
 * signed-out browser something it already knows about itself.
 */

export const dynamic = "force-dynamic";

/**
 * A refusal that discloses nothing.
 *
 * No body, no message, no code. `no-store` matters even here: a cached 404 from
 * one session must not answer for another after access changes.
 */
function notFound(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ receiptSubmissionId: string }> },
) {
  // A promise in this version of Next.js — it must be awaited before any value
  // is read.
  const { receiptSubmissionId } = await params;

  // ---------------------------------------------------------------------------
  // 1. Shape
  // ---------------------------------------------------------------------------
  if (!isReceiptSubmissionId(receiptSubmissionId)) {
    return notFound();
  }

  // ---------------------------------------------------------------------------
  // 2. Reviewer authorization, as the ordinary authenticated user
  // ---------------------------------------------------------------------------
  const detail = await getClaimReviewDetail(receiptSubmissionId);

  if (detail.status === "unauthenticated") {
    // Deliberately a status, not a redirect: an <img> cannot follow a login
    // flow, and redirecting it to an HTML page would make the browser try to
    // decode a document as an image.
    return new NextResponse(null, {
      status: 401,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (detail.status === "not-found") {
    // Missing, foreign, ineligible and unauthorized are indistinguishable here
    // exactly as they are on the page.
    return notFound();
  }

  if (detail.status === "unavailable") {
    return new NextResponse(null, {
      status: 503,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Only now: service role, for bytes alone
  // ---------------------------------------------------------------------------
  const image = await readClaimReviewReceiptImage(receiptSubmissionId);

  if (image.status === "missing" || image.status === "unsupported") {
    // An object the reviewer is entitled to but cannot be served reads as 404
    // rather than an error, so it stays indistinguishable from every other
    // refusal. The reason is logged server-side, never returned.
    return notFound();
  }

  if (image.status === "unavailable") {
    return new NextResponse(null, {
      status: 503,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return new NextResponse(image.image.bytes, {
    status: 200,
    headers: {
      // The DATABASE's MIME type. Constrained to the three the upload flow
      // accepts, so this header can only ever be one of three known values and
      // no stored string is reflected into it.
      "Content-Type": image.image.contentType,
      "Content-Length": String(image.image.bytes.byteLength),

      // `private` keeps it out of any shared or CDN cache; `no-store` keeps it
      // off disk entirely. Receipt images are per-tenant private data and a
      // cached copy would outlive the authorization that produced it.
      "Cache-Control": "private, no-store, max-age=0",

      // Without this a browser may sniff the bytes and decide they are HTML,
      // which would turn an uploaded file into script running on this origin.
      "X-Content-Type-Options": "nosniff",

      // `inline` with NO filename. The stored original filename is attacker-
      // influenced text and reflecting it into a header invites header
      // injection and content-disposition tricks; the page already displays it
      // as escaped body text where it is harmless.
      "Content-Disposition": "inline",

      // This response is never a document, so it should never be framed or
      // treated as one.
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}
