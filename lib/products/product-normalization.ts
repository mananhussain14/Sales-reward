/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * Where the three product READ RPCs' snake_case output becomes the application's
 * camelCase types, and where their runtime shape is validated. Free of side effects so
 * it can be exercised directly by ./product-normalization.test.ts.
 *
 * WHY VALIDATE AT ALL. `supabase.rpc()` is untyped in this project (there are no
 * generated database types), so its result is `any`. A type assertion would be a claim
 * about the SQL, not a check of it, and TypeScript erases it at runtime.
 *
 * NOTHING UNSAFE PASSES THROUGH, because nothing unsafe arrives: none of the three RPCs
 * returns a Vendor organization id, a creator profile id, an assignment id, audit
 * metadata or membership internals. The mappers below build an explicit allow-list
 * rather than spreading the row, so a column added to an RPC later cannot reach the UI
 * without an edit here.
 */

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** bigint arrives from PostgREST as a number when it fits, a string when it doesn't. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/* ---------------------------------------------------------------------------
 * Statuses
 * ------------------------------------------------------------------------- */

/**
 * The two states a product may hold, verbatim. Exhaustive: the
 * vendor_products_status_allowed CHECK permits exactly these. An unrecognized value is
 * treated as drift and fails the read rather than rendering an unknown badge — or,
 * worse, defaulting into a state that offers an action.
 *
 * There is deliberately no draft, review, approval, discontinued or archived state.
 */
export const PRODUCT_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

function isProductStatus(value: unknown): value is ProductStatus {
  return typeof value === "string" && (PRODUCT_STATUSES as readonly string[]).includes(value);
}

/** The two states an assignment may hold. Same vocabulary, different subject. */
export const ASSIGNMENT_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

function isAssignmentStatus(value: unknown): value is AssignmentStatus {
  return (
    typeof value === "string" && (ASSIGNMENT_STATUSES as readonly string[]).includes(value)
  );
}

/* ---------------------------------------------------------------------------
 * Vendor catalog — public.list_vendor_products()
 * ------------------------------------------------------------------------- */

export type VendorProduct = {
  productId: string;
  productCode: string;
  barcode: string | null;
  productName: string;
  brand: string | null;
  description: string | null;
  status: ProductStatus;
  activeAssignmentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type VendorProductsNormalization =
  | { status: "ok"; products: VendorProduct[] }
  | { status: "malformed"; reason: string };

export function normalizeVendorProducts(data: unknown): VendorProductsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const products: VendorProduct[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;

    const productId = requiredText(record.product_id);
    const productCode = requiredText(record.product_code);
    const productName = requiredText(record.product_name);
    const count = wholeNumber(record.active_assignment_count);

    if (productId === null) return { status: "malformed", reason: "product_id" };
    if (productCode === null) return { status: "malformed", reason: "product_code" };
    if (productName === null) return { status: "malformed", reason: "product_name" };
    if (!isProductStatus(record.status)) return { status: "malformed", reason: "status" };
    if (count === null) {
      return { status: "malformed", reason: "active_assignment_count" };
    }

    products.push({
      productId: productId.toLowerCase(),
      productCode,
      barcode: optionalText(record.barcode),
      productName,
      brand: optionalText(record.brand),
      description: optionalText(record.description),
      status: record.status,
      activeAssignmentCount: count,
      createdAt: optionalTimestamp(record.created_at),
      updatedAt: optionalTimestamp(record.updated_at),
    });
  }

  return { status: "ok", products };
}

/* ---------------------------------------------------------------------------
 * Assignment panel — public.list_vendor_product_retailer_assignments(uuid)
 * ------------------------------------------------------------------------- */

export type ProductRetailerAssignment = {
  retailerOrganizationId: string;
  retailerName: string;
  retailerStatus: string;
  relationshipStatus: string;
  /** null when this Retailer has never been assigned the product. */
  assignmentStatus: AssignmentStatus | null;
  assignedAt: string | null;
};

export type AssignmentsNormalization =
  | { status: "ok"; assignments: ProductRetailerAssignment[] }
  | { status: "malformed"; reason: string };

export function normalizeProductAssignments(data: unknown): AssignmentsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const assignments: ProductRetailerAssignment[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;

    const retailerOrganizationId = requiredText(record.retailer_organization_id);
    const retailerName = requiredText(record.retailer_name);
    const retailerStatus = requiredText(record.retailer_status);
    const relationshipStatus = requiredText(record.relationship_status);

    if (retailerOrganizationId === null) {
      return { status: "malformed", reason: "retailer_organization_id" };
    }
    if (retailerName === null) return { status: "malformed", reason: "retailer_name" };
    if (retailerStatus === null) return { status: "malformed", reason: "retailer_status" };
    if (relationshipStatus === null) {
      return { status: "malformed", reason: "relationship_status" };
    }

    // NULL is a legitimate value here — "never assigned" — so only a non-null value
    // that is not one of the two known statuses counts as drift.
    const rawAssignment = record.assignment_status;
    if (
      rawAssignment !== null &&
      rawAssignment !== undefined &&
      !isAssignmentStatus(rawAssignment)
    ) {
      return { status: "malformed", reason: "assignment_status" };
    }

    assignments.push({
      retailerOrganizationId: retailerOrganizationId.toLowerCase(),
      retailerName,
      retailerStatus,
      relationshipStatus,
      assignmentStatus: isAssignmentStatus(rawAssignment) ? rawAssignment : null,
      assignedAt: optionalTimestamp(record.assigned_at),
    });
  }

  return { status: "ok", assignments };
}

/**
 * Whether a Retailer may currently RECEIVE a new assignment of an active product.
 *
 * Mirrors assign_vendor_product_to_retailer's own rule: both the Retailer organization
 * and the Vendor–Retailer relationship must be ACTIVE. The database refuses anything
 * else, so offering the control would be offering a button that fails.
 */
export function canAssignToRetailer(assignment: ProductRetailerAssignment): boolean {
  return assignment.retailerStatus === "ACTIVE" && assignment.relationshipStatus === "ACTIVE";
}

/* ---------------------------------------------------------------------------
 * Retailer view — public.list_retailer_assigned_products()
 * ------------------------------------------------------------------------- */

export type AssignedProduct = {
  productId: string;
  productCode: string;
  barcode: string | null;
  productName: string;
  brand: string | null;
  description: string | null;
  assignmentStatus: AssignmentStatus;
};

export type AssignedProductsNormalization =
  | { status: "ok"; products: AssignedProduct[] }
  | { status: "malformed"; reason: string };

export function normalizeAssignedProducts(data: unknown): AssignedProductsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const products: AssignedProduct[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;

    const productId = requiredText(record.product_id);
    const productCode = requiredText(record.product_code);
    const productName = requiredText(record.product_name);

    if (productId === null) return { status: "malformed", reason: "product_id" };
    if (productCode === null) return { status: "malformed", reason: "product_code" };
    if (productName === null) return { status: "malformed", reason: "product_name" };
    if (!isAssignmentStatus(record.assignment_status)) {
      return { status: "malformed", reason: "assignment_status" };
    }

    products.push({
      productId: productId.toLowerCase(),
      productCode,
      barcode: optionalText(record.barcode),
      productName,
      brand: optionalText(record.brand),
      description: optionalText(record.description),
      assignmentStatus: record.assignment_status,
    });
  }

  return { status: "ok", products };
}

/** Presentation labels. Nothing branches on these. */
const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};

export function productStatusLabel(status: ProductStatus): string {
  return PRODUCT_STATUS_LABELS[status];
}
