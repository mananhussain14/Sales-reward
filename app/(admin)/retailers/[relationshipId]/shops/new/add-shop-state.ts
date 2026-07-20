/**
 * Shared state contract for the Add Shop form.
 *
 * This lives outside actions.ts deliberately, for the same reason
 * app/(admin)/retailers/new/onboard-state.ts and app/login/login-state.ts do: a
 * module with a top-level "use server" directive may only export async functions
 * — every export becomes a callable server endpoint — so exporting a plain object
 * or a const from there is a runtime error.
 *
 * No "use server" / "use client" directive here on purpose: this module is plain,
 * side-effect-free data that both the Server Action and the Client Component
 * import.
 *
 * Everything in this file crosses the network to the browser, so nothing here may
 * carry anything the browser did not already send. There is deliberately no
 * Vendor organization id, Retailer organization id, actor/profile id, shop id,
 * role code, permission code, status, SQLSTATE, constraint name, or raw Supabase
 * error in any of these shapes — the browser has no legitimate use for one, and a
 * field that does not exist cannot leak.
 *
 * Note what is ALSO absent: the relationship id. It travels in the form as a
 * hidden input and in the URL as a route segment, but it is not part of the state
 * echoed back — the form already knows it from its prop, and putting it here
 * would be a second copy to keep in step for no benefit.
 */

/**
 * The form's four inputs. Named as one union so the field errors and the retained
 * values cannot drift apart: adding an input means adding it here, and both
 * records below fail to typecheck until they account for it.
 */
export type AddShopField = "shopName" | "shopCode" | "shopCity" | "countryCode";

/**
 * The submitted values, echoed back so a rejected submission does not clear the
 * form. These are the caller's OWN input after trimming and canonicalization —
 * never anything read from the database.
 */
export type AddShopValues = Record<AddShopField, string>;

/** Typed state for `useActionState`. This is the entire browser-visible surface. */
export type AddShopState = {
  /**
   * Per-input messages, all authored in this codebase and all describing the
   * INPUT rather than the database. Partial because a valid field has no entry.
   *
   * `shopCode` additionally carries the duplicate-code message, which is the one
   * database outcome specific enough to name a field: the RPC raises SQLSTATE
   * 23505 for it, and the action maps that code — never a message string — to
   * this entry.
   */
  fieldErrors: Partial<Record<AddShopField, string>>;
  /**
   * One safe, generic message for everything that is not a field problem — an RPC
   * failure, a refused authorization, an inactive Retailer, a malformed or
   * inaccessible relationship id, or a transport error. Never a Supabase,
   * PostgreSQL, SQLSTATE, constraint, function, schema, table, or policy string.
   */
  formError: string | null;
  /** The submitted values to re-render. */
  values: AddShopValues;
};

/** An untouched form: every input blank. */
export const EMPTY_ADD_SHOP_VALUES: AddShopValues = {
  shopName: "",
  shopCode: "",
  shopCity: "",
  countryCode: "",
};

/** The form's state before any submission has occurred. */
export const INITIAL_ADD_SHOP_STATE: AddShopState = {
  fieldErrors: {},
  formError: null,
  values: EMPTY_ADD_SHOP_VALUES,
};
