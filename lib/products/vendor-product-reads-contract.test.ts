/**
 * STATIC CONTRACT GUARDS for the mobile Vendor Product reads
 * (supabase/migrations/20260803090000_mobile_vendor_product_reads.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * lib/rbac/vendor-role-reads-contract.test.ts, lib/members/vendor-user-reads-contract.test.ts,
 * lib/retailers/vendor-retailer-reads-contract.test.ts and
 * lib/portal/portal-context-contract.test.ts. They read the SQL and assert structural
 * properties that a careless later edit could silently break.
 *
 * They do NOT execute the functions. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_product_reads_test.sql — pgTAP, 180 assertions, covering
 * every role denial, inactive callers, the split permission requirement proved by REMOVING a
 * seeded mapping, field and status accuracy on both a fully-populated and an all-null
 * product, the exact assignment-count semantics against four status combinations, the
 * count-equals-companion-rows invariant, tenant isolation in both directions, the non-leaking
 * zero-row answer for unknown, foreign-table and null ids, stable ordering under a duplicated
 * Retailer name, and the proof that the two reads write nothing. It requires Docker and is
 * run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of properties
 * decidable from the source, and which would be a SECURITY or CONTRACT regression rather than
 * a behavioural one:
 *
 *   1. The migration is new, forward-only, and edits no applied migration.
 *   2. It adds two functions and nothing else — no table, policy, index, grant on a table,
 *      seed row, permission, role mapping, or write of any kind. In particular it changes no
 *      product and no assignment.
 *   3. Neither function accepts identity, Vendor, tenant, role-code, permission-code, status
 *      or Retailer-organization input, and the one selector it does accept is the product id.
 *   4. Both functions are correctly-hardened, read-only SECURITY DEFINER.
 *   5. Privileges are explicit and exact: authenticated only, never anon, never PUBLIC, never
 *      service_role.
 *   6. The output columns are exactly the agreed contract; the detail set is the shipped list
 *      set plus `assignment_count` and nothing else; and no authentication field, contact
 *      field, invitation field, storage reference, image reference or fabricated commercial
 *      field appears in any of them.
 *   7. Authorization is DELEGATED to the existing helpers rather than reimplemented, and is
 *      split by least privilege: the read that returns Retailer identity requires
 *      RETAILERS_READ as well as PRODUCTS_READ; the one that returns only counts does not.
 *   8. The counts are a single set-based lateral aggregate, so neither read can be N+1 or
 *      duplicate a product, and the assignment list is driven from the assignment table so
 *      its row count is the count.
 *   9. The web Products pages and their module are untouched, and the RPCs they call keep
 *      their exact names.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const MIGRATION_NAME = "20260803090000_mobile_vendor_product_reads.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

/** The already-deployed migration that owns list_vendor_products() and the web's write path. */
const CATALOG_MIGRATION_NAME = "20260727210000_vendor_product_catalog_operations.sql";

const SQL = readFileSync(MIGRATION_PATH, "utf8");
const CATALOG_SQL = readFileSync(join(MIGRATIONS_DIR, CATALOG_MIGRATION_NAME), "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose discusses the very patterns some of these tests forbid (it
 * explains why a Retailer organization id must not be an input, why there is no image column,
 * and which permission the EXISTING editor read demands). Asserting against the raw text
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
const CATALOG_CODE = stripComments(CATALOG_SQL);

/** The two functions this migration creates, and the signature each must carry. */
const READS = [
  { name: "get_vendor_product_detail", args: "uuid" },
  { name: "list_vendor_product_assigned_retailers", args: "uuid" },
] as const;

/**
 * The read that returns Retailer identity and relationship state, and therefore reads
 * public.organizations and public.vendor_retailers. get_vendor_product_detail is deliberately
 * NOT here: it returns two integers about Retailers and no Retailer, so demanding the
 * Retailer directory permission of it would be asking for a privilege it has no use for.
 */
const RETAILER_TOUCHING_READ = "list_vendor_product_assigned_retailers";

/**
 * The `create function` statement for one function, from its CREATE through the closing `$$;`
 * of its body. Everything asserted per-function is asserted against this slice rather than
 * the whole file, so a clause belonging to one function can never satisfy an assertion about
 * another.
 */
