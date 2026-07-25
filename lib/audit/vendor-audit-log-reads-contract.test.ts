/**
 * STATIC CONTRACT GUARDS for the mobile Vendor Audit Log read
 * (supabase/migrations/20260804090000_mobile_vendor_audit_log_reads.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * lib/products/vendor-product-reads-contract.test.ts, lib/rbac/vendor-role-reads-contract.test.ts,
 * lib/members/vendor-user-reads-contract.test.ts and
 * lib/retailers/vendor-retailer-reads-contract.test.ts. They read the SQL and assert
 * structural properties that a careless later edit could silently break.
 *
 * They do NOT execute the function. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_audit_log_reads_test.sql — pgTAP, 113 assertions, covering
 * every role denial, inactive callers, the exact permission requirement proved by REMOVING the
 * seeded mapping, actor and entity accuracy across system / foreign / deactivated / deleted
 * cases, the metadata whitelist against a deliberately hostile row, tenant isolation in both
 * directions, the limit bounds, cursor validation, and a full paginated traversal at four page
 * sizes compared against an unpaginated read. It requires Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of properties
 * decidable from the source, and which would be a SECURITY or CONTRACT regression rather than
 * a behavioural one:
 *
 *   1. The migration is new, forward-only, and edits no applied migration.
 *   2. It adds one function and nothing else — no table, policy, index, trigger, table grant,
 *      seed row, permission or write of any kind. In particular it writes NO audit row and
 *      touches NO audit trigger.
 *   3. The function accepts no identity, tenant, role-code or permission-code input; its only
 *      arguments are a page size and a two-part cursor.
 *   4. It is a correctly-hardened, read-only SECURITY DEFINER function.
 *   5. Privileges are explicit and exact: authenticated only, never anon, never PUBLIC, never
 *      service_role.
 *   6. The limit is bounded at BOTH ends by literal constants, and the cursor is all-or-nothing.
 *   7. The ordering and the cursor predicate use the SAME two columns — the property that makes
 *      pagination free of duplicates and skips.
 *   8. Authorization is DELEGATED to the existing helpers rather than reimplemented, and the
 *      permission code is the real, already-seeded one.
 *   9. The output columns are exactly the agreed contract, and no authentication field, contact
 *      field, invitation secret, network identifier, raw metadata or old/new-value payload
 *      appears in any of them.
 *  10. The metadata read is a CLOSED whitelist of name keys guarded by a JSON type check — the
 *      single property that stops unrestricted jsonb from reaching a client.
 *  11. The web Audit Logs page and its module are untouched, and still perform their own reads.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const MIGRATION_NAME = "20260804090000_mobile_vendor_audit_log_reads.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

/** The already-deployed migrations that own the audit table, its policy, and its permission. */
const AUDIT_TABLE_MIGRATION = "20260716130351_vendor_admin_audit_logs.sql";
const RLS_MIGRATION = "20260716131930_vendor_admin_rls_read_policies.sql";
const SEED_MIGRATION = "20260716133023_seed_vendor_admin_roles_permissions.sql";

const SQL = readFileSync(MIGRATION_PATH, "utf8");

/** The web surfaces this milestone must leave alone. */
const WEB_MODULE_PATH = join(ROOT, "lib/audit/vendor-audit-logs.ts");
const WEB_PAGE_PATH = join(ROOT, "app/(admin)/audit-logs/page.tsx");
const WEB_MODULE = readFileSync(WEB_MODULE_PATH, "utf8");
const WEB_PAGE = readFileSync(WEB_PAGE_PATH, "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose discusses the very patterns some of these tests forbid (it
 * explains why entity_id must not be returned, names ip_address and user_agent as columns it
 * refuses to select, and lists the full action vocabulary). Asserting against the raw text
 * would match those explanations and pass — or fail — for the wrong reason. Every structural
 * assertion below runs against executable SQL only.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

const CODE = stripComments(SQL);

const READ_NAME = "list_vendor_audit_logs";
const READ_ARGS = "integer, timestamptz, uuid";

