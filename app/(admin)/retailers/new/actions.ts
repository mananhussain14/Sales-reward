"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { isIsoCountryCode } from "@/lib/reference/iso-country-codes";
import type {
  OnboardRetailerField,
  OnboardRetailerState,
  OnboardRetailerValues,
} from "@/app/(admin)/retailers/new/onboard-state";

/**
 * Server Action backing the Vendor Admin Retailer onboarding form.
 *
 * The write itself is NOT performed here. This action validates, authorizes,
 * and then calls public.onboard_vendor_retailer() — one SECURITY DEFINER RPC
 * that creates the Retailer organization, the Vendor relationship, the first
 * shop, and the audit record in a single transaction. There is deliberately no
 * table insert in this module, and there could not be one: organizations,
 * vendor_retailers, retailer_shops, and audit_logs are all RLS default-deny with
 * no write privilege for `authenticated`. The RPC is the one audited door.
 *
 * Nothing about the tenant or the actor is sent. The RPC's signature has no
 * vendor organization id, actor/profile id, relationship id, role code,
 * permission code, or status parameter, because any such parameter is a value
 * the caller controls — and a caller-controlled tenant id is exactly how a
 * cross-tenant write happens. The caller says WHAT to create; the database
 * decides WHO it is created for, and AS whom, from auth.uid().
 *
 * Because of the "use server" directive above, `onboardRetailer` must be this
 * module's only runtime export — every export here is exposed as a callable
 * server endpoint, so Next.js rejects anything that is not an async function.
 * The state types and initial value therefore live in ./onboard-state;
 * `import type` above is erased at compile time and adds no export.
 */

/**
 * The single message used for every failure that is not a field problem.
 *
 * The raw Supabase/PostgreSQL error is never forwarded: it can name schemas,
 * tables, columns, constraints, functions, and policies, and its SQLSTATE
 * distinguishes failure modes. The admin can only usefully do one thing about
 * any of them — check the details and try again — so they all collapse here.
 */
const GENERIC_ONBOARD_ERROR =
  "We couldn't create the Retailer. Please review the details and try again.";

/**
 * Reads one FormData entry as a trimmed string.
 *
 * FormData entries are `string | File`; a File here means a malformed or
 * hand-crafted request, and is treated as absent rather than coerced — the
 * "[object File]" a naive String() would produce is not something to store.
 */
