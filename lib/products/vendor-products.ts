// SERVER-ONLY MODULE.
//
// The seven Vendor product operations, each a thin wrapper over one SECURITY DEFINER
// RPC called under the CALLER'S OWN token (the ordinary publishable-key server
// client — never service-role; this module does not import one).
//
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE. Every RPC derives the Vendor itself
// from auth.uid() through get_vendor_super_admin_context() and then requires the
// specific permission — PRODUCTS_READ, PRODUCTS_MANAGE or PRODUCT_RETAILER_ASSIGN.
// There is no Vendor organization id, membership id, role id or permission constant in
// this file, deliberately: a TypeScript copy of those conditions would be a second
// definition free to drift from the migrations.
//
// THE ONLY IDS THAT TRAVEL ARE ADDRESSES. A product id and a Retailer organization id
// are passed to some operations. Each is filtered in SQL on the id AND the derived
// Vendor, so an id belonging to another Vendor selects nothing and is refused
// identically to "you are not authorized".
//
// NO DIRECT TABLE ACCESS. This module contains zero `.from(` calls.
// public.vendor_products and public.vendor_product_retailer_assignments have RLS
// enabled with zero policies and no privilege granted to any browser role, so the RPCs
// are the only way in — and that is intentional.
//
// ERROR DISCIPLINE. Supabase/PostgREST errors are never returned or rendered — their
// messages can name tables, columns, functions and policies. Only the SQLSTATE is
// inspected, and only to distinguish outcomes the UI must report differently.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeProductAssignments,
  normalizeVendorProducts,
  type ProductRetailerAssignment,
  type VendorProduct,
} from "@/lib/products/product-normalization";

const LIST_PRODUCTS_RPC = "list_vendor_products" as const;
const CREATE_PRODUCT_RPC = "create_vendor_product" as const;
const UPDATE_PRODUCT_RPC = "update_vendor_product" as const;
const SET_STATUS_RPC = "set_vendor_product_status" as const;
const LIST_ASSIGNMENTS_RPC = "list_vendor_product_retailer_assignments" as const;
const ASSIGN_RPC = "assign_vendor_product_to_retailer" as const;
const UNASSIGN_RPC = "unassign_vendor_product_from_retailer" as const;

/** SQLSTATEs the product RPCs raise. Only the CODE is ever read. */
const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const NOT_IN_PREREQUISITE_STATE = "55000";

/** Sanitized operator logging. No ids, codes, names, or error objects. */
function logProductFailure(operation: string, category: string): void {
  console.error(`[vendor-products] ${operation} failed: ${category}`);
}

export type VendorProductsResult =
  | { status: "ok"; products: VendorProduct[] }
  /** Not an authorized Vendor Super Admin with PRODUCTS_READ. */
  | { status: "denied" }
  | { status: "unavailable" };

export type ProductAssignmentsResult =
  | { status: "ok"; assignments: ProductRetailerAssignment[] }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * The outcome of any product WRITE.
 *
 * `duplicate` and `invalid` are distinct because the UI reports them against different
 * things — a field the operator must change, versus a value they must correct — while
 * `denied` covers an unauthorized caller, a foreign product id and a foreign Retailer
 * id identically, exactly as the database does.
 */
export type ProductWriteResult =
  | { status: "ok" }
  /** A product code or barcode already exists in this Vendor's own catalog. */
  | { status: "duplicate"; message: string }
  /** The database rejected a value. Reachable from a tampered call. */
  | { status: "invalid" }
  /** The product must be ACTIVE before it can be assigned. */
  | { status: "not-active" }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * Classifies a write outcome without ever surfacing an error object.
 *
 * The `duplicate` branch is the one place a database MESSAGE is carried forward, and
 * only from this repository's OWN fixed literals: create_vendor_product and
 * update_vendor_product raise "A product with that code already exists" and "A product
 * with that barcode already exists", both defined in migration 20260727210000 and both
 * describing the CALLER'S OWN catalog — the unique indexes are scoped per Vendor, so
 * neither can reveal anything about another Vendor's products. An unrecognized message
 * degrades to a generic duplicate notice rather than being echoed.
 */
