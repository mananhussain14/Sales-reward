/**
 * STATIC CONTRACT GUARDS for the post-acceptance Retailer staff SHOP ASSIGNMENT write
 *
 *   public.set_retailer_staff_shop_assignments(uuid, uuid[])
 *     [20260809090000_retailer_staff_shop_assignment_management.sql]
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text and the documentation, in the
 * same idiom as ../products/vendor-product-assignment-writes-contract.test.ts. They read
 * the SQL and assert structural properties that a careless later edit could silently
 * destroy.
 *
 * They do NOT execute the function. The BEHAVIOURAL suite is
 *
 *     supabase/tests/database/retailer_staff_shop_assignment_writes_test.sql
 *
 * which signs in as eight different callers, walks the whole validation matrix, proves the
 * ACTIVE-projection scoping, proves the audit row rolls back with its mutation, and proves
 * the shipped roster agrees with the table after every write. It requires Docker and is
 * run with:
 *
 *     npx supabase test db --local
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of
 * properties that are cheap to assert on every `npm test` and expensive to notice once
 * broken: that the signature did not grow an argument, that no hard delete appeared, that
 * no browser grant or RLS policy was introduced on retailer_shop_members, that the two
 * existing read contracts were not edited, and that the documentation still describes what
 * the SQL does.
 *
 * ============================================================================
 * THE FIVE DECISIONS THESE GUARDS PIN
 * ============================================================================
 *   O-1  An empty or null requested shop set is REFUSED. No "stand down" path exists.
 *   O-2  Duplicate shop ids are CANONICALIZED (array_agg distinct), not rejected.
 *   O-3  No client-supplied version, ETag or timestamp. FOR UPDATE + ascending FOR SHARE.
 *   R-1  Replacement is scoped to shops whose status is ACTIVE, so a live assignment to a
 *        suspended or deactivated shop — invisible in list_retailer_staff_members() — is
 *        preserved rather than silently destroyed.
 *   ---  Retirement is removed_at; there is NO hard delete anywhere on this path.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");

const MIGRATION_NAME = "20260809090000_retailer_staff_shop_assignment_management.sql";
const FOUNDATION_NAME =
  "20260722210000_retailer_staff_role_permission_shop_assignment_foundation.sql";
const ACCEPTANCE_NAME = "20260724210000_retailer_staff_invitation_acceptance.sql";
const ASSIGNABLE_SHOPS_NAME = "20260725090000_retailer_staff_assignable_shops.sql";

const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
const FOUNDATION_SQL = readFileSync(join(MIGRATIONS_DIR, FOUNDATION_NAME), "utf8");
const ACCEPTANCE_SQL = readFileSync(join(MIGRATIONS_DIR, ACCEPTANCE_NAME), "utf8");
const ASSIGNABLE_SHOPS_SQL = readFileSync(join(MIGRATIONS_DIR, ASSIGNABLE_SHOPS_NAME), "utf8");

const PGTAP_NAME = "retailer_staff_shop_assignment_writes_test.sql";
const PGTAP = readFileSync(join(ROOT, "supabase/tests/database", PGTAP_NAME), "utf8");

const AUDIT_DOC = readFileSync(
  join(ROOT, "docs/retailer-staff-shop-assignment-management-audit.md"),
  "utf8",
);
const BACKEND_CONTRACT = readFileSync(join(ROOT, "docs/mobile-backend-contract.md"), "utf8");
const FEATURE_MATRIX = readFileSync(join(ROOT, "docs/mobile-feature-matrix.md"), "utf8");

const FN = "set_retailer_staff_shop_assignments";
const PERMISSION = "RETAILER_STAFF_SHOP_ASSIGN";
const AUDIT_ACTION = "STAFF_SHOP_ASSIGNMENTS_UPDATED";
const AUDIT_ENTITY = "RETAILER_STAFF_MEMBER";

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this migration's header discusses `delete`, `service_role`, `grant` and
 * `RETAILER_OWNER` at length while doing none of them, and its body explains exactly why
 * the rules below exist. Asserting against the raw text would fail on the sentences that
 * state the guarantees.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

const CODE = stripComments(MIGRATION_SQL);

/**
 * One `create [or replace] function` statement, from its CREATE through the closing `$$;`
 * of its body. Everything asserted per-function is asserted against this slice rather than
 * the whole file, so a clause belonging to one function can never satisfy an assertion
 * about another.
 */
