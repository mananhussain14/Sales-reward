// SERVER-ONLY MODULE.
//
// The web portal's ONE reader of a receipt's extracted line items: a thin wrapper over the
// existing SECURITY DEFINER RPC, called under the CALLER'S OWN token (the ordinary
// publishable-key server client — never service-role).
//
// ============================================================================
// WHY AN RPC HERE, WHERE THE STATUS READ USES AN EDGE FUNCTION
// ============================================================================
// `get-receipt-extraction` is an Edge Function because CALLING it is what finalizes an
// attempt: it polls the provider and records the terminal row with the service-role key, so it
// must hold that key and therefore must live there. Reading line items does none of that. It
// is a plain authorized read of evidence that is already recorded, exactly like
// list_my_assigned_receipt_shops() and list_my_receipt_submissions() in ./receipt-data.ts, and
// it uses the same posture those two established: one RPC, the caller's own token, no service
// role, no key material, no second endpoint to authorize.
//
// ============================================================================
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE
// ============================================================================
// The RPC's first statement is `assert_my_receipt_extraction_access(p_submission_id)`, which
// requires `submitted_by_profile_id = auth.uid()`. Naming somebody else's receipt returns ZERO
// ROWS, byte-identically to naming one that does not exist or one whose attempt never
// succeeded. There is no organization id, profile id, membership id or extraction id in this
// file, and none is accepted: the only argument is a submission id the caller already holds.
//
// ============================================================================
// WHAT THIS MODULE CANNOT DO
// ============================================================================
//   * It reads NO table and names none. There is no `.from(` here — the protected tables are
//     not selectable by `authenticated` at all, which is why the RPC is the only way in.
//   * It does not construct a service-role client; `createAdminClient` does not appear.
//   * It reads no service-role key, no Azure value, and no secret of any kind.
//   * It writes nothing. There is no confirmation, correction or exclusion on this path.
//   * It returns only values that survived `normalizeExtractionLineItems`, whose type has no
//     field for a provider, an operation id, a claim token, a bucket, an object path or a
//     file hash — because the RPC returns none of them either.
import { createClient } from "@/lib/supabase/server";
import {
  normalizeExtractionLineItems,
  type LineItemView,
} from "@/lib/receipts/receipt-extraction-normalization";

/** The only RPC name this module may call. One literal, one greppable place. */
const LINE_ITEMS_RPC = "list_my_receipt_extraction_line_items" as const;

/** The SQLSTATE every receipt RPC raises for a caller who may not submit receipts at all. */
const INSUFFICIENT_PRIVILEGE = "42501";

export type ExtractionLineItemsResult =
  /** Zero rows is a legitimate `ok`: not our receipt, or no successful attempt. */
  | { readonly status: "ok"; readonly lineItems: LineItemView[] }
  /** Not an authorized Sales Staff member. Owners and Managers land here. */
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

/**
 * Sanitized operator logging.
 *
 * Deliberately NOT logged: the PostgREST error object and its message (which can name
 * functions, columns and policies), the submission id, the session, the access token, and any
 * row.
 */
function logLineItemsFailure(category: string): void {
  console.error(`[receipts-line-items] ${category}`);
}

/**
 * The extracted line items of ONE of the caller's own receipts, in the RPC's own order.
 *
 * @param submissionId the canonical submission id. It is re-authorized in PostgreSQL from
 *   auth.uid(); naming somebody else's receipt yields an empty list, not their data.
 */
export async function getMyReceiptExtractionLineItems(
  submissionId: string,
): Promise<ExtractionLineItemsResult> {
  const supabase = await createClient();

  // Promise.resolve() because the PostgREST builder is a thenable rather than a real Promise —
  // adopting it gives a genuine Promise to attach the rejection handler to, without altering
  // when the request fires. The same pattern as ./receipt-data.ts.
  const result = await Promise.resolve(
    supabase.rpc(LINE_ITEMS_RPC, { p_submission_id: submissionId }),
  ).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The thrown value is
  // deliberately not bound, inspected or logged — it may carry request URLs, headers or token
  // material.
  if (result === null) {
    logLineItemsFailure("transport");
    return { status: "unavailable" };
  }

  if (result.error) {
    // Only the SQLSTATE is read, and only to tell a DENIAL from a FAILURE.
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
    logLineItemsFailure("rpc-error");
    return { status: "unavailable" };
  }

  const normalized = normalizeExtractionLineItems(result.data as unknown);

  if (normalized.status === "malformed") {
    // The reason names only field names — never values — so it is safe to log. A
    // half-validated line item is never rendered: a row this build cannot vouch for is
    // reported as unavailable rather than shown beside rows it can.
    logLineItemsFailure(`malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }

  return { status: "ok", lineItems: normalized.lineItems };
}

export type { LineItemView };
