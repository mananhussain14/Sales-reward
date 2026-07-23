import type {
  ProductFieldErrors,
  ProductValues,
} from "@/lib/products/product-input";
import { EMPTY_PRODUCT_VALUES } from "@/lib/products/product-input";

/**
 * Shared state contracts for the product forms and the row-level controls.
 *
 * These live outside actions.ts deliberately. A module with a top-level "use server"
 * directive may only export async functions — every export becomes a callable server
 * endpoint — so exporting a plain object from there is a runtime error.
 *
 * THE BROWSER-VISIBLE SURFACE IS ONLY WHAT IS HERE: field messages, one form message,
 * one success message, and the values the operator typed (echoed back so a rejected
 * submission does not lose their work). There is no Vendor organization id, creator
 * profile id, membership id, role id, assignment id or audit metadata — none is
 * produced by any action, because every operation returns a status and nothing else.
 */
export type ProductFormState = {
  fieldErrors: ProductFieldErrors;
  formError: string | null;
  successMessage: string | null;
  values: ProductValues;
};

export const INITIAL_PRODUCT_FORM_STATE: ProductFormState = {
  fieldErrors: {},
  formError: null,
  successMessage: null,
  values: EMPTY_PRODUCT_VALUES,
};

/**
 * State for the single-button controls: activate / deactivate, assign / unassign.
 *
 * The product id and Retailer id travel only INTO the action as hidden fields — each an
 * address the database re-checks against the Vendor it derives for itself — and never
 * back out.
 */
export type ProductActionState = {
  error: string | null;
  success: string | null;
};

export const INITIAL_PRODUCT_ACTION_STATE: ProductActionState = {
  error: null,
  success: null,
};
