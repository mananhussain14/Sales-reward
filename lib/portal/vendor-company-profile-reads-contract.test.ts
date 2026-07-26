/**
 * STATIC CONTRACT GUARDS for the mobile Vendor company/profile self-read
 * (supabase/migrations/20260806090000_mobile_vendor_company_profile_reads.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * lib/members/vendor-user-reads-contract.test.ts, lib/audit/vendor-audit-log-reads-contract.test.ts
 * and lib/dashboard/vendor-dashboard-summary-contract.test.ts. They read the SQL and assert
 * structural properties that a careless later edit could silently break.
 *
 * They do NOT execute the function. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_company_profile_reads_test.sql — pgTAP, covering every denial,
 * self isolation between two administrators of the SAME Vendor, tenant isolation, the
 * lowest-organization-id multi-Vendor rule, the ACTIVE-role filter, the exact permission
 * requirement (including which permissions are deliberately NOT required), agreement with
 * list_vendor_users(), and the PortalContext non-duplication relationship. It requires Docker and
 * is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of properties
 * decidable from the source, and which would be a SECURITY or CONTRACT regression rather than a
 * behavioural one:
 *
 *   1. The migration is new, forward-only, and edits no applied migration — get_my_portal_context()
 *      in particular is not modified, because both clients already consume it.
 *   2. It adds one function and nothing else — no table, policy, index, grant on a table, seed row
 *      or write of any kind.
 *   3. The function accepts NO input at all: no identity, profile selector, membership selector,
 *      organization selector, tenant, role or permission argument.
 *   4. It is a correctly-hardened, read-only SECURITY DEFINER function.
 *   5. Privileges are explicit and exact: authenticated only, never anon, never PUBLIC, never
 *      service_role.
 *   6. The output is exactly two personal fields — text and text[] — with no company field, no
 *      status, no timestamp, no id, no JSON and no sensitive field.
 *   7. Authorization is DELEGATED to the existing helpers, requires the real seeded RBAC_READ
 *      permission, and fails closed with one generic refusal.
 *   8. The read is a SELF read inside ONE tenant: both predicates are derived, never parameters.
 *   9. It does not duplicate what get_my_portal_context() already returns.
 *  10. The web is untouched — there is no Settings/company/profile route to change, and the
 *      Settings nav item remains a disabled placeholder.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const MIGRATION_NAME = "20260806090000_mobile_vendor_company_profile_reads.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose discusses the very patterns some of these tests forbid (it
 * explains why an organization id must not be an input, and it names every field it deliberately
 * does not return). Asserting against the raw text would match those explanations and pass — or
 * fail — for the wrong reason. Every structural assertion below runs against executable SQL only.
 */
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/** The one function this migration creates. */
const READ = "get_my_vendor_profile";

/**
 * The exact output contract, in order. Both fields are PERSONAL data about the caller; the
 * company half of the screen is served by get_my_portal_context() and appears here nowhere.
 */
const OUTPUT_COLUMNS = ["administrator_display_name", "administrator_role_names"] as const;

/**
 * The `create function` statement, from its CREATE through the closing `$$;` of its body.
 * Everything asserted about the function is asserted against this slice rather than the whole
 * file, so a clause in the header prose can never satisfy an assertion about the body.
 */
