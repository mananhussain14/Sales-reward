/**
 * STATIC CONTRACT GUARDS for the mobile Vendor dashboard summary
 * (supabase/migrations/20260805090000_mobile_vendor_dashboard_summary.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * lib/members/vendor-user-reads-contract.test.ts and
 * lib/audit/vendor-audit-log-reads-contract.test.ts. They read the SQL and assert structural
 * properties that a careless later edit could silently break.
 *
 * They do NOT execute the function. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_dashboard_summary_test.sql — pgTAP, 66 assertions, covering
 * tenant isolation, the tenant-vs-catalogue distinction, every role and permission denial,
 * inactive callers, the empty Vendor, exact status semantics, and duplicate-free counting for
 * multi-role and multi-organization members. It requires Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of properties
 * decidable from the source, and which would be a SECURITY or CONTRACT regression rather than
 * a behavioural one:
 *
 *   1. The migration is new, forward-only, and edits no applied migration.
 *   2. It adds one function and nothing else — no table, policy, index, grant on a table, or
 *      write of any kind.
 *   3. The function accepts NO input at all: no identity, Vendor, tenant, role, permission,
 *      status, date-range or organization selector.
 *   4. It is a correctly-hardened, read-only SECURITY DEFINER function.
 *   5. Privileges are explicit and exact: authenticated only, never anon, never PUBLIC, never
 *      service_role.
 *   6. The output is exactly four bigint counts and nothing else — no id, status, name,
 *      timestamp, JSON, or sensitive field.
 *   7. Authorization is DELEGATED to the existing helpers rather than reimplemented, and
 *      requires the role AND all three real, already-seeded permissions.
 *   8. Each metric's tenant and status predicate matches the web card it mirrors, and the
 *      four counts cannot inflate one another.
 *   9. The web dashboard is untouched.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const MIGRATION_NAME = "20260805090000_mobile_vendor_dashboard_summary.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose discusses the very patterns some of these tests forbid (it
 * explains why an organization id must not be an input, and it names the metrics it
 * deliberately does not count). Asserting against the raw text would match those explanations
 * and pass — or fail — for the wrong reason. Every structural assertion below runs against
 * executable SQL only.
 */
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/** The one function this migration creates. */
const READ = "get_vendor_admin_dashboard_summary";

/**
 * The three permissions the summary must require — the union of what its four counted
 * relations already require under the migration-5 RLS policies.
 */
const REQUIRED_PERMISSIONS = [
  "ORGANIZATION_MEMBERS_READ",
  "RBAC_READ",
  "AUDIT_LOGS_READ",
] as const;

/** The exact output contract, in order. */
const OUTPUT_COLUMNS = [
  "active_member_count",
  "catalog_active_role_count",
  "catalog_permission_count",
  "audit_event_count",
] as const;

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

/**
 * The parts of `sql` that sit at parenthesis depth 0, with every bracketed group removed.
 *
 * Used to reason about the OUTER query without its scalar subqueries. Written as a scan
 * rather than a regex because the nesting is genuine: `(select count(*) from public.roles …)`
 * contains a `)` that closes `count(*)`, so any non-greedy pattern stops in the wrong place.
 */