function statementFrom(source: string, name: string): string {
  const start = source.search(new RegExp(`create\\s+function\\s+public\\.${name}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `migration must create public.${name}`);
  const end = source.indexOf("$$;", start);
  assert.notEqual(end, -1, `public.${name} must have a $$-quoted body`);
  return source.slice(start, end);
}

function statementFor(name: string): string {
  return statementFrom(CODE, name);
}

/** The `returns table (...)` column names of one function, in declaration order. */
function columnsOf(statement: string, name: string): string[] {
  const match = statement.match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  assert.ok(match, `public.${name} must declare a returns table (...) contract`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((entry) => entry.length > 0);
}

function outputColumns(name: string): string[] {
  return columnsOf(statementFor(name), name);
}

/**
 * The shipped list contract, parsed from the migration that owns it rather than restated
 * here. That is what makes "the detail is the list plus one column" a structural relationship
 * instead of two literals free to drift.
 */
function shippedListColumns(): string[] {
  return columnsOf(
    statementFrom(CATALOG_CODE, "list_vendor_products"),
    "list_vendor_products",
  );
}

/** Every output column of both new reads, flattened. */
function allOutputColumns(): { read: string; column: string }[] {
  return READS.flatMap((read) =>
    outputColumns(read.name).map((column) => ({ read: read.name, column })),
  );
}

// ============================================================================
// Migration hygiene
// ============================================================================
describe("mobile Vendor Product reads — migration hygiene", () => {
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
      "20260716131104_vendor_admin_authorization_helpers.sql",
      "20260717083515_vendor_super_admin_context.sql",
      "20260717094520_retailer_core_tables.sql",
      "20260717115211_seed_retailer_read_permission.sql",
      "20260727090000_vendor_product_catalog_foundation.sql",
      CATALOG_MIGRATION_NAME,
    ];

    for (const dependency of DEPENDENCIES) {
      assert.ok(applied.includes(dependency), `declared dependency ${dependency} is missing`);
      assert.ok(
        dependency < MIGRATION_NAME,
        `${MIGRATION_NAME} must sort after its dependency ${dependency}`,
      );
    }
  });

  test("2. adds two functions and changes nothing that already exists", () => {
    const forbidden: [RegExp, string][] = [
      [/\bcreate\s+table\b/i, "create table"],
      [/\balter\s+table\b/i, "alter table"],
      [/\balter\s+policy\b/i, "alter policy"],
      [/\bdrop\s+/i, "drop"],
      [/\bcreate\s+policy\b/i, "create policy"],
      [/\bcreate\s+trigger\b/i, "create trigger"],
      [/\bcreate\s+index\b/i, "create index"],
      [/\bcreate\s+or\s+replace\b/i, "create or replace"],
      [/\binsert\s+into\b/i, "insert into"],
      [/\bdelete\s+from\b/i, "delete from"],
      [/\btruncate\b/i, "truncate"],
      [/\bexecute\s+format\b/i, "dynamic SQL"],
      // The one that matters most for a "make the mobile read easier" regression: a direct
      // table grant would let a client bypass these functions entirely, and both product
      // tables ship default-deny with zero policies.
      [/\bgrant\b[^;]*\bon\s+table\b/i, "grant on table"],
      [/\bgrant\b[^;]*\bon\s+all\s+tables\b/i, "grant on all tables"],
      [/\bsecurity\s+invoker\b/i, "security invoker"],
      // RLS must not be relaxed anywhere to make these reads possible; they are SECURITY
      // DEFINER precisely so that no policy has to change.
      [/\bdisable\s+row\s+level\s+security\b/i, "disable row level security"],
      [/\benable\s+row\s+level\s+security\b/i, "enable row level security"],
      [/\bforce\s+row\s+level\s+security\b/i, "force row level security"],
    ];

    for (const [pattern, label] of forbidden) {
      assert.ok(
        !pattern.test(CODE),
        `migration must not contain \`${label}\` — it adds two functions and changes nothing that exists`,
      );
    }

    const creates = CODE.match(/\bcreate\s+function\b/gi) ?? [];
    assert.equal(creates.length, READS.length, "exactly two functions are created");
  });

  test("3. seeds no permission and alters no role→permission mapping", () => {
    // This milestone's sharpest rule: a read contract that quietly granted a permission — or
    // invented one — would be a privilege change dressed as a feature. PRODUCTS_READ and
    // RETAILERS_READ both already exist and are both already mapped to VENDOR_SUPER_ADMIN.
    for (const table of [
      "public.permissions",
      "public.role_permissions",
      "public.roles",
      "public.member_roles",
      "public.organization_members",
      "public.vendor_products",
      "public.vendor_product_retailer_assignments",
      "public.vendor_retailers",
      "public.organizations",
      "public.audit_logs",
    ]) {
      const escaped = table.replace(".", "\\.");
      assert.ok(
        !new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+${escaped}\\b`, "i").test(CODE),
        `migration must not write to ${table}`,
      );
    }

    // And it must not name a permission code that does not already exist, which would mean
    // inventing authorization vocabulary. Only the two real ones may appear. 'ACTIVE' is
    // excluded because it is a STATUS value, not a permission — it appears exactly once, in
    // the active-count filter, and test 36 pins it there.
    const STATUS_VOCABULARY = new Set(["ACTIVE", "INACTIVE", "SUSPENDED", "DEACTIVATED"]);
    const referenced = new Set(
      (CODE.match(/'[A-Z][A-Z_]{3,}'/g) ?? [])
        .map((literal) => literal.slice(1, -1))
        .filter((literal) => !STATUS_VOCABULARY.has(literal)),
    );
    assert.deepEqual(
      [...referenced].sort(),
      ["PRODUCTS_READ", "RETAILERS_READ"],
      "the migration may reference exactly the two existing permission codes it requires, and no other SCREAMING_CASE literal",
    );
  });

  test("4. modifies no previously applied migration", () => {
    // A forward-only history is the whole reason a migration can be trusted to describe the
    // deployed database. This test states the rule; `git diff --check` and the branch review
    // confirm nothing else in supabase/migrations was edited. Here it is enforced
    // structurally: no OTHER migration file may mention this migration's new objects.
    const others = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && file !== MIGRATION_NAME)
      .sort();

    for (const other of others) {
      const text = readFileSync(join(MIGRATIONS_DIR, other), "utf8");
      for (const read of READS) {
        assert.ok(
          !text.includes(`public.${read.name}`),
          `${other} must not reference public.${read.name} — that object is introduced by ${MIGRATION_NAME}`,
        );
      }
    }
  });

  test("5. the shipped product operations are still exactly as deployed", () => {
    // The existing catalogue migration owns the eight functions the web depends on, including
    // the list this milestone REUSES and the assignment editor read it deliberately does not
    // replace. If this branch had edited any of them, it would have edited an applied
    // migration — which is the one thing a forward-only history forbids.
    for (const shipped of [
      "list_vendor_products",
      "create_vendor_product",
      "update_vendor_product",
      "set_vendor_product_status",
      "list_vendor_product_retailer_assignments",
      "assign_vendor_product_to_retailer",
      "unassign_vendor_product_from_retailer",
      "list_retailer_assigned_products",
    ]) {
      assert.ok(
        new RegExp(`create\\s+function\\s+public\\.${shipped}\\s*\\(`, "i").test(CATALOG_CODE),
        `${CATALOG_MIGRATION_NAME} must still create public.${shipped}`,
      );
      assert.ok(
        !new RegExp(`\\b(drop|alter)\\s+function\\s+public\\.${shipped}\\b`, "i").test(CODE),
        `this migration must not drop or alter public.${shipped}`,
      );
      assert.ok(
        !new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${shipped}\\s*\\(`, "i").test(
          CODE,
        ),
        `this migration must not redefine public.${shipped}`,
      );
    }
  });

  test("6. the pgTAP suite for this contract exists", () => {
    // Static guards supplement behavioural tests; they never replace them. A migration whose
    // behavioural suite was deleted would still pass every assertion in this file.
    const suites = readdirSync(join(ROOT, "supabase/tests/database"));
    assert.ok(
      suites.includes("vendor_product_reads_test.sql"),
      "supabase/tests/database/vendor_product_reads_test.sql must exist",
    );

    const suite = readFileSync(
      join(ROOT, "supabase/tests/database/vendor_product_reads_test.sql"),
      "utf8",
    );
    for (const read of READS) {
      assert.ok(
        suite.includes(`public.${read.name}`),
        `the pgTAP suite must exercise public.${read.name}`,
      );
    }
    assert.ok(
      suite.includes("rollback;"),
      "the pgTAP suite must roll its transaction back so no fixture survives",
    );
  });
});

