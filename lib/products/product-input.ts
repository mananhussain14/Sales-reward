/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * Normalization and validation for the Vendor product forms, separated from the Server
 * Actions so it can be exercised directly by ./product-input.test.ts. The actions
 * cannot be unit-tested that way: importing them pulls in `next/headers`.
 *
 * WHAT THIS IS NOT. It is NOT the enforcement boundary. Every rule below is applied
 * again, independently, by create_vendor_product / update_vendor_product under the
 * caller's own token — those RPCs re-normalize and re-validate from scratch, and the
 * table's CHECK constraints and unique indexes are the final authority. This module
 * exists so an operator sees a useful message before a round trip, not so the browser
 * can be trusted.
 *
 * NORMALIZATION IS THE SAME RULE IN BOTH PLACES, and that matters more than the
 * validation. If this module and the RPC disagreed about what "SR-100" means, a form
 * could report "available" for a code the database then rejects as a duplicate. The
 * rules are therefore stated identically here and in migration 20260727210000:
 *   product code   trim → collapse internal whitespace → upper-case
 *   name / brand   trim → collapse internal whitespace
 *   barcode        remove spaces and hyphens; empty becomes absent
 *   description    trim only (internal formatting is the author's)
 */

/** Byte-identical to vendor_products_code_shape in the storage migration. */
const PRODUCT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9 ._/-]*$/;

/** Byte-identical to vendor_products_barcode_shape: GTIN-8/12/13/14. */
const BARCODE_PATTERN = /^[0-9]{8,14}$/;

export const MAX_PRODUCT_CODE_LENGTH = 64;
export const MAX_PRODUCT_NAME_LENGTH = 200;
export const MAX_BRAND_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2000;

/** The canonical, submitted-and-echoed form values. */
export type ProductValues = {
  productCode: string;
  productName: string;
  /** "" when absent — the action converts it to null on the wire. */
  barcode: string;
  brand: string;
  description: string;
};

export type ProductFieldErrors = {
  productCode?: string;
  productName?: string;
  barcode?: string;
  brand?: string;
  description?: string;
};

export type ProductValidation =
  | { ok: true; values: ProductValues }
  | { ok: false; fieldErrors: ProductFieldErrors; values: ProductValues };

export const EMPTY_PRODUCT_VALUES: ProductValues = {
  productCode: "",
  productName: "",
  barcode: "",
  brand: "",
  description: "",
};

function readString(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/** Trim, then collapse every internal run of whitespace to one space. */
function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Canonicalizes raw submitted values.
 *
 * The product CODE is additionally upper-cased, so "sr-100" and "SR-100" are one
 * product rather than two. Names and brands are never case-folded — a brand is written
 * the way its owner writes it.
 */
export function normalizeProductInput(raw: {
  productCode?: unknown;
  productName?: unknown;
  barcode?: unknown;
  brand?: unknown;
  description?: unknown;
}): ProductValues {
  return {
    productCode: collapse(readString(raw.productCode)).toUpperCase(),
    productName: collapse(readString(raw.productName)),
    // A barcode is a number people transcribe with separators; strip them.
    barcode: readString(raw.barcode).replace(/[\s-]/g, ""),
    brand: collapse(readString(raw.brand)),
    description: readString(raw.description).trim(),
  };
}

/**
 * Validates canonical values.
 *
 * @param mode "create" validates the product code; "update" does not, because the code
 *   is immutable in the database (a trigger enforces it) and the edit form has no field
 *   for it. Validating a value the form cannot send would be a rule with no subject.
 */
export function validateProductInput(
  values: ProductValues,
  mode: "create" | "update",
): ProductValidation {
  const fieldErrors: ProductFieldErrors = {};

  if (mode === "create") {
    if (values.productCode.length === 0) {
      fieldErrors.productCode = "Enter a product code.";
    } else if (values.productCode.length > MAX_PRODUCT_CODE_LENGTH) {
      fieldErrors.productCode = `Product codes must be ${MAX_PRODUCT_CODE_LENGTH} characters or fewer.`;
    } else if (!PRODUCT_CODE_PATTERN.test(values.productCode)) {
      fieldErrors.productCode =
        "Use letters, numbers, spaces and . _ / - only, starting with a letter or number.";
    }
  }

  if (values.productName.length === 0) {
    fieldErrors.productName = "Enter a product name.";
  } else if (values.productName.length > MAX_PRODUCT_NAME_LENGTH) {
    fieldErrors.productName = `Product names must be ${MAX_PRODUCT_NAME_LENGTH} characters or fewer.`;
  }

  // A barcode is optional. Only a NON-EMPTY value is checked, so leaving it blank is
  // never an error.
  if (values.barcode.length > 0 && !BARCODE_PATTERN.test(values.barcode)) {
    fieldErrors.barcode = "Enter a barcode of 8 to 14 digits, or leave it blank.";
  }

  if (values.brand.length > MAX_BRAND_LENGTH) {
    fieldErrors.brand = `Brand must be ${MAX_BRAND_LENGTH} characters or fewer.`;
  }

  if (values.description.length > MAX_DESCRIPTION_LENGTH) {
    fieldErrors.description = `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, values };
  }

  return { ok: true, values };
}

/** Turns an optional form value into what the RPC expects: a string, or null. */
export function optionalOrNull(value: string): string | null {
  return value.length > 0 ? value : null;
}