function readTrimmed(formData: FormData, field: OnboardRetailerField): string {
  const raw = formData.get(field);
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Canonicalizes a code input: trimmed by the caller, then upper-cased, because
 * the stored form is canonical and 'ae' and 'AE' are the same country. Mirrors
 * the `upper(nullif(btrim(...), ''))` the RPC applies to the same inputs.
 */
function canonicalizeCode(value: string): string {
  return value.toUpperCase();
}

/** Optional text: an empty string means "absent", which the database stores as NULL. */
function orNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

/**
 * Rejected for a country code that is well-shaped but not a real country.
 *
 * The message names the RULE and gives one example. It deliberately does NOT
 * enumerate the 249 accepted codes: a wall of them would be unreadable in a
 * field error, and the admin's problem is almost always a typo rather than
 * ignorance of the standard. It also says nothing about the database — no table,
 * constraint, or foreign key is mentioned or implied.
 */
const INVALID_COUNTRY_CODE_ERROR = "Enter a valid country code, such as AE.";

/** Exactly three ASCII letters, matching organizations_default_currency_len. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export async function onboardRetailer(
  _prevState: OnboardRetailerState,
  formData: FormData,
): Promise<OnboardRetailerState> {
  // ---------------------------------------------------------------------------
  // 1. Read and canonicalize
  // ---------------------------------------------------------------------------
  // Every text input is trimmed. The two code fields are additionally
  // upper-cased, so the value validated below, the value sent to the RPC, and
  // the value echoed back into the form are all the same canonical string —
  // an admin who typed "ae" sees "AE" rather than being told their valid input
  // was rejected. Nothing is truncated anywhere: an over-long code is REJECTED
  // below, never silently shortened, because quietly turning "USDD" into "USD"
  // would invent data the admin never supplied.
  const values: OnboardRetailerValues = {
    retailerName: readTrimmed(formData, "retailerName"),
    countryCode: canonicalizeCode(readTrimmed(formData, "countryCode")),
    defaultCurrency: canonicalizeCode(readTrimmed(formData, "defaultCurrency")),
    shopName: readTrimmed(formData, "shopName"),
    shopCode: readTrimmed(formData, "shopCode"),
    shopCity: readTrimmed(formData, "shopCity"),
  };

  // ---------------------------------------------------------------------------
  // 2. Field validation
  // ---------------------------------------------------------------------------
  // These rules are the RPC's own rules, restated so a mistake is caught with a
  // clear per-field message instead of a round trip that can only come back as
  // one generic failure. They do NOT replace the database's checks: the RPC
  // re-validates everything, and the table constraints still have the final say.
  //
  // No maximum length is imposed on the free-text fields. The schema puts none
  // on organizations.name or retailer_shops.name — only non-empty checks — and
  // inventing a ceiling here would reject input the database accepts.
  //
  // Every field is checked before returning, so one submission reports every
  // problem at once rather than revealing them one round trip at a time.
  const fieldErrors: OnboardRetailerState["fieldErrors"] = {};

  if (values.retailerName.length === 0) {
    fieldErrors.retailerName = "Enter the Retailer's name.";
  }

  if (values.shopName.length === 0) {
    fieldErrors.shopName = "Enter the first shop's name.";
  }

  // Membership in the ISO 3166-1 alpha-2 list, not merely "two letters". A
  // shape check accepted DD (a retired code), II and ZZ (user-assigned ranges),
  // and every other well-formed non-country — values the schema was willing to
  // store and nobody could act on. isIsoCountryCode() is case-sensitive by
  // design, which is why the value was upper-cased during canonicalization above
  // rather than here.
  //
  // The database now enforces the same rule underneath, via the NOT VALID
  // foreign key from organizations.country_code to public.iso_country_codes.
  // This check exists so the admin gets a named field and a clear message
  // instead of one generic failure after a round trip; it does not replace the
  // constraint, which has the final say.
  if (
    values.countryCode.length > 0 &&
    !isIsoCountryCode(values.countryCode)
  ) {
    fieldErrors.countryCode = INVALID_COUNTRY_CODE_ERROR;
  }

  if (
    values.defaultCurrency.length > 0 &&
    !CURRENCY_PATTERN.test(values.defaultCurrency)
  ) {
    fieldErrors.defaultCurrency = "Use exactly three letters, such as AED.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    // The submitted values ride back so the admin does not retype the fields
    // that were fine.
    return { fieldErrors, formError: null, values };
  }

  // ---------------------------------------------------------------------------
  // 3. Authorization
  // ---------------------------------------------------------------------------
  // A Server Action is a public endpoint. It is reachable directly, by any
  // caller, regardless of which page rendered the form or whether that page
  // guarded itself — so the check is repeated here rather than assumed from the
  // route. The decision is delegated in full to the shared function, never
  // re-implemented, so this action and the (admin) layout cannot disagree.
  //
  // This is defense in depth, not the enforcement boundary. The RPC evaluates
  // the same chain again from auth.uid() and then requires RETAILERS_CREATE, and
  // that check — inside the database, under the caller's own token — is what
  // actually stops an unauthorized write. Failing here simply turns a guaranteed
  // rejection into an honest redirect instead of a generic error.
  const access = await getVendorSuperAdminAccess();

  // Both redirects sit outside every try/catch in this module: redirect()
  // signals by throwing NEXT_REDIRECT, and catching it would swallow the
  // navigation.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  // `access` is used for nothing else. Its organizationId is deliberately NOT
  // read and NOT sent: the RPC resolves the Vendor itself, from the caller's own
  // verified token, and accepts no organization parameter at all.

  const supabase = await createClient();

  // ---------------------------------------------------------------------------
  // 4. The write — one RPC, one transaction
  // ---------------------------------------------------------------------------
  // The ordinary authenticated server client, carrying the caller's own cookie
  // session. service_role is not used here or anywhere in this codebase: it
  // would have no auth.uid() for the function to resolve, so the call would fail
  // closed at its first check — and it would bypass RLS, making this module,
  // rather than the database, the thing standing between one Vendor and another.
  //
  // Optional fields are sent as null rather than "" so an absent value is stored
  // as absent. The RPC applies nullif(btrim(...), '') as well; sending null is
  // simply saying the same thing plainly.
  //
  // Promise.resolve() because the PostgREST builder is a thenable, not a real
  // Promise — it implements `then` and has no `.catch()` of its own. Adopting it
  // gives a genuine Promise to attach the rejection handler to, without altering
  // when the request fires or what it returns. This is the same shape
  // lib/auth/vendor-admin-access.ts uses for its RPC.
  const result = await Promise.resolve(
    supabase.rpc("onboard_vendor_retailer", {
      p_retailer_name: values.retailerName,
      p_shop_name: values.shopName,
      p_country_code: orNull(values.countryCode),
      p_default_currency: orNull(values.defaultCurrency),
      p_shop_code: orNull(values.shopCode),
      p_shop_city: orNull(values.shopCity),
    }),
  ).catch(() => null);

  // `null` is a throw: a fetch-level TypeError, an aborted request, a DNS or TLS
  // failure. The thrown value is deliberately not bound, inspected, or logged —
  // it may carry request URLs, headers, or token material, and the request body
  // here includes the submitted form.
  //
  // A reported PostgREST/RPC error lands in the same branch. Its message can
  // name the function, its constraints, and its raise strings, and its SQLSTATE
  // separates "not authorized" from "check violation" — none of which may reach
  // a browser. The RPC's own three authorization raises are byte-identical for
  // exactly this reason, and this collapses the rest to match.
  //
  // The error is NOT parsed to route the message. String-matching a PostgreSQL
  // message is brittle and one refactor away from surfacing raw SQL text; and
  // since section 2 already validated every field, a check violation arriving
  // here means the caller bypassed the form, for which the generic message is
  // the correct answer.
  if (result === null || result.error) {
    // A minimal, entirely static diagnostic: a fixed string with no
    // interpolation. It records THAT the call failed and nothing else — no error
    // object, no message, no SQLSTATE, no access token, no user or organization
    // id, and none of the submitted values. This codebase's convention is that
    // error objects from Supabase are never logged, and that holds here; a line
    // that names the failing operation is the most a server log may carry.
    console.error("onboardRetailer: onboard_vendor_retailer RPC failed");

    return { fieldErrors: {}, formError: GENERIC_ONBOARD_ERROR, values };
  }

  // ---------------------------------------------------------------------------
  // 5. Success
  // ---------------------------------------------------------------------------
  // Reaching here means the transaction committed: the Retailer, its
  // relationship, its first shop, and the audit row all exist. The RPC returns
  // void, so there is nothing to unwrap — and no generated id to hand back to a
  // browser that never chose one and has no use for one.

  // The directory is the only route whose content changed. Deliberately not
  // revalidatePath("/", "layout"), which is reserved for session transitions
  // where the whole authenticated shell must be dropped. Revalidating before the
  // redirect is what makes the new Retailer visible on arrival.
  revalidatePath("/retailers");

  // A hardcoded literal destination. No redirectTo/next form field or search
  // parameter is read anywhere in this module — a caller-supplied redirect
  // target is an open-redirect vector. The `created=1` flag carries no id and no
  // database value; it only tells the directory to render a success banner.
  //
  // Outside any try/catch, and nothing follows it: redirect() throws
  // NEXT_REDIRECT, so no success state is returned or could be. Swallowing that
  // throw would turn a committed write into a spurious failure message.
  redirect("/retailers?created=1");
}