function classifyWriteError(error: { code?: string; message?: string }): ProductWriteResult {
  if (error.code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
  if (error.code === NOT_IN_PREREQUISITE_STATE) return { status: "not-active" };
  if (error.code === CHECK_VIOLATION) return { status: "invalid" };
  if (error.code === UNIQUE_VIOLATION) {
    const message = typeof error.message === "string" ? error.message : "";
    if (message.includes("A product with that code already exists")) {
      return { status: "duplicate", message: "A product with that code already exists." };
    }
    if (message.includes("A product with that barcode already exists")) {
      return {
        status: "duplicate",
        message: "A product with that barcode already exists.",
      };
    }
    return { status: "duplicate", message: "That product already exists." };
  }
  logProductFailure("write", "rpc-error");
  return { status: "unavailable" };
}

/** Runs one write RPC and classifies the outcome. */
async function runWrite(
  rpcName: string,
  params: Record<string, unknown>,
): Promise<ProductWriteResult> {
  const supabase = await createClient();

  // Promise.resolve() because the PostgREST builder is a thenable, not a real Promise.
  const result = await Promise.resolve(supabase.rpc(rpcName, params)).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The thrown
  // value is deliberately not bound, inspected, or logged — it may carry request URLs,
  // headers, or token material.
  if (result === null) {
    logProductFailure("write", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    return classifyWriteError(result.error as { code?: string; message?: string });
  }
  return { status: "ok" };
}

/**
 * The calling Vendor's own catalog.
 *
 * REQUEST-SCOPED CACHE ONLY. React allocates a fresh cache per request, so a page and
 * its children resolve it once. It is NOT a persistent cache and must never become
 * one: an authorization-bearing result belongs to exactly one caller for exactly one
 * request. The function takes no arguments, so there is no cache key — deliberately.
 */
export const getVendorProducts = cache(
  async function getVendorProducts(): Promise<VendorProductsResult> {
    const supabase = await createClient();
    const result = await Promise.resolve(supabase.rpc(LIST_PRODUCTS_RPC)).catch(() => null);

    if (result === null) {
      logProductFailure("list", "transport");
      return { status: "unavailable" };
    }
    if (result.error) {
      const code = (result.error as { code?: string }).code;
      if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
      logProductFailure("list", "rpc-error");
      return { status: "unavailable" };
    }

    const normalized = normalizeVendorProducts(result.data as unknown);
    if (normalized.status === "malformed") {
      // The reason names only field names — never values — so it is safe to log.
      logProductFailure("list", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", products: normalized.products };
  },
);

/**
 * Every Retailer this Vendor is related to, with the product's assignment status
 * against each. Also the only source of Retailer ids the assignment UI has.
 */
export async function getProductRetailerAssignments(
  productId: string,
): Promise<ProductAssignmentsResult> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(LIST_ASSIGNMENTS_RPC, { p_product_id: productId }),
  ).catch(() => null);

  if (result === null) {
    logProductFailure("assignments", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
    logProductFailure("assignments", "rpc-error");
    return { status: "unavailable" };
  }

  const normalized = normalizeProductAssignments(result.data as unknown);
  if (normalized.status === "malformed") {
    logProductFailure("assignments", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", assignments: normalized.assignments };
}

/** Creates one product. The new id is deliberately not returned to the caller. */
export async function createVendorProduct(input: {
  productCode: string;
  productName: string;
  barcode: string | null;
  brand: string | null;
  description: string | null;
}): Promise<ProductWriteResult> {
  return runWrite(CREATE_PRODUCT_RPC, {
    p_product_code: input.productCode,
    p_product_name: input.productName,
    p_barcode: input.barcode,
    p_brand: input.brand,
    p_description: input.description,
  });
}

/**
 * Edits a product's display details.
 *
 * There is no product-code parameter: the code is immutable in the database and the
 * form has no field for it. See migration 20260727090000 for why.
 */
export async function updateVendorProduct(input: {
  productId: string;
  productName: string;
  barcode: string | null;
  brand: string | null;
  description: string | null;
}): Promise<ProductWriteResult> {
  return runWrite(UPDATE_PRODUCT_RPC, {
    p_product_id: input.productId,
    p_product_name: input.productName,
    p_barcode: input.barcode,
    p_brand: input.brand,
    p_description: input.description,
  });
}

/** Activates or deactivates a product. Setting the current status is a no-op in SQL. */
export async function setVendorProductStatus(
  productId: string,
  status: "ACTIVE" | "INACTIVE",
): Promise<ProductWriteResult> {
  return runWrite(SET_STATUS_RPC, { p_product_id: productId, p_status: status });
}

/** Makes an ACTIVE product visible to one of this Vendor's ACTIVE Retailers. */
export async function assignProductToRetailer(
  productId: string,
  retailerOrganizationId: string,
): Promise<ProductWriteResult> {
  return runWrite(ASSIGN_RPC, {
    p_product_id: productId,
    p_retailer_organization_id: retailerOrganizationId,
  });
}

/** Withdraws a product from a Retailer. Non-destructive: the row is set INACTIVE. */
export async function unassignProductFromRetailer(
  productId: string,
  retailerOrganizationId: string,
): Promise<ProductWriteResult> {
  return runWrite(UNASSIGN_RPC, {
    p_product_id: productId,
    p_retailer_organization_id: retailerOrganizationId,
  });
}
