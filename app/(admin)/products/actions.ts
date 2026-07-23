"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import {
  assignProductToRetailer,
  createVendorProduct,
  setVendorProductStatus,
  unassignProductFromRetailer,
  updateVendorProduct,
  type ProductWriteResult,
} from "@/lib/products/vendor-products";
import {
  normalizeProductInput,
  optionalOrNull,
  validateProductInput,
} from "@/lib/products/product-input";
import type {
  ProductActionState,
  ProductFormState,
} from "@/app/(admin)/products/product-form-state";
import { INITIAL_PRODUCT_FORM_STATE } from "@/app/(admin)/products/product-form-state";

/**
 * Server Actions for the Vendor product catalog.
 *
 * NO TABLE IS WRITTEN HERE. Every effect is delegated to @/lib/products/vendor-products,
 * which calls exactly one RPC per operation. `.from(` appears nowhere in this module,
 * and no service-role client is constructed anywhere in this feature.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT. It is reachable by a hand-crafted POST from any
 * client, regardless of which page rendered the form. So every action re-resolves
 * Vendor Admin access before delegating — and the RPC then re-derives the Vendor from
 * auth.uid() and re-checks the specific permission, which is what actually stops an
 * unauthorized or cross-Vendor write. Hiding a control removes the accident; only those
 * checks remove the capability.
 *
 * WHAT THE BROWSER MAY INFLUENCE, EXHAUSTIVELY: the product's display fields, a product
 * id, a Retailer organization id, and a status of exactly "ACTIVE" or "INACTIVE". There
 * is no Vendor organization id, creator id, membership id or role id accepted from any
 * form — the database derives all of them.
 *
 * Because of the "use server" directive, every runtime export here is a callable server
 * endpoint, so Next.js rejects anything that is not an async function. The state types
 * live in ./product-form-state.
 */

/** The two revalidation targets. Fixed literals; never interpolated from input. */
const PRODUCTS_PATH = "/products";

/**
 * The one message for every failure that is not a field problem.
 *
 * It covers an unauthorized caller, a product id belonging to another Vendor, a
 * Retailer that is not this Vendor's, a suspended relationship, and a database outage.
 * Collapsing them is deliberate: the RPCs already refuse all of the addressing cases
 * with a single byte-identical exception so they cannot be used as an existence oracle.
 */
const GENERIC_ERROR = "We couldn't complete that. Refresh the page and try again.";

/** Shown when the database rejected a value the form thought was fine. */
const INVALID_ERROR = "Check the details and try again.";

/** Shown when an inactive product is assigned. Safe: the Vendor can see the status. */
const NOT_ACTIVE_ERROR =
  "Activate this product before assigning it to a Retailer.";

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readField(formData: FormData, field: string): string {
  const raw = formData.get(field);
  return typeof raw === "string" ? raw : "";
}

/**
 * Re-resolves Vendor Admin access, or redirects.
 *
 * redirect() signals by throwing NEXT_REDIRECT, so calling this outside any try/catch
 * is required — catching it would swallow the navigation.
 */
async function requireVendorAdmin(): Promise<void> {
  const access = await getVendorSuperAdminAccess();
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }
}

/** Maps a write outcome to the single-button control's state. */
function toActionState(result: ProductWriteResult, success: string): ProductActionState {
  switch (result.status) {
    case "ok":
      return { error: null, success };
    case "duplicate":
      return { error: result.message, success: null };
    case "not-active":
      return { error: NOT_ACTIVE_ERROR, success: null };
    case "invalid":
      return { error: INVALID_ERROR, success: null };
    default:
      return { error: GENERIC_ERROR, success: null };
  }
}

/* ---------------------------------------------------------------------------
 * Create
 * ------------------------------------------------------------------------- */

export async function createProductAction(
  _prevState: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const values = normalizeProductInput({
    productCode: readField(formData, "productCode"),
    productName: readField(formData, "productName"),
    barcode: readField(formData, "barcode"),
    brand: readField(formData, "brand"),
    description: readField(formData, "description"),
  });

  await requireVendorAdmin();

  const validation = validateProductInput(values, "create");
  if (!validation.ok) {
    return {
      fieldErrors: validation.fieldErrors,
      formError: null,
      successMessage: null,
      values,
    };
  }

  const result = await createVendorProduct({
    productCode: values.productCode,
    productName: values.productName,
    barcode: optionalOrNull(values.barcode),
    brand: optionalOrNull(values.brand),
    description: optionalOrNull(values.description),
  });

  if (result.status === "ok") {
    revalidatePath(PRODUCTS_PATH);
    return {
      fieldErrors: {},
      formError: null,
      successMessage: `${values.productCode} added to your catalog.`,
      // Cleared so the next product starts from a blank form.
      values: INITIAL_PRODUCT_FORM_STATE.values,
    };
  }

  if (result.status === "duplicate") {
    // Attached to the field the operator must change, which is what tells them so.
    const field = result.message.includes("barcode") ? "barcode" : "productCode";
    return {
      fieldErrors: { [field]: result.message },
      formError: null,
      successMessage: null,
      values,
    };
  }

  return {
    fieldErrors: {},
    formError: result.status === "invalid" ? INVALID_ERROR : GENERIC_ERROR,
    successMessage: null,
    values,
  };
}