/** The exact, documented contract this milestone commits to. */
const EXPECTED_INPUTS = ["p_limit", "p_before_occurred_at", "p_before_audit_log_id"];
const EXPECTED_OUTPUTS = [
  "audit_log_id",
  "occurred_at",
  "action_code",
  "entity_type",
  "entity_display_name",
  "actor_type",
  "actor_display_name",
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * The `create function` statement, from its CREATE through the closing `$$;` of its body.
 * Everything asserted about the function is asserted against this slice rather than the whole
 * file, so a REVOKE or GRANT written after it can never satisfy an assertion about the body.
 */
function statement(): string {
  const start = CODE.search(new RegExp(`create\\s+function\\s+public\\.${READ_NAME}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `migration must create public.${READ_NAME}`);
  const end = CODE.indexOf("$$;", start);
  assert.notEqual(end, -1, `public.${READ_NAME} must have a $$-quoted body`);
  return CODE.slice(start, end);
}

/** The `(...)` argument list, i.e. everything before `returns table`. */
function signature(): string {
  const match = statement().match(/create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)\s*returns/i);
  assert.ok(match, "the function must declare an argument list followed by RETURNS");
  return match[1];
}

/** The declared input parameter names, in order. */
function inputArgs(): string[] {
  return signature()
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(/\s+/)[0]);
}

/** The `returns table (...)` column names, in declaration order. */
function outputColumns(): string[] {
  const match = statement().match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  assert.ok(match, `public.${READ_NAME} must declare a returns table (...) contract`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((entry) => entry.length > 0);
}

/** The plpgsql body, between `as $$` and the closing `$$;`. */
function body(): string {
  const source = statement();
  const start = source.indexOf("$$");
  assert.notEqual(start, -1, "the function must have a $$-quoted body");
  return source.slice(start + 2);
}

// ============================================================================
// Migration hygiene
// ============================================================================
describe("mobile Vendor Audit Log reads — migration hygiene", () => {
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
      AUDIT_TABLE_MIGRATION,
      "20260716131104_vendor_admin_authorization_helpers.sql",
      SEED_MIGRATION,
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
      [/\bdelete\s+from\b/i, "delete from"],
      [/\btruncate\b/i, "truncate"],
      [/\bexecute\s+format\b/i, "dynamic SQL"],
      // The one that matters most for an audit table: a direct table grant would let a client
      // read the raw rows — metadata, ip_address, user_agent and all — bypassing this
      // function's projection entirely.
      [/\bgrant\b[^;]*\bon\s+table\b/i, "grant on table"],
      [/\bgrant\b[^;]*\bon\s+all\s+tables\b/i, "grant on all tables"],
      [/\bgrant\b[^;]*\bservice_role\b/i, "grant to service_role"],
      [/\bsecurity\s+invoker\b/i, "security invoker"],
      // RLS must not be relaxed to make this read possible; it is SECURITY DEFINER precisely
      // so that no policy has to change.
      [/\bdisable\s+row\s+level\s+security\b/i, "disable row level security"],
      [/\benable\s+row\s+level\s+security\b/i, "enable row level security"],
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

  test("3. writes nothing at all — least of all an audit row", () => {
    // An audit-log READ that could write an audit row would be able to forge history. This is
    // the sharpest rule of the milestone and is asserted per-table rather than generically.
    for (const table of [
      "public.audit_logs",
      "public.profiles",
      "public.organization_members",
      "public.organizations",
      "public.permissions",
      "public.role_permissions",
      "public.roles",
      "public.member_roles",
      "public.vendor_products",
      "public.vendor_retailers",
      "public.retailer_invitations",
      "public.retailer_staff_invitations",
    ]) {
      const escaped = table.replace(/\./g, "\\.");
      assert.ok(
        !new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+${escaped}\\b`, "i").test(CODE),
        `migration must not write to ${table}`,
      );
    }

    // And it declares itself unable to: STABLE is enforced by PostgreSQL at execution time.
    assert.match(statement(), /\bstable\b/i, "the function must be declared STABLE");
    assert.ok(
      !/\bvolatile\b/i.test(statement()),
      "the function must not be VOLATILE — that is the volatility a writer needs",
    );
  });

  test("4. seeds no permission and invents no authorization vocabulary", () => {
    // AUDIT_LOGS_READ already exists (20260716133023) and is already mapped to
    // VENDOR_SUPER_ADMIN. A read contract that quietly seeded or renamed a permission would be
    // a privilege change dressed as a feature.
    const seedSql = readFileSync(join(MIGRATIONS_DIR, SEED_MIGRATION), "utf8");
    assert.ok(
      seedSql.includes("'AUDIT_LOGS_READ'"),
      "AUDIT_LOGS_READ must already be seeded by the shipped seed migration",
    );

    // Every SCREAMING_CASE literal in executable SQL, classified. Anything left over would be
    // vocabulary this migration invented.
    const ACTOR_TYPES = new Set(["USER", "SYSTEM", "UNKNOWN"]);
    const ENTITY_TYPES = new Set([
      "VENDOR_PRODUCT",
      "RETAILER_ORGANIZATION",
      "RETAILER_SHOP",
      "RETAILER_INVITATION",
      "RETAILER_STAFF_INVITATION",
    ]);

    const referenced = new Set(
      (CODE.match(/'[A-Z][A-Z_]{3,}'/g) ?? [])
        .map((literal) => literal.slice(1, -1))
        .filter((literal) => !ACTOR_TYPES.has(literal) && !ENTITY_TYPES.has(literal)),
    );

    assert.deepEqual(
      [...referenced].sort(),
      ["AUDIT_LOGS_READ"],
      "the only permission code the migration may name is the real, already-seeded AUDIT_LOGS_READ",
    );

    // The entity types it DOES name must all be ones the shipped writers actually write. An
    // entity type in the whitelist that nothing produces would be a speculative category.
    const allMigrations = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && file !== MIGRATION_NAME)
      .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");

    for (const entityType of ENTITY_TYPES) {
      assert.ok(
        allMigrations.includes(`'${entityType}'`),
        `${entityType} must be an entity type a shipped writer actually records — not a speculative category`,
      );
    }
  });

  test("5. modifies no previously applied migration", () => {
    // A forward-only history is the whole reason a migration can be trusted to describe the
    // deployed database. Enforced structurally: no OTHER migration file may mention this
    // migration's new object.
    const others = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && file !== MIGRATION_NAME)
      .sort();

    for (const other of others) {
      const text = readFileSync(join(MIGRATIONS_DIR, other), "utf8");
      assert.ok(
        !text.includes(`public.${READ_NAME}`),
        `${other} must not reference public.${READ_NAME} — that object is introduced by ${MIGRATION_NAME}`,
      );
    }
  });

  test("6. the audit table, its policy and its grants are still exactly as deployed", () => {
    const tableSql = readFileSync(join(MIGRATIONS_DIR, AUDIT_TABLE_MIGRATION), "utf8");
    const rlsSql = readFileSync(join(MIGRATIONS_DIR, RLS_MIGRATION), "utf8");

    assert.ok(
      tableSql.includes("create table public.audit_logs"),
      "the audit table migration must still create public.audit_logs",
    );
    assert.ok(
      rlsSql.includes("create policy audit_logs_select_authorized"),
      "the RLS migration must still create audit_logs_select_authorized",
    );

    // This migration must not touch either.
    assert.ok(
      !/audit_logs_select_authorized/i.test(CODE),
      "this migration must not reference, alter or replace the shipped RLS policy",
    );
    assert.ok(
      !/audit_logs_(org_created|actor_created|entity|created)_idx/i.test(CODE),
      "this migration must not create or alter any audit_logs index",
    );
  });
});

