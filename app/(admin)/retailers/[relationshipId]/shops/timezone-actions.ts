"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { hasIanaTimeZoneShape } from "@/lib/reference/iana-timezone-shape";
import type {
  ShopTimeZoneState,
  ShopTimeZoneValues,
} from "@/app/(admin)/retailers/[relationshipId]/shops/timezone-state";

/**
 * Server Action backing the Shop Time Zone form.
 *
 * The write itself is NOT performed here. This action validates, authorizes, and
 * then calls public.set_retailer_shop_timezone() — one SECURITY DEFINER RPC that
 * updates the shop and writes its audit record in a single transaction. There is
 * deliberately no table update in this module, and there could not be one:
 * retailer_shops grants `authenticated` SELECT and nothing else, audit_logs grants
 * it nothing at all and has been append-only since migration 20260816090000, and
 * both are RLS default-deny for writes. The RPC is the one audited door.
 *
 * TWO values are sent, and NEITHER is authorization:
 *   * `shopId` says WHICH of the caller's own shops to configure. The RPC derives
 *     the Vendor from auth.uid() and joins the shop through vendor_retailers to
 *     it, so a shop id belonging to another Vendor selects nothing there and is
 *     refused with the same byte-identical exception as an id that does not
 *     exist.
 *   * `timezoneName` is the value to store, and the DATABASE decides whether it
 *     is acceptable.
 *
 * Nothing else about the tenant or the actor is sent. The RPC's signature has no
 * Vendor organization id, Retailer organization id, relationship id, actor or
 * profile id, role code, permission code, or resolved UTC offset, because any
 * such parameter is a value the caller controls — and a caller-controlled tenant
 * id is exactly how a cross-tenant write happens.
 *
 * The AUTHENTICATED server client is used, never the service role. The whole
 * point of the RPC is that it resolves the caller from their own token; handing
 * it a service-role connection would erase the actor the audit row records.
 *
 * Because of the "use server" directive above, `setShopTimeZone` must be this
 * module's only runtime export — every export here is exposed as a callable
 * server endpoint, so Next.js rejects anything that is not an async function. The
 * state types therefore live in ./timezone-state; `import type` above is erased
 * at compile time and adds no export.
 */

/**
 * The single message used for every failure that is not a field problem.
 *
 * The raw Supabase/PostgreSQL error is never forwarded. It can name schemas,
 * tables, columns, constraints, functions and policies — and in this specific
 * case it demonstrably does: a CHECK violation on retailer_shops emits a DETAIL
 * line containing the ENTIRE failing row, including the shop id, the Retailer
 * organization id, the shop name and every address column. Forwarding that would
 * leak more than the page ever shows.
 *
 * Crucially, this ONE message covers all of: a malformed shop id, a nonexistent
 * one, one belonging to another Vendor, a missing permission, a suspended profile
 * or membership, and a database outage. Collapsing them is deliberate — the RPC
 * already refuses every addressing case with a single byte-identical exception so
 * it cannot be used as an existence oracle, and distinguishing them here would
 * reintroduce exactly the disclosure the database went out of its way to prevent.
 */
const GENERIC_TIMEZONE_ERROR =
  "We couldn't save the time zone. Please check the value and try again.";

/**
 * The field message for a value the database will not accept.
 *
 * Shown for both shape failures caught here and catalogue failures caught by the
 * database, because from an operator's point of view they are the same mistake —
 * "that is not a time zone I can use" — and the fix is identical.
 */
const INVALID_TIMEZONE_MESSAGE =
  "Enter a valid IANA time zone in Region/City form, for example Asia/Dubai. " +
  "Fixed offsets such as UTC+3 or Etc/GMT+3 are not accepted.";

const MISSING_TIMEZONE_MESSAGE = "Enter the shop's IANA time zone.";

/**
 * SQLSTATE 23514 (check_violation) is the ONE outcome specific enough to blame a
 * field: both `retailer_shops_timezone_name_shape` and
 * retailer_shops_assert_timezone() raise it, and so does the RPC's own
 * "a shop time zone is required". Every other SQLSTATE — 42501 above all — is a
 * refusal that must stay generic. The CODE is matched, never a message string.
 */
