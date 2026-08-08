/**
 * PURE MODULE — no React, no I/O, no environment. Every effect is injected.
 *
 * THE ONE DECISION about when a receipt's line items may be read, and the sequencing around
 * it, so both can be tested in Node against a counting fake rather than against a rendered
 * tree and a live database.
 *
 * ============================================================================
 * ONLY A SUCCEEDED ATTEMPT HAS LINE ITEMS
 * ============================================================================
 * `record_receipt_extraction_success` is the only writer of receipt_extraction_line_items,
 * and `list_my_receipt_extraction_line_items` filters on `status = 'SUCCEEDED'`, so for
 * QUEUED, PROCESSING and FAILED the read can only ever return zero rows. Issuing it anyway
 * would be a request whose answer is known in advance — and, on a QUEUED or PROCESSING
 * attempt, a request issued WHILE the polling loop is still running. That is the overlap this
 * gate exists to make impossible: the loop settles first, and only then is one read sent.
 *
 * ============================================================================
 * THE GATE IS NOT THE AUTHORIZATION
 * ============================================================================
 * `assert_my_receipt_extraction_access` requires `submitted_by_profile_id = auth.uid()` and
 * runs on every call regardless of what this module decides. Skipping the read for a
 * PROCESSING attempt is an efficiency and an ordering guarantee, never a permission.
 */

import type { ExtractionStatus } from "./receipt-extraction-vocabulary.ts";
import type { LineItemView } from "./receipt-extraction-normalization.ts";

/** What the injected read may answer. Mirrors the Server Action's closed union. */
export type LineItemReadResult =
  | { readonly status: "ok"; readonly lineItems: readonly LineItemView[] }
  /** Signed out, or no longer a Sales Staff member. */
  | { readonly status: "unauthorized" }
  /** A transport fault or a database outage. Nothing is claimed about the items. */
  | { readonly status: "unavailable" };

/** What the panel does with the answer. `skipped` means no request was sent. */
export type LineItemLoadOutcome =
  | { readonly status: "ok"; readonly lineItems: readonly LineItemView[] }
  | { readonly status: "skipped" }
  | { readonly status: "unauthorized" }
  | { readonly status: "unavailable" };

export type LineItemLoadPorts = {
  /** Performs the one read. Must not throw; a fault is an `unavailable` result. */
  read(): Promise<LineItemReadResult>;
};

/** True for SUCCEEDED and for nothing else. There is no other status with line items. */
export function shouldReadLineItems(status: ExtractionStatus | null): boolean {
  return status === "SUCCEEDED";
}

/**
 * Reads the line items when — and only when — the attempt succeeded.
 *
 * Called ONCE per settled reading by the panel, which holds a generation counter for the same
 * reason the polling loop does. This function issues at most one read per call and never
 * retries: a retry would be a second request for evidence that does not change.
 */
export async function loadLineItemsForStatus(
  status: ExtractionStatus | null,
  ports: LineItemLoadPorts,
): Promise<LineItemLoadOutcome> {
  if (!shouldReadLineItems(status)) return { status: "skipped" };

  const result = await ports.read();

  if (result.status === "ok") {
    return { status: "ok", lineItems: result.lineItems };
  }
  return { status: result.status };
}
