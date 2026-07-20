"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { isIsoCountryCode } from "@/lib/reference/iso-country-codes";
import type {
  AddShopField,
  AddShopState,
  AddShopValues,
} from "@/app/(admin)/retailers/[relationshipId]/shops/new/add-shop-state";

/**
 * Server Action backing the Add Shop form.
 *
 * The write itself is NOT performed here. This action validates, authorizes, and
 * then calls public.add_vendor_retailer_shop() — one SECURITY DEFINER RPC that
 * creates the shop and its audit record in a single transaction. There is
 * deliberately no table insert in this module, and there could not be one:
 * retailer_shops grants `authenticated` SELECT and nothing else, audit_logs
 * grants it nothing at all, and both are RLS default-deny for writes. The RPC is
 * the one audited door.
 *
 * ONE identifier is sent, and it is an ADDRESS rather than authorization.
 * `relationshipId` says WHICH of the caller's own Retailers to add a shop to. It
 * does not say who the caller is, which Vendor they act for, or which Retailer
 * organization is written — the RPC derives all three itself, from auth.uid(),
 * and re-verifies the relationship against the Vendor it derived. A relationship
 * id belonging to another Vendor selects nothing there. Nothing else about the
 * tenant or the actor is sent: the RPC's signature has no Vendor organization id,
 * Retailer organization id, actor/profile id, shop id, role code, permission
 * code, or status parameter, because any such parameter is a value the caller
 * controls — and a caller-controlled tenant id is exactly how a cross-tenant
 * write happens.
 *
 * Because of the "use server" directive above, `addVendorRetailerShop` must be
 * this module's only runtime export — every export here is exposed as a callable
 * server endpoint, so Next.js rejects anything that is not an async function. The
 * state types and initial value therefore live in ./add-shop-state; `import type`
 * above is erased at compile time and adds no export.
 */

/**
 * The single message used for every failure that is not a field problem.
 *
 * The raw Supabase/PostgreSQL error is never forwarded: it can name schemas,
 * tables, columns, constraints, functions, and policies, and its SQLSTATE
 * distinguishes failure modes. Crucially, this ONE message covers all of:
 * a malformed relationship id, a nonexistent one, one belonging to another
 * Vendor, one the caller may not read, a suspended relationship or Retailer, a
 * missing permission, and a database outage. Collapsing them is deliberate — the
 * RPC already refuses all of the addressing cases with a single byte-identical
 * exception so it cannot be used as an existence oracle, and distinguishing them
 * here would reintroduce exactly the disclosure the database went out of its way
 * to prevent.
 */
const GENERIC_ADD_SHOP_ERROR =
  "We couldn't add the shop. Please check the details and try again.";

/**
 * The one database outcome specific enough to name a field. The RPC raises
 * SQLSTATE 23505 for a case-insensitive duplicate code within the Retailer, and
 * the partial unique index raises the same code if a concurrent insert wins the
 * race. Either way the admin has a correctable input problem, and telling them
 * "something went wrong" would be unhelpful and untrue.
 */
const DUPLICATE_SHOP_CODE_ERROR =
  "This shop code is already in use for this Retailer.";

/** PostgreSQL unique_violation. Matched on the CODE, never on message text. */
const UNIQUE_VIOLATION_SQLSTATE = "23505";

/**
 * Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. The
 * same shape lib/retailers/vendor-retailer-detail.ts screens with.
 *
 * Validating before the call keeps a malformed value out of the request entirely.
 * It is also what makes the redirect and revalidate targets below safe: an
 * unvalidated segment interpolated into a path is a path-injection vector.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rejected for a country code that is well-shaped but not a real country.
 *
 * The message names the RULE and gives one example. It deliberately does NOT
 * enumerate the 249 accepted codes: a wall of them would be unreadable in a field
 * error, and the admin's problem is almost always a typo. It also says nothing
 * about the database — no table, constraint, or foreign key is mentioned.
 */
const INVALID_COUNTRY_CODE_ERROR = "Enter a valid country code, such as AE.";

/**
 * Reads one FormData entry as a trimmed string.
 *
 * FormData entries are `string | File`; a File here means a malformed or
 * hand-crafted request, and is treated as absent rather than coerced — the
 * "[object File]" a naive String() would produce is not something to store.
 */
function readTrimmed(
  formData: FormData,
  // The four form fields, plus the one hidden routing field. Typed as a union
  // rather than `string` so a typo in a field name is a compile error instead of
  // a silently empty value that would read as "the admin left it blank".
  field: AddShopField | "relationshipId",
): string {
  const raw = formData.get(field);
  return typeof raw === "string" ? raw.trim() : "";
}

/** Optional text: an empty string means "absent", which the database stores as NULL. */
function orNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