const CHECK_VIOLATION = "23514";

/** Shape of the single row public.set_retailer_shop_timezone returns. */
type SetShopTimeZoneRow = {
  shop_id: string;
  timezone_name: string;
  changed: boolean;
};

function failure(
  values: ShopTimeZoneValues,
  formError: string | null,
  fieldErrors: ShopTimeZoneState["fieldErrors"] = {},
): ShopTimeZoneState {
  return {
    fieldErrors,
    formError,
    savedTimezoneName: null,
    unchanged: false,
    values,
  };
}

export async function setShopTimeZone(
  _previous: ShopTimeZoneState,
  formData: FormData,
): Promise<ShopTimeZoneState> {
  // The three form inputs. Read as strings and never trusted: `shopId` and
  // `relationshipId` are addresses, and the zone is validated below and again by
  // the database.
  const shopId = String(formData.get("shopId") ?? "");
  const relationshipId = String(formData.get("relationshipId") ?? "");
  // NOT trimmed. The database requires the stored value to equal btrim() of
  // itself, so silently trimming here would let the form accept a value the
  // database refuses — and would hide the operator's actual mistake.
  const timezoneName = String(formData.get("timezoneName") ?? "");

  const values: ShopTimeZoneValues = { timezoneName };

  // ---------------------------------------------------------------------------
  // Authorization — the same gate the surrounding pages use, not a second one.
  // ---------------------------------------------------------------------------
  // This is a fast, honest refusal for a caller who is not a Vendor Super Admin
  // at all. It is NOT the security boundary: the RPC re-derives the Vendor from
  // auth.uid() and checks SHOP_TIMEZONE_MANAGE itself, and would refuse this call
  // even if the check below were deleted.
  const access = await getVendorSuperAdminAccess();

  if (access.status !== "authorized") {
    return failure(values, GENERIC_TIMEZONE_ERROR);
  }

  // ---------------------------------------------------------------------------
  // Input validation — fast feedback only; the database remains the authority.
  // ---------------------------------------------------------------------------
  if (timezoneName.length === 0) {
    return failure(values, null, { timezoneName: MISSING_TIMEZONE_MESSAGE });
  }

  if (!hasIanaTimeZoneShape(timezoneName)) {
    return failure(values, null, { timezoneName: INVALID_TIMEZONE_MESSAGE });
  }

  // A shop id that is not a plausible identifier is refused before a round trip.
  // Not a security check — the RPC refuses a foreign id regardless — just a way
  // to avoid sending an obviously broken form.
  if (shopId.length === 0) {
    return failure(values, GENERIC_TIMEZONE_ERROR);
  }

  // ---------------------------------------------------------------------------
  // The write — one RPC, under the caller's own token.
  // ---------------------------------------------------------------------------
  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc("set_retailer_shop_timezone", {
      p_retailer_shop_id: shopId,
      p_timezone_name: timezoneName,
    })
    .maybeSingle<SetShopTimeZoneRow>();

  if (error) {
    // The only code mapped to a field. Everything else — 42501 for an
    // unauthorized caller, an unknown shop or a foreign shop alike — falls
    // through to the one generic message.
    if (error.code === CHECK_VIOLATION) {
      return failure(values, null, { timezoneName: INVALID_TIMEZONE_MESSAGE });
    }
    return failure(values, GENERIC_TIMEZONE_ERROR);
  }

  if (!data) {
    // A successful call always returns exactly one row. No row means something
    // unexpected happened, and an unexpected outcome is reported as a failure
    // rather than optimistically as success.
    return failure(values, GENERIC_TIMEZONE_ERROR);
  }

  // Re-render the detail page so the shop list shows the stored value rather than
  // the pre-submission one.
  revalidatePath(`/retailers/${relationshipId}`);

  return {
    fieldErrors: {},
    formError: null,
    // The AUTHORITATIVE stored value from the RPC, not the submitted string.
    savedTimezoneName: data.timezone_name,
    unchanged: !data.changed,
    values: { timezoneName: data.timezone_name },
  };
}