// ============================================================================
// No client-supplied identity, Vendor, or tenant context
// ============================================================================
describe("mobile Vendor Product reads — no client-supplied context", () => {
  test("7. both reads take exactly one product selector, typed uuid", () => {
    for (const read of READS) {
      const signature = statementFor(read.name).match(
        /create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)\s*returns/i,
      );
      assert.ok(signature, `${read.name} must declare a parameter list`);

      const parameters = signature[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      assert.deepEqual(
        parameters.map((entry) => entry.split(/\s+/)[0]),
        ["p_product_id"],
        `${read.name} must take exactly one input, the product selector`,
      );
      assert.match(parameters[0], /\buuid\b/i, "the selector must be a uuid");
    }
  });

  test("8. neither read accepts an identity, tenant, status or Retailer selector", () => {
    // The vulnerability this whole shape exists to prevent: a parameter a browser could set
    // that decides WHOSE data is returned, or what state it is reported to be in.
    //
    // p_retailer_organization_id deserves its own note. It would address an assignment set
    // just as precisely — and that is exactly why it is refused. A Retailer organization id
    // names a tenant that other Vendors may also manage, so accepting one would put the
    // choice of tenant in a client's hands. The product id names one Vendor's own row, is
    // NOT NULL and is immutable by trigger, so it IS the tenant boundary.
    //
    // p_status and p_assignment_status are refused for a different reason: a caller that
    // could filter by status could also be told a status, and the milestone's rule is that a
    // status is only ever reported, never accepted.
    const FORBIDDEN_PARAMETERS = [
      "p_user_id",
      "p_auth_user_id",
      "p_profile_id",
      "p_membership_id",
      "p_email",
      "p_vendor_organization_id",
      "p_vendor_id",
      "p_organization_id",
      "p_retailer_organization_id",
      "p_retailer_id",
      "p_relationship_id",
      "p_tenant_id",
      "p_role",
      "p_role_code",
      "p_permission",
      "p_permission_code",
      "p_actor",
      "p_status",
      "p_product_status",
      "p_assignment_status",
      "p_product_code",
      "p_barcode",
      "p_scope",
      "p_limit",
      "p_offset",
    ];

    for (const read of READS) {
      const signature = statementFor(read.name).match(
        /create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)\s*returns/i,
      );
      assert.ok(signature, `${read.name} must declare a parameter list`);

      for (const forbidden of FORBIDDEN_PARAMETERS) {
        assert.ok(
          !new RegExp(`\\b${forbidden}\\b`, "i").test(signature[1]),
          `${read.name} must not accept ${forbidden} — identity, tenant, authorization vocabulary and status come from the database`,
        );
      }
    }
  });

  test("9. the two reads share one selector name, so they cannot drift into two address spaces", () => {
    // Precisely the defect docs/mobile-backend-contract.md § 6.8 records against the existing
    // pair: an assignment read addressed by Retailer organization id beside Retailer screens
    // addressed by relationship id.
    const [detail, assignments] = READS.map((read) => {
      const signature = statementFor(read.name).match(
        /create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)\s*returns/i,
      );
      assert.ok(signature);
      return signature[1].trim().replace(/\s+/g, " ");
    });
    assert.equal(detail, assignments, "both reads must declare an identical parameter list");
  });

  test("10. every read derives its Vendor from the shared context function", () => {
    // Delegation, not reimplementation. get_vendor_super_admin_context() evaluates the whole
    // chain — ACTIVE profile owned by auth.uid(), ACTIVE membership, ACTIVE VENDOR
    // organization, ACTIVE VENDOR_SUPER_ADMIN role — and these reads inherit all of it, plus
    // the shipped multi-Vendor tie-break, by calling it rather than restating it.
    for (const read of READS) {
      const body = statementFor(read.name);
      assert.match(
        body,
        /public\.get_vendor_super_admin_context\s*\(\s*\)/,
        `${read.name} must derive its Vendor from public.get_vendor_super_admin_context()`,
      );
      assert.match(
        body,
        /order\s+by\s+ctx\.organization_id\s*\n?\s*limit\s+1/i,
        `${read.name} must apply the same deterministic multi-Vendor tie-break every other Vendor RPC applies`,
      );
    }
  });

  test("11. the permission requirement is split by least privilege", () => {
    // Each function requires exactly the permissions the tables it actually reads would
    // demand:
    //
    //   PRODUCTS_READ    vendor_products, vendor_product_retailer_assignments  — both reads
    //   RETAILERS_READ   organizations, vendor_retailers                       — only the one
    //                                                                            that returns
    //                                                                            Retailer
    //                                                                            identity
    //
    // These functions are SECURITY DEFINER and so run outside RLS; requiring the matching
    // permission explicitly is what stops the contract from being a way to read what the
    // policies would have refused.
    for (const read of READS) {
      assert.match(
        statementFor(read.name),
        /public\.has_organization_permission\s*\(\s*v_vendor\s*,\s*'PRODUCTS_READ'\s*\)/,
        `${read.name} must require PRODUCTS_READ through the shared permission helper`,
      );
    }

    assert.match(
      statementFor(RETAILER_TOUCHING_READ),
      /public\.has_organization_permission\s*\(\s*v_vendor\s*,\s*'RETAILERS_READ'\s*\)/,
      `${RETAILER_TOUCHING_READ} returns Retailer identity and must therefore also require RETAILERS_READ`,
    );

    // And the detail must NOT demand it: it reads no Retailer table, so requiring the
    // Retailer directory permission would be asking for a privilege it has no use for.
    const detail = statementFor("get_vendor_product_detail");
    assert.ok(
      !/RETAILERS_READ/.test(detail),
      "get_vendor_product_detail must not require RETAILERS_READ — it returns counts, not Retailers",
    );
    for (const table of ["public.organizations", "public.vendor_retailers"]) {
      assert.ok(
        !detail.includes(table),
        `get_vendor_product_detail must not read ${table} at all`,
      );
    }

    // Neither read may demand the ASSIGNMENT-WRITE permission. Requiring the permission to
    // CHANGE assignments in order to READ them is exactly what makes the existing editor read
    // unusable as a read contract, and is the reason this milestone exists.
    for (const read of READS) {
      assert.ok(
        !/PRODUCT_RETAILER_ASSIGN|PRODUCTS_MANAGE/.test(statementFor(read.name)),
        `${read.name} must not require a product WRITE permission to perform a read`,
      );
    }
  });

  test("12. neither read reimplements the authorization chain, or names a role code", () => {
    // Restating "is this caller authorized" here would be a SECOND definition, free to drift
    // from the helpers and from the RLS policies — and only one of the two could be right.
    for (const read of READS) {
      const body = statementFor(read.name);
      assert.ok(
        !/'VENDOR_SUPER_ADMIN'|'RETAILER_OWNER'|'RETAILER_MANAGER'|'SALES_STAFF'/.test(body),
        `${read.name} must not name a role code — which role holds these permissions is seed data`,
      );
      assert.ok(
        !/auth\.users/.test(body),
        `${read.name} must not read auth.users — no authentication metadata belongs in this contract`,
      );
      assert.ok(
        !/\bauth\.uid\s*\(/.test(body),
        `${read.name} must reach auth.uid() through the shared context function, not directly`,
      );
      assert.ok(
        !/public\.(profiles|organization_members|member_roles|roles|permissions|role_permissions)\b/.test(
          body,
        ),
        `${read.name} must not read an identity or RBAC table directly — the helpers own that`,
      );
    }
  });

  test("13. ownership is proved against the DERIVED Vendor, never a parameter", () => {
    // This single predicate is the whole tenant boundary: it is what makes another Vendor's
    // product id inert rather than merely unlikely to be guessed.
    for (const read of READS) {
      assert.match(
        statementFor(read.name),
        /vendor_organization_id\s*=\s*v_vendor/,
        `${read.name} must match the product on the Vendor derived from auth.uid()`,
      );
      assert.match(
        statementFor(read.name),
        /\bid\s*=\s*p_product_id\b/,
        `${read.name} must match the product on the supplied id as well`,
      );
      assert.ok(
        !/vendor_organization_id\s*=\s*p_/.test(statementFor(read.name)),
        `${read.name} must never compare a tenant column against a parameter`,
      );
    }
  });
});

