/**
 * PURE MODULE — no imports but a size constant and a type, no I/O, no Node built-in, no
 * `next/*`, no Supabase client. Safe in a Client Component and unit-testable directly.
 *
 * THE BROWSER'S PRE-FLIGHT CHECK, and nothing more.
 *
 * It answers one question about a file the person has just chosen: is there any point
 * sending it? A file the browser can already see is over the limit, empty, absent, or
 * one of several is refused here, on the device, before a single byte crosses the
 * network — which is both faster for the person on a shop-floor connection and the only
 * way to keep an over-sized upload from reaching a request boundary that can no longer
 * explain itself once it trips.
 *
 * ⚠️ THIS IS NOT VALIDATION, AND IT IS NOT A SECURITY BOUNDARY.
 *   Everything here runs in the browser, so all of it can be skipped by anyone who wants
 *   to skip it. The real checks are in ./receipt-file.ts, which runs on the server,
 *   derives the file's REAL type from its own leading bytes rather than anything the
 *   browser declared, and re-checks the same size limit — and after that in SQL, where
 *   reserve_receipt_submission() checks the size again and the receipt_submissions CHECK
 *   constraint refuses anything larger regardless. Removing this module would cost
 *   responsiveness and nothing else.
 *
 * WHY IT DELIBERATELY CANNOT SAY "unsupported-type".
 *   `File.type` is whatever the client chose to send, and the file picker's `accept`
 *   filter is a suggestion a person can override. Refusing on either would mean the
 *   browser had made a type decision, which is exactly the thing the server refuses to
 *   trust. Type is decided on the server, from the bytes, and only there — so a file
 *   with the wrong contents is sent, and comes back refused with the server's own
 *   message. The same reasoning excludes "invalid-name": the sanitizer that can answer
 *   it lives on the server.
 *
 * The rejection reasons are a SUBSET of ./receipt-file.ts's, never a parallel
 * vocabulary, so the sentence a person reads is the same one either side produces.
 */
import { MAX_RECEIPT_FILE_BYTES } from "../uploads/upload-policy.ts";
import type { ReceiptFileRejection } from "./receipt-file.ts";

/**
 * The reasons a browser can establish on its own, without reading the file's contents.
 *
 * Typed as a subset of the server's reasons so this module cannot invent a category the
 * shared message table has no sentence for.
 */
export type ReceiptPreflightRejection = Extract<
  ReceiptFileRejection,
  "missing" | "empty" | "too-large" | "too-many-files"
>;

/** The single fact this check needs from each selected file. */
export type SelectedFileFacts = { size: number };

/**
 * Why the current selection cannot be sent, or null when it is worth sending.
 *
 * The order matches ./receipt-file.ts exactly — count, then presence, then emptiness,
 * then size — so a selection that is wrong in more than one way is described the same
 * way on both sides of the network.
 *
 * The size comparison is `>`, not `>=`: a file of EXACTLY MAX_RECEIPT_FILE_BYTES is
 * accepted, which is the same boundary the server, the reservation RPC and the database
 * CHECK all use. "Up to 10 MB" includes 10 MB.
 */
export function receiptSelectionRejection(
  files: readonly SelectedFileFacts[],
): ReceiptPreflightRejection | null {
  if (files.length > 1) return "too-many-files";

  const file = files[0];
  if (!file) return "missing";

  // A negative or non-finite size is not something a real file picker produces; it is
  // treated as "no usable file" rather than trusted into a comparison.
  if (!Number.isFinite(file.size) || file.size <= 0) return "empty";

  if (file.size > MAX_RECEIPT_FILE_BYTES) return "too-large";

  return null;
}