function statementFrom(source: string, name: string): string {
  const start = source.search(
    new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i"),
  );
  assert.notEqual(start, -1, `must define public.${name}`);
  const end = source.indexOf("$$;", start);
  assert.notEqual(end, -1, `public.${name} must have a $$-quoted body`);
  return source.slice(start, end);
}

/** The parameter list of a function statement, as declared. */
function parameterBlock(statement: string, name: string): string {
  const open = statement.indexOf("(");
  assert.notEqual(open, -1, `public.${name} must declare a parameter list`);
  let depth = 0;
  for (let i = open; i < statement.length; i += 1) {
    if (statement[i] === "(") depth += 1;
    if (statement[i] === ")") {
      depth -= 1;
      if (depth === 0) return statement.slice(open + 1, i);
    }
  }
  throw new Error(`public.${name} has an unbalanced parameter list`);
}

function parameterNames(statement: string, name: string): string[] {
  return parameterBlock(statement, name)
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((entry) => entry.length > 0);
}

function parameterTypes(statement: string, name: string): string[] {
  return parameterBlock(statement, name)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) =>
      entry
        .split(/\s+default\s+/i)[0]
        .trim()
        .split(/\s+/)
        .slice(1)
        .join(" "),
    );
}

/** The `returns table ( ... )` block of a function statement. */
function returnsTableBlock(statement: string, name: string): string {
  const at = statement.search(/returns\s+table\s*\(/i);
  assert.notEqual(at, -1, `public.${name} must declare returns table (...)`);
  const open = statement.indexOf("(", at);
  let depth = 0;
  for (let i = open; i < statement.length; i += 1) {
    if (statement[i] === "(") depth += 1;
    if (statement[i] === ")") {
      depth -= 1;
      if (depth === 0) return statement.slice(open + 1, i);
    }
  }
  throw new Error(`public.${name} has an unbalanced returns table block`);
}

const STATEMENT = statementFrom(CODE, FN);

// ============================================================================
// The signature
// ============================================================================
describe("staff shop assignment write — the signature", () => {
  test("1. the migration exists, is forward-only, and is the newest one", () => {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    assert.ok(migrations.includes(MIGRATION_NAME), `${MIGRATION_NAME} must exist`);
    assert.equal(
      migrations[migrations.length - 1],
      MIGRATION_NAME,
      "this milestone's migration must sort last — forward-only, after 20260808090000",
    );
    assert.ok(
      MIGRATION_NAME > "20260808090000_repair_retailer_staff_registration_context.sql",
      "the timestamp must be later than the previously newest migration",
    );
  });

  test("2. the RPC has exactly the name the clients will call", () => {
    assert.ok(
      new RegExp(`create\\s+function\\s+public\\.${FN}\\s*\\(`).test(CODE),
      `the migration must define public.${FN}`,
    );
    // Plain CREATE, never CREATE OR REPLACE: a conflicting existing object must FAIL the
    // migration rather than be silently overwritten.
    assert.ok(
      !/create\s+or\s+replace\s+function/i.test(CODE),
      "the migration must use plain CREATE FUNCTION, not CREATE OR REPLACE",
    );
  });

  test("3. exactly two arguments, named and ordered as the contract states", () => {
    assert.deepEqual(parameterNames(STATEMENT, FN), ["p_membership_id", "p_shop_ids"]);
    assert.deepEqual(parameterTypes(STATEMENT, FN), ["uuid", "uuid[]"]);
  });

  test("4. no argument is defaulted — a half-addressed call is an error, not a guess", () => {
    assert.ok(
      !/default/i.test(parameterBlock(STATEMENT, FN)),
      "neither argument may carry a DEFAULT",
    );
  });

  test("5. no organization / Retailer / tenant argument", () => {
    for (const name of parameterNames(STATEMENT, FN)) {
      assert.ok(
        !/organization|retailer|tenant|company/i.test(name),
        `${name} looks like a caller-supplied tenant id; the Retailer must come from auth.uid()`,
      );
    }
  });

  test("6. no actor / caller / user / profile / auth argument", () => {
    for (const name of parameterNames(STATEMENT, FN)) {
      assert.ok(
        !/actor|caller|user|profile|auth|uid|email|token|claim/i.test(name),
        `${name} looks like a caller-supplied identity; the actor must come from auth.uid()`,
      );
    }
  });

  test("7. no role / permission / status / timestamp / audit / version argument", () => {
    for (const name of parameterNames(STATEMENT, FN)) {
      assert.ok(
        !/role|permission|status|audit|version|etag|updated|timestamp|assigned_at|removed_at/i.test(
          name,
        ),
        `${name} would let a client assert something the backend must decide for itself`,
      );
    }
  });

  test("8. no current-assignment list, add/remove pair or idempotency key", () => {
    // Complete replacement means the caller sends ONE set. A second array argument would
    // be a client claim about the current state, or an add/remove split the backend would
    // have to trust.
    assert.deepEqual(
      parameterNames(STATEMENT, FN).filter((n) => n !== "p_membership_id" && n !== "p_shop_ids"),
      [],
      "the RPC accepts the membership and the desired set and nothing else",
    );
  });

  test("9. returns exactly the three integer counts", () => {
    const block = returnsTableBlock(STATEMENT, FN);
    const columns = block
      .split(",")
      .map((entry) => entry.trim().split(/\s+/))
      .filter((parts) => parts[0].length > 0);

    assert.deepEqual(
      columns.map((parts) => parts[0]),
      ["shops_added", "shops_removed", "shops_unchanged"],
    );
    assert.deepEqual(
      columns.map((parts) => parts[1]),
      ["integer", "integer", "integer"],
    );
  });

  test("10. the return shape leaks no id, name, timestamp or hidden assignment", () => {
    const block = returnsTableBlock(STATEMENT, FN);
    assert.ok(
      !/uuid|timestamptz|text|jsonb/i.test(block),
      "the return shape must be counts only — no id, name, timestamp or payload",
    );
  });
});

// ============================================================================
// Authorization
// ============================================================================
describe("staff shop assignment write — authorization", () => {
  test("11. gates on the EXISTING RETAILER_STAFF_SHOP_ASSIGN permission", () => {
    assert.ok(
      STATEMENT.includes(`resolve_retailer_member_organization('${PERMISSION}')`),
      `the body must resolve the Retailer through ${PERMISSION}`,
    );
  });

  test("12. introduces no permission, role or mapping of its own", () => {
    assert.ok(
      !/insert\s+into\s+public\.(permissions|roles|role_permissions)/i.test(CODE),
      "the migration must not seed a permission, role or role -> permission mapping",
    );
    assert.ok(
      !/create\s+(unique\s+)?(table|index|trigger|policy|type)/i.test(CODE),
      "the migration must create no table, index, trigger, policy or type",
    );
    assert.ok(
      !/\balter\s+table\b/i.test(CODE),
      "the migration must alter no table",
    );
    assert.ok(!/\bdrop\s+/i.test(CODE), "the migration must drop nothing");
  });

  test("13. no role code gates the operation — the mapping is the authority", () => {
    assert.ok(
      !/RETAILER_OWNER/.test(CODE),
      "a RETAILER_OWNER literal in the code would be a second, drifting copy of the mapping",
    );
    assert.ok(
      !/RETAILER_MANAGER/.test(CODE),
      "a RETAILER_MANAGER literal would likewise duplicate the mapping",
    );
    // SALES_STAFF is the one role code that legitimately appears: it constrains the
    // TARGET, and this operation is defined only for Sales Staff.
    assert.ok(
      /'SALES_STAFF'/.test(CODE),
      "the body must restrict the TARGET to SALES_STAFF",
    );
  });

  test("14. SECURITY DEFINER, VOLATILE, empty search_path, no dynamic SQL", () => {
    assert.match(STATEMENT, /security\s+definer/i);
    assert.match(STATEMENT, /\bvolatile\b/i);
    assert.match(STATEMENT, /set\s+search_path\s*=\s*''/i);
    assert.ok(
      !/\bexecute\s+(format|'|")/i.test(STATEMENT),
      "no dynamic SQL — a tenant predicate assembled by concatenation is one waiting to be lost",
    );
  });

  test("15. granted to authenticated only — never anon, PUBLIC or service_role", () => {
    assert.ok(
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${FN}\\(uuid,\\s*uuid\\[\\]\\)\\s+to\\s+authenticated`, "i").test(CODE),
      "authenticated must hold EXECUTE",
    );
    assert.ok(
      new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${FN}\\(uuid,\\s*uuid\\[\\]\\)\\s+from\\s+public`, "i").test(CODE),
      "PUBLIC's default EXECUTE must be revoked",
    );
    assert.ok(
      new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${FN}\\(uuid,\\s*uuid\\[\\]\\)\\s+from\\s+anon`, "i").test(CODE),
      "anon must be revoked explicitly",
    );
    assert.ok(
      !/grant[^;]*service_role/i.test(CODE),
      "service_role must be granted nothing — this function's whole authority is auth.uid()",
    );
  });

  test("16. every id is derived, none is accepted", () => {
    assert.ok(STATEMENT.includes("auth.uid()"), "the actor must come from auth.uid()");
    // The target's Retailer, role and status are all READ, and the read is what the
    // predicates below constrain.
    assert.match(
      STATEMENT,
      /m\.organization_id\s*=\s*v_retailer/,
      "the target must be constrained to the resolved Retailer",
    );
    assert.match(
      STATEMENT,
      /s\.retailer_organization_id\s*=\s*v_retailer/,
      "every requested shop must be constrained to the resolved Retailer",
    );
  });
});

// ============================================================================
// The five pinned semantics
// ============================================================================
describe("staff shop assignment write — replacement semantics", () => {
  test("17. the canonical target identifier is the membership id", () => {
    // organization_members.id is the exact FK target of
    // retailer_shop_members.organization_member_id, so nothing stands between what the
    // caller names and what is written.
    assert.match(
      STATEMENT,
      /from\s+public\.organization_members\s+m\s+where\s+m\.id\s*=\s*p_membership_id/i,
      "the target must be looked up by organization_members.id",
    );
    assert.ok(
      !/auth\.users/i.test(STATEMENT),
      "the function must never resolve the target through auth.users",
    );
  });

  test("18. the membership id it accepts is the one the roster already returns", () => {
    // If these ever diverge, a client would need a translation step that does not exist.
    assert.ok(
      /returns\s+table\s*\(\s*\n?\s*membership_id\s+uuid/i.test(ACCEPTANCE_SQL),
      "list_retailer_staff_members must still return membership_id as its first column",
    );
  });

  test("19. p_shop_ids is COMPLETE REPLACEMENT — the diff is computed server-side", () => {
    // Retire: live rows not in the requested array.
    assert.match(
      STATEMENT,
      /not\s*\(\s*sm\.retailer_shop_id\s*=\s*any\(v_shop_ids\)\s*\)/i,
      "retirement must select live rows ABSENT from the requested set",
    );
    // Add: requested shops with no live row.
    assert.match(
      STATEMENT,
      /not\s+exists\s*\([^)]*retailer_shop_members[\s\S]*?removed_at\s+is\s+null/i,
      "insertion must select requested shops with NO live row",
    );
    // Keep: requested shops that already have a live row are counted, never written.
    assert.match(
      STATEMENT,
      /into\s+v_unchanged/i,
      "unchanged assignments must be counted rather than rewritten",
    );
  });

  test("20. O-2 — duplicate shop ids are CANONICALIZED, not rejected", () => {
    assert.match(
      STATEMENT,
      /array_agg\s*\(\s*distinct\s+s\s+order\s+by\s+s\s*\)/i,
      "duplicates must collapse through array_agg(distinct ...), matching reserve_retailer_staff_invitation",
    );
    // A NULL ELEMENT is a different matter and is still refused.
    assert.match(
      STATEMENT,
      /where\s+s\s+is\s+null/i,
      "a NULL element inside the array must still be rejected",
    );
  });

  test("21. O-1 — an empty or null requested set is REJECTED", () => {
    assert.match(
      STATEMENT,
      /if\s+v_shop_count\s*=\s*0\s+then[\s\S]{0,200}?check_violation/i,
      "an empty canonical set must raise check_violation",
    );
    // NULL and '{}' are one input: coalesce makes them identical before the count.
    assert.match(
      STATEMENT,
      /coalesce\s*\(\s*p_shop_ids\s*,\s*'\{\}'::uuid\[\]\s*\)/i,
      "a null array must be coalesced to empty, so both refuse identically",
    );
  });

  test("22. R-1 — removal is scoped to shops that are currently ACTIVE", () => {
    // THE guarantee. Without the s.status='ACTIVE' predicate on the retiring statement, a
    // client round-tripping the roster would destroy assignments it was never shown.
    const retire = STATEMENT.slice(STATEMENT.search(/with\s+retired\s+as/i));
    assert.ok(retire.length > 0, "the retiring statement must exist");
    assert.match(
      retire.slice(0, retire.indexOf("with added") === -1 ? undefined : retire.indexOf("with added")),
      /s\.status\s*=\s*'ACTIVE'/i,
      "the retiring statement must be scoped to ACTIVE shops, preserving invisible assignments",
    );
  });

  test("23. NO HARD DELETE anywhere — retirement is removed_at", () => {
    assert.ok(
      !/\bdelete\b/i.test(CODE),
      "the migration must contain no DELETE — an assignment is retired, never destroyed",
    );
    assert.ok(!/\btruncate\b/i.test(CODE), "the migration must contain no TRUNCATE");
    assert.match(
      STATEMENT,
      /set\s+removed_at\s*=\s*now\(\)/i,
      "removal must set removed_at",
    );
  });

  test("24. re-adding inserts a NEW row — no removed_at is ever cleared", () => {
    assert.ok(
      !/removed_at\s*=\s*null/i.test(CODE),
      "clearing removed_at would erase the fact that the person was ever off that shop",
    );
    assert.match(
      STATEMENT,
      /insert\s+into\s+public\.retailer_shop_members/i,
      "re-adding must go through an INSERT",
    );
  });

  test("25. O-3 — locking, and no client-supplied concurrency token", () => {
    assert.match(STATEMENT, /for\s+update/i, "the target membership must be locked FOR UPDATE");
    assert.match(STATEMENT, /for\s+share/i, "the requested shops must be locked FOR SHARE");
    assert.match(
      STATEMENT,
      /order\s+by\s+s\.id[\s\S]{0,40}for\s+share/i,
      "shops must be locked in ascending UUID order — deterministic lock order",
    );
    // The absence of a version argument is already asserted in test 7; this is the other
    // half: nothing in the body reads one either.
    assert.ok(
      !/if_match|etag|expected_version|p_version/i.test(CODE),
      "no optimistic-concurrency token may be introduced",
    );
  });
});

// ============================================================================
// Audit
// ============================================================================
describe("staff shop assignment write — audit", () => {
  test("26. writes one audit row with the new, minimal vocabulary", () => {
    assert.ok(CODE.includes(`'${AUDIT_ACTION}'`), `the action code must be ${AUDIT_ACTION}`);
    assert.ok(CODE.includes(`'${AUDIT_ENTITY}'`), `the entity type must be ${AUDIT_ENTITY}`);
    assert.match(
      STATEMENT,
      /insert\s+into\s+public\.audit_logs/i,
      "a successful change must write an audit row",
    );
    assert.equal(
      (CODE.match(/insert\s+into\s+public\.audit_logs/gi) ?? []).length,
      1,
      "exactly one audit INSERT — one event per changing call",
    );
  });

  test("27. a no-op returns before the audit row is written", () => {
    const noop = STATEMENT.search(/if\s+v_added\s*=\s*0\s+and\s+v_removed\s*=\s*0\s+then/i);
    const audit = STATEMENT.search(/insert\s+into\s+public\.audit_logs/i);
    assert.notEqual(noop, -1, "the no-op guard must exist");
    assert.ok(
      noop < audit,
      "the no-op early return must precede the audit INSERT — a no-op is not an event",
    );
  });

  test("28. the audit payload is safe: counts and names, never ids or secrets", () => {
    const audit = STATEMENT.slice(STATEMENT.search(/insert\s+into\s+public\.audit_logs/i));

    for (const key of [
      "retailer_name",
      "role_code",
      "membership_status",
      "shop_count_before",
      "shop_count_after",
      "shops_added",
      "shops_removed",
    ]) {
      assert.ok(audit.includes(`'${key}'`), `audit metadata must carry ${key}`);
    }

    // Names, not ids. v_added_names / v_removed_names are text[] of shop names; the shop
    // UUID arrays (v_shop_ids) must not reach the metadata.
    assert.ok(
      audit.includes("v_added_names") && audit.includes("v_removed_names"),
      "the added/removed lists must be shop NAMES",
    );
    assert.ok(
      !/v_shop_ids/.test(audit),
      "no shop UUID array may reach the audit metadata",
    );
    assert.ok(
      !/email|token|hash|password|secret|ip_address|user_agent/i.test(audit),
      "no email, token, hash, secret or request field may reach the audit metadata",
    );
    // organization_id is the RETAILER's, which is what keeps the row out of
    // list_vendor_audit_logs.
    assert.match(
      audit,
      /values\s*\(\s*\n?\s*v_retailer\s*,/,
      "the audit row must belong to the Retailer's activity feed",
    );
  });
});

// ============================================================================
// Nothing else moved
// ============================================================================
describe("staff shop assignment write — the blast radius is one function", () => {
  test("29. no direct client grant or RLS policy on retailer_shop_members", () => {
    assert.ok(
      !/grant[^;]*\bon\s+table\b/i.test(CODE),
      "no table privilege may be granted to any role",
    );
    assert.ok(
      !/create\s+policy|alter\s+policy|drop\s+policy/i.test(CODE),
      "no RLS policy may be created, altered or dropped",
    );
    assert.ok(
      !/enable\s+row\s+level\s+security|disable\s+row\s+level\s+security/i.test(CODE),
      "the RLS posture of every table must be left exactly as it was",
    );
    // And the foundation migration's posture is still what this milestone relies on.
    assert.match(
      FOUNDATION_SQL,
      /alter\s+table\s+public\.retailer_shop_members\s+enable\s+row\s+level\s+security/i,
      "retailer_shop_members must still have RLS enabled at the foundation",
    );
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(
        new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.retailer_shop_members\\s+from\\s+${role}`, "i").test(
          FOUNDATION_SQL,
        ),
        `retailer_shop_members must still REVOKE ALL from ${role}`,
      );
    }
  });

  test("30. the two existing read contracts are untouched", () => {
    // This milestone deliberately added no read RPC and edited none, so the roster and the
    // shop picker are still exactly what shipped — which is why no client can break.
    assert.ok(
      !CODE.includes("list_retailer_staff_members"),
      "the migration must not touch list_retailer_staff_members",
    );
    assert.ok(
      !CODE.includes("list_retailer_staff_assignable_shops"),
      "the migration must not touch list_retailer_staff_assignable_shops",
    );
    assert.ok(
      !CODE.includes("accept_retailer_staff_invitation"),
      "the migration must not touch accept_retailer_staff_invitation",
    );
    assert.match(
      ASSIGNABLE_SHOPS_SQL,
      /returns\s+table\s*\(\s*\n?\s*shop_id\s+uuid/i,
      "list_retailer_staff_assignable_shops must still return shop_id",
    );
  });

  test("31. this milestone ships NO UI and no client wrapper", () => {
    // The deliberate stop for anyone who starts integrating before the UI milestone: the
    // RPC name must not appear in application code yet.
    const appDirs = ["app", "lib", "components"];
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(rel);
        } else if (/\.tsx?$/.test(entry.name) && rel !== join("lib/staff", "staff-shop-assignment-contract.test.ts")) {
          if (readFileSync(join(ROOT, rel), "utf8").includes(FN)) offenders.push(rel);
        }
      }
    }
    for (const dir of appDirs) walk(dir);

    assert.deepEqual(
      offenders,
      [],
      `${FN} must not be referenced in application code — this is a backend-only milestone`,
    );
  });
});

