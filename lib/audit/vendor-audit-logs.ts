// SERVER-ONLY MODULE.
//
// Like @/lib/auth/vendor-admin-access, this must never be imported into a Client
// Component. It transitively imports `next/headers` (via @/lib/supabase/server),
// which throws at build time if it ever reaches the browser bundle.
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";

/**
 * Read-only audit history for the authorized Vendor organization.
 *
 * Authorization is delegated in full to getVendorSuperAdminAccess() — not
 * re-implemented — and this function takes no arguments, so no caller can
 * nominate which organization's history is read, whose actions are listed, or
 * how many rows come back.
 *
 * Audit rows are the most sensitive table in the schema: they record who did
 * what, from which IP, with which user agent, and carry arbitrary jsonb
 * metadata. This module is deliberately narrow about what it even SELECTS — not
 * merely what it renders — because a column that is never read cannot leak from
 * a page, a payload, a log, or a future refactor of this file.
 *
 * Two failure kinds stay strictly apart, as in the dashboard summary, the member
 * directory, and the RBAC catalogue:
 *
 *   - Authorization failure -> a non-authorized status for the WHOLE page.
 *   - Data query failure    -> `auditLogs: null`, still authorized.
 */

/**
 * The newest N records. The audit table grows without bound — it is append-only
 * and never pruned — so an unfiltered read would get slower every day and
 * eventually pull an unbounded result set into a render. The
 * audit_logs_org_created_idx index on (organization_id, created_at desc) serves
 * exactly this shape, so the read stays a bounded index scan.
 */
const AUDIT_LOG_LIMIT = 100;

/** Shown for a row whose actor_profile_id is null — a non-human action. */
const SYSTEM_ACTOR_DISPLAY_NAME = "System";

/**
 * Defensive floor, used ONLY when a referenced actor profile cannot be resolved.
 *
 * This is reachable, unlike most such floors: actor_profile_id is ON DELETE SET
 * NULL, but the profiles RLS policy admits only the caller's own row and members
 * of organizations they administer. An action taken by someone outside that set
 * therefore leaves a row whose actor exists but is not readable here. Naming that
 * "Unknown user" is the honest answer — the alternative would be inventing an
 * identity or silently dropping an audit record, and dropping records from an
 * audit log is the one thing an audit log must never do.
 */
const UNRESOLVED_ACTOR_DISPLAY_NAME = "Unknown user";

/** Shown when a stored timestamp cannot be parsed. Defensive; see formatTimestamp. */
const UNKNOWN_TIMESTAMP = "Unknown time";

/**
 * Fixed locale AND fixed time zone, so the rendered string depends on neither the
 * host machine's locale nor its TZ environment. A server that formats dates in
 * whatever locale it happens to boot with produces output that silently changes
 * between machines; an audit trail is the last place that should happen.
 *
 * UTC is chosen over the viewer's zone because this is a Server Component with no
 * access to the reader's zone, and guessing would be worse than being explicit.
 * The page labels the column accordingly.
 */
const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** One rendered audit row. Deliberately carries no ids and no request metadata. */
export type VendorAuditLog = {
  /** Preformatted, deterministic, UTC. See TIMESTAMP_FORMATTER. */
  occurredAt: string;
  /** A resolved profile name, "System", or the defensive "Unknown user". */
  actorDisplayName: string;
  /** Humanized from audit_logs.action. */
  action: string;
  /**
   * Humanized from audit_logs.entity_type. NOT nullable: the column is NOT NULL
   * and check-constrained non-empty, so every row has one.
   */
  entityType: string;
};

export type VendorAuditLogsResult =
  | {
      status: "authorized";
      organizationName: string;
      /**
       * `[]` means the organization genuinely has no audit records — the expected
       * state today, since nothing writes to this table yet.
       * `null` means the history could not be loaded — never treat it as empty.
       */
      auditLogs: VendorAuditLog[] | null;
    }
  | { status: "unauthenticated" }
  | { status: "unauthorized" };

