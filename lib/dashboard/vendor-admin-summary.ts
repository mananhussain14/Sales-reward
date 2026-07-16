// SERVER-ONLY MODULE.
//
// Like @/lib/auth/vendor-admin-access, this must never be imported into a Client
// Component. It transitively imports `next/headers` (via @/lib/supabase/server),
// which throws at build time if it ever reaches the browser bundle.
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";

/**
 * Read-only dashboard summary for the authorized Vendor organization.
 *
 * Authorization is NOT re-implemented here: it is delegated in full to
 * getVendorSuperAdminAccess(), so this module and the (admin) layout enforce
 * exactly the same rule. This function takes no arguments for the same reason
 * that function does — an organization id accepted from a caller would let a
 * request nominate whose data is counted, which is precisely what the RLS model
 * exists to prevent.
 *
 * Two failure kinds are kept strictly apart:
 *
 *   - Authorization failure  -> a non-authorized status for the WHOLE summary.
 *   - Summary query failure  -> `null` for THAT count only, still authorized.
 *
 * Conflating them would be a security bug in one direction (a failed count must
 * never read as "denied", nor a denial as "zero") and a correctness bug in the
 * other (a broken query must never be reported as a real figure).
 */

/** The lifecycle state required of counted memberships and roles. */
const ACTIVE_STATUS = "ACTIVE";

export type VendorAdminDashboardSummary =
  | {
      status: "authorized";
      organizationName: string;
      // On every count below, `null` means the figure could not be read — it is
      // never zero. 0 is a valid count and is reported as 0.
      activeMemberCount: number | null;
      activeRoleCount: number | null;
      permissionCount: number | null;
      auditEventCount: number | null;
    }
  | { status: "unauthenticated" }
  | { status: "unauthorized" };

/**
 * The only part of a PostgREST response this module reads. Structural by design
 * — it matches what the query builder resolves to without importing the client's
 * generic response types, and keeps both helpers free of `any`.
 */
type CountResult = { count: number | null; error: unknown };

/**
 * Normalizes one PostgREST count response into `number | null`.
 *
 * The raw error is deliberately neither returned nor logged: its message can
 * name tables, columns, and policies, and this value is rendered in a browser.
 * A failed count collapses to `null`, which the UI shows as "Unavailable".
 *
 * `count` is typed `number | null` by the client — null on error, and also
 * whenever no count was requested. Only a real number is passed through, so a
 * null count can never be mistaken for 0.
 */
function toCount(result: CountResult): number | null {
  if (result.error) return null;
  return typeof result.count === "number" ? result.count : null;
}

/**
 * Awaits one count query and reduces every failure mode to `null`.
 *
 * toCount() alone only covers the failures the client REPORTS as `{ error }`.
 * A query can also THROW — a fetch-level TypeError, an aborted request, a DNS
 * or TLS failure — and inside Promise.all a single throw rejects the whole
 * batch, taking down three healthy counts and the page with them. Catching per
 * query keeps one unreachable table from becoming a dashboard-wide outage: that
 * card degrades to "Unavailable" and the rest still render.
 *
 * The thrown value is deliberately not bound or logged: it may carry request
 * URLs, headers, or token material, and this result reaches a browser.
 */
async function safelyReadCount(
  query: PromiseLike<CountResult>,
): Promise<number | null> {
  try {
    return toCount(await query);
  } catch {
    return null;
  }
}

export async function getVendorAdminDashboardSummary(): Promise<VendorAdminDashboardSummary> {
  // ---------------------------------------------------------------------------
  // 1. Authorization — the single source of truth, not repeated here.
  // ---------------------------------------------------------------------------
  const access = await getVendorSuperAdminAccess();

  if (access.status !== "authorized") {
    // Propagated unchanged so the page maps "unauthenticated" -> /login and
    // "unauthorized" -> /access-denied exactly as the layout does. No count
    // query runs on this path.
    return access;
  }

  // The ONLY organization id used below. It comes from the authorized result —
  // never from a parameter, URL, form field, or browser state.
  const organizationId = access.organizationId;

  const supabase = await createClient();

  // ---------------------------------------------------------------------------
  // 2. Counts — head-only, under the caller's own RLS.
  // ---------------------------------------------------------------------------
  // `head: true` sends no rows back: PostgREST answers with the Content-Range
  // count alone. That matters beyond bandwidth — audit rows carry actor ids, IP
  // addresses, user agents, and metadata, and membership rows carry member
  // identity. None of it has any reason to enter a page render.
  //
  // `count: "exact"` is a real COUNT(*), so these are true figures rather than
  // planner estimates. Every query uses the ordinary authenticated client, so
  // each count is computed over exactly the rows the caller's policies already
  // admit; RLS is what makes them correct, not merely permitted.
  //
  // The four are independent, so they run concurrently. Every query is wrapped in
  // safelyReadCount(), which is what makes Promise.all appropriate here: it
  // rejects as soon as ANY input rejects, so one throwing query would otherwise
  // discard three good counts and fail the whole page. Wrapped, each promise
  // settles to `number | null` and can no longer reject at all — the failure is
  // contained to its own card.
  const [activeMemberCount, activeRoleCount, permissionCount, auditEventCount] =
    await Promise.all([
      // Scoped to the authorized organization. The organization_members policy
      // independently restricts this to organizations where the caller holds
      // ORGANIZATION_MEMBERS_READ or VENDOR_SUPER_ADMIN — the explicit filter and
      // the policy agree rather than either standing alone.
      safelyReadCount(
        supabase
          .from("organization_members")
          .select("*", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq("status", ACTIVE_STATUS),
      ),

      // roles and permissions are the GLOBAL catalogue — the rows carry no
      // organization_id, so there is nothing to scope them by. Their policies gate
      // the catalogue wholesale on RBAC_READ or VENDOR_SUPER_ADMIN held in at
      // least one of the caller's own organizations.
      safelyReadCount(
        supabase
          .from("roles")
          .select("*", { count: "exact", head: true })
          .eq("status", ACTIVE_STATUS),
      ),

      // public.permissions has no status column — the catalogue is counted whole.
      safelyReadCount(
        supabase.from("permissions").select("*", { count: "exact", head: true }),
      ),

      // The audit_logs policy already excludes null-organization rows entirely and
      // requires AUDIT_LOGS_READ or VENDOR_SUPER_ADMIN per row's organization.
      // This filter narrows to the authorized organization on top of that.
      safelyReadCount(
        supabase
          .from("audit_logs")
          .select("*", { count: "exact", head: true })
          .eq("organization_id", organizationId),
      ),
    ]);

  // Already reduced to `number | null` above — whether by a reported error or a
  // caught throw. A failing count degrades that one card to "Unavailable"; it can
  // never revoke access, because authorization was decided above and no branch
  // here revisits it.
  return {
    status: "authorized",
    organizationName: access.organizationName,
    activeMemberCount,
    activeRoleCount,
    permissionCount,
    auditEventCount,
  };
}