// ============================================================================
// The documentation describes what the SQL does
// ============================================================================
describe("staff shop assignment write — documentation", () => {
  test("32. the behavioural suite exists and covers the load-bearing cases", () => {
    for (const marker of [
      FN,
      "SECTION H",
      "SECTION K",
      AUDIT_ACTION,
      AUDIT_ENTITY,
    ]) {
      assert.ok(PGTAP.includes(marker), `the pgTAP suite must reference ${marker}`);
    }
    // The suite must be honest about what one transaction cannot prove.
    assert.ok(
      /HONEST LIMITATION/.test(PGTAP),
      "the suite must state the concurrency limitation rather than let it read as coverage",
    );
  });

  test("33. the audit doc and both contract docs describe this contract accurately", () => {
    // The audit document records the decision, not just the recommendation.
    for (const marker of [
      FN,
      "p_membership_id",
      "shops_unchanged",
      MIGRATION_NAME,
      PERMISSION,
    ]) {
      assert.ok(AUDIT_DOC.includes(marker), `the audit doc must state ${marker}`);
    }
    assert.ok(
      /SHIPS NO UI/i.test(AUDIT_DOC),
      "the audit doc must state that this milestone ships no UI",
    );

    // RO-10 in the mobile backend contract.
    assert.ok(BACKEND_CONTRACT.includes("RO-10"), "the backend contract must add RO-10");
    for (const marker of [FN, PERMISSION, "shops_added", AUDIT_ACTION, AUDIT_ENTITY]) {
      assert.ok(BACKEND_CONTRACT.includes(marker), `RO-10 must state ${marker}`);
    }
    assert.ok(
      /backend-only milestone|backend only/i.test(BACKEND_CONTRACT),
      "RO-10 must state that no UI exists",
    );

    // The feature matrix row.
    assert.ok(FEATURE_MATRIX.includes(FN), "the feature matrix must name the RPC");
    assert.ok(
      /No UI exists on web or mobile/i.test(FEATURE_MATRIX),
      "the feature matrix must state that no UI exists",
    );
  });
});