// ============================================================================
// SECURITY DEFINER hardening
// ============================================================================
describe("mobile Vendor Product reads — SECURITY DEFINER hardening", () => {
  test("14. both functions are hardened, read-only definer functions", () => {
    for (const read of READS) {
      const statement = statementFor(read.name);
      for (const [clause, label] of [
        [/\bsecurity\s+definer\b/i, "security definer"],
        [/\bset\s+search_path\s*=\s*''/i, "set search_path = ''"],
        [/\bstable\b/i, "stable"],
        [/\blanguage\s+plpgsql\b/i, "language plpgsql"],
      ] as [RegExp, string][]) {
        assert.match(statement, clause, `public.${read.name} must declare ${label}`);
      }
    }
  });

  test("15. neither function writes a product, an assignment, or an audit row", () => {
    // STABLE is the declaration; this is the check. A read that mutated would make a Flutter
    // list refresh a write, and would make these functions unsafe to retry. It would also put
    // a write path behind a read permission.
    for (const read of READS) {
      const statement = statementFor(read.name);
      for (const [pattern, label] of [
        [/\binsert\s+into\b/i, "insert"],
        [/\bupdate\s+public\./i, "update"],
        [/\bdelete\s+from\b/i, "delete"],
        [/\bfor\s+update\b/i, "a row lock"],
        [/\bperform\s+public\.expire_/i, "a hidden expiry sweep"],
        [/audit_logs/i, "an audit write"],
      ] as [RegExp, string][]) {
        assert.ok(!pattern.test(statement), `public.${read.name} must not contain ${label}`);
      }
    }
  });

  test("16. every object reference inside a function body is schema-qualified", () => {
    // An empty search_path makes an unqualified reference a runtime error rather than a
    // hijack risk — but only if it is caught. Every FROM/JOIN target below must name its
    // schema, so nothing can be resolved from an attacker-controlled one.
    for (const read of READS) {
      const statement = statementFor(read.name);
      const targets = statement.match(/\b(from|join)\s+(?!lateral\b)([a-z_][\w.]*)/gi) ?? [];

      // Without this, a regex that stopped matching anything would turn the loop below into a
      // no-op and the test would pass by finding nothing to check.
      assert.ok(
        targets.length > 0,
        `public.${read.name} must contain FROM/JOIN targets for this assertion to mean anything`,
      );

      for (const target of targets) {
        const referenced = target.split(/\s+/)[1];
        assert.ok(
          referenced.includes("."),
          `public.${read.name} references \`${referenced}\` without a schema qualifier`,
        );
      }
    }
  });

  test("17. the denial is generic, identical across both reads, and machine-readable", () => {
    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.match(
        statement,
        /raise\s+exception\s+'Not authorized to view products'\s*\n?\s*using\s+errcode\s*=\s*'insufficient_privilege'/i,
        `${read.name} must fail closed with one generic, machine-readable denial`,
      );

      // The message must not name a table, a column, a policy, a role code or a permission
      // code — the difference between "you are not signed in", "you are not a Vendor Super
      // Admin" and "your role lost RETAILERS_READ" is not a client's business. Every
      // identifier in this schema is either schema-qualified or snake_case, so a message free
      // of `.` and `_` cannot be naming one.
      const messages = statement.match(/raise\s+exception\s+'([^']*)'/gi) ?? [];
      assert.ok(
        messages.length > 0,
        `${read.name} must raise a message for this check to mean anything`,
      );
      for (const message of messages) {
        assert.ok(
          !/[_.]/.test(message.replace(/^raise\s+exception\s+/i, "")),
          `${read.name}'s denial message must not name an internal identifier: ${message}`,
        );
      }
    }

    // The wording is the SAME as the shipped list's, so a caller cannot tell the list, the
    // detail and the companion apart by their denials either.
    assert.ok(
      CATALOG_CODE.includes("'Not authorized to view products'"),
      "the denial must reuse the wording list_vendor_products() already raises",
    );
  });

  test("18. an unaddressable product returns zero rows rather than raising", () => {
    // The non-leaking property: an authorized caller who names something that is not their
    // product gets the same answer for an unknown uuid, another Vendor's product, an id
    // belonging to another table, and null. A distinguishable refusal would confirm that a
    // competitor's product exists, and by sweeping ids, roughly how many.
    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.match(
        statement,
        /if\s+p_product_id\s+is\s+null\s+then\s*\n\s*return\s*;/i,
        `${read.name} must return zero rows for a null selector, not raise`,
      );

      const raises = statement.match(/\braise\s+exception\b/gi) ?? [];
      assert.equal(
        raises.length,
        1,
        `${read.name} must raise exactly once — for authorization — and never for an id it cannot address`,
      );
    }

    // The companion proves ownership with its OWN lookup and returns early; it must not raise
    // when that lookup finds nothing.
    assert.match(
      statementFor(RETAILER_TOUCHING_READ),
      /if\s+v_product\s+is\s+null\s+then\s*\n\s*return\s*;/i,
      "the companion must return zero rows — not raise — for a product it cannot address",
    );
  });
});

