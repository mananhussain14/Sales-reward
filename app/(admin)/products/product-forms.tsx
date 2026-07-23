"use client";

import { useActionState } from "react";
import {
  assignProductAction,
  createProductAction,
  setProductStatusAction,
  unassignProductAction,
  updateProductAction,
} from "@/app/(admin)/products/actions";
import {
  INITIAL_PRODUCT_ACTION_STATE,
  INITIAL_PRODUCT_FORM_STATE,
  type ProductFormState,
} from "@/app/(admin)/products/product-form-state";
import {
  MAX_BRAND_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_PRODUCT_CODE_LENGTH,
  MAX_PRODUCT_NAME_LENGTH,
} from "@/lib/products/product-input";
import type { VendorProduct } from "@/lib/products/product-normalization";

/**
 * The Vendor product forms and row-level controls.
 *
 * Client Components only so they can surface pending/error state via `useActionState`,
 * and — for withdrawal — ask for confirmation before submitting.
 *
 * WHAT CROSSES THE SERVER BOUNDARY INTO THESE COMPONENTS. Only a product's own display
 * fields, its id, and a Retailer's organization id and name — all from RPCs that
 * already proved the caller owns them. No Vendor organization id, creator profile id,
 * membership id, role id, permission code or audit metadata is passed in; none is
 * available to pass, because no RPC returns one.
 *
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY. Every action re-resolves Vendor Admin
 * access, and every RPC behind it re-derives the Vendor from auth.uid() and re-checks
 * the specific permission. The hidden ids are addresses the database validates against
 * the Vendor it derived, never claims it trusts.
 *
 * @/lib/products/product-input is imported here only for its four PURE length
 * constants, so the inputs' `maxLength` and the server's rule cannot drift.
 */

const inputClasses =
  "block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500";

const labelClasses = "block text-sm font-medium text-zinc-900 dark:text-zinc-100";

const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950";

const smallButton =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:ring-offset-zinc-950";

const dangerButton =
  "inline-flex items-center justify-center rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950/40 dark:focus-visible:ring-offset-zinc-950";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

function FormBanner({ state }: { state: ProductFormState }) {
  if (state.formError) {
    return (
      <div
        role="alert"
        aria-live="polite"
        className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
      >
        <p>{state.formError}</p>
      </div>
    );
  }
  if (state.successMessage) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
      >
        <p>{state.successMessage}</p>
      </div>
    );
  }
  return null;
}

/** The shared display fields, used by both the create and the edit form. */
function ProductDetailFields({
  state,
  pending,
  idPrefix,
}: {
  state: ProductFormState;
  pending: boolean;
  idPrefix: string;
}) {
  return (
    <>
      <div className="space-y-2">
        <label htmlFor={`${idPrefix}-productName`} className={labelClasses}>
          Product name
        </label>
        <input
          id={`${idPrefix}-productName`}
          name="productName"
          type="text"
          required
          maxLength={MAX_PRODUCT_NAME_LENGTH}
          disabled={pending}
          defaultValue={state.values.productName}
          aria-describedby={
            state.fieldErrors.productName ? `${idPrefix}-productName-error` : undefined
          }
          className={inputClasses}
        />
        <FieldError
          id={`${idPrefix}-productName-error`}
          message={state.fieldErrors.productName}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor={`${idPrefix}-barcode`} className={labelClasses}>
            Barcode <span className="font-normal text-zinc-500">(optional)</span>
          </label>
          <input
            id={`${idPrefix}-barcode`}
            name="barcode"
            type="text"
            inputMode="numeric"
            maxLength={20}
            disabled={pending}
            defaultValue={state.values.barcode}
            aria-describedby={
              state.fieldErrors.barcode
                ? `${idPrefix}-barcode-error`
                : `${idPrefix}-barcode-hint`
            }
            className={inputClasses}
          />
          <FieldError
            id={`${idPrefix}-barcode-error`}
            message={state.fieldErrors.barcode}
          />
          <p
            id={`${idPrefix}-barcode-hint`}
            className="text-xs text-zinc-500 dark:text-zinc-400"
          >
            8 to 14 digits. Spaces and hyphens are removed.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor={`${idPrefix}-brand`} className={labelClasses}>
            Brand <span className="font-normal text-zinc-500">(optional)</span>
          </label>
          <input
            id={`${idPrefix}-brand`}
            name="brand"
            type="text"
            maxLength={MAX_BRAND_LENGTH}
            disabled={pending}
            defaultValue={state.values.brand}
            aria-describedby={
              state.fieldErrors.brand ? `${idPrefix}-brand-error` : undefined
            }
            className={inputClasses}
          />
          <FieldError id={`${idPrefix}-brand-error`} message={state.fieldErrors.brand} />
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor={`${idPrefix}-description`} className={labelClasses}>
          Description <span className="font-normal text-zinc-500">(optional)</span>
        </label>
        <textarea
          id={`${idPrefix}-description`}
          name="description"
          rows={3}
          maxLength={MAX_DESCRIPTION_LENGTH}
          disabled={pending}
          defaultValue={state.values.description}
          aria-describedby={
            state.fieldErrors.description ? `${idPrefix}-description-error` : undefined
          }
          className={inputClasses}
        />
        <FieldError
          id={`${idPrefix}-description-error`}
          message={state.fieldErrors.description}
        />
      </div>
    </>
  );
}