function statement(): string {
  const start = CODE.search(new RegExp(`create\\s+function\\s+public\\.${READ}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `migration must create public.${READ}`);
  const end = CODE.indexOf("$$;", start);
  assert.notEqual(end, -1, `public.${READ} must have a $$-quoted body`);
  return CODE.slice(start, end);
}

/** The `returns table (...)` declaration entries, as [name, type] pairs, in order. */
function outputContract(): [string, string][] {
  const match = statement().match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  assert.ok(match, `public.${READ} must declare a returns table (...) contract`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().split(/\s+/))
    .filter((parts) => parts[0]?.length > 0)
    .map((parts) => [parts[0], parts.slice(1).join(" ")] as [string, string]);
}

/** The `return query` slice of the body — the statement that actually produces the row. */
function resultQuery(): string {
  const body = statement();
  const start = body.search(/return\s+query/i);
  assert.notEqual(start, -1, `${READ} must produce its result with return query`);
  return body.slice(start);
}

// ============================================================================
// Migration hygiene
// ============================================================================
describe("Vendor company profile reads — migration hygiene", () => {
  test("1. is a NEW migration, ordered after every dependency it names", () => {
    const applied = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    assert.ok(
      applied.includes(MIGRATION_NAME),
      "the migration file must exist in supabase/migrations",
    );

    // Ordered after its DEPENDENCIES, not last overall. "Newest in the repository" is a property
    // of one moment in time, not of this migration, and asserting it would fail the moment any
    // unrelated migration landed. What matters is that every object this migration references
    // already exists when it applies.
    const DEPENDENCIES = [
      "20260716124419_core_identity_tables.sql",
      "20260716125559_vendor_admin_rbac.sql",
      "20260716131104_vendor_admin_authorization_helpers.sql",
      "20260716131930_vendor_admin_rls_read_policies.sql",
      "20260716133023_seed_vendor_admin_roles_permissions.sql",
      "20260717083515_vendor_super_admin_context.sql",
    ];

    for (const dependency of DEPENDENCIES) {
      assert.ok(applied.includes(dependency), `declared dependency ${dependency} is missing`);
      assert.ok(
        dependency < MIGRATION_NAME,
        `${MIGRATION_NAME} must sort after its dependency ${dependency}`,
      );
    }
  });

  test("2. adds one function and changes nothing that already exists", () => {
    const forbidden: [RegExp, string][] = [
      [/\bcreate\s+table\b/i, "create table"],
      [/\balter\s+table\b/i, "alter table"],
      [/\balter\s+policy\b/i, "alter policy"],
      [/\balter\s+function\b/i, "alter function"],
      [/\bdrop\s+/i, "drop"],
      [/\bcreate\s+policy\b/i, "create policy"],
      [/\bcreate\s+trigger\b/i, "create trigger"],
      [/\bcreate\s+index\b/i, "create index"],
      [/\bcreate\s+or\s+replace\b/i, "create or replace"],
      [/\binsert\s+into\b/i, "insert into"],
      [/\bupdate\s+public\./i, "update"],
      [/\bdelete\s+from\b/i, "delete from"],
      [/\btruncate\b/i, "truncate"],
      [/\bexecute\s+format\b/i, "dynamic SQL"],
      // The one that matters most for a "make the mobile read easier" regression: a direct table
      // grant would let a client bypass this function entirely.
      [/\bgrant\b[^;]*\bon\s+table\b/i, "grant on table"],
      [/\bgrant\b[^;]*\bon\s+all\s+tables\b/i, "grant on all tables"],
      [/\bsecurity\s+invoker\b/i, "security invoker"],
      // RLS must not be relaxed anywhere to make this read possible; it is SECURITY DEFINER
      // precisely so that no policy has to change.
      [/\bdisable\s+row\s+level\s+security\b/i, "disable row level security"],
      [/\bforce\s+row\s+level\s+security\b/i, "force row level security"],
    ];

    for (const [pattern, label] of forbidden) {
      assert.ok(
        !pattern.test(CODE),
        `migration must not contain \`${label}\` — it adds one function and changes nothing that exists`,
      );
    }

    const creates = CODE.match(/\bcreate\s+function\b/gi) ?? [];
    assert.equal(creates.length, 1, "exactly one function is created");
  });

  test("3. does not modify get_my_portal_context, and does not call it either", () => {
    // The whole architectural decision of this milestone is that PortalContext keeps serving the
    // company half of the screen UNCHANGED. Editing it would risk a live contract that both the
    // web sign-in path and a shipped Flutter binary already consume; an additive function is
    // strictly safer.
    assert.ok(
      !/\b(create|alter|drop)\b[^;]*get_my_portal_context/i.test(CODE),
      "get_my_portal_context() must not be created, altered or dropped by this migration",
    );

    // Nor does the new function call it. The two contracts are COMPOSED BY THE CLIENT — chaining
    // them in SQL would make one read's availability depend on the other's, and would put the
    // organization name back into this function's result by the back door.
    assert.ok(
      !statement().includes("get_my_portal_context"),
      "the self-read must not call get_my_portal_context() — the two reads are composed by the client",
    );
  });

  test("4. seeds nothing and writes to no catalogue table", () => {
    // RBAC_READ already exists and is already mapped to VENDOR_SUPER_ADMIN (20260716133023).
    // Re-seeding it here would put a second definition of the catalogue in the history, free to
    // drift from the first.
    for (const table of [
      "public.roles",
      "public.permissions",
      "public.role_permissions",
      "public.member_roles",
      "public.profiles",
      "public.organizations",
      "public.organization_members",
    ]) {
      assert.ok(
        !new RegExp(`\\b(insert\\s+into|update)\\s+${table.replace(".", "\\.")}\\b`, "i").test(CODE),
        `migration must not write to ${table}`,
      );
    }
  });

  test("5. modifies no previously applied migration", () => {
    // A forward-only history is the whole reason a migration can be trusted to describe the
    // deployed database. This test states the rule; `git diff --check` and the branch review
    // confirm nothing else in supabase/migrations was edited. Here it is enforced structurally:
    // no OTHER migration file may mention this migration's new object.
    const others = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && file !== MIGRATION_NAME)
      .sort();

    for (const other of others) {
      const text = readFileSync(join(MIGRATIONS_DIR, other), "utf8");
      assert.ok(
        !text.includes(`public.${READ}`),
        `${other} must not reference public.${READ} — that object is introduced by ${MIGRATION_NAME}`,
      );
    }
  });
});