// ============================================================================
// Privileges
// ============================================================================
describe("mobile Vendor Product reads — privileges are explicit and exact", () => {
  test("19. every function revokes PUBLIC and anon", () => {
    for (const read of READS) {
      const signature = `public.${read.name}\\(${read.args}\\)`;
      assert.match(
        CODE,
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${signature}\\s+from\\s+public\\s*;`, "i"),
        `${read.name} must revoke ALL from PUBLIC — PostgreSQL grants PUBLIC execute by default and every role inherits it`,
      );
      assert.match(
        CODE,
        new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+${signature}\\s+from\\s+anon\\s*;`, "i"),
        `${read.name} must revoke execute from anon`,
      );
    }
  });

  test("20. every read grants execute to authenticated and to nobody else", () => {
    for (const read of READS) {
      const signature = `public.${read.name}\\(${read.args}\\)`;
      assert.match(
        CODE,
        new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+${signature}\\s+to\\s+authenticated\\s*;`,
          "i",
        ),
        `${read.name} must grant execute to authenticated`,
      );
    }

    // service_role is granted nothing: these reads derive their authority from auth.uid(),
    // which a service-role connection does not have, so a grant would produce a function that
    // can only ever refuse — while suggesting a trusted bypass exists. Flutter calls these
    // directly with the caller's own token, so a service-role-only design is also excluded.
    assert.ok(
      !/\bgrant\b[^;]*\bto\s+service_role\b/i.test(CODE),
      "no function may be granted to service_role",
    );
    assert.ok(!/\bgrant\b[^;]*\bto\s+anon\b/i.test(CODE), "no function may be granted to anon");
    assert.ok(!/\bgrant\b[^;]*\bto\s+public\b/i.test(CODE), "no function may be granted to PUBLIC");
  });

  test("21. every privilege statement names the exact signature it means to affect", () => {
    // A mismatched signature would silently privilege a different overload, or fail to revoke
    // the one that exists.
    const statements = CODE.match(/\b(revoke|grant)\b[^;]*;/gi) ?? [];
    assert.equal(
      statements.length,
      READS.length * 3,
      "each function must carry exactly its revoke-from-public, revoke-from-anon and grant-to-authenticated",
    );

    const known = READS.map((read) => `public.${read.name}(${read.args})`);

    for (const statement of statements) {
      const named = known.some((signature) =>
        statement.replace(/\s+/g, "").includes(signature.replace(/\s+/g, "")),
      );
      assert.ok(
        named,
        `privilege statement must name one of this migration's exact signatures: ${statement.trim()}`,
      );
    }
  });
});

