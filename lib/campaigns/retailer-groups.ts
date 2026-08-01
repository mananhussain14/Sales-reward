// SERVER-ONLY MODULE.
//
// The six Retailer-group operations, each a thin wrapper over one SECURITY DEFINER RPC
// called under the CALLER'S OWN token (the ordinary publishable-key server client — never
// service-role; this module does not import one).
//
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE. Every RPC derives the Vendor itself from
// auth.uid() through get_vendor_super_admin_context() and then requires
// RETAILER_GROUPS_MANAGE. There is no Vendor organization id, membership id, role id or
// permission constant in this file, deliberately: a TypeScript copy of those conditions
// would be a second definition free to drift from the migrations.
//
// THE ONLY IDS THAT TRAVEL ARE ADDRESSES. A group id and vendor_retailers relationship
// ids are passed. Each is filtered in SQL on the id AND the derived Vendor, so an id
// belonging to another Vendor selects nothing and is refused identically to "you are not
// authorized".
//
// NO DIRECT TABLE ACCESS. This module contains zero `.from(` calls. Both group tables
// have RLS enabled with zero policies and no privilege granted to any browser role, so
// the RPCs are the only way in — and that is intentional.
//
// ERROR DISCIPLINE. Supabase/PostgREST errors are never returned or rendered — their
// messages can name tables, columns, functions and policies. Only the SQLSTATE is
// inspected, and only to distinguish outcomes the UI must report differently.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeGroupMembers,
  normalizeGroupMembershipOutcome,
  normalizeRetailerGroups,
  type GroupMembershipOutcome,
  type RetailerGroup,
  type RetailerGroupMember,
} from "@/lib/campaigns/campaign-normalization";

const LIST_GROUPS_RPC = "list_vendor_retailer_groups" as const;
const GET_GROUP_RPC = "get_vendor_retailer_group" as const;
const LIST_MEMBERS_RPC = "list_vendor_retailer_group_members" as const;
const CREATE_GROUP_RPC = "create_vendor_retailer_group" as const;
const UPDATE_GROUP_RPC = "update_vendor_retailer_group" as const;
const SET_MEMBERS_RPC = "set_vendor_retailer_group_members" as const;

/** SQLSTATEs the group RPCs raise. Only the CODE is ever read. */
const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const NOT_IN_PREREQUISITE_STATE = "55000";

/** Sanitized operator logging. No ids, names, or error objects. */
function logGroupFailure(operation: string, category: string): void {
  console.error(`[retailer-groups] ${operation} failed: ${category}`);
}

export type RetailerGroupsResult =
  | { status: "ok"; groups: RetailerGroup[] }
  /** Not an authorized Vendor Super Admin with RETAILER_GROUPS_MANAGE. */
  | { status: "denied" }
  | { status: "unavailable" };

export type RetailerGroupResult =
  | { status: "ok"; group: RetailerGroup }
  /** Unknown id, or another Vendor's — the database does not distinguish them. */
  | { status: "not-found" }
  | { status: "denied" }
  | { status: "unavailable" };

export type GroupMembersResult =
  | { status: "ok"; members: RetailerGroupMember[] }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * The outcome of any group WRITE.
 *
 * `duplicate` and `invalid` are distinct because the UI reports them against different
 * things — a name the operator must change, versus a value they must correct — while
 * `denied` covers an unauthorized caller, a foreign group id and a foreign relationship id
 * identically, exactly as the database does.
 */
export type GroupWriteResult =
  | { status: "ok" }
  | { status: "duplicate" }
  /** The database rejected a value. Reachable from a tampered call. */
  | { status: "invalid" }
  /** A suspended Retailer or relationship cannot be added to a group. */
  | { status: "not-eligible" }
  | { status: "denied" }
  | { status: "unavailable" };

function classifyWriteError(error: { code?: string }): GroupWriteResult {
  if (error.code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
  if (error.code === UNIQUE_VIOLATION) return { status: "duplicate" };
  if (error.code === NOT_IN_PREREQUISITE_STATE) return { status: "not-eligible" };
  if (error.code === CHECK_VIOLATION) return { status: "invalid" };
  logGroupFailure("write", "rpc-error");
  return { status: "unavailable" };
}

/**
 * Runs one RPC and returns its raw data, or a classified failure.
 *
 * Promise.resolve() because the PostgREST builder is a thenable, not a real Promise. A
 * throw — fetch-level TypeError, aborted request, DNS or TLS failure — is deliberately
 * not bound, inspected or logged: the thrown value may carry request URLs, headers or
 * token material.
 */
async function runRead(
  rpcName: string,
  params?: Record<string, unknown>,
): Promise<{ status: "ok"; data: unknown } | { status: "denied" } | { status: "unavailable" }> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    params === undefined ? supabase.rpc(rpcName) : supabase.rpc(rpcName, params),
  ).catch(() => null);

  if (result === null) {
    logGroupFailure(rpcName, "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
    logGroupFailure(rpcName, "rpc-error");
    return { status: "unavailable" };
  }
  return { status: "ok", data: result.data as unknown };
}