/** Adds a product to the Vendor's catalog. */
export function CreateProductForm() {
  const [state, formAction, pending] = useActionState(
    createProductAction,
    INITIAL_PRODUCT_FORM_STATE,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormBanner state={state} />

      <div className="space-y-2">
        <label htmlFor="create-productCode" className={labelClasses}>
          Product code
        </label>
        <input
          id="create-productCode"
          name="productCode"
          type="text"
          required
          maxLength={MAX_PRODUCT_CODE_LENGTH}
          disabled={pending}
          defaultValue={state.values.productCode}
          aria-describedby={
            state.fieldErrors.productCode ? "create-productCode-error" : "create-code-hint"
          }
          className={inputClasses}
        />
        <FieldError
          id="create-productCode-error"
          message={state.fieldErrors.productCode}
        />
        <p id="create-code-hint" className="text-xs text-zinc-500 dark:text-zinc-400">
          Upper-cased automatically, and unique within your catalog. It cannot be
          changed later.
        </p>
      </div>

      <ProductDetailFields state={state} pending={pending} idPrefix="create" />

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Adding…" : "Add product"}
      </button>
    </form>
  );
}

/**
 * Edits one product's display details.
 *
 * The product CODE is shown as static text, not an input: it is immutable in the
 * database, so an editable field would invite a change the server must refuse.
 */
export function EditProductForm({ product }: { product: VendorProduct }) {
  const [state, formAction, pending] = useActionState(updateProductAction, {
    ...INITIAL_PRODUCT_FORM_STATE,
    values: {
      productCode: product.productCode,
      productName: product.productName,
      barcode: product.barcode ?? "",
      brand: product.brand ?? "",
      description: product.description ?? "",
    },
  });

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="productId" value={product.productId} />
      <FormBanner state={state} />

      <div className="space-y-1">
        <span className={labelClasses}>Product code</span>
        <p className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
          {product.productCode}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Product codes cannot be changed. Create a replacement product instead.
        </p>
      </div>

      <ProductDetailFields state={state} pending={pending} idPrefix="edit" />

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

function ActionFeedback({
  error,
  success,
}: {
  error: string | null;
  success: string | null;
}) {
  if (error) {
    return (
      <p role="alert" aria-live="polite" className="mt-1 text-xs text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-1 text-xs text-emerald-700 dark:text-emerald-400"
      >
        {success}
      </p>
    );
  }
  return null;
}

/** Activates or deactivates one product. */
export function ProductStatusForm({
  productId,
  productName,
  currentStatus,
}: {
  productId: string;
  /** Accessible name only — the action never reads it. */
  productName: string;
  currentStatus: "ACTIVE" | "INACTIVE";
}) {
  const [state, formAction, pending] = useActionState(
    setProductStatusAction,
    INITIAL_PRODUCT_ACTION_STATE,
  );

  const next = currentStatus === "ACTIVE" ? "INACTIVE" : "ACTIVE";
  const label = next === "ACTIVE" ? "Activate" : "Deactivate";

  return (
    <form action={formAction}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="status" value={next} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`${label} ${productName}`}
        className={next === "ACTIVE" ? smallButton : dangerButton}
      >
        {pending ? "Saving…" : label}
      </button>
      <ActionFeedback error={state.error} success={state.success} />
    </form>
  );
}

/** Assigns a product to one Retailer. */
export function AssignRetailerForm({
  productId,
  retailerId,
  retailerName,
  disabled,
}: {
  productId: string;
  retailerId: string;
  retailerName: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    assignProductAction,
    INITIAL_PRODUCT_ACTION_STATE,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="retailerId" value={retailerId} />
      <button
        type="submit"
        disabled={pending || disabled}
        aria-label={`Assign to ${retailerName}`}
        className={smallButton}
      >
        {pending ? "Assigning…" : "Assign"}
      </button>
      <ActionFeedback error={state.error} success={state.success} />
    </form>
  );
}

/** Withdraws a product from one Retailer. Confirms first — the Retailer loses sight of it. */
export function UnassignRetailerForm({
  productId,
  retailerId,
  retailerName,
}: {
  productId: string;
  retailerId: string;
  retailerName: string;
}) {
  const [state, formAction, pending] = useActionState(
    unassignProductAction,
    INITIAL_PRODUCT_ACTION_STATE,
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        // The Retailer stops seeing the product immediately. That is reversible — the
        // row is kept and can be re-assigned — but it is still worth one interruption.
        // UX only: the action re-authorizes regardless, and a no-JS submission that
        // skips this handler is handled by the server on its own terms.
        if (
          !window.confirm(
            `Withdraw this product from ${retailerName}? They will stop seeing it straight away.`,
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="retailerId" value={retailerId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Withdraw from ${retailerName}`}
        className={dangerButton}
      >
        {pending ? "Withdrawing…" : "Withdraw"}
      </button>
      <ActionFeedback error={state.error} success={state.success} />
    </form>
  );
}