// ============================================================================
// The output contract
// ============================================================================
describe("mobile Vendor Product reads — output contract", () => {
  const DETAIL_COLUMNS = [
    "product_id",
    "product_code",
    "barcode",
    "product_name",
    "brand",
    "description",
    "status",
    "assignment_count",
    "active_assignment_count",
    "created_at",
    "updated_at",
  ];

  const ASSIGNMENT_COLUMNS = [
    "relationship_id",
    "retailer_organization_id",
    "retailer_name",
    "retailer_status",
    "relationship_status",
    "assignment_status",
    "assigned_at",
    "assignment_updated_at",
  ];

  test("22. the detail returns exactly the agreed columns, in order", () => {
    assert.deepEqual(outputColumns("get_vendor_product_detail"), DETAIL_COLUMNS);
  });

  test("23. the detail column set is the SHIPPED list set plus assignment_count", () => {
    // Parsed from 20260727210000 rather than restated, so this is a relationship between two
    // live contracts and not two literals free to drift. Every shared column is
    // byte-identical in name and order, so the two can share one mapper for the overlap and a
    // future addition has to be made to both or to neither.
    //
    // NOTE: the list does NOT return assignment_count, so this is a superset relationship and
    // NOT a single model. See docs/mobile-vendor-product-reads-audit.md § 5.1 for why a
    // client should use two entities rather than one with a nullable count.
    const list = shippedListColumns();
    assert.deepEqual(
      list,
      [
        "product_id",
        "product_code",
        "barcode",
        "product_name",
        "brand",
        "description",
        "status",
        "active_assignment_count",
        "created_at",
        "updated_at",
      ],
      "the shipped list contract must be exactly what this milestone reuses",
    );

    const detail = outputColumns("get_vendor_product_detail");
    assert.deepEqual(
      detail.filter((column) => column !== "assignment_count"),
      list,
      "the detail must be the list column set plus assignment_count, in the same relative order",
    );
    assert.equal(
      detail.length - list.length,
      1,
      "assignment_count must be the ONLY column the detail adds",
    );
  });

  test("24. the assignment companion returns exactly the agreed columns, in order", () => {
    assert.deepEqual(outputColumns(RETAILER_TOUCHING_READ), ASSIGNMENT_COLUMNS);
  });

  test("25. both counts are bigint, matching the shipped list's type exactly", () => {
    // count(*) is bigint and the shipped list declares it as bigint. Casting to integer here
    // would make the same value arrive as a different JSON type from the list and the detail,
    // and a pinned mobile build would break on whichever it did not expect.
    const detail = statementFor("get_vendor_product_detail");
    assert.match(detail, /assignment_count\s+bigint/i, "assignment_count must be bigint");
    assert.match(
      detail,
      /active_assignment_count\s+bigint/i,
      "active_assignment_count must be bigint",
    );
    assert.match(
      statementFrom(CATALOG_CODE, "list_vendor_products"),
      /active_assignment_count\s+bigint/i,
      "the shipped list declares active_assignment_count as bigint — the detail must agree",
    );
    assert.ok(
      !/\)::integer/.test(detail),
      "neither count may be cast away from the type the list already publishes",
    );
  });

  test("26. no output column carries identity, authentication, or authorization internals", () => {
    // `retailer_organization_id` IS returned and is intended: it is an OUTPUT, never an
    // input, and it names a Retailer this Vendor already manages. The patterns below are
    // anchored so they forbid a bare `organization_id` and a `vendor_organization_id` without
    // catching it.
    const FORBIDDEN = [
      /auth_user/i,
      /\buser_id\b/i,
      /profile_id/i,
      /created_by/i,
      /assigned_by/i,
      /membership/i,
      /vendor_organization/i,
      /^organization_id$/i,
      /tenant/i,
      /\bpassword\b/i,
      /provider/i,
      /session/i,
      /\bjwt\b/i,
      /\bpolicy\b/i,
      /\brls\b/i,
      /search_path/i,
      /definer/i,
    ];

    for (const { read, column } of allOutputColumns()) {
      for (const pattern of FORBIDDEN) {
        assert.ok(!pattern.test(column), `${read} must not return \`${column}\``);
      }
    }
  });

  test("27. no output column carries Retailer personal, contact, or invitation data", () => {
    // An assignment names an ORGANIZATION, never a person. The Retailer's owner, their email
    // and every invitation artefact stay where they already are: unreachable from any read in
    // this contract.
    const FORBIDDEN = [
      /email/i,
      /phone/i,
      /mobile/i,
      /first_name/i,
      /last_name/i,
      /\bowner\b/i,
      /contact/i,
      /address/i,
      /token/i,
      /hash/i,
      /secret/i,
      /invitation/i,
      /invited_by/i,
      /expires_at/i,
      /audit/i,
    ];

    for (const { read, column } of allOutputColumns()) {
      for (const pattern of FORBIDDEN) {
        assert.ok(!pattern.test(column), `${read} must not return \`${column}\``);
      }
    }

    // And no body may read the invitation, audit, receipt or staff tables.
    for (const read of READS) {
      const body = statementFor(read.name);
      for (const table of [
        "retailer_invitations",
        "retailer_staff_invitations",
        "retailer_invitation_shop_assignments",
        "retailer_shops",
        "receipt_submissions",
        "audit_logs",
      ]) {
        assert.ok(
          !body.includes(table),
          `${read.name} must not read public.${table} — it is not product or assignment data`,
        );
      }
    }
  });

  test("28. no output column returns an image, a storage path, or a signed URL", () => {
    // The audit found no product image ANYWHERE: no column on public.vendor_products, no
    // product storage bucket, no image rendering in either web product page, and no storage
    // call in lib/products. Option A of the image decision is therefore the only honest one —
    // nothing is returned because nothing exists — and this test is what stops a later edit
    // from inventing an image system to decorate a screen.
    //
    // \b anchors each alternative: without it `assigned_at` matches "signed".
    const FORBIDDEN = [
      /image/i,
      /photo/i,
      /picture/i,
      /thumbnail/i,
      /\bmedia\b/i,
      /\basset/i,
      /bucket/i,
      /storage/i,
      /\bsigned/i,
      /\burl\b/i,
      /\bfile/i,
      /\bpath\b/i,
      /object_key/i,
    ];

    for (const { read, column } of allOutputColumns()) {
      for (const pattern of FORBIDDEN) {
        assert.ok(
          !pattern.test(column),
          `${read} must not return \`${column}\` — this milestone adds no product-image contract`,
        );
      }
    }

    // Nor may either body touch storage at all.
    for (const read of READS) {
      const body = statementFor(read.name);
      assert.ok(
        !/\bstorage\./i.test(body),
        `${read.name} must not reference the storage schema`,
      );
      // \b anchors both alternatives: a bare `sign` would match `vendor_product_retailer_
      // assignments`, which is the table the whole contract reads.
      assert.ok(
        !/\bsigned_url|create_signed_url|\bservice_role\b/i.test(body),
        `${read.name} must not mint or reference a signed URL or a service-role path`,
      );
    }
  });

  test("29. no output column invents a property the schema does not have", () => {
    // public.vendor_products has no price, incentive, campaign, reward, coin, payout, claim,
    // receipt, inventory or shop-assignment column, and there is no shop-level product
    // assignment table anywhere. A column that reported one would be inventing product
    // semantics rather than reporting them.
    const FORBIDDEN = [
      /price/i,
      /\bcost\b/i,
      /\bamount\b/i,
      /currency/i,
      /incentive/i,
      /reward/i,
      /campaign/i,
      /\bcoin/i,
      /payout/i,
      /claim/i,
      /receipt/i,
      /\bsales\b/i,
      /inventory/i,
      /\bstock\b/i,
      /\bshop/i,
      /\bdraft\b/i,
      /archived/i,
      /discontinued/i,
      /\bsku\b/i,
      /\bgtin\b/i,
      /\bean\b/i,
      /\bupc\b/i,
    ];

    for (const { read, column } of allOutputColumns()) {
      for (const pattern of FORBIDDEN) {
        assert.ok(
          !pattern.test(column),
          `${read} must not return \`${column}\` — the schema has no such property to report`,
        );
      }
    }
  });

  test("30. the assignment row identity is the relationship id, not an internal assignment id", () => {
    // relationship_id is the address the shipped Vendor Retailer reads already use
    // (list_vendor_retailers / get_vendor_retailer_detail, 20260731090000), so a product's
    // assignment row can open the Retailer detail screen directly. The assignment table's own
    // primary key is deliberately absent: no operation anywhere accepts it — every assignment
    // write is addressed by (product id, Retailer organization id) — so it would identify
    // nothing a client can act on.
    const columns = outputColumns(RETAILER_TOUCHING_READ);
    assert.ok(columns.includes("relationship_id"), "the companion must return relationship_id");
    assert.ok(
      !columns.includes("assignment_id"),
      "the companion must not return the assignment row's internal id",
    );

    const body = statementFor(RETAILER_TOUCHING_READ);
    assert.match(
      body,
      /vr\.vendor_organization_id\s*=\s*v_vendor/,
      "the relationship must be matched on the DERIVED Vendor, so no other Vendor's relationship id can appear",
    );
  });
});