// ============================================================================
// No client-supplied input, of any kind
// ============================================================================
describe("Vendor company profile reads — no client-supplied context", () => {
  test("6. the function takes ZERO arguments", () => {
    // The central security property. There is no parameter at all, so there is nothing a client
    // could set that decides WHOSE profile is returned or WHICH Vendor is described.
    assert.match(
      CODE,
      new RegExp(`create\\s+function\\s+public\\.${READ}\\s*\\(\\s*\\)`, "i"),
      `${READ} must be declared with an EMPTY parameter list`,
    );

    const signature = statement().match(
      new RegExp(`create\\s+function\\s+public\\.${READ}\\s*\\(([\\s\\S]*?)\\)\\s*returns`, "i"),
    );
    assert.ok(signature, `${READ} must declare a parameter list`);
    assert.equal(
      signature[1].trim(),
      "",
      `${READ} must accept no input — identity and tenant both come from the database`,
    );
  });

  test("7. no identity, profile, membership, organization or permission selector exists", () => {
    // Test 6 already proves the list is empty; this states the rule by name so the reason
    // survives any future attempt to add "just one" selector — in particular a profile id, which
    // would turn a self-read into a way to read a colleague.
    const FORBIDDEN_PARAMETERS = [
      "p_user_id",
      "p_auth_user_id",
      "p_profile_id",
      "p_membership_id",
      "p_member_id",
      "p_email",
      "p_vendor_organization_id",
      "p_vendor_id",
      "p_organization_id",
      "p_tenant_id",
      "p_role",
      "p_role_id",
      "p_role_code",
      "p_permission",
      "p_permission_code",
      "p_status",
    ];

    for (const forbidden of FORBIDDEN_PARAMETERS) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, "i").test(CODE),
        `${READ} must not accept ${forbidden} anywhere`,
      );
    }
  });

  test("8. the Vendor is derived from the shared context function, once", () => {
    // Delegation, not reimplementation. get_vendor_super_admin_context() evaluates the whole
    // chain — ACTIVE profile owned by auth.uid(), ACTIVE membership, ACTIVE VENDOR organization,
    // ACTIVE VENDOR_SUPER_ADMIN role — and this read inherits all of it, plus the shipped
    // multi-Vendor tie-break, by calling it rather than restating it.
    const body = statement();
    assert.match(
      body,
      /public\.get_vendor_super_admin_context\s*\(\s*\)/,
      `${READ} must derive its Vendor from public.get_vendor_super_admin_context()`,
    );
    assert.match(
      body,
      /order\s+by\s+ctx\.organization_id\s+limit\s+1/i,
      `${READ} must apply the same deterministic multi-Vendor tie-break every other Vendor RPC applies`,
    );

    const contextCalls = body.match(/get_vendor_super_admin_context\s*\(/g) ?? [];
    assert.equal(
      contextCalls.length,
      1,
      `${READ} must resolve identity and Vendor exactly once — a second resolution would re-walk the whole authorization chain`,
    );
  });

  test("9. the caller is identified by auth.uid(), and the self predicate is real", () => {
    const body = statement();

    // The self predicate. Without it, an authorized Vendor Super Admin would receive an arbitrary
    // member of their own Vendor — which is the one bug that would silently render a colleague's
    // name and roles as "my profile".
    assert.match(
      body,
      /m\.user_id\s*=\s*auth\.uid\s*\(\s*\)/,
      `${READ} must match the membership on m.user_id = auth.uid()`,
    );

    // The tenant predicate, compared against the DERIVED Vendor and never against a parameter.
    assert.match(
      body,
      /m\.organization_id\s*=\s*v_vendor/,
      `${READ} must scope the membership to the Vendor derived from auth.uid()`,
    );

    // auth.users is never read: profiles.id IS the auth user id, so the profile row is addressed
    // directly and no authentication data is touched.
    assert.ok(
      !/auth\.users/.test(body),
      `${READ} must not read auth.users — no authentication data belongs in a profile read`,
    );

    // No email is resolved anywhere, by any route.
    assert.ok(
      !/\bemail\b/i.test(body),
      `${READ} must not reference email — the Vendor UI displays none`,
    );
  });

  test("10. authorization requires RBAC_READ through the shared helper, and fails closed", () => {
    const body = statement();

    // RBAC_READ is the real, already-seeded code (20260716133023) and it is the permission the
    // migration-5 policy roles_select_rbac_authorized requires of a browser client reading
    // public.roles — which is where the returned role NAMES come from.
    assert.match(
      body,
      /public\.has_organization_permission\s*\(\s*v_vendor\s*,\s*'RBAC_READ'\s*\)/,
      `${READ} must require RBAC_READ through the shared permission helper`,
    );

    // Exactly one permission is required: the union of what the two returned facts need. The
    // caller's own name and own membership are ownership facts that the migration-5 policies
    // admit unconditionally, so ORGANIZATION_MEMBERS_READ is deliberately NOT required — see the
    // pgTAP suite, which asserts a caller without it can still read their own profile.
    const permissionChecks = body.match(/has_organization_permission\s*\(/g) ?? [];
    assert.equal(
      permissionChecks.length,
      1,
      `${READ} must check exactly one permission — a self-read must not demand directory permissions`,
    );
    assert.ok(
      !/ORGANIZATION_MEMBERS_READ|AUDIT_LOGS_READ/.test(body),
      `${READ} must not require a directory or audit permission to read the caller's OWN profile`,
    );

    // Fail closed on a caller who resolved to no Vendor, rather than falling through to a query
    // with a null tenant predicate.
    assert.match(
      body,
      /if\s+v_vendor\s+is\s+null/i,
      `${READ} must refuse a caller who resolves to no Vendor`,
    );
    assert.match(
      body,
      /errcode\s*=\s*'insufficient_privilege'/i,
      `${READ} must deny with insufficient_privilege (42501)`,
    );

    // The gate must come BEFORE the query, so an unauthorized caller never causes a row to be
    // read at all — a partial result after a failed check is exactly what must not happen.
    const gate = body.search(/raise\s+exception/i);
    const query = body.search(/return\s+query/i);
    assert.ok(gate !== -1 && query !== -1 && gate < query, "the gate must precede the query");
  });

  test("11. the denial is generic and names nothing", () => {
    const raise = statement().match(/raise\s+exception\s+'([^']*)'/i);
    assert.ok(raise, `${READ} must raise an exception on denial`);

    for (const leak of [
      "profiles",
      "organization_members",
      "member_roles",
      "roles",
      "RBAC_READ",
      "VENDOR_SUPER_ADMIN",
      "ORGANIZATION_MEMBERS_READ",
      "auth.uid",
      "policy",
    ]) {
      assert.ok(
        !raise[1].includes(leak),
        `the denial message must not name ${leak} — every failure is byte-identical to the client`,
      );
    }

    // Exactly one raise: "not signed in", "not a Vendor Super Admin", "suspended", and "no
    // RBAC_READ" must be indistinguishable, so there is only one place a refusal can come from.
    const raises = statement().match(/\braise\s+exception\b/gi) ?? [];
    assert.equal(
      raises.length,
      1,
      `${READ} must have exactly one refusal — a second raise would be a second, distinguishable answer`,
    );
  });

  test("12. authorization is not reimplemented from the identity or RBAC tables", () => {
    const body = statement();

    // Reading role_permissions or permissions here would be a SECOND definition of "is this
    // caller authorized", free to drift from the helper and from the RLS policies — and only one
    // of the two could be right.
    assert.ok(
      !body.includes("public.role_permissions"),
      `${READ} must not read public.role_permissions — the permission check is a boolean helper, not a row read`,
    );
    assert.ok(
      !body.includes("public.permissions"),
      `${READ} must not read public.permissions — permission rows are not display data`,
    );

    // No role CODE is compared anywhere. Which role authorizes a Vendor administrator is decided
    // by get_vendor_super_admin_context() and by seed data, not restated here.
    assert.ok(
      !/'VENDOR_SUPER_ADMIN'/.test(body),
      `${READ} must not name a role code — the authorizing role is the context function's decision`,
    );

    // public.organizations is not read at all: the organization name is PortalContext's job, and
    // reading the row here would be the first step toward returning it.
    assert.ok(
      !body.includes("public.organizations"),
      `${READ} must not read public.organizations — no company field is returned`,
    );
  });
});

