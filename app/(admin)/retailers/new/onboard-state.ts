/**
 * Shared state contract for the Retailer onboarding form.
 *
 * This lives outside actions.ts deliberately, for the same reason
 * app/login/login-state.ts does: a module with a top-level "use server"
 * directive may only export async functions — every export becomes a callable
 * server endpoint — so exporting a plain object or a const from there is a
 * runtime error. The types alone could have stayed (types are erased before the
 * directive is enforced), but keeping the pair together is clearer than
 * splitting them across files.
 *
 * No "use server" / "use client" directive here on purpose: this module is
 * plain, side-effect-free data that both the Server Action and the Client
 * Component import.
 *
 * Everything in this file crosses the network to the browser, so nothing here
 * may carry anything the browser did not already send. There is deliberately no
 * organization id, actor id, Retailer id, relationship id, shop id, role code,
 * permission code, or status in any of these shapes — the browser has no
 * legitimate use for one, and a field that does not exist cannot leak.
 */

/**
 * The form's six inputs. Named as one union so the field errors and the
 * retained values cannot drift apart: adding an input means adding it here, and
 * both records below fail to typecheck until they account for it.
 */
export type OnboardRetailerField =
  | "retailerName"
  | "countryCode"
  | "defaultCurrency"
  | "shopName"
  | "shopCode"
  | "shopCity";

/**
 * The submitted values, echoed back so a rejected submission does not clear the
 * form. These are the caller's OWN input after trimming and canonicalization —
 * never anything read from the database.
 */
export type OnboardRetailerValues = Record<OnboardRetailerField, string>;

/** Typed state for `useActionState`. This is the entire browser-visible surface. */
export type OnboardRetailerState = {
  /**
   * Per-input messages, all authored in this codebase and all describing the
   * INPUT rather than the database. Partial because a valid field has no entry.
   */
  fieldErrors: Partial<Record<OnboardRetailerField, string>>;
  /**
   * One safe, generic message for everything that is not a field problem —
   * chiefly an RPC failure. Never a Supabase, PostgreSQL, SQLSTATE, constraint,
   * function, schema, or table string.
   */
  formError: string | null;
  /** The submitted values to re-render. */
  values: OnboardRetailerValues;
};

/** An untouched form: every input blank. */
export const EMPTY_ONBOARD_RETAILER_VALUES: OnboardRetailerValues = {
  retailerName: "",
  countryCode: "",
  defaultCurrency: "",
  shopName: "",
  shopCode: "",
  shopCity: "",
};

/** The form's state before any submission has occurred. */
export const INITIAL_ONBOARD_RETAILER_STATE: OnboardRetailerState = {
  fieldErrors: {},
  formError: null,
  values: EMPTY_ONBOARD_RETAILER_VALUES,
};
