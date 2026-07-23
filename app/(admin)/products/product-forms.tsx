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
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldHint, inputClasses, Label, textareaClasses } from "@/components/ui/field";

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

/** Field-level error text, kept as its own element (not the shared Alert) so it can
 *  carry role="alert" on the exact id each input's aria-describedby points at. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm font-medium text-red-700">
      {message}
    </p>
  );
}

function FormBanner({ state }: { state: ProductFormState }) {
  if (state.formError) {
    return (
      <Alert tone="error" role="alert">
        {state.formError}
      </Alert>
    );
  }
  if (state.successMessage) {
    return (
      <Alert tone="success" role="status">
        {state.successMessage}
      </Alert>
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
        <Label htmlFor={`${idPrefix}-productName`}>Product name</Label>
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
          className={inputClasses(Boolean(state.fieldErrors.productName))}
        />
        <FieldError
          id={`${idPrefix}-productName-error`}
          message={state.fieldErrors.productName}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-barcode`} optional>
            Barcode
          </Label>
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
            className={inputClasses(Boolean(state.fieldErrors.barcode))}
          />
          <FieldError
            id={`${idPrefix}-barcode-error`}
            message={state.fieldErrors.barcode}
          />
          <FieldHint id={`${idPrefix}-barcode-hint`}>
            8 to 14 digits. Spaces and hyphens are removed.
          </FieldHint>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-brand`} optional>
            Brand
          </Label>
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
            className={inputClasses(Boolean(state.fieldErrors.brand))}
          />
          <FieldError id={`${idPrefix}-brand-error`} message={state.fieldErrors.brand} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-description`} optional>
          Description
        </Label>
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
          className={textareaClasses(Boolean(state.fieldErrors.description))}
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
        <Label htmlFor="create-productCode">Product code</Label>
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
          className={inputClasses(Boolean(state.fieldErrors.productCode))}
        />
        <FieldError
          id="create-productCode-error"
          message={state.fieldErrors.productCode}
        />
        <FieldHint id="create-code-hint">
          Upper-cased automatically, and unique within your catalog. It cannot be
          changed later.
        </FieldHint>
      </div>

      <ProductDetailFields state={state} pending={pending} idPrefix="create" />

      <Button type="submit" loading={pending} loadingLabel="Adding…">
        Add product
      </Button>
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
        <span className="block text-sm font-medium text-slate-800">Product code</span>
        <p className="font-mono text-sm text-slate-700">{product.productCode}</p>
        <p className="text-xs text-slate-500">
          Product codes cannot be changed. Create a replacement product instead.
        </p>
      </div>

      <ProductDetailFields state={state} pending={pending} idPrefix="edit" />

      <Button type="submit" loading={pending} loadingLabel="Saving…">
        Save changes
      </Button>
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
      <p role="alert" aria-live="polite" className="mt-1 text-xs text-red-600">
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p role="status" aria-live="polite" className="mt-1 text-xs text-emerald-700">
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
      <Button
        type="submit"
        variant={next === "ACTIVE" ? "outline" : "danger"}
        size="sm"
        loading={pending}
        loadingLabel="Saving…"
        aria-label={`${label} ${productName}`}
      >
        {label}
      </Button>
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
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={disabled}
        loading={pending}
        loadingLabel="Assigning…"
        aria-label={`Assign to ${retailerName}`}
      >
        Assign
      </Button>
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
      <Button
        type="submit"
        variant="danger"
        size="sm"
        loading={pending}
        loadingLabel="Withdrawing…"
        aria-label={`Withdraw from ${retailerName}`}
      >
        Withdraw
      </Button>
      <ActionFeedback error={state.error} success={state.success} />
    </form>
  );
}