// ============================================================================
// SECURITY DEFINER hardening
// ============================================================================
describe("Vendor company profile reads — SECURITY DEFINER hardening", () => {
  test("13. the function is a hardened, read-only definer function", () => {
    const body = statement();
    for (const [clause, label] of [
      [/\bsecurity\s+definer\b/i, "security definer"],
      [/\bset\s+search_path\s*=\s*''/i, "set search_path = ''"],
      [/\bstable\b/i, "stable"],
      [/\blanguage\s+plpgsql\b/i, "language plpgsql"],
    ] as [RegExp, string][]) {
      assert.match(body, clause, `public.${READ} must declare ${label}`);
    }
  });

  test("14. the function writes nothing", () => {
    // STABLE is the declaration; this is the check. A read that mutated would make a Flutter
    // profile screen refresh a write, and would let a GET-shaped call change data. It also writes
    // no audit row: reading one's own name is not a sensitive administrative action, and the
    // installed model audits state CHANGES only.
    const body = statement();
    for (const [pattern, label] of [
      [/\binsert\s+into\b/i, "insert"],
      [/\bupdate\s+\w/i, "update"],
      [/\bdelete\s+from\b/i, "delete"],
      [/\bperform\s+public\.\w*(write|create|record|log|expire)/i, "a write helper"],
      [/\baudit_logs\b/i, "an audit_logs reference"],
    ] as [RegExp, string][]) {
      assert.ok(!pattern.test(body), `${READ} must not perform ${label}`);
    }
  });

  test("15. every object reference is schema-qualified", () => {
    // The function runs with an EMPTY search_path, so an unqualified reference would not resolve
    // at all — and a qualified one cannot be hijacked by an attacker-controlled schema.
    const body = statement();
    for (const relation of [
      "organization_members",
      "profiles",
      "member_roles",
      "roles",
      "get_vendor_super_admin_context",
      "has_organization_permission",
    ]) {
      assert.match(
        body,
        new RegExp(`public\\.${relation}\\b`),
        `${READ} must reference ${relation} as public.${relation}`,
      );
    }

    // No `from <bare>` anywhere. Matches `from x` but deliberately not `from public.x`.
    const bareFrom = body.match(/\bfrom\s+(?!public\.)(?!\()\w+/gi) ?? [];
    assert.deepEqual(
      bareFrom.filter((match) => !/\bfrom\s+(select|lateral)\b/i.test(match)),
      [],
      `${READ} must not reference any relation without its schema`,
    );
  });

  test("16. privileges are explicit, minimal, and exclude every unintended role", () => {
    assert.match(
      CODE,
      new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${READ}\\(\\)\\s+from\\s+public`, "i"),
      "PUBLIC's implicit EXECUTE must be revoked",
    );
    assert.match(
      CODE,
      new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${READ}\\(\\)\\s+from\\s+anon`, "i"),
      "anon must be explicitly revoked",
    );
    assert.match(
      CODE,
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${READ}\\(\\)\\s+to\\s+authenticated`, "i"),
      "authenticated must be the only grantee",
    );

    // service_role must NOT be granted: this read derives its authority from auth.uid(), which a
    // service-role connection does not have, so a grant would produce a function that can only
    // ever refuse — while looking like a supported back-channel.
    assert.ok(
      !/grant[^;]*\bto\s+service_role\b/i.test(CODE),
      "service_role must not be granted EXECUTE",
    );
    assert.ok(!/grant[^;]*\bto\s+anon\b/i.test(CODE), "anon must never be granted anything");

    // Exactly one grant statement in the whole migration.
    const grants = CODE.match(/\bgrant\b/gi) ?? [];
    assert.equal(grants.length, 1, "the migration must contain exactly one GRANT");
  });
});

// ============================================================================
// The output contract
// ============================================================================
describe("Vendor company profile reads — the output contract", () => {
  test("17. returns exactly the two agreed columns, in order, with exact types", () => {
    const contract = outputContract();

    assert.deepEqual(
      contract.map(([name]) => name),
      [...OUTPUT_COLUMNS],
      "the output columns and their ORDER are the pinned contract",
    );

    assert.equal(
      contract[0][1].toLowerCase(),
      "text",
      "administrator_display_name must be text",
    );
    assert.equal(
      contract[1][1].toLowerCase().replace(/\s+/g, ""),
      "text[]",
      "administrator_role_names must be text[] — one membership genuinely may hold several roles",
    );
  });

  test("18. every output field is PERSONAL and named as such", () => {
    // The `administrator_` prefix is what keeps a Flutter model that merges this row with
    // PortalContext's company block unambiguous. `name`, `status` and `created_at` are exactly
    // the field names that would be ambiguous once company and personal data sit on one screen.
    for (const [name] of outputContract()) {
      assert.match(
        name,
        /^administrator_/,
        `${name} must be prefixed administrator_ so company and personal fields cannot be confused`,
      );
    }

    for (const [name] of outputContract()) {
      assert.ok(
        !/^(name|status|created_at|updated_at|email)$/.test(name),
        `${name} is an ambiguous field name and must not be used`,
      );
    }
  });

  test("19. no company or organization field is returned", () => {
    // The audit's central architectural decision: get_my_portal_context() already returns
    // `vendor.organization_name`, resolved through the same authorization chain, so duplicating
    // it here would create a second source of truth for the one company field the product has.
    for (const [name] of outputContract()) {
      assert.ok(
        !/organization|company|vendor|country|currency|website|registration|legal|tax/.test(name),
        `${name} must not be a company field — the organization name comes from get_my_portal_context()`,
      );
    }

    // And the body must not read the organizations table at all (also asserted in test 12, from
    // the delegation angle).
    assert.ok(
      !resultQuery().includes("organizations"),
      "the result query must not touch public.organizations",
    );
  });

  test("20. no status, timestamp, id or code is returned", () => {
    // The statuses are CONDITIONS of authorization here, not output: an authorized caller has an
    // ACTIVE profile, an ACTIVE membership and an ACTIVE organization by construction, so such a
    // column could only ever hold 'ACTIVE'. This follows get_vendor_super_admin_context()'s own
    // documented convention ("the statuses are CONDITIONS here, not output"). No timestamp is
    // returned because no web surface displays one for the caller.
    for (const [name] of outputContract()) {
      assert.ok(
        !/status|_at$|_id$|_code$|^id$/.test(name),
        `${name} must not be a status, timestamp, id or code`,
      );
    }

    // In particular the three statuses must not be combined into one "account status" either.
    for (const [name] of outputContract()) {
      assert.ok(
        !/account_status|membership_status|profile_status|organization_status/.test(name),
        `${name} must not surface a status the product does not show for the caller`,
      );
    }
  });

  test("21. no sensitive field is returned, under any name", () => {
    const forbidden =
      /token|hash|secret|password|provider|session|mfa|ip_address|user_agent|invitation|auth_user|user_id|profile_id|membership_id|tenant|email|mobile|phone|address|metadata|app_metadata|user_metadata|billing|payment|bank|invoice|logo|avatar|image|bucket|storage|permission/;

    for (const [name] of outputContract()) {
      assert.ok(!forbidden.test(name), `${name} must not name a sensitive or internal field`);
    }

    // The body must not read a jsonb metadata column, project one, or reach into auth metadata.
    const body = statement();
    for (const [pattern, label] of [
      [/\bmetadata\b/i, "metadata"],
      [/\braw_app_meta_data\b/i, "app metadata"],
      [/\braw_user_meta_data\b/i, "user metadata"],
      [/\bmobile_number\b/i, "mobile_number"],
      [/\btoken_hash\b/i, "token_hash"],
    ] as [RegExp, string][]) {
      assert.ok(!pattern.test(body), `${READ} must not read or return ${label}`);
    }
  });

  test("22. the result is not JSON, and is not a document", () => {
    const body = statement();
    for (const [pattern, label] of [
      [/returns\s+json/i, "returns json"],
      [/returns\s+jsonb/i, "returns jsonb"],
      [/\bjsonb?_build_object\b/i, "json_build_object"],
      [/\bjsonb?_agg\b/i, "json_agg"],
      [/\bto_jsonb?\b/i, "to_json"],
      [/\brow_to_json\b/i, "row_to_json"],
    ] as [RegExp, string][]) {
      assert.ok(
        !pattern.test(body),
        `${READ} must not use ${label} — the contract is typed scalar columns, not a document`,
      );
    }
  });

  test("23. exactly one row is guaranteed, and neither field can be null", () => {
    const query = resultQuery();

    // ONE ROW, structurally: organization_members is UNIQUE on (organization_id, user_id), so the
    // two predicates match at most one row — and at least one, because v_vendor was derived by
    // joining through that very membership. A GROUP BY, DISTINCT or LIMIT would each make "no
    // row" or "a different row" reachable for an authorized caller.
    for (const [pattern, label] of [
      [/\bgroup\s+by\b/i, "GROUP BY"],
      [/\bhaving\b/i, "HAVING"],
      [/\bdistinct\b/i, "DISTINCT"],
      [/\blimit\b/i, "LIMIT"],
    ] as [RegExp, string][]) {
      assert.ok(
        !pattern.test(query),
        `${label} in the result query would change which row an authorized caller receives`,
      );
    }

    // NEITHER FIELD IS NULLABLE, and each is defended: the name has a coalesce floor, the array a
    // coalesce to '{}'. A null in either would be an undocumented optional field.
    assert.match(
      query,
      /coalesce\s*\(\s*nullif\s*\(\s*btrim/i,
      "administrator_display_name must be composed with the same trim/nullif/coalesce floor as list_vendor_users()",
    );
    assert.match(
      query,
      /coalesce\s*\([\s\S]*'\{\}'::text\[\]\s*\)/,
      "administrator_role_names must coalesce to an EMPTY ARRAY, never NULL",
    );
    assert.match(
      query,
      /'Member'/,
      "the display-name floor must be the same literal the other SQL reads use",
    );
  });

  test("24. the role list is an ACTIVE-only, ordered aggregate that cannot duplicate the row", () => {
    const query = resultQuery();

    // A correlated scalar aggregate, not a join: member_roles is keyed by
    // (organization_member_id, role_id), so a join would emit one row per role and duplicate the
    // caller. The aggregate is evaluated once per membership row and cannot.
    assert.match(
      query,
      /select\s+array_agg\s*\(\s*r\.name\s+order\s+by\s+r\.name\s*,\s*r\.id\s*\)/i,
      "role names must be aggregated with a stable ORDER BY inside the aggregate",
    );
    assert.match(
      query,
      /where\s+mr\.organization_member_id\s*=\s*m\.id/i,
      "the aggregate must be correlated to the caller's OWN membership row",
    );
    assert.match(
      query,
      /r\.status\s*=\s*'ACTIVE'/,
      "only ACTIVE role definitions may be reported as live roles",
    );

    // NAMES, NOT CODES. r.code must not be selected anywhere: the codes are the literals the RLS
    // policies match on, and no read RPC in this schema returns one.
    assert.ok(
      !/\br\.code\b/.test(query),
      "the role CODE must never be returned — it is authorization vocabulary, not display data",
    );
  });

  test("25. one statement produces the row, and no other member can appear in it", () => {
    const statements = statement().match(/\breturn\s+query\b/gi) ?? [];
    assert.equal(statements.length, 1, `${READ} must produce its result with a single statement`);

    // The only join in the result query is the caller's own profile, on its primary key. A join
    // to another membership, or an aggregate over the Vendor's members, would put someone else's
    // data into a row labelled "my profile".
    const joins = resultQuery().match(/\bjoin\b/gi) ?? [];
    assert.equal(
      joins.length,
      2,
      "exactly two joins are expected: the caller's own profile, and roles inside the correlated aggregate",
    );

    // No aggregate over people, and no second membership.
    for (const [pattern, label] of [
      [/\bcount\s*\(/i, "a count"],
      [/\bsum\s*\(/i, "a sum"],
      [/\bmax\s*\(/i, "a max"],
      [/organization_members\s+\w+\s*,/i, "a second organization_members reference"],
    ] as [RegExp, string][]) {
      assert.ok(
        !pattern.test(resultQuery()),
        `${READ} must not use ${label} — this is one row about one person, not a summary`,
      );
    }
  });
});

// ============================================================================
// PortalContext non-duplication
// ============================================================================
describe("Vendor company profile reads — PortalContext is the company source", () => {
  test("26. the shipped PortalContext really does return the organization name", () => {
    // The requirement "Flutter takes the company name from PortalContext" is only safe if
    // PortalContext genuinely returns it. Asserted against the shipped migration so a future edit
    // that removed the key would fail HERE, where the dependency is stated, rather than in a
    // client.
    const portal = readFileSync(
      join(MIGRATIONS_DIR, "20260729090000_shared_portal_context.sql"),
      "utf8",
    );

    assert.match(
      portal,
      /'organization_name',\s*v_vendor_organization_name/,
      "get_my_portal_context() must still return vendor.organization_name",
    );
  });

  test("27. PortalContext returns neither the caller's name nor a role name", () => {
    // This is the GAP that justifies the new function. If PortalContext ever gained a caller
    // display name or a Vendor role list, this test would fail and the new RPC would have to be
    // re-justified rather than silently duplicating it.
    const portal = readFileSync(
      join(MIGRATIONS_DIR, "20260729090000_shared_portal_context.sql"),
      "utf8",
    );
    const code = portal
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");

    const vendorBlock = code.match(/v_vendor\s*:=\s*jsonb_build_object\(([\s\S]*?)\);/);
    assert.ok(vendorBlock, "PortalContext must build its vendor block with jsonb_build_object");

    assert.deepEqual(
      (vendorBlock[1].match(/'([a-z_]+)',/g) ?? []).map((key) => key.slice(1, -2)),
      ["organization_id", "organization_name"],
      "PortalContext's vendor block must carry exactly the two company keys — no caller name, no role, no status",
    );

    // No Vendor capability or role list either — the migration documents that it returns none.
    assert.ok(
      !/first_name|last_name|display_name|role_names/.test(vendorBlock[1]),
      "PortalContext must not carry personal fields — that is what the new self-read is for",
    );
  });

  test("28. the new read duplicates no PortalContext field", () => {
    // Field-by-field: neither of PortalContext's two vendor keys may appear as an output column
    // here, under that name or a plausible synonym. Written as an explicit synonym list rather
    // than a substring test, because "administrator_display_name" legitimately contains "name"
    // and a looser check would forbid the very field this contract exists to add.
    const names = outputContract().map(([name]) => name);
    const PORTAL_FIELDS_AND_SYNONYMS = [
      "organization_id",
      "organization_name",
      "org_id",
      "org_name",
      "vendor_id",
      "vendor_name",
      "company_id",
      "company_name",
      "tenant_id",
      "tenant_name",
    ];

    for (const duplicate of PORTAL_FIELDS_AND_SYNONYMS) {
      assert.ok(
        !names.includes(duplicate) && !names.some((name) => name.endsWith(`_${duplicate}`)),
        `${duplicate} is guaranteed by get_my_portal_context() and must not be duplicated here`,
      );
    }

    // Anti-vacuity: the list above must be tested against a NON-EMPTY column set, or it would
    // pass for a function that returned nothing at all.
    assert.equal(names.length, OUTPUT_COLUMNS.length, "the output contract must be non-empty");

    // The personal field this contract DOES add is still present — the point is that the two
    // contracts are complementary, not that this one returns nothing.
    assert.ok(
      names.includes("administrator_display_name"),
      "the caller's display name IS the field PortalContext lacks, and must be returned here",
    );
  });
});

// ============================================================================
// Web compatibility
// ============================================================================
describe("Vendor company profile reads — the web is untouched", () => {
  test("29. there is still no Settings, company, organization, profile or account route", () => {
    // The audit's first finding: the web has NO Vendor company or profile surface at all. This
    // milestone is backend-only and must not create one.
    const adminRoot = readdirSync(join(ROOT, "app/(admin)"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const route of ["settings", "company", "organization", "profile", "account", "me"]) {
      assert.ok(
        !adminRoot.includes(route),
        `app/(admin)/${route} must not exist — this milestone adds no web surface`,
      );
    }

    // And the same at the application root, where /login, /access-denied and /invitations live.
    const appRoot = readdirSync(join(ROOT, "app"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const route of ["settings", "company", "profile", "account"]) {
      assert.ok(!appRoot.includes(route), `app/${route} must not exist`);
    }
  });

  test("30. the Settings navigation item remains a disabled placeholder", () => {
    // It is the only company/profile affordance in the product, and it is deliberately
    // non-navigable. Enabling it would be a visible web change.
    const nav = readFileSync(join(ROOT, "components/admin/nav-items.tsx"), "utf8");

    const settingsEntry = nav.match(/label:\s*"Settings",[\s\S]*?disabled:\s*(true|false)/);
    assert.ok(settingsEntry, "the Settings nav item must still exist");
    assert.equal(
      settingsEntry[1],
      "true",
      "Settings must remain disabled — this milestone ships no Settings screen",
    );
  });

  test("31. the admin header still renders the organization name and caller name it always did", () => {
    // The only two company/profile values the web displays. Both keep their existing source: the
    // header receives them as props from the (admin) layout, which gets them from
    // getVendorSuperAdminAccess().
    const header = readFileSync(join(ROOT, "components/admin/admin-header.tsx"), "utf8");
    for (const prop of ["organizationName", "userDisplayName"]) {
      assert.ok(header.includes(prop), `the header must still render ${prop}`);
    }
    assert.ok(
      !header.includes(READ),
      "the header is a Client Component and must never reference a database function",
    );
  });

  test("32. no web module calls the new RPC in this milestone", () => {
    // Additive: the function has no caller in this repository yet. The web keeps composing the
    // header from getVendorSuperAdminAccess() exactly as before.
    const roots = ["lib", "app", "components"];
    const offenders: string[] = [];

    function walk(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // This test file names the function by definition.
        if (path === fileURLToPath(import.meta.url)) continue;
        if (readFileSync(path, "utf8").includes(READ)) offenders.push(path);
      }
    }

    for (const root of roots) walk(join(ROOT, root));

    assert.deepEqual(
      offenders,
      [],
      `no web module may call public.${READ} in this milestone — it is additive and unwired`,
    );
  });

  test("33. the shared authorization module is unchanged in shape", () => {
    // getVendorSuperAdminAccess() remains the web's single source for the header identity, and it
    // still returns the four display/identity values it always did. A change here would be a
    // visible web change smuggled in under a backend milestone.
    const access = readFileSync(join(ROOT, "lib/auth/vendor-admin-access.ts"), "utf8");

    for (const marker of [
      "get_vendor_super_admin_context",
      "userDisplayName",
      "organizationName",
      "organizationId",
    ]) {
      assert.ok(access.includes(marker), `lib/auth/vendor-admin-access.ts must still carry ${marker}`);
    }
    assert.ok(
      !access.includes(READ),
      "the authorization module must not call the new RPC — authorization is unchanged",
    );
  });
});
