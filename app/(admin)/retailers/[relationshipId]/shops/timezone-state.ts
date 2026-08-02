/**
 * Shared state contract for the Shop Time Zone form.
 *
 * Lives outside the action module deliberately, for the same reason
 * shops/new/add-shop-state.ts does: a module with a top-level "use server"
 * directive may only export async functions — every export becomes a callable
 * server endpoint — so exporting a plain object or a const from there is a
 * runtime error.
 *
 * No "use server" / "use client" directive here on purpose: this module is plain,
 * side-effect-free data that both the Server Action and the Client Component
 * import.
 *
 * Everything in this file crosses the network to the browser, so nothing here may
 * carry anything the browser did not already send. There is deliberately no
 * Vendor organization id, Retailer organization id, actor/profile id, role code,
 * permission code, SQLSTATE, constraint name, resolved UTC offset, or raw
 * Supabase error in any of these shapes — the browser has no legitimate use for
 * one, and a field that does not exist cannot leak.
 *
 * Note what is ALSO absent: the shop id and the relationship id. Both travel in
 * the form as hidden inputs and are known to the component from its props;
 * echoing them back would be a second copy to keep in step for no benefit.
 */

/** The form's single input. */
export type ShopTimeZoneField = "timezoneName";

/** The submitted value, echoed back so a rejected submission does not clear it. */
export type ShopTimeZoneValues = Record<ShopTimeZoneField, string>;

/** Typed state for `useActionState`. This is the entire browser-visible surface. */
export type ShopTimeZoneState = {
  /**
   * Per-input messages, all authored in this codebase and all describing the
   * INPUT rather than the database. Partial because a valid field has no entry.
   */
  fieldErrors: Partial<Record<ShopTimeZoneField, string>>;
  /**
   * One safe, generic message for everything that is not a field problem — a
   * refused authorization, an unknown or foreign shop id, a rejected zone the
   * shape check did not catch, or a transport failure. Never a Supabase,
   * PostgreSQL, SQLSTATE, constraint, function, schema, table or policy string.
   */
  formError: string | null;
  /**
   * Set only after a write that actually changed the stored value. Carries the
   * zone the DATABASE now holds, re-read from the RPC's return rather than echoed
   * from the submission, so the confirmation cannot claim something that was not
   * stored.
   */
  savedTimezoneName: string | null;
  /**
   * True when the submission was accepted but changed nothing, because the shop
   * already held that zone. Reported distinctly rather than as a success: telling
   * an operator "saved" when nothing was written would teach them to trust a
   * message that is sometimes false.
   */
  unchanged: boolean;
  /** The submitted value to re-render. */
  values: ShopTimeZoneValues;
};

/** An untouched form. */
export const EMPTY_SHOP_TIMEZONE_VALUES: ShopTimeZoneValues = {
  timezoneName: "",
};

/** The form's state before any submission has occurred. */
export const INITIAL_SHOP_TIMEZONE_STATE: ShopTimeZoneState = {
  fieldErrors: {},
  formError: null,
  savedTimezoneName: null,
  unchanged: false,
  values: EMPTY_SHOP_TIMEZONE_VALUES,
};