export async function addVendorRetailerShop(
  _prevState: AddShopState,
  formData: FormData,
): Promise<AddShopState> {
  // ---------------------------------------------------------------------------
  // 1. Read and canonicalize
  // ---------------------------------------------------------------------------
  // Every text input is trimmed. The country code is additionally upper-cased, so
  // the value validated below, the value sent to the RPC, and the value echoed
  // back into the form are all the same canonical string — an admin who typed
  // "ae" sees "AE" rather than being told their valid input was rejected. The
  // shop code is trimmed but NOT upper-cased: it is the Retailer's own label and
  // its case is theirs to choose, exactly as the RPC and migration 8's unique
  // index treat it. Nothing is truncated anywhere: an over-long country code is
  // REJECTED below, never silently shortened.
  const values: AddShopValues = {
    shopName: readTrimmed(formData, "shopName"),
    shopCode: readTrimmed(formData, "shopCode"),
    shopCity: readTrimmed(formData, "shopCity"),
    countryCode: readTrimmed(formData, "countryCode").toUpperCase(),
  };

  // The one identifier the browser supplies. Read here but deliberately NOT
  // placed in `values` — it is a routing address, not a form field to echo back,
  // and the form already holds it as a prop.
  const relationshipId = readTrimmed(formData, "relationshipId");

  // ---------------------------------------------------------------------------
  // 2. Field validation
  // ---------------------------------------------------------------------------
  // These rules are the RPC's own rules, restated so a mistake is caught with a
  // clear per-field message instead of a round trip that can only come back as
  // one generic failure. They do NOT replace the database's checks: the RPC
  // re-validates everything, and the table constraints still have the final say.
  //
  // No maximum length is imposed on the free-text fields. Migration 8 puts none
  // on retailer_shops.name, code, or city — only non-empty checks — and inventing
  // a ceiling here would reject input the database accepts. The country code is
  // the one field with a real length rule in the schema, and it is enforced as an
  // exact two-letter pattern rather than a maximum.
  //
  // Every field is checked before returning, so one submission reports every
  // problem at once rather than revealing them one round trip at a time.
  const fieldErrors: AddShopState["fieldErrors"] = {};

  if (values.shopName.length === 0) {
    fieldErrors.shopName = "Enter the shop's name.";
  }

  // Membership in the ISO 3166-1 alpha-2 list, not merely "two letters". A shape
  // check accepted DD (a retired code), II and ZZ (user-assigned ranges), and
  // every other well-formed non-country — values the schema was willing to store
  // and nobody could act on. isIsoCountryCode() is case-sensitive by design,
  // which is why the value was upper-cased during canonicalization above rather
  // than here.
  //
  // The database now enforces the same rule underneath, via the NOT VALID foreign
  // key from retailer_shops.country_code to public.iso_country_codes. This check
  // exists so the admin gets a named field and a clear message instead of one
  // generic failure after a round trip; it does not replace the constraint, which
  // has the final say.
  if (values.countryCode.length > 0 && !isIsoCountryCode(values.countryCode)) {
    fieldErrors.countryCode = INVALID_COUNTRY_CODE_ERROR;
  }

  if (Object.keys(fieldErrors).length > 0) {
    // The submitted values ride back so the admin does not retype the fields that
    // were fine.
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
  // This is defense in depth, not the enforcement boundary. The RPC evaluates the
  // same chain again from auth.uid(), then requires RETAILER_SHOPS_CREATE, then
  // re-verifies that the relationship belongs to the Vendor it derived, and only
  // then checks that both the relationship and the Retailer are ACTIVE. Those
  // checks — inside the database, under the caller's own token — are what
  // actually stop an unauthorized or cross-tenant write.
  const access = await getVendorSuperAdminAccess();

  // Both redirects sit outside every try/catch in this module: redirect() signals
  // by throwing NEXT_REDIRECT, and catching it would swallow the navigation.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  // `access` is used for nothing else. Its organizationId is deliberately NOT
  // read and NOT sent: the RPC resolves the Vendor itself, from the caller's own
  // verified token, and accepts no organization parameter at all.

  // ---------------------------------------------------------------------------
  // 4. Relationship id — shape only, and never a disclosure
  // ---------------------------------------------------------------------------
  // A malformed value returns the SAME generic message as a nonexistent, foreign,
  // or inaccessible one. That is the whole point: the browser must not be able to
  // tell these apart, because the difference between them is information about
  // rows the caller may not read. A malformed id can only mean a tampered form,
  // so there is no legitimate submission this costs.
  //
  // Screening the shape here also keeps a bad value out of the RPC call, where
  // PostgREST would reject it with a uuid cast error — a database-shaped failure
  // for what is really a bad address.
  if (!UUID_PATTERN.test(relationshipId)) {
    return { fieldErrors: {}, formError: GENERIC_ADD_SHOP_ERROR, values };
  }

  const supabase = await createClient();

  // ---------------------------------------------------------------------------
  // 5. The write — one RPC, one transaction
  // ---------------------------------------------------------------------------
  // The ordinary authenticated server client, carrying the caller's own cookie
  // session. service_role is not used here or anywhere in this codebase: it would
  // have no auth.uid() for the function to resolve, so the call would fail closed
  // at its first check — and it would bypass RLS, making this module, rather than
  // the database, the thing standing between one Vendor and another.
  //
  // Named arguments matching the RPC signature exactly. Optional fields are sent
  // as null rather than "" so an absent value is stored as absent; the RPC
  // applies nullif(btrim(...), '') as well, and sending null is simply saying the
  // same thing plainly.
  //
  // Promise.resolve() because the PostgREST builder is a thenable, not a real
  // Promise — it implements `then` and has no `.catch()` of its own. Adopting it
  // gives a genuine Promise to attach the rejection handler to, without altering
  // when the request fires or what it returns. This is the same shape
  // lib/auth/vendor-admin-access.ts and the onboarding action use.
  const result = await Promise.resolve(
    supabase.rpc("add_vendor_retailer_shop", {
      p_relationship_id: relationshipId,
      p_shop_name: values.shopName,
      p_shop_code: orNull(values.shopCode),
      p_shop_city: orNull(values.shopCity),
      p_country_code: orNull(values.countryCode),
    }),
  ).catch(() => null);

  // ---------------------------------------------------------------------------
  // 6. Failure handling
  // ---------------------------------------------------------------------------
  // `null` is a throw: a fetch-level TypeError, an aborted request, a DNS or TLS
  // failure. The thrown value is deliberately not bound, inspected, or logged —
  // it may carry request URLs, headers, or token material, and the request body
  // here includes the submitted form.
  if (result === null || result.error) {
    // The ONE exception to "never inspect the error": the SQLSTATE, and only to
    // recognize a duplicate shop code. This is a code comparison, not
    // string-matching a PostgreSQL message — the codes are a stable documented
    // contract, whereas a message is one refactor away from surfacing raw SQL
    // text. Nothing from the error is rendered; the message shown is this
    // codebase's own string.
    if (result?.error?.code === UNIQUE_VIOLATION_SQLSTATE) {
      return {
        fieldErrors: { shopCode: DUPLICATE_SHOP_CODE_ERROR },
        formError: null,
        values,
      };
    }

    // Everything else collapses to one message: a refused authorization, an
    // unowned or nonexistent relationship, a suspended relationship or Retailer,
    // a validation failure that slipped past section 2, and a database outage
    // alike. Their SQLSTATEs and messages differ, and none of that may reach a
    // browser — the RPC's four authorization raises are byte-identical for
    // exactly this reason, and this collapses the rest to match.
    //
    // A minimal, entirely static diagnostic: a fixed string with no
    // interpolation. It records THAT the call failed and nothing else — no error
    // object, no message, no SQLSTATE, no access token, no relationship id, no
    // user or organization id, and none of the submitted values.
    console.error("addVendorRetailerShop: add_vendor_retailer_shop RPC failed");

    return { fieldErrors: {}, formError: GENERIC_ADD_SHOP_ERROR, values };
  }

  // ---------------------------------------------------------------------------
  // 7. Success
  // ---------------------------------------------------------------------------
  // Reaching here means the transaction committed: the shop and its audit row
  // both exist. The RPC returns void, so there is nothing to unwrap — and no
  // generated id to hand back to a browser that never chose one and has no use
  // for one.

  // Two routes changed. The detail page gained a shop; the directory's shopCount
  // for this Retailer went up by one. Deliberately not revalidatePath("/",
  // "layout"), which is reserved for session transitions where the whole
  // authenticated shell must be dropped. Revalidating before the redirect is what
  // makes the new shop visible on arrival.
  //
  // `relationshipId` is the value validated in section 4, so these paths cannot
  // be poisoned by the submitted string.
  revalidatePath("/retailers");
  revalidatePath(`/retailers/${relationshipId}`);

  // The destination is built only from the validated relationship id. No
  // redirectTo/next form field or search parameter is read anywhere in this
  // module — a caller-supplied redirect target is an open-redirect vector. The
  // `shopCreated=1` flag carries no id and no database value; it only tells the
  // detail page to render a success banner.
  //
  // Outside any try/catch, and nothing follows it: redirect() throws
  // NEXT_REDIRECT, so no success state is returned or could be. Swallowing that
  // throw would turn a committed write into a spurious failure message.
  redirect(`/retailers/${relationshipId}?shopCreated=1`);
}