// Shapes of the columns read from each table, matching the migrations exactly.
//
// audit_logs deliberately does NOT select: id and organization_id (internal),
// entity_id (an opaque identifier of the touched row), metadata (arbitrary jsonb
// whose contents are unknown and unvetted — the migration constrains it to be an
// object and nothing more, so there is no "small explicitly safe readable field"
// to whitelist), ip_address, or user_agent. The last two are personal data about
// the actor's device and network, and no part of this page needs them.
type AuditLogRow = {
  actor_profile_id: string | null;
  action: string;
  entity_type: string;
  created_at: string;
};

/** Only the two name columns — no email (which lives in auth.users, never queried), no status. */
type ActorProfileRow = { id: string; first_name: string; last_name: string };

/**
 * Thrown when a read returns a PostgREST error, so the single catch below can
 * treat reported errors and thrown errors identically. The Supabase error is
 * deliberately NOT attached: it can name tables, columns, and policies, and
 * nothing here may reach a browser.
 */
class AuditLogsUnavailableError extends Error {}

/** Rejects a reported PostgREST error; otherwise yields the rows (never null). */
function unwrap<Row>(result: { data: Row[] | null; error: unknown }): Row[] {
  if (result.error || !result.data) throw new AuditLogsUnavailableError();
  return result.data;
}

/**
 * Renders a stored timestamp deterministically, or a readable floor.
 *
 * created_at is NOT NULL timestamptz, so an unparseable value is not a branch the
 * schema permits — but Date silently yields NaN rather than throwing, and
 * "Invalid Date" printed into an audit table would be worse than saying so.
 */
function formatTimestamp(createdAt: string): string {
  const occurredAt = new Date(createdAt);
  if (Number.isNaN(occurredAt.getTime())) return UNKNOWN_TIMESTAMP;

  return TIMESTAMP_FORMATTER.format(occurredAt);
}

/**
 * Turns a stored code into a readable label: "MEMBER_INVITED" -> "Member
 * invited", "organization_member" -> "Organization member".
 *
 * This is a general humanizer rather than a lookup table, and that is a
 * deliberate, temporary choice: nothing writes to audit_logs yet, so the action
 * and entity_type vocabularies do not exist to be mapped. The columns are plain
 * `text` with only a non-empty check, so there is no enum to enumerate either.
 * Once the module that writes audit rows defines its vocabulary, this should be
 * replaced by an explicit Record<string, string> map — the same approach
 * StatusBadge takes — so that an unrecognized code renders a safe fallback
 * rather than a prettied-up internal string.
 *
 * Until then this at least guarantees the page never prints raw SCREAMING_SNAKE
 * database values at the reader.
 */