/**
 * Every Retailer group this Vendor owns.
 *
 * REQUEST-SCOPED CACHE ONLY. React allocates a fresh cache per request, so a page and its
 * children resolve it once. It is NOT a persistent cache and must never become one: an
 * authorization-bearing result belongs to exactly one caller for exactly one request. The
 * function takes no arguments, so there is no cache key — deliberately.
 */
export const getRetailerGroups = cache(
  async function getRetailerGroups(): Promise<RetailerGroupsResult> {
    const result = await runRead(LIST_GROUPS_RPC);
    if (result.status !== "ok") return result;

    const normalized = normalizeRetailerGroups(result.data);
    if (normalized.status === "malformed") {
      // The reason names only field names — never values — so it is safe to log.
      logGroupFailure("list", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", groups: normalized.groups };
  },
);

/** One group's header. Zero rows means unknown OR foreign; both become `not-found`. */
export async function getRetailerGroup(groupId: string): Promise<RetailerGroupResult> {
  const result = await runRead(GET_GROUP_RPC, { p_group_id: groupId });
  if (result.status !== "ok") return result;

  const normalized = normalizeRetailerGroups(result.data);
  if (normalized.status === "malformed") {
    logGroupFailure("get", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  const group = normalized.groups[0];
  if (group === undefined) return { status: "not-found" };
  return { status: "ok", group };
}

/** One group's LIVE members. Retired memberships are not returned by the RPC. */
export async function getRetailerGroupMembers(
  groupId: string,
): Promise<GroupMembersResult> {
  const result = await runRead(LIST_MEMBERS_RPC, { p_group_id: groupId });
  if (result.status !== "ok") return result;

  const normalized = normalizeGroupMembers(result.data);
  if (normalized.status === "malformed") {
    logGroupFailure("members", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", members: normalized.members };
}

/** Creates one empty group. The new id IS returned — the caller redirects to it. */
export async function createRetailerGroup(input: {
  name: string;
  description: string | null;
}): Promise<GroupWriteResult & { groupId?: string }> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(CREATE_GROUP_RPC, {
      p_name: input.name,
      p_description: input.description,
    }),
  ).catch(() => null);

  if (result === null) {
    logGroupFailure("create", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    return classifyWriteError(result.error as { code?: string });
  }

  const groupId = typeof result.data === "string" ? result.data.toLowerCase() : undefined;
  return { status: "ok", groupId };
}

/**
 * Renames, re-describes, or archives/restores one group.
 *
 * The RPC returns `changed: false` for a submit that altered nothing and writes no audit
 * row for it. That distinction is carried through so the UI can say "no changes to save"
 * rather than claiming a save that did not happen.
 */
export async function updateRetailerGroup(input: {
  groupId: string;
  name: string;
  description: string | null;
  status: "ACTIVE" | "ARCHIVED" | null;
}): Promise<GroupWriteResult & { changed?: boolean }> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(UPDATE_GROUP_RPC, {
      p_group_id: input.groupId,
      p_name: input.name,
      p_description: input.description,
      p_status: input.status,
    }),
  ).catch(() => null);

  if (result === null) {
    logGroupFailure("update", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    return classifyWriteError(result.error as { code?: string });
  }

  const rows = result.data as unknown;
  const changed =
    Array.isArray(rows) && typeof rows[0] === "object" && rows[0] !== null
      ? (rows[0] as Record<string, unknown>).changed === true
      : undefined;

  return { status: "ok", changed };
}

/**
 * ATOMIC REPLACEMENT of a group's live membership.
 *
 * The counts come back from the database rather than being derived from what was sent:
 * the caller cannot know how many rows actually moved, because a concurrent edit may have
 * changed the starting set. Reporting the server's numbers is the only honest option.
 */
export async function setRetailerGroupMembers(
  groupId: string,
  vendorRetailerIds: string[],
): Promise<GroupWriteResult & { outcome?: GroupMembershipOutcome }> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(SET_MEMBERS_RPC, {
      p_group_id: groupId,
      p_vendor_retailer_ids: vendorRetailerIds,
    }),
  ).catch(() => null);

  if (result === null) {
    logGroupFailure("set-members", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    return classifyWriteError(result.error as { code?: string });
  }

  const normalized = normalizeGroupMembershipOutcome(result.data as unknown);
  if (normalized.status === "malformed") {
    // THE WRITE COMMITTED. A malformed response to a successful mutation is a READ
    // problem, and reporting it as a failure would invite a retry of something that has
    // already happened. The caller re-reads canonical state instead.
    logGroupFailure("set-members", `malformed:${normalized.reason}`);
    return { status: "ok" };
  }
  return { status: "ok", outcome: normalized.outcome };
}