// ============================================================================
// The signature: no identity, no tenant, no authorization input
// ============================================================================
describe("mobile Vendor Audit Log reads — inputs", () => {
  test("7. the signature is exactly the documented one", () => {
    assert.deepEqual(
      inputArgs(),
      EXPECTED_INPUTS,
      "the only inputs are a page size and a two-part cursor",
    );

    assert.match(
      signature(),
      /p_limit\s+integer/i,
      "p_limit is an integer",
    );
    assert.match(
      signature(),
      /p_before_occurred_at\s+timestamptz/i,
      "the cursor timestamp matches the ordering column's type",
    );
    assert.match(
      signature(),
      /p_before_audit_log_id\s+uuid/i,
      "the cursor id matches audit_logs.id's type",
    );
  });

  test("8. no input names an identity, tenant, role or permission", () => {
    // The security property, stated as a prohibition rather than as an allow-list, so a FOURTH
    // parameter added later is caught even though test 7 would also catch it.
    const FORBIDDEN = /user|profile|member|organization|org_|tenant|vendor|role|permission|actor|auth|email|token/i;

    for (const arg of inputArgs()) {
      assert.ok(
        !FORBIDDEN.test(arg),
        `input \`${arg}\` must not name a user, profile, membership, organization, tenant, Vendor, role, permission, actor, auth identity, email or token`,
      );
    }
  });

  test("9. the Vendor is DERIVED from auth.uid(), never accepted", () => {
    assert.match(
      body(),
      /get_vendor_super_admin_context\s*\(\s*\)/i,
      "the Vendor must come from the existing zero-argument context helper",
    );
    // The helper takes no arguments, so there is nothing for a caller to influence. Asserting
    // the empty parens is what makes that a checked property rather than a convention.
    assert.ok(
      !/get_vendor_super_admin_context\s*\(\s*[^)\s]/i.test(body()),
      "get_vendor_super_admin_context() must be called with no arguments",
    );

    // The shipped multi-Vendor rule, reproduced verbatim rather than redesigned.
    assert.match(
      body(),
      /order\s+by\s+ctx\.organization_id\s+limit\s+1/i,
      "multi-Vendor selection must be the shipped lowest-organization-id rule",
    );
  });

  test("10. authorization is DELEGATED, and fails closed", () => {
    assert.match(
      body(),
      /has_organization_permission\s*\(\s*v_vendor\s*,\s*'AUDIT_LOGS_READ'\s*\)/i,
      "the permission check must delegate to the existing helper with the real code",
    );
    assert.match(
      body(),
      /if\s+v_vendor\s+is\s+null[\s\S]{0,200}?raise\s+exception/i,
      "an unresolved Vendor must raise, not fall through to a query",
    );
    assert.match(
      body(),
      /errcode\s*=\s*'insufficient_privilege'/i,
      "the denial must be the standard 42501",
    );

    // The refusal must be evaluated BEFORE any parameter validation, so probing the argument
    // rules cannot distinguish an unauthorized caller from an authorized one.
    const authIndex = body().search(/errcode\s*=\s*'insufficient_privilege'/i);
    const paramIndex = body().search(/errcode\s*=\s*'invalid_parameter_value'/i);
    assert.ok(authIndex !== -1 && paramIndex !== -1, "both error classes must be present");
    assert.ok(
      authIndex < paramIndex,
      "authorization must be decided before any argument is validated",
    );

    // Authorization is never re-derived per row: exactly one context lookup, one permission
    // check, and neither inside the returned query.
    assert.equal(
      (body().match(/get_vendor_super_admin_context/gi) ?? []).length,
      1,
      "the Vendor context is resolved exactly once per call, never per row",
    );
    assert.equal(
      (body().match(/has_organization_permission/gi) ?? []).length,
      1,
      "the permission is checked exactly once per call, never per row",
    );
  });
});