function toReadableLabel(value: string): string {
  const words = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  if (words.length === 0) return value.trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Joins the stored name parts into one display string, ignoring blank parts. */
function buildActorDisplayName(profile: ActorProfileRow): string {
  const displayName = [profile.first_name, profile.last_name]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");

  // public.profiles constrains both name columns NOT NULL and non-empty after
  // trimming, so an empty join is not reachable today; it falls back to the same
  // floor an unreadable profile gets rather than rendering a blank actor.
  return displayName || UNRESOLVED_ACTOR_DISPLAY_NAME;
}

/**
 * Loads the newest audit records and resolves their actors.
 *
 * TWO queries TOTAL, regardless of row count — never one per audit row. The
 * second is a single set-based read keyed by the actor ids collected from the
 * first, and the joining happens in memory here.
 *
 * The two are necessarily sequential (the second needs ids the first returns), so
 * there is nothing to parallelize; what matters is that neither scales with the
 * number of rows rendered.
 */
async function loadAuditLogs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
): Promise<VendorAuditLog[]> {
  // ---------------------------------------------------------------------------
  // 1. The newest records of the authorized organization.
  // ---------------------------------------------------------------------------
  // The explicit organization_id filter and RLS agree rather than either standing
  // alone: audit_logs_select_authorized independently requires the row's
  // organization_id to be non-null AND the caller to hold AUDIT_LOGS_READ or
  // VENDOR_SUPER_ADMIN in that organization. The filter here narrows to the one
  // organization the caller was authorized for; the policy is what makes any of
  // it legal.
  const auditRows = unwrap<AuditLogRow>(
    await supabase
      .from("audit_logs")
      .select("actor_profile_id, action, entity_type, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(AUDIT_LOG_LIMIT),
  );

  // No records is a legitimate answer — and today the expected one. It also means
  // the `.in()` below would receive an empty array, which PostgREST would turn
  // into a match-nothing filter: a wasted round trip to learn what is already
  // known.
  if (auditRows.length === 0) return [];

  // ---------------------------------------------------------------------------
  // 2. Actor profiles — one batch, never one query per row.
  // ---------------------------------------------------------------------------
  // Null actors (system actions) are filtered out before the query, and the ids
  // are deduplicated because `.in()` takes a set and one person will appear
  // across many rows. If every row in this page is a system action, the set is
  // empty and the query is skipped entirely rather than called with `[]`.
  const actorIds = [
    ...new Set(
      auditRows
        .map((row) => row.actor_profile_id)
        .filter((actorId): actorId is string => actorId !== null),
    ),
  ];

  const actorProfiles =
    actorIds.length === 0
      ? []
      : unwrap<ActorProfileRow>(
          await supabase
            .from("profiles")
            .select("id, first_name, last_name")
            .in("id", actorIds),
        );

  // ---------------------------------------------------------------------------
  // 3. Assemble — ids are used here and then discarded.
  // ---------------------------------------------------------------------------
  const actorNamesById = new Map(
    actorProfiles.map((profile) => [profile.id, buildActorDisplayName(profile)]),
  );

  return auditRows.map((row) => ({
    occurredAt: formatTimestamp(row.created_at),
    actorDisplayName:
      row.actor_profile_id === null
        ? SYSTEM_ACTOR_DISPLAY_NAME
        : (actorNamesById.get(row.actor_profile_id) ?? UNRESOLVED_ACTOR_DISPLAY_NAME),
    action: toReadableLabel(row.action),
    entityType: toReadableLabel(row.entity_type),
  }));
  // Already newest-first from the query's ORDER BY; the mapping preserves order,
  // so no re-sort is needed and none is done.
}

export async function getVendorAuditLogs(): Promise<VendorAuditLogsResult> {
  // ---------------------------------------------------------------------------
  // Authorization — the single source of truth, not repeated here.
  // ---------------------------------------------------------------------------
  const access = await getVendorSuperAdminAccess();

  if (access.status !== "authorized") {
    // Propagated unchanged so the page maps "unauthenticated" -> /login and
    // "unauthorized" -> /access-denied. No audit query runs on this path.
    return access;
  }

  const supabase = await createClient();

  try {
    return {
      status: "authorized",
      organizationName: access.organizationName,
      // The ONLY organization id used: from the authorized result, never from a
      // parameter, URL, form field, or browser state.
      auditLogs: await loadAuditLogs(supabase, access.organizationId),
    };
  } catch {
    // One catch for every failure mode — a reported PostgREST error (rethrown as
    // AuditLogsUnavailableError above) and a genuine throw (fetch-level
    // TypeError, aborted request, DNS or TLS failure) alike. The value is not
    // bound or logged: it may carry request URLs, headers, or token material.
    //
    // Still `status: "authorized"` — a data failure must never read as a denial,
    // and can never grant access either, since authorization was settled above.
    // It is never converted to `[]`: "we could not read the history" and "this
    // organization has taken no recorded actions" are opposite claims, and on an
    // audit page confusing them would be a serious misstatement.
    return {
      status: "authorized",
      organizationName: access.organizationName,
      auditLogs: null,
    };
  }
}
