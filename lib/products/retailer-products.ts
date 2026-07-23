// SERVER-ONLY MODULE.
//
// The Retailer's read-only view of the products a Vendor has assigned to it — one thin
// wrapper over one zero-argument SECURITY DEFINER RPC, called under the CALLER'S OWN
// token (the ordinary publishable-key server client — never service-role).
//
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE. list_retailer_assigned_products takes
// NO ARGUMENTS and resolves the Retailer itself from auth.uid() through
// public.resolve_retailer_member_organization('RETAILER_PRODUCTS_READ') — a permission
// mapped to RETAILER_OWNER and RETAILER_MANAGER only. A SALES_STAFF member holds no
// such mapping and is refused, so this module cannot become the way the full assigned
// catalog reaches them; a future receipt-matching operation will need its own
// narrowly-scoped access.
//
// There is no organization id, membership id, role id or permission constant in this
// file, and no `.from(` call: both product tables are RPC-only and default-deny.
//
// DENIED IS NOT EMPTY. The RPC raises insufficient_privilege (42501) for an
// unauthorized caller rather than returning zero rows, and this module preserves the
// distinction — collapsing them would render "you may not see products" as "no products
// have been assigned to you".
import { createClient } from "@/lib/supabase/server";
import {
  normalizeAssignedProducts,
  type AssignedProduct,
} from "@/lib/products/product-normalization";

const ASSIGNED_PRODUCTS_RPC = "list_retailer_assigned_products" as const;

const INSUFFICIENT_PRIVILEGE = "42501";

export type AssignedProductsResult =
  | { status: "ok"; products: AssignedProduct[] }
  /** Not an authorized Retailer Owner or Manager. Sales Staff land here. */
  | { status: "denied" }
  | { status: "unavailable" };

/** Sanitized operator logging. Never an error object, a row, or a session. */
function logAssignedProductsFailure(category: string): void {
  console.error(`[retailer-products] assigned-products failed: ${category}`);
}

/**
 * The ACTIVE products actively assigned to the caller's own Retailer.
 *
 * An empty array is a valid, successful answer meaning nothing is assigned yet — never
 * a denial. Callers must not conflate the two.
 */
export async function getRetailerAssignedProducts(): Promise<AssignedProductsResult> {
  const supabase = await createClient();

  // Promise.resolve() because the PostgREST builder is a thenable, not a real Promise.
  const result = await Promise.resolve(supabase.rpc(ASSIGNED_PRODUCTS_RPC)).catch(
    () => null,
  );

  if (result === null) {
    logAssignedProductsFailure("transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
    logAssignedProductsFailure("rpc-error");
    return { status: "unavailable" };
  }

  const normalized = normalizeAssignedProducts(result.data as unknown);
  if (normalized.status === "malformed") {
    logAssignedProductsFailure(`malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", products: normalized.products };
}