// ============================================================================
// Hardening and privileges
// ============================================================================
describe("mobile Vendor Audit Log reads — hardening", () => {
  test("11. is a correctly-hardened SECURITY DEFINER function", () => {
    const declaration = statement();
    assert.match(declaration, /\bsecurity\s+definer\b/i, "must be SECURITY DEFINER");
    assert.match(declaration, /\bstable\b/i, "must be STABLE");
    assert.match(
      declaration,
      /set\s+search_path\s*=\s*''/i,
      "must pin an EMPTY search_path",
    );
  });

  test("12. every object reference in the body is schema-qualified", () => {
    // Under an empty search_path an unqualified reference cannot resolve at all, so this is a
    // correctness property as much as a security one.
    for (const object of [
      "audit_logs",
      "organization_members",
      "profiles",
      "get_vendor_super_admin_context",
      "has_organization_permission",
    ]) {
      const qualified = new RegExp(`public\\.${object}\\b`, "i");
      assert.match(body(), qualified, `${object} must be referenced as public.${object}`);

      // No BARE occurrence anywhere: every match must be preceded by `public.`.
      const bare = new RegExp(`(^|[^.\\w])${object}\\b`, "gi");
      for (const match of body().matchAll(bare)) {
        const prefix = body().slice(Math.max(0, match.index - 8), match.index + match[0].length);
        assert.ok(
          /public\.\w+$/.test(prefix.trimEnd()) || /public\.$/.test(prefix.slice(0, -object.length)),
          `every reference to ${object} must be schema-qualified (found: ...${prefix})`,
        );
      }
    }
  });

  test("13. privileges are explicit and exact", () => {
    const escaped = READ_ARGS.replace(/\s/g, "\\s*");
    const fn = `public\\.${READ_NAME}\\s*\\(\\s*${escaped}\\s*\\)`;

    assert.match(
      CODE,
      new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${fn}\\s+from\\s+public`, "i"),
      "PUBLIC's default EXECUTE must be revoked",
    );
    assert.match(
      CODE,
      new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+${fn}\\s+from\\s+anon`, "i"),
      "anon must be explicitly revoked",
    );
    assert.match(
      CODE,
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${fn}\\s+to\\s+authenticated`, "i"),
      "authenticated is the only role granted EXECUTE",
    );

    // Exactly one GRANT in the whole migration, and it is that one.
    const grants = CODE.match(/\bgrant\b/gi) ?? [];
    assert.equal(grants.length, 1, "the migration contains exactly one GRANT");

    // service_role is granted nothing: this read derives authority from auth.uid(), which a
    // service-role connection does not have.
    assert.ok(
      !/service_role/i.test(CODE),
      "service_role must not appear — a service-role read would bypass auth.uid() entirely",
    );
  });
});

// ============================================================================
// Pagination: bounded limit, complete cursor, deterministic order
// ============================================================================
describe("mobile Vendor Audit Log reads — pagination", () => {
  test("14. the limit has a literal default and a literal hard maximum", () => {
    assert.match(
      signature(),
      new RegExp(`p_limit\\s+integer\\s+default\\s+${DEFAULT_LIMIT}\\b`, "i"),
      `the declared default page size must be ${DEFAULT_LIMIT}`,
    );

    // A null limit must resolve to the SAME default, so `f()` and `f(null)` cannot differ.
    assert.match(
      body(),
      new RegExp(`coalesce\\s*\\(\\s*p_limit\\s*,\\s*${DEFAULT_LIMIT}\\s*\\)`, "i"),
      `an explicit null limit must also mean ${DEFAULT_LIMIT}`,
    );

    // Bounded at BOTH ends. The low bound is what stops 0 (an empty page indistinguishable
    // from the end of history) and negatives (which are UNBOUNDED in PostgreSQL).
    assert.match(
      body(),
      new RegExp(`v_limit\\s*<\\s*1\\s+or\\s+v_limit\\s*>\\s*${MAX_LIMIT}`, "i"),
      `the limit must be rejected outside 1..${MAX_LIMIT}`,
    );
    assert.match(
      body(),
      /errcode\s*=\s*'invalid_parameter_value'/i,
      "an out-of-range limit must raise a documented validation failure",
    );

    // The query is limited by the VALIDATED variable, never by the raw parameter.
    assert.match(body(), /limit\s+v_limit\s*;/i, "the query must be bounded by v_limit");
    assert.ok(
      !/limit\s+p_limit\b/i.test(body()),
      "the query must never be bounded by the unvalidated parameter",
    );
  });

  test("15. the cursor is all-or-nothing", () => {
    // Exactly the both-or-neither test. A half cursor silently completed with a default would
    // present a rewound list as a continuation, which is how a paginating client loses rows.
    assert.match(
      body(),
      /\(\s*p_before_occurred_at\s+is\s+null\s*\)\s*<>\s*\(\s*p_before_audit_log_id\s+is\s+null\s*\)/i,
      "supplying exactly one cursor part must be detected",
    );
  });

  test("16. the ordering and the cursor use the SAME two columns", () => {
    // This is THE property that makes the pagination correct. If the ORDER BY and the cursor
    // predicate ever disagree on their columns or their direction, adjacent pages duplicate or
    // skip rows — silently, and only at a tie.
    assert.match(
      body(),
      /order\s+by\s+a\.created_at\s+desc\s*,\s*a\.id\s+desc/i,
      "the ordering must be (created_at DESC, id DESC) — a total order",
    );
    assert.match(
      body(),
      /\(\s*a\.created_at\s*,\s*a\.id\s*\)\s*<\s*\(\s*p_before_occurred_at\s*,\s*p_before_audit_log_id\s*\)/i,
      "the cursor predicate must be a row comparison over the same two columns",
    );

    // Strictly less-than, so the cursor row itself is never re-emitted on the next page.
    assert.ok(
      !/\(\s*a\.created_at\s*,\s*a\.id\s*\)\s*<=/i.test(body()),
      "the cursor comparison must be strict — `<=` would duplicate the cursor row",
    );

    // And no OFFSET anywhere: offset over an indefinitely growing table is the failure mode
    // this whole contract exists to avoid.
    assert.ok(
      !/\boffset\b/i.test(body()),
      "the query must not use OFFSET — it re-walks skipped rows and shifts under inserts",
    );
  });

  test("17. the tenant predicate is the derived Vendor, and the cursor cannot replace it", () => {
    assert.match(
      body(),
      /where\s+a\.organization_id\s*=\s*v_vendor/i,
      "the tenant boundary must compare against the Vendor derived from auth.uid()",
    );
    // The cursor is ANDed after it, never ORed with it — an OR would let a cursor widen the
    // row set instead of narrowing it.
    const where = body().slice(body().search(/where\s+a\.organization_id/i));
    const clause = where.slice(0, where.search(/order\s+by/i));
    assert.ok(
      !/\bor\b/i.test(clause.replace(/p_before_occurred_at\s+is\s+null\s*\n?\s*or/gi, "")),
      "the only OR in the WHERE clause is the null-cursor short-circuit",
    );
    assert.ok(
      !/organization_id\s*=\s*p_/i.test(body()),
      "the tenant predicate must never compare against a parameter",
    );
  });
});

// ============================================================================
// The output contract, and what may never appear in it
// ============================================================================
describe("mobile Vendor Audit Log reads — output", () => {
  test("18. the output is exactly the seven agreed columns, in order", () => {
    assert.deepEqual(outputColumns(), EXPECTED_OUTPUTS);
  });

  test("19. no output column names a sensitive or internal field", () => {
    const FORBIDDEN: [RegExp, string][] = [
      [/email/i, "an email address"],
      [/phone|mobile/i, "a phone number"],
      [/token|hash|secret|password|credential/i, "an invitation token, hash or credential"],
      [/session|jwt|claim|refresh|access_token/i, "session or token material"],
      [/\bip\b|ip_address|ipaddr/i, "an IP address"],
      [/user_agent|useragent/i, "a user agent"],
      [/metadata|payload|raw/i, "raw metadata"],
      [/old_value|new_value|old_values|new_values|diff/i, "old/new value JSON"],
      [/storage|bucket|url|signed|receipt|path/i, "a storage reference"],
      [/profile_id|user_id|auth_id|membership_id|member_id/i, "an identity id"],
      [/organization_id|tenant|vendor_id/i, "a tenant id"],
      [/policy|search_path|service_role/i, "an authorization internal"],
    ];

    for (const column of outputColumns()) {
      for (const [pattern, label] of FORBIDDEN) {
        assert.ok(
          !pattern.test(column),
          `output column \`${column}\` must not expose ${label}`,
        );
      }
    }
  });

  test("20. the sensitive audit_logs columns are never SELECTED", () => {
    // Stronger than "not returned": a column that is never read cannot leak from a future
    // refactor, a log line, or an error payload either.
    for (const column of ["ip_address", "user_agent", "entity_id"]) {
      assert.ok(
        !new RegExp(`\\ba\\.${column}\\b`, "i").test(body()),
        `audit_logs.${column} must never be selected`,
      );
    }

    // actor_profile_id IS the auth user id (public.profiles.id is a 1:1 FK to auth.users). It
    // may be TESTED for null and JOINED on, but must never reach the returns table.
    const selectList = body().slice(
      body().search(/return\s+query/i),
      body().search(/from\s+public\.audit_logs/i),
    );
    assert.ok(
      !/a\.actor_profile_id\s*,/i.test(selectList),
      "actor_profile_id must never be emitted — it is the auth user id",
    );
    assert.ok(
      !/a\.organization_id\s*,/i.test(selectList),
      "organization_id must never be emitted",
    );
    assert.ok(
      !/a\.metadata\s*(,|$)/im.test(selectList),
      "the metadata object must never be emitted whole",
    );

    // auth.users is never touched: profiles.id already IS the auth user id, so there is no
    // reason to reach into the auth schema, and every reason not to.
    assert.ok(!/\bauth\.users\b/i.test(CODE), "auth.users must never be queried");
    assert.ok(
      !/\bauth\.\w+/i.test(CODE.replace(/auth\.uid\s*\(/gi, "")),
      "the only auth-schema reference permitted is auth.uid()",
    );
  });

  test("21. metadata is read through a CLOSED whitelist, guarded by a JSON type check", () => {
    // The single property that stops unrestricted jsonb from reaching a client.
    const extractions = [...body().matchAll(/a\.metadata\s*->>?\s*([^\s),]+)/g)].map((m) => m[1]);
    assert.ok(extractions.length > 0, "the migration must extract from metadata");

    // Every extraction goes through the whitelist variable, never through a literal key or a
    // parameter — so the set of readable keys is fixed by the CASE expression alone.
    for (const key of extractions) {
      assert.equal(
        key,
        "snap.key",
        `metadata may only be read through the whitelist expression, not via \`${key}\``,
      );
    }

    // The whitelist itself, read from the `snap` lateral ALONE — not from the whole body,
    // which also contains the actor_type CASE and would otherwise contribute its labels.
    const lateral = body().match(
      /cross\s+join\s+lateral\s*\(([\s\S]*?)\)\s*snap\b/i,
    );
    assert.ok(lateral, "the whitelist must live in its own `snap` lateral");

    const mappings = [...lateral[1].matchAll(/when\s+'([A-Z_]+)'\s+then\s+'([a-z_]+)'/g)];
    assert.equal(
      mappings.length,
      5,
      "the whitelist must map exactly the five entity types a shipped writer records",
    );

    assert.deepEqual(
      [...new Set(mappings.map((m) => m[2]))].sort(),
      ["product_name", "retailer_name", "shop_name"],
      "the whitelist may contain only display-NAME keys",
    );
    assert.deepEqual(
      mappings.map((m) => m[1]).sort(),
      [
        "RETAILER_INVITATION",
        "RETAILER_ORGANIZATION",
        "RETAILER_SHOP",
        "RETAILER_STAFF_INVITATION",
        "VENDOR_PRODUCT",
      ],
      "and it may key on only the five real entity types",
    );

    // No ELSE branch, so an entity type the whitelist does not know yields null rather than
    // falling through to whichever key happens to be last.
    assert.ok(
      !/\belse\b/i.test(lateral[1]),
      "the whitelist must have no ELSE — an unknown entity type must yield a null key",
    );

    // The type guard. Without it, `->>` on an object returns that object's raw JSON text —
    // which is exactly the raw-metadata leak this contract forbids.
    assert.match(
      body(),
      /jsonb_typeof\s*\(\s*a\.metadata\s*->\s*snap\.key\s*\)\s*=\s*'string'/i,
      "a non-string metadata value must not be stringified into the name",
    );

    // A blank snapshot reads as "not named", so a client's null check is the only check.
    assert.match(
      body(),
      /nullif\s*\(\s*btrim\s*\(/i,
      "a blank snapshot must normalise to null",
    );
  });

  test("22. the actor join is scoped to the audit row's own Vendor", () => {
    // This function is SECURITY DEFINER, so an UNSCOPED join to public.profiles would bypass
    // the profiles RLS policy and could print a person from a different organization onto a
    // Vendor's audit screen. The membership predicate is the privacy boundary.
    assert.match(
      body(),
      /from\s+public\.organization_members\s+m[\s\S]{0,200}?join\s+public\.profiles\s+p\s+on\s+p\.id\s*=\s*m\.user_id/i,
      "profiles must be reached THROUGH organization_members, never directly",
    );
    assert.match(
      body(),
      /m\.organization_id\s*=\s*v_vendor/i,
      "the actor must be scoped to the derived Vendor's own membership",
    );

    // LEFT joins throughout: an audit log that drops records with incomplete context is not an
    // audit log.
    assert.match(
      body(),
      /left\s+join\s+lateral/i,
      "the actor lookup must be a LEFT join so an unresolvable actor cannot remove the row",
    );

    // Only the two name columns are read from profiles — no email, no mobile_number, no status.
    const actorJoin = body().slice(body().search(/left\s+join\s+lateral/i));
    assert.match(
      actorJoin.slice(0, 200),
      /select\s+p\.first_name\s*,\s*p\.last_name\b/i,
      "only the two name columns may be read from profiles",
    );
    assert.ok(
      !/p\.(mobile_number|status|created_at|updated_at)\b/i.test(body()),
      "no other profile column may be read",
    );
  });

  test("23. actor_type is a closed, documented set", () => {
    const actorTypes = new Set(
      (body().match(/'(USER|SYSTEM|UNKNOWN)'/g) ?? []).map((m) => m.slice(1, -1)),
    );
    assert.deepEqual(
      [...actorTypes].sort(),
      ["SYSTEM", "UNKNOWN", "USER"],
      "actor_type must be exactly the three documented values",
    );
  });

  test("24. no action or entity code is mapped, defaulted or hidden", () => {
    // The action and entity_type columns must be emitted RAW. A CASE over a.action would be a
    // mapping; a coalesce would be a default; a WHERE on it would be hiding.
    assert.ok(
      !/case[\s\S]{0,120}?a\.action\b/i.test(body()),
      "the action code must not be mapped through a CASE",
    );
    assert.ok(
      !/coalesce\s*\(\s*a\.(action|entity_type)\b/i.test(body()),
      "no action or entity code may be defaulted",
    );
    assert.ok(
      !/\ba\.action\s*(=|<>|in|not\s+in|like|~)/i.test(body()),
      "no action code may be filtered out — an unknown action must stay visible",
    );

    // entity_type IS used in the snapshot CASE, which is a display lookup and not a mapping of
    // the emitted value. The emitted value itself must still be the raw column.
    const selectList = body().slice(
      body().search(/return\s+query/i),
      body().search(/from\s+public\.audit_logs/i),
    );
    assert.match(selectList, /^\s*a\.action\s*,/m, "action is emitted as the raw column");
    assert.match(selectList, /^\s*a\.entity_type\s*,/m, "entity_type is emitted as the raw column");
  });
});

// ============================================================================
// Web compatibility
// ============================================================================
describe("mobile Vendor Audit Log reads — web compatibility", () => {
  test("25. the web Audit Logs module still performs its own reads, unchanged", () => {
    // The milestone forbids migrating the web in this PR. The web must still call the tables
    // directly and must NOT have been rewired to the new RPC.
    assert.ok(
      WEB_MODULE.includes('.from("audit_logs")'),
      "the web module must still read public.audit_logs directly",
    );
    assert.ok(
      WEB_MODULE.includes('.from("profiles")'),
      "the web module must still resolve actor names itself",
    );
    assert.ok(
      !WEB_MODULE.includes(READ_NAME),
      `the web module must NOT call ${READ_NAME} — the web is not migrated in this milestone`,
    );
    assert.ok(
      !WEB_PAGE.includes(READ_NAME),
      `the web page must NOT call ${READ_NAME}`,
    );

    // Its exported shape — what the page renders — is untouched.
    for (const field of ["occurredAt", "actorDisplayName", "action", "entityType"]) {
      assert.ok(
        WEB_MODULE.includes(field),
        `the web module must still expose ${field}`,
      );
    }
    assert.ok(
      WEB_MODULE.includes("getVendorSuperAdminAccess"),
      "the web module must still delegate authorization to the shipped helper",
    );
  });

  test("26. the web still selects only its four non-sensitive audit columns", () => {
    // The web's narrowness is a security property of the shipped product, and this milestone
    // must not have widened it as a side effect.
    assert.ok(
      WEB_MODULE.includes('.select("actor_profile_id, action, entity_type, created_at")'),
      "the web audit query must still select exactly its four columns",
    );
    for (const column of ["ip_address", "user_agent", "metadata", "entity_id"]) {
      assert.ok(
        !new RegExp(`select\\([^)]*${column}`, "i").test(WEB_MODULE),
        `the web module must still never select ${column}`,
      );
    }
  });
});