function topLevelOf(sql: string): string {
  let depth = 0;
  let out = "";
  for (const character of sql) {
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += character;
  }
  return out;
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

// ============================================================================
// Migration hygiene
// ============================================================================
describe("Vendor dashboard summary — migration hygiene", () => {
  test("1. is a NEW migration, ordered after every dependency it names", () => {
    const applied = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    assert.ok(
      applied.includes(MIGRATION_NAME),
      "the migration file must exist in supabase/migrations",
    );

    // Ordered after its DEPENDENCIES, not last overall. "Newest in the repository" is a
    // property of one moment in time, not of this migration, and asserting it would fail the
    // moment any unrelated migration landed. What matters is that every object this migration
    // references already exists when it applies.
    const DEPENDENCIES = [
      "20260716124419_core_identity_tables.sql",
      "20260716125559_vendor_admin_rbac.sql",
      "20260716130351_vendor_admin_audit_logs.sql",
      "20260716131104_vendor_admin_authorization_helpers.sql",
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
      // The one that matters most for a "make the mobile read easier" regression: a direct
      // table grant would let a client bypass this function entirely.
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

  test("3. seeds no role, permission, or mapping", () => {
    // All three permissions already exist and are already mapped to VENDOR_SUPER_ADMIN
    // (20260716133023). Re-seeding them here would put a second definition of the catalogue in
    // the history, free to drift from the first.
    for (const table of [
      "public.roles",
      "public.permissions",
      "public.role_permissions",
      "public.member_roles",
    ]) {
      assert.ok(
        !new RegExp(`\\b(insert\\s+into|update)\\s+${table.replace(".", "\\.")}\\b`, "i").test(CODE),
        `migration must not write to ${table}`,
      );
    }
  });

  test("4. modifies no previously applied migration", () => {
    // A forward-only history is the whole reason a migration can be trusted to describe the
    // deployed database. This test states the rule; `git diff --check` and the branch review
    // confirm nothing else in supabase/migrations was edited. Here it is enforced
    // structurally: no OTHER migration file may mention this migration's new object.
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
describe("Vendor dashboard summary — no client-supplied context", () => {
  test("5. the function takes ZERO arguments", () => {
    // The central security property. There is no parameter at all, so there is nothing a
    // client could set that decides whose data is counted, which statuses are included, or
    // over what period.
    assert.match(
      CODE,
      new RegExp(`create\\s+function\\s+public\\.${READ}\\s*\\(\\s*\\)`, "i"),
      `${READ} must be declared with an EMPTY parameter list`,
    );
  });

  test("6. no identity, tenant, role, permission, status or period parameter exists", () => {
    // Test 5 already proves the list is empty; this states the rule by name so the reason
    // survives any future attempt to add "just one" selector.
    const signature = statement().match(
      new RegExp(`create\\s+function\\s+public\\.${READ}\\s*\\(([\\s\\S]*?)\\)\\s*returns`, "i"),
    );
    assert.ok(signature, `${READ} must declare a parameter list`);
    assert.equal(
      signature[1].trim(),
      "",
      `${READ} must accept no input — identity, tenant, metric definitions and status filters all come from the database`,
    );

    const FORBIDDEN_PARAMETERS = [
      "p_user_id",
      "p_auth_user_id",
      "p_profile_id",
      "p_membership_id",
      "p_email",
      "p_vendor_organization_id",
      "p_vendor_id",
      "p_organization_id",
      "p_tenant_id",
      "p_role",
      "p_role_code",
      "p_permission",
      "p_permission_code",
      "p_status",
      "p_statuses",
      "p_from",
      "p_to",
      "p_since",
      "p_period",
      "p_days",
    ];

    for (const forbidden of FORBIDDEN_PARAMETERS) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, "i").test(CODE),
        `${READ} must not accept ${forbidden} anywhere`,
      );
    }
  });

  test("7. the Vendor is derived from the shared context function", () => {
    // Delegation, not reimplementation. get_vendor_super_admin_context() evaluates the whole
    // chain — ACTIVE profile owned by auth.uid(), ACTIVE membership, ACTIVE VENDOR
    // organization, ACTIVE VENDOR_SUPER_ADMIN role — and this read inherits all of it, plus
    // the shipped multi-Vendor tie-break, by calling it rather than restating it.
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
  });

  test("8. all three permissions are required through the shared helper", () => {
    // This function is SECURITY DEFINER and so runs outside the migration-5 policies that
    // would otherwise require ORGANIZATION_MEMBERS_READ (organization_members), RBAC_READ
    // (roles, permissions) and AUDIT_LOGS_READ (audit_logs). Requiring all three explicitly is
    // what stops the summary from being a way to learn figures RLS would have refused, and is
    // what makes it never more permissive than the drill-down screens it summarises.
    const body = statement();
    for (const permission of REQUIRED_PERMISSIONS) {
      assert.match(
        body,
        new RegExp(
          `public\\.has_organization_permission\\s*\\(\\s*v_vendor\\s*,\\s*'${permission}'\\s*\\)`,
        ),
        `${READ} must require ${permission} through the shared permission helper`,
      );
    }
  });

  test("9. the authorization check fails closed and denies generically", () => {
    const body = statement();

    // The Vendor must be tested for null, so a caller who resolved to no Vendor is refused
    // rather than falling through to a query with a null tenant predicate.
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

    // The denial must not name a table, permission, Vendor or metric — a caller must not be
    // able to tell WHICH gate refused them.
    const raise = body.match(/raise\s+exception\s+'([^']*)'/i);
    assert.ok(raise, `${READ} must raise an exception on denial`);
    for (const leak of [
      "organization_members",
      "audit_logs",
      "roles",
      "permissions",
      "ORGANIZATION_MEMBERS_READ",
      "RBAC_READ",
      "AUDIT_LOGS_READ",
      "VENDOR_SUPER_ADMIN",
    ]) {
      assert.ok(
        !raise[1].includes(leak),
        `the denial message must not name ${leak} — every failure is byte-identical to the client`,
      );
    }

    // The authorization gate must come BEFORE the query, so an unauthorized caller never
    // causes a count to be computed.
    const gate = body.search(/raise\s+exception/i);
    const query = body.search(/return\s+query/i);
    assert.ok(gate !== -1 && query !== -1 && gate < query, "the gate must precede the query");
  });

  test("10. the caller's authorization is resolved ONCE, before the counts", () => {
    const body = statement();
    const contextCalls = body.match(/get_vendor_super_admin_context\s*\(/g) ?? [];
    assert.equal(
      contextCalls.length,
      1,
      `${READ} must resolve its Vendor exactly once — a per-count resolution would re-walk the authorization chain four times`,
    );

    const permissionCalls = body.match(/has_organization_permission\s*\(/g) ?? [];
    assert.equal(
      permissionCalls.length,
      REQUIRED_PERMISSIONS.length,
      `${READ} must check each permission exactly once, before the query rather than inside it`,
    );
  });

  test("11. authorization is not reimplemented from the RBAC tables", () => {
    // Reading role_permissions here would be a SECOND definition of "is this caller
    // authorized", free to drift from the helpers and from the RLS policies — and only one of
    // the two could be right. public.roles and public.permissions ARE read, but as COUNTED
    // CATALOGUE DATA and never as a condition on the caller, which test 17 pins precisely.
    const body = statement();
    assert.ok(
      !body.includes("public.role_permissions"),
      `${READ} must not read public.role_permissions — the permission check is a boolean helper, not a row read`,
    );
    assert.ok(
      !body.includes("public.member_roles"),
      `${READ} must not read public.member_roles — no count is a count of role assignments`,
    );
    assert.ok(
      !/'VENDOR_SUPER_ADMIN'/.test(body),
      `${READ} must not name a role code — which role holds these permissions is seed data`,
    );
    assert.ok(
      !/auth\.users/.test(body),
      `${READ} must not read auth.users — no authentication data belongs in a count`,
    );
    assert.ok(
      !/public\.profiles/.test(body),
      `${READ} must not read public.profiles — the member count needs only organization_members, exactly as the web card does`,
    );
  });
});

// ============================================================================
// SECURITY DEFINER hardening
// ============================================================================
describe("Vendor dashboard summary — SECURITY DEFINER hardening", () => {
  test("12. the function is a hardened, read-only definer function", () => {
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

  test("13. the function writes nothing", () => {
    // STABLE is the declaration; this is the check. A read that mutated would make a Flutter
    // dashboard refresh a write, and would let a GET-shaped call change data.
    const body = statement();
    for (const [pattern, label] of [
      [/\binsert\s+into\b/i, "insert"],
      [/\bupdate\s+\w/i, "update"],
      [/\bdelete\s+from\b/i, "delete"],
      [/\bperform\s+public\.\w*(write|create|record|log|expire)/i, "a write helper"],
    ] as [RegExp, string][]) {
      assert.ok(!pattern.test(body), `${READ} must not perform ${label}`);
    }
  });

  test("14. every object reference is schema-qualified", () => {
    // The function runs with an EMPTY search_path, so an unqualified reference would not
    // resolve at all — and a qualified one cannot be hijacked by an attacker-controlled schema.
    const body = statement();
    for (const relation of [
      "organization_members",
      "roles",
      "permissions",
      "audit_logs",
      "get_vendor_super_admin_context",
      "has_organization_permission",
    ]) {
      const qualified = new RegExp(`public\\.${relation}\\b`);
      assert.match(body, qualified, `${READ} must reference ${relation} as public.${relation}`);
    }

    // No `from <bare>` anywhere. Matches `from x` but deliberately not `from public.x`.
    const bareFrom = body.match(/\bfrom\s+(?!public\.)(?!\()\w+/gi) ?? [];
    assert.deepEqual(
      bareFrom.filter((m) => !/\bfrom\s+(select|lateral)\b/i.test(m)),
      [],
      `${READ} must not reference any relation without its schema`,
    );
  });

  test("15. privileges are explicit, minimal, and exclude every unintended role", () => {
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

    // service_role must NOT be granted: this read derives its authority from auth.uid(), which
    // a service-role connection does not have, so a grant would produce a function that can
    // only ever refuse — while looking like a supported back-channel.
    assert.ok(
      !/grant[^;]*\bto\s+service_role\b/i.test(CODE),
      "service_role must not be granted EXECUTE",
    );
    assert.ok(
      !/grant[^;]*\bto\s+anon\b/i.test(CODE),
      "anon must never be granted anything",
    );
  });
});

// ============================================================================
// The output contract
// ============================================================================
describe("Vendor dashboard summary — the output contract", () => {
  test("16. returns exactly the four agreed columns, in order, all bigint", () => {
    const contract = outputContract();

    assert.deepEqual(
      contract.map(([name]) => name),
      [...OUTPUT_COLUMNS],
      "the output columns and their ORDER are the pinned contract",
    );

    for (const [name, type] of contract) {
      assert.equal(
        type.toLowerCase(),
        "bigint",
        `${name} must be bigint — count(*) is bigint, and narrowing it would overflow silently`,
      );
    }
  });

  test("17. every output is a count, and nothing else is returned", () => {
    for (const [name] of outputContract()) {
      assert.match(name, /_count$/, `${name} must be a _count — this contract returns counts only`);
    }

    // No id, status, name, timestamp or code is emitted. Statuses are PREDICATES in this
    // function, not output; ids are not needed because nothing here addresses a row.
    const forbidden =
      /token|hash|secret|password|provider|session|ip_address|user_agent|invitation|auth_user|user_id|profile_id|organization_id|tenant|email|mobile|phone|metadata|status|_id$|_at$|name$|code$/;
    for (const [name] of outputContract()) {
      assert.ok(
        !forbidden.test(name),
        `${name} must not name an id, status, timestamp, code, or any sensitive field`,
      );
    }
  });

  test("18. the result is not JSON, and carries no nested collection", () => {
    const body = statement();
    for (const [pattern, label] of [
      [/returns\s+json/i, "returns json"],
      [/returns\s+jsonb/i, "returns jsonb"],
      [/\bjsonb?_build_object\b/i, "json_build_object"],
      [/\bjsonb?_agg\b/i, "json_agg"],
      [/\barray_agg\b/i, "array_agg"],
      [/\bto_jsonb?\b/i, "to_json"],
    ] as [RegExp, string][]) {
      assert.ok(
        !pattern.test(body),
        `${READ} must not use ${label} — the contract is four scalar bigints, not a document`,
      );
    }
  });

  test("19. exactly one row is structurally guaranteed", () => {
    const body = statement();
    const returnQuery = body.slice(body.search(/return\s+query/i));

    // A select with NO from-clause produces exactly one row. That is what makes "an authorized
    // Vendor always receives one row, even with no data" a property of the shape rather than a
    // guard a later edit could drop.
    //
    // The check must ignore the scalar subqueries, each of which legitimately HAS a
    // from-clause. A regex cannot do that — `\(select[\s\S]*?\)` stops at the first `)`, which
    // is the one closing `count(*)` — so the nesting is stripped by an explicit depth scan.
    const topLevel = topLevelOf(returnQuery);

    // Anti-vacuity: if the scan ever returned nothing, "no from-clause" would pass for any SQL
    // at all. The outer select must still be there after the subqueries are stripped.
    assert.match(
      topLevel.replace(/\s+/g, " ").trim(),
      /^return query select ,\s*,\s*,\s*;/i,
      "the outer query must be a bare select of four parenthesised subqueries — if this shape changes, the guard below is no longer measuring what it claims",
    );

    assert.ok(
      !/\bfrom\b/i.test(topLevel),
      "the outer select must have no from-clause, so it emits exactly one row",
    );

    // No GROUP BY / HAVING / LIMIT anywhere: each would make "no row" reachable for an
    // authorized caller, which is the one outcome the contract forbids.
    for (const [pattern, label] of [
      [/\bgroup\s+by\b/i, "GROUP BY"],
      [/\bhaving\b/i, "HAVING"],
    ] as [RegExp, string][]) {
      assert.ok(
        !pattern.test(returnQuery),
        `${label} in the summary query would make zero rows reachable for an authorized Vendor`,
      );
    }
  });

  test("20. counts can never be null, and no coalesce pretends otherwise", () => {
    const returnQuery = statement().slice(statement().search(/return\s+query/i));

    // count(*) is bigint and never null, and an aggregate scalar subquery with no GROUP BY
    // returns 0 — not NULL, and not "no row" — over an empty set. A coalesce() here would
    // imply a null was possible and would mask a future rewrite that made one so.
    assert.ok(
      !/\bcoalesce\b/i.test(returnQuery),
      "no coalesce is needed on a count(*) — adding one would imply NULL was reachable",
    );

    const counts = returnQuery.match(/\bcount\s*\(/gi) ?? [];
    assert.equal(
      counts.length,
      OUTPUT_COLUMNS.length,
      "there must be exactly one count() per output column",
    );

    // count(*) specifically — count(<expr>) skips nulls and would silently undercount.
    const starCounts = returnQuery.match(/\bcount\s*\(\s*\*\s*\)/gi) ?? [];
    assert.equal(
      starCounts.length,
      OUTPUT_COLUMNS.length,
      "every count must be count(*) — count(<expr>) skips nulls and would undercount",
    );
  });
});

// ============================================================================
// Metric definitions
// ============================================================================
describe("Vendor dashboard summary — metric definitions", () => {
  test("21. the two tenant-scoped counts filter on the DERIVED Vendor", () => {
    const body = statement();

    assert.match(
      body,
      /m\.organization_id\s*=\s*v_vendor/,
      "active_member_count must be scoped to the Vendor derived from auth.uid()",
    );
    assert.match(
      body,
      /a\.organization_id\s*=\s*v_vendor/,
      "audit_event_count must be scoped to the Vendor derived from auth.uid()",
    );

    // The audit predicate is an equality against a non-null uuid, which is exactly what
    // excludes null-organization rows — null never equals anything. An `is not distinct from`
    // or an `or ... is null` would silently admit orphaned history.
    assert.ok(
      !/organization_id\s+is\s+not\s+distinct\s+from/i.test(body),
      "the tenant predicate must be a plain equality, so null-organization rows stay excluded",
    );
    assert.ok(
      !/organization_id\s+is\s+null/i.test(body),
      "no count may admit rows with a null organization",
    );
  });

  test("22. active_member_count filters on ACTIVE membership status only", () => {
    const body = statement();
    assert.match(
      body,
      /m\.status\s*=\s*'ACTIVE'/,
      "active_member_count must require an ACTIVE membership, matching the web card's label",
    );

    // It must NOT also require an ACTIVE profile. The web query filters
    // organization_members.status alone and never joins profiles; adding a profile predicate
    // here would make the mobile figure disagree with the web figure.
    assert.ok(
      !/p\.status\s*=\s*'ACTIVE'/.test(body),
      "active_member_count must not additionally require an ACTIVE profile — the web does not",
    );

    // INVITED must not be folded in. There is no Vendor invitation system, and an "invited"
    // membership is not an active member.
    assert.ok(
      !/'INVITED'/.test(body),
      "no count may include INVITED memberships — the card counts ACTIVE members",
    );
  });

  test("23. the catalogue counts are GLOBAL and carry no tenant predicate", () => {
    const body = statement();

    // public.roles and public.permissions have no organization_id at all. A tenant predicate
    // on either would not compile — but a JOIN through member_roles would, and would silently
    // turn a catalogue figure into a usage figure.
    const rolesSubquery = body.match(/select\s+count\s*\(\s*\*\s*\)\s+from\s+public\.roles[\s\S]*?\)/i);
    assert.ok(rolesSubquery, "the roles count must be its own scalar subquery");
    assert.ok(
      !/v_vendor/.test(rolesSubquery[0]),
      "catalog_active_role_count must NOT be tenant-scoped — public.roles is a global catalogue",
    );
    assert.match(
      rolesSubquery[0],
      /r\.status\s*=\s*'ACTIVE'/,
      "catalog_active_role_count must count ACTIVE role definitions only",
    );

    const permsSubquery = body.match(
      /select\s+count\s*\(\s*\*\s*\)\s*\n?\s*from\s+public\.permissions[\s\S]*?\)/i,
    );
    assert.ok(permsSubquery, "the permissions count must be its own scalar subquery");
    assert.ok(
      !/v_vendor/.test(permsSubquery[0]),
      "catalog_permission_count must NOT be tenant-scoped — public.permissions is a global catalogue",
    );
    // public.permissions HAS NO status column, so a status predicate would not compile. The
    // field name must therefore not promise one.
    assert.ok(
      !/status/i.test(permsSubquery[0]),
      "public.permissions has no status column — the whole catalogue is counted",
    );
  });

  test("24. the field names distinguish tenant metrics from catalogue metrics", () => {
    // The audit's central finding: two of the four web cards are deployment-wide figures shown
    // on an organization overview. The contract names that distinction so no client can
    // inherit the ambiguity by accident.
    const names = outputContract().map(([name]) => name);

    for (const global of ["catalog_active_role_count", "catalog_permission_count"]) {
      assert.ok(names.includes(global), `${global} must carry the catalog_ prefix`);
    }
    for (const tenant of ["active_member_count", "audit_event_count"]) {
      assert.ok(
        names.includes(tenant) && !tenant.startsWith("catalog_"),
        `${tenant} is tenant-scoped and must NOT carry the catalog_ prefix`,
      );
    }
  });

  test("25. audit_event_count applies no time window and no filter", () => {
    const body = statement();
    const auditSubquery = body.match(/select\s+count\s*\(\s*\*\s*\)\s*\n?\s*from\s+public\.audit_logs[\s\S]*?\)/i);
    assert.ok(auditSubquery, "the audit count must be its own scalar subquery");

    // The web card counts every audit row for the organization with NO date predicate. There
    // is no shipped notion of "today", "this week" or "last 30 days" anywhere in the product,
    // so inventing one here would be a new product definition made in SQL.
    for (const [pattern, label] of [
      [/\bnow\s*\(\s*\)/i, "now()"],
      [/\bcurrent_date\b/i, "current_date"],
      [/\bcurrent_timestamp\b/i, "current_timestamp"],
      [/\binterval\b/i, "an interval"],
      [/\bcreated_at\b/i, "a created_at predicate"],
      [/\baction\b/i, "an action filter"],
      [/\bentity_type\b/i, "an entity_type filter"],
      [/\bactor_profile_id\b/i, "an actor filter"],
    ] as [RegExp, string][]) {
      assert.ok(
        !pattern.test(auditSubquery[0]),
        `audit_event_count must not use ${label} — the web card is an all-time, unfiltered total`,
      );
    }

    // And the field must not be named as though it were windowed.
    assert.ok(
      !outputContract().some(([name]) => /recent|today|week|month|last/.test(name)),
      "no output field may imply a time window that the product does not define",
    );
  });

  test("26. the four counts are independent and cannot inflate one another", () => {
    const body = statement();
    const returnQuery = body.slice(body.search(/return\s+query/i));

    // Four scalar subqueries over four unrelated relations. A join between them would produce
    // a cartesian product and multiply every count by the cardinality of the others.
    const subqueries = returnQuery.match(/\(\s*select\s+count\s*\(\s*\*\s*\)/gi) ?? [];
    assert.equal(
      subqueries.length,
      OUTPUT_COLUMNS.length,
      "each count must be its own independent scalar subquery",
    );

    // No JOIN anywhere in the result query, and no DISTINCT. Row multiplicity is fixed by the
    // schema (organization_members is UNIQUE on (organization_id, user_id); roles.code and
    // permissions.code are UNIQUE; an audit row has one organization), so a DISTINCT would
    // hide a genuine duplication bug rather than fix one.
    assert.ok(
      !/\bjoin\b/i.test(returnQuery),
      "the summary query must contain no join — the four relations share no key",
    );
    assert.ok(
      !/\bdistinct\b/i.test(returnQuery),
      "no DISTINCT is needed; adding one would mask a duplication bug rather than prevent it",
    );
  });

  test("27. no speculative metric is counted", () => {
    // The web dashboard shows exactly four figures. Counting a Retailer, Product, shop,
    // assignment, invitation or receipt would be inventing a product decision in a migration
    // and freezing its semantics into a pinned mobile contract.
    const body = statement();
    for (const relation of [
      "vendor_retailers",
      "retailer_shops",
      "vendor_products",
      "vendor_product_assignments",
      "retailer_invitations",
      "retailer_staff_invitations",
      "receipt_submissions",
      "retailer_shop_members",
    ]) {
      assert.ok(
        !body.includes(relation),
        `${READ} must not read ${relation} — it is not on the web dashboard, so there is no shipped definition to share`,
      );
    }
  });

  test("28. exactly one row-producing statement is issued", () => {
    const queries = statement().match(/\breturn\s+query\b/gi) ?? [];
    assert.equal(
      queries.length,
      1,
      `${READ} must produce its result with a single statement — that is the whole point of replacing four round trips`,
    );
  });
});

// ============================================================================
// Web compatibility
// ============================================================================
describe("Vendor dashboard summary — the web is untouched", () => {
  test("29. the existing dashboard data module still performs its own four reads", () => {
    // This PR adds a shared contract; it does not migrate the web onto it. The visible
    // behaviour of / must be byte-identical after this branch.
    const web = readFileSync(join(ROOT, "lib/dashboard/vendor-admin-summary.ts"), "utf8");

    assert.ok(
      !web.includes(READ),
      "lib/dashboard/vendor-admin-summary.ts must not call the new RPC in this milestone",
    );
    for (const table of ["organization_members", "roles", "permissions", "audit_logs"]) {
      assert.ok(
        web.includes(`.from("${table}")`),
        `the web module must still read ${table} exactly as it did before`,
      );
    }
  });

  test("30. the dashboard card labels and page structure are unchanged", () => {
    // The audit found two card labels ("Active Roles", "Permissions") that name global
    // catalogue figures on an organization overview. That is recorded as a finding and named
    // in the CONTRACT's field names — it is NOT fixed here, because changing a visible label
    // is a web change this milestone forbids.
    const page = readFileSync(join(ROOT, "app/(admin)/page.tsx"), "utf8");

    for (const label of ["Active Members", "Active Roles", "Permissions", "Audit Events"]) {
      assert.ok(page.includes(`"${label}"`), `the web dashboard must still show the "${label}" card`);
    }
    assert.ok(
      !page.includes(READ),
      "the dashboard page must not call the new RPC in this milestone",
    );

    // No new card, and no chart, trend or feed is introduced.
    for (const forbidden of ["Retailers Count", "chart", "Chart", "trend", "sparkline"]) {
      assert.ok(!page.includes(forbidden), `the dashboard must not gain ${forbidden}`);
    }
  });

  test("31. no admin route is added or removed by this milestone", () => {
    // The milestone is backend-only.
    const adminRoot = readdirSync(join(ROOT, "app/(admin)"));
    assert.ok(adminRoot.includes("page.tsx"), "the dashboard page must still exist");
    assert.ok(adminRoot.includes("loading.tsx"), "the dashboard loading state must still exist");
    assert.ok(
      !adminRoot.includes("dashboard"),
      "no new dashboard route directory may be introduced",
    );
  });

  test("32. the metric definitions are not duplicated into TypeScript", () => {
    // The whole point of the shared contract is ONE definition of each figure. A second copy
    // in a Next.js helper — even an unused one — would be free to drift from the SQL.
    const dashboardDir = readdirSync(join(ROOT, "lib/dashboard"));
    for (const file of dashboardDir) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const text = readFileSync(join(ROOT, "lib/dashboard", file), "utf8");
      assert.ok(
        !text.includes("catalog_active_role_count") && !text.includes("catalog_permission_count"),
        `lib/dashboard/${file} must not restate the RPC's metric field names — the web migration is a separate change`,
      );
    }
  });
});