/* ---------------------------------------------------------------------------
 * Update
 * ------------------------------------------------------------------------- */

/**
 * Edits a product's display details.
 *
 * No product-code field is read: the code is immutable in the database and the edit
 * form has no input for it. A submission that carried one would be ignored.
 */
export async function updateProductAction(
  _prevState: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const productId = readField(formData, "productId").trim().toLowerCase();
  const values = normalizeProductInput({
    productName: readField(formData, "productName"),
    barcode: readField(formData, "barcode"),
    brand: readField(formData, "brand"),
    description: readField(formData, "description"),
  });

  await requireVendorAdmin();

  if (!UUID_PATTERN.test(productId)) {
    // Only reachable from a tampered form; reported identically to a foreign id.
    return { fieldErrors: {}, formError: GENERIC_ERROR, successMessage: null, values };
  }

  const validation = validateProductInput(values, "update");
  if (!validation.ok) {
    return {
      fieldErrors: validation.fieldErrors,
      formError: null,
      successMessage: null,
      values,
    };
  }

  const result = await updateVendorProduct({
    productId,
    productName: values.productName,
    barcode: optionalOrNull(values.barcode),
    brand: optionalOrNull(values.brand),
    description: optionalOrNull(values.description),
  });

  if (result.status === "ok") {
    revalidatePath(PRODUCTS_PATH);
    revalidatePath(`${PRODUCTS_PATH}/${productId}`);
    return {
      fieldErrors: {},
      formError: null,
      successMessage: "Product details saved.",
      values,
    };
  }

  if (result.status === "duplicate") {
    return {
      fieldErrors: { barcode: result.message },
      formError: null,
      successMessage: null,
      values,
    };
  }

  return {
    fieldErrors: {},
    formError: result.status === "invalid" ? INVALID_ERROR : GENERIC_ERROR,
    successMessage: null,
    values,
  };
}

/* ---------------------------------------------------------------------------
 * Status
 * ------------------------------------------------------------------------- */

export async function setProductStatusAction(
  _prevState: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const productId = readField(formData, "productId").trim().toLowerCase();
  const raw = readField(formData, "status").trim().toUpperCase();

  await requireVendorAdmin();

  // The status is a closed literal set, checked here and again in SQL. A value outside
  // it can only come from a tampered form.
  if (!UUID_PATTERN.test(productId) || (raw !== "ACTIVE" && raw !== "INACTIVE")) {
    return { error: GENERIC_ERROR, success: null };
  }

  const result = await setVendorProductStatus(productId, raw);

  if (result.status === "ok") {
    revalidatePath(PRODUCTS_PATH);
    revalidatePath(`${PRODUCTS_PATH}/${productId}`);
  }

  return toActionState(
    result,
    raw === "ACTIVE" ? "Product activated." : "Product deactivated.",
  );
}

/* ---------------------------------------------------------------------------
 * Assignment
 * ------------------------------------------------------------------------- */

/** Shared by both assignment actions: read and screen the two ids. */
function readAssignmentIds(formData: FormData): {
  productId: string;
  retailerId: string;
  ok: boolean;
} {
  const productId = readField(formData, "productId").trim().toLowerCase();
  const retailerId = readField(formData, "retailerId").trim().toLowerCase();
  return {
    productId,
    retailerId,
    ok: UUID_PATTERN.test(productId) && UUID_PATTERN.test(retailerId),
  };
}

export async function assignProductAction(
  _prevState: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const { productId, retailerId, ok } = readAssignmentIds(formData);

  await requireVendorAdmin();

  if (!ok) {
    return { error: GENERIC_ERROR, success: null };
  }

  const result = await assignProductToRetailer(productId, retailerId);

  if (result.status === "ok") {
    revalidatePath(PRODUCTS_PATH);
    revalidatePath(`${PRODUCTS_PATH}/${productId}`);
  }

  return toActionState(result, "Product assigned.");
}

export async function unassignProductAction(
  _prevState: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const { productId, retailerId, ok } = readAssignmentIds(formData);

  await requireVendorAdmin();

  if (!ok) {
    return { error: GENERIC_ERROR, success: null };
  }

  const result = await unassignProductFromRetailer(productId, retailerId);

  if (result.status === "ok") {
    revalidatePath(PRODUCTS_PATH);
    revalidatePath(`${PRODUCTS_PATH}/${productId}`);
  }

  return toActionState(result, "Product withdrawn.");
}