// ============================================================================
// Set-based aggregation — no N+1, no duplicated products, no invented defaults
// ============================================================================
describe("mobile Vendor Product reads — set-based aggregation", () => {
  test("31. both counts come from ONE lateral aggregate over the assignment table", () => {
    // A product may have many assignments, so a JOIN would emit one row per assignment and
    // duplicate the product. A lateral aggregate is evaluated once per product row and cannot
    // — and computing both counts in one lateral means the assignment table is scanned once,
    // not twice, and the two numbers can never be taken from different snapshots.
    const detail = statementFor("get_vendor_product_detail");

    assert.match(
      detail,
      /left\s+join\s+lateral\s*\(\s*\n?\s*select\s*\n?\s*count\(\*\)[\s\S]*?count\(\*\)\s+filter\s*\(\s*where\s+a\.status\s*=\s*'ACTIVE'\s*\)/i,
      "the detail must compute both counts in a single lateral aggregate",
    );

    const laterals = detail.match(/\bjoin\s+lateral\b/gi) ?? [];
    assert.equal(laterals.length, 1, "exactly one lateral — not one per count");

    assert.ok(
      !/\bdistinct\b/i.test(detail),
      "the detail must not need DISTINCT — row multiplicity is fixed by the primary key, and a DISTINCT would hide a genuine duplication bug",
    );

    // LEFT, so a product with no assignments keeps its row and reports 0 rather than
    // vanishing from the contract.
    assert.match(
      detail,
      /left\s+join\s+lateral/i,
      "the lateral must be a LEFT join so a product with no assignments still returns a row",
    );
  });

  test("32. the assignment list is DRIVEN FROM the assignment table", () => {
    // This is what makes assignment_count equal the companion's row count: both are the same
    // set. The existing editor read drives from vendor_retailers instead, which is why it
    // returns never-assigned Retailers with a null status — a different question, deliberately
    // left alone.
    const body = statementFor(RETAILER_TOUCHING_READ);
    assert.match(
      body,
      /from\s+public\.vendor_product_retailer_assignments\s+a\b/i,
      "the companion must be driven from the assignment table, so assignment_status is never null",
    );
    assert.match(
      body,
      /where\s+a\.vendor_product_id\s*=\s*v_product/i,
      "the companion must filter assignments on the product it already proved the caller owns",
    );

    // The relationship join is LEFT: an INNER join would make an assignment row VANISH if its
    // relationship row ever ceased to exist, while the count — taken from the assignment table
    // alone — would keep counting it. A missing relationship must surface as a null
    // relationship_id, never as a silently shorter list that contradicts the count.
    assert.match(
      body,
      /left\s+join\s+public\.vendor_retailers\s+vr\b/i,
      "the relationship join must be LEFT so no assignment row can be dropped from the list",
    );
    assert.ok(
      !/\bdistinct\b/i.test(body),
      "the companion must not need DISTINCT — one assignment per (product, Retailer) is a schema guarantee",
    );
  });

  test("33. the caller's Vendor is resolved ONCE per call, not per row", () => {
    for (const read of READS) {
      const statement = statementFor(read.name);
      const contextCalls = statement.match(/get_vendor_super_admin_context\s*\(/g) ?? [];
      assert.equal(
        contextCalls.length,
        1,
        `${read.name} must resolve its Vendor exactly once — a per-row resolution would be N+1 authorization`,
      );

      const permissionCalls = statement.match(/has_organization_permission\s*\(/g) ?? [];
      const expected = read.name === RETAILER_TOUCHING_READ ? 2 : 1;
      assert.equal(
        permissionCalls.length,
        expected,
        `${read.name} must check each permission it needs exactly once, before the query rather than inside it`,
      );
    }
  });

  test("34. each read issues exactly one row-producing statement", () => {
    for (const read of READS) {
      const statement = statementFor(read.name);
      const queries = statement.match(/\breturn\s+query\b/gi) ?? [];
      assert.equal(
        queries.length,
        1,
        `${read.name} must produce its result with a single statement, whatever the row count`,
      );
    }
  });

  test("35. the ordering is deterministic and total", () => {
    // Two Retailers may legitimately share a display name; without a tie-break they could
    // swap places between requests and a re-fetched mobile list would flicker. The tie-break
    // is the organization id rather than the relationship id, because the latter is nullable
    // under the LEFT join.
    assert.match(
      statementFor(RETAILER_TOUCHING_READ),
      /order\s+by\s+o\.name\s*,\s*o\.id\s*;/i,
      "the companion must order by Retailer name then Retailer organization id",
    );
    assert.ok(
      !/order\s+by\s+vr\.id/i.test(statementFor(RETAILER_TOUCHING_READ)),
      "the ordering must not depend on the nullable relationship id",
    );
  });

  test("36. nothing is filtered, defaulted, substituted, or fabricated", () => {
    // The rule that matters most here: an INACTIVE product must stay readable, a withdrawn
    // assignment must stay listed and marked, an unknown status must never be mapped to
    // ACTIVE, and no date may be invented to stand in for a withdrawal the schema does not
    // record.
    const body = statementFor(RETAILER_TOUCHING_READ);

    for (const filter of [
      /a\.status\s*=\s*'ACTIVE'/,
      /vr\.status\s*=\s*'ACTIVE'/,
      /o\.status\s*=\s*'ACTIVE'/,
      /vp\.status\s*=\s*'ACTIVE'/,
    ]) {
      assert.ok(
        !filter.test(body),
        "the companion must not filter by any status — every assignment row is returned and marked instead",
      );
    }

    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.ok(
        !/coalesce\s*\(\s*(vp|a|o|vr)\.(status|barcode|brand|description|name|assigned_at|updated_at)/i.test(
          statement,
        ),
        `${read.name} must not substitute a value for an absent field or status`,
      );
      assert.ok(
        !/\bcase\s+when\b[\s\S]*\bstatus\b/i.test(statement),
        `${read.name} must not derive a status from anything — the stored value is returned as-is`,
      );
    }

    // 'ACTIVE' may appear in the detail ONLY inside the count filter, never as a value that
    // is returned, defaulted to, or used to hide a row.
    const detail = statementFor("get_vendor_product_detail");
    const activeLiterals = detail.match(/'ACTIVE'/g) ?? [];
    assert.equal(
      activeLiterals.length,
      1,
      "the detail may name 'ACTIVE' exactly once — in the active-count filter and nowhere else",
    );
    assert.ok(
      !/where[\s\S]*vp\.status/i.test(detail),
      "the detail must not filter the product by status — an INACTIVE product stays readable",
    );

    // And the companion names no status literal at all.
    assert.ok(
      !/'(ACTIVE|INACTIVE|SUSPENDED|DEACTIVATED)'/.test(body),
      "the companion must name no status literal — it reports four statuses and decides none of them",
    );
  });
});

// ============================================================================
// Web compatibility
// ============================================================================
describe("mobile Vendor Product reads — the web is untouched", () => {
  test("37. the existing Products module still calls exactly the RPCs it called before", () => {
    // This PR adds a shared contract; it does not migrate the web onto it. The visible
    // behaviour of /products and /products/[productId] must be byte-identical after this
    // branch.
    const web = readFileSync(join(ROOT, "lib/products/vendor-products.ts"), "utf8");

    for (const read of READS) {
      assert.ok(
        !web.includes(read.name),
        `lib/products/vendor-products.ts must not call ${read.name} in this milestone`,
      );
    }

    for (const shipped of [
      "list_vendor_products",
      "create_vendor_product",
      "update_vendor_product",
      "set_vendor_product_status",
      "list_vendor_product_retailer_assignments",
      "assign_vendor_product_to_retailer",
      "unassign_vendor_product_from_retailer",
    ]) {
      assert.ok(
        web.includes(`"${shipped}"`),
        `the web module must still name the ${shipped} RPC exactly as it did before`,
      );
    }

    // And it must still reach the database only through RPCs — no direct table read may have
    // been introduced alongside this milestone. Matched against `supabase.from(` rather than
    // a bare `.from(`, because the module's own header prose states the rule and would
    // otherwise satisfy the very check that enforces it.
    assert.ok(
      !/supabase\s*\.\s*from\s*\(/.test(web),
      "lib/products/vendor-products.ts must contain zero direct table reads",
    );
  });

  test("38. no product route, page, or write path is added by this milestone", () => {
    // The milestone is backend-only and read-only. The two existing routes and their files
    // must be exactly what shipped.
    const productsRoute = readdirSync(join(ROOT, "app/(admin)/products"));
    assert.deepEqual(
      productsRoute.sort(),
      ["[productId]", "actions.ts", "loading.tsx", "page.tsx", "product-form-state.ts", "product-forms.tsx"],
      "app/(admin)/products must still contain exactly the files that shipped",
    );

    const detailRoute = readdirSync(join(ROOT, "app/(admin)/products/[productId]"));
    assert.deepEqual(
      detailRoute.sort(),
      ["loading.tsx", "page.tsx"],
      "app/(admin)/products/[productId] must still contain only the detail page and its loading state",
    );
  });

  test("39. the Retailer-facing product read is untouched", () => {
    // list_retailer_assigned_products() serves a different role entirely and must not have
    // been drawn into this contract.
    const retailerWeb = readFileSync(join(ROOT, "lib/products/retailer-products.ts"), "utf8");
    for (const read of READS) {
      assert.ok(
        !retailerWeb.includes(read.name),
        `lib/products/retailer-products.ts must not call ${read.name}`,
      );
    }
    assert.ok(
      retailerWeb.includes('"list_retailer_assigned_products"'),
      "the Retailer module must still call list_retailer_assigned_products",
    );
  });

  test("40. the shared normalization module is unchanged in shape", () => {
    // The web's runtime validator encodes the two product statuses and the two assignment
    // statuses. This milestone adds no state to either vocabulary, so neither list may have
    // grown.
    const normalization = readFileSync(
      join(ROOT, "lib/products/product-normalization.ts"),
      "utf8",
    );
    assert.ok(
      normalization.includes('export const PRODUCT_STATUSES = ["ACTIVE", "INACTIVE"] as const;'),
      "the product status vocabulary must still be exactly ACTIVE and INACTIVE",
    );
    assert.ok(
      normalization.includes(
        'export const ASSIGNMENT_STATUSES = ["ACTIVE", "INACTIVE"] as const;',
      ),
      "the assignment status vocabulary must still be exactly ACTIVE and INACTIVE",
    );
  });
});
