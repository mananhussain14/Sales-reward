/**
 * STATIC CONTRACT GUARDS for the Retailer staff MEMBERSHIP LIFECYCLE contracts
 *
 *   public.set_retailer_staff_membership_status(uuid, text)
 *   public.get_my_lifecycle_access_state()
 *     [20260810090000_retailer_staff_membership_lifecycle.sql]
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text and the documentation, in the
 * same idiom as ./staff-shop-assignment-contract.test.ts. They read the SQL and assert
 * structural properties that a careless later edit could silently destroy.
 *
 * They do NOT execute either function. The BEHAVIOURAL suite is
 *
 *     supabase/tests/database/retailer_staff_membership_lifecycle_test.sql
 *
 * which signs in as a dozen different callers, walks the whole validation matrix, proves the
 * preservation guarantees row by row, injects a post-UPDATE failure to prove atomicity, and
 * walks every word of the access_state vocabulary as the person it describes. It requires
 * Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of
 * properties that are cheap to assert on every `npm test` and expensive to notice once
 * broken: that neither signature grew an argument, that no auth.users write or hard delete
 * appeared, that no browser grant or RLS write policy was introduced, that
 * get_my_portal_context() was not edited, that receipt authorization is still delegated to
 * the database resolver, and that the documentation still describes what the SQL does.
 *
 * ============================================================================
 * THE SIX DECISIONS THESE GUARDS PIN
 * ============================================================================
 *   L-1  auth.users is NEVER written — no ban, no delete, no update. A deactivated person
 *        can still sign in; they simply have no Retailer context.
 *   L-2  NOTHING IS DELETED. Roles, Shop assignments (live and retired), receipts,
 *        invitations and audit history all survive, which is what makes reactivation a
 *        one-column write rather than a rebuild.
 *   L-3  Only {RETAILER_MANAGER} and {SALES_STAFF} are eligible targets, as EXACT role
 *        sets — so every Owner, multi-role and role-less target is refused.
 *   L-4  The caller may not address their own membership, as a rule separate from L-3.
 *   L-5  The diagnostic takes ZERO arguments and returns ONE closed-vocabulary word. It is
 *        not an authorization gate and must never become one.
 *   L-6  get_my_portal_context() is untouched: same signature, same context_version, same
 *        generic-denial behaviour.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");

const MIGRATION_NAME = "20260810090000_retailer_staff_membership_lifecycle.sql";
const SHOP_ASSIGNMENT_NAME = "20260809090000_retailer_staff_shop_assignment_management.sql";
const PORTAL_NAME = "20260729090000_shared_portal_context.sql";
const RECEIPT_OPS_NAME = "20260726210000_receipt_submission_operations.sql";
const FOUNDATION_NAME =
  "20260722210000_retailer_staff_role_permission_shop_assignment_foundation.sql";

const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
const PORTAL_SQL = readFileSync(join(MIGRATIONS_DIR, PORTAL_NAME), "utf8");
const RECEIPT_OPS_SQL = readFileSync(join(MIGRATIONS_DIR, RECEIPT_OPS_NAME), "utf8");
const FOUNDATION_SQL = readFileSync(join(MIGRATIONS_DIR, FOUNDATION_NAME), "utf8");

const PGTAP_NAME = "retailer_staff_membership_lifecycle_test.sql";
const PGTAP = readFileSync(join(ROOT, "supabase/tests/database", PGTAP_NAME), "utf8");

const AUDIT_DOC = readFileSync(
  join(ROOT, "docs/retailer-staff-membership-lifecycle-audit.md"),
  "utf8",
);
const BACKEND_CONTRACT = readFileSync(join(ROOT, "docs/mobile-backend-contract.md"), "utf8");
const FEATURE_MATRIX = readFileSync(join(ROOT, "docs/mobile-feature-matrix.md"), "utf8");

const RECEIPT_SUBMISSIONS_TS = readFileSync(
  join(ROOT, "lib/receipts/receipt-submissions.ts"),
  "utf8",
);

/** The write contract. */
const WRITE_FN = "set_retailer_staff_membership_status";
/** The self-only diagnostic. */
const READ_FN = "get_my_lifecycle_access_state";

const PERMISSION = "RETAILER_STAFF_MANAGE";
const AUDIT_ENTITY = "RETAILER_STAFF_MEMBER";
const AUDIT_DEACTIVATE = "STAFF_MEMBERSHIP_DEACTIVATED";
const AUDIT_REACTIVATE = "STAFF_MEMBERSHIP_REACTIVATED";

/** The two membership statuses this RPC owns, and no others. */
const STATUS_VOCABULARY = ["ACTIVE", "DEACTIVATED"] as const;

/** The six words the diagnostic may return, and no others. */
const ACCESS_STATE_VOCABULARY = [
  "ACTIVE",
  "PROFILE_INACTIVE",
  "MEMBERSHIP_INACTIVE",
  "ORGANIZATION_INACTIVE",
  "NO_SUPPORTED_ACCESS",
  "AMBIGUOUS",
] as const;

/** The three Retailer roles the diagnostic interprets. */
const SUPPORTED_ROLES = ["RETAILER_OWNER", "RETAILER_MANAGER", "SALES_STAFF"] as const;

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this migration's header discusses `auth.users`, `banned_until`, `delete`,
 * `service_role`, `profiles.status` and `RETAILER_OWNER` at length while doing none of them,
 * and its body explains exactly why each rule exists. Asserting against the raw text would
 * fail on the very sentences that state the guarantees.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

/** The TypeScript equivalent, so prose describing a rule cannot trip the rule it describes. */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const CODE = stripComments(MIGRATION_SQL);

/**
 * One `create [or replace] function` statement, from its CREATE through the closing `$$;` of
 * its body. Everything asserted per-function is asserted against this slice rather than the
 * whole file, so a clause belonging to one function can never satisfy an assertion about the
 * other — which matters here, because this migration installs two.
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

/** The declared return columns as [name, type] pairs. */
function returnColumns(statement: string, name: string): Array<[string, string]> {
  return returnsTableBlock(statement, name)
    .split(",")
    .map((entry) => entry.trim().split(/\s+/))
    .filter((parts) => parts[0].length > 0)
    .map((parts) => [parts[0], parts.slice(1).join(" ")] as [string, string]);
}

const WRITE_STATEMENT = statementFrom(CODE, WRITE_FN);
const READ_STATEMENT = statementFrom(CODE, READ_FN);

// ============================================================================
// The migration itself
// ============================================================================
describe("staff membership lifecycle — the migration", () => {
  test("1. the migration exists and is forward-only", () => {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    assert.ok(migrations.includes(MIGRATION_NAME), `${MIGRATION_NAME} must exist`);
    // Later than every migration it depends on. Deliberately NOT "sorts last": that is a
    // property of the moment rather than of this contract, and a test the next milestone
    // must edit to keep true is a test nobody trusts.
    for (const dependency of [SHOP_ASSIGNMENT_NAME, PORTAL_NAME, RECEIPT_OPS_NAME, FOUNDATION_NAME]) {
      assert.ok(
        MIGRATION_NAME > dependency,
        `the migration must sort after ${dependency}, which it depends on`,
      );
    }
  });

  test("2. plain CREATE FUNCTION — a conflicting object fails the migration", () => {
    for (const fn of [WRITE_FN, READ_FN]) {
      assert.ok(
        new RegExp(`create\\s+function\\s+public\\.${fn}\\s*\\(`).test(CODE),
        `the migration must define public.${fn}`,
      );
    }
    assert.ok(
      !/create\s+or\s+replace\s+function/i.test(CODE),
      "the migration must use plain CREATE FUNCTION, not CREATE OR REPLACE",
    );
  });

  test("3. EXACTLY TWO functions are created, and nothing else is", () => {
    const created = [...CODE.matchAll(/create\s+function\s+public\.(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(
      created.sort(),
      [READ_FN, WRITE_FN].sort(),
      "the migration installs exactly the two declared functions",
    );

    // No schema object of any other kind.
    assert.ok(
      !/create\s+(unique\s+)?(table|index|trigger|policy|type|view|sequence|extension)/i.test(
        CODE,
      ),
      "the migration must create no table, column, index, trigger, policy, type or view",
    );
    assert.ok(!/\balter\s+table\b/i.test(CODE), "the migration must alter no table");
    assert.ok(!/\bdrop\s+/i.test(CODE), "the migration must drop nothing");
  });

  test("4. no new permission, role or role -> permission mapping is seeded", () => {
    assert.ok(
      !/insert\s+into\s+public\.(permissions|roles|role_permissions)/i.test(CODE),
      "the migration must not seed a permission, role or role -> permission mapping",
    );
    // The Vendor-side Retailer lifecycle permission belongs to a LATER milestone and must
    // not appear here under any spelling.
    assert.ok(
      !/RETAILER_LIFECYCLE|RETAILER_STATUS_MANAGE|VENDOR_RETAILER_STATUS|RETAILER_DEACTIVATE/i.test(
        CODE,
      ),
      "no Vendor-side Retailer lifecycle permission may be introduced by this milestone",
    );
  });

  test("5. the migration writes exactly one table, and only its status pair", () => {
    const writes = [
      ...CODE.matchAll(/(?:insert\s+into|update|delete\s+from)\s+(public\.\w+)/gi),
    ].map((m) => m[1].toLowerCase());

    assert.deepEqual(
      [...new Set(writes)].sort(),
      ["public.audit_logs", "public.organization_members"],
      "the only tables written are organization_members (the status pair) and audit_logs",
    );

    // Exactly one UPDATE, and it sets exactly status and deactivated_at.
    const updates = [...CODE.matchAll(/update\s+public\.\w+/gi)];
    assert.equal(updates.length, 1, "there must be exactly ONE UPDATE statement");

    // The SET clause, split on TOP-LEVEL commas only — `deactivated_at = case ... end`
    // contains none, but a future edit might, and splitting naively would also pick up the
    // right-hand side of each assignment as if it were a column.
    const setBlock = CODE.slice(CODE.search(/update\s+public\.organization_members/i));
    const setClause = setBlock.slice(
      setBlock.search(/\bset\b/i) + 3,
      setBlock.search(/\bwhere\b/i),
    );
    const assigned: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of setClause) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        assigned.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    assigned.push(current);

    assert.deepEqual(
      assigned.map((entry) => entry.split("=")[0].trim()).sort(),
      ["deactivated_at", "status"],
      "the UPDATE assigns exactly status and deactivated_at — nothing else moves",
    );
  });
});

// ============================================================================
// The write signature
// ============================================================================
describe("staff membership lifecycle write — the signature", () => {
  test("6. exactly two arguments, named and ordered as the contract states", () => {
    assert.deepEqual(parameterNames(WRITE_STATEMENT, WRITE_FN), [
      "p_membership_id",
      "p_status",
    ]);
    assert.deepEqual(parameterTypes(WRITE_STATEMENT, WRITE_FN), ["uuid", "text"]);
  });

  test("7. no argument is defaulted — a half-addressed call is an error, not a guess", () => {
    assert.ok(
      !/default/i.test(parameterBlock(WRITE_STATEMENT, WRITE_FN)),
      "neither argument may carry a DEFAULT",
    );
  });

  test("8. no organization / Retailer / tenant argument", () => {
    for (const name of parameterNames(WRITE_STATEMENT, WRITE_FN)) {
      assert.ok(
        !/organization|retailer|tenant|company/i.test(name),
        `${name} looks like a caller-supplied tenant id; the Retailer must come from auth.uid()`,
      );
    }
  });

  test("9. no actor / caller / user / profile / auth argument", () => {
    for (const name of parameterNames(WRITE_STATEMENT, WRITE_FN)) {
      assert.ok(
        !/actor|caller|user|profile|auth|uid|email|token|claim/i.test(name),
        `${name} looks like a caller-supplied identity; the actor must come from auth.uid()`,
      );
    }
  });

  test("10. no role, permission, current-status, audit or timestamp argument", () => {
    for (const name of parameterNames(WRITE_STATEMENT, WRITE_FN)) {
      assert.ok(
        !/role|permission|audit|action|version|etag|updated|timestamp|deactivated_at|reason|note/i.test(
          name,
        ),
        `${name} would let a client assert something the backend must decide for itself`,
      );
      // p_status is the REQUESTED state and is legitimate. A SECOND status-ish argument
      // would be a client claim about the CURRENT state, which the backend must read for
      // itself under lock.
      assert.ok(
        !/current|expected|previous|from_status|was/i.test(name),
        `${name} would be a client claim about the current state`,
      );
    }
  });

  test("11. accepts the membership and the requested state and NOTHING else", () => {
    assert.deepEqual(
      parameterNames(WRITE_STATEMENT, WRITE_FN).filter(
        (n) => n !== "p_membership_id" && n !== "p_status",
      ),
      [],
    );
  });

  test("12. returns exactly the four declared columns, in order and by type", () => {
    assert.deepEqual(returnColumns(WRITE_STATEMENT, WRITE_FN), [
      ["membership_id", "uuid"],
      ["membership_status", "text"],
      ["role_code", "text"],
      ["status_changed", "boolean"],
    ]);
  });

  test("13. the return shape leaks no email, name, organization or timestamp", () => {
    const block = returnsTableBlock(WRITE_STATEMENT, WRITE_FN);
    assert.ok(
      !/timestamptz|jsonb|email|name\b|organization/i.test(block),
      "the return shape must carry no timestamp, payload, email, display name or organization",
    );
  });

  test("14. the target identifier is the MEMBERSHIP id, the one the roster already returns", () => {
    assert.ok(
      /p_membership_id\s+uuid/.test(WRITE_STATEMENT),
      "the target is addressed by organization_members.id",
    );
    // organization_members is UNIQUE (organization_id, user_id), so a membership id names
    // exactly one person in exactly one organization — which is what makes the single
    // organization_id predicate a complete cross-tenant boundary.
    assert.ok(
      /m\.organization_id\s*=\s*v_retailer/.test(WRITE_STATEMENT),
      "the target must be constrained to the DERIVED Retailer — the cross-tenant boundary",
    );
    assert.ok(
      !/p_(profile|user|auth|email|owner)_id/.test(WRITE_STATEMENT),
      "no profile id, auth user id or email may address the target",
    );
  });
});

// ============================================================================
// The write: authorization and tenancy
// ============================================================================
describe("staff membership lifecycle write — authorization", () => {
  test("15. gates on the EXISTING RETAILER_STAFF_MANAGE permission", () => {
    assert.ok(
      WRITE_STATEMENT.includes(`resolve_retailer_member_organization('${PERMISSION}')`),
      `the body must resolve the Retailer through ${PERMISSION}`,
    );
    // The permission already exists — this milestone reuses it rather than inventing one.
    assert.ok(
      FOUNDATION_SQL.includes(PERMISSION),
      `${PERMISSION} must already be seeded by the foundation migration`,
    );
  });

  test("16. no CALLER role code gates the operation — the mapping is the authority", () => {
    // RETAILER_OWNER must not appear in executable code at all. The Owner EXCLUSION is
    // achieved by requiring an exact one-element role set, not by naming the banned role —
    // which is what makes it hold for any future role too.
    assert.ok(
      !WRITE_STATEMENT.includes("RETAILER_OWNER"),
      "the executable write body must name no RETAILER_OWNER role code",
    );
    // The two ELIGIBLE TARGET roles DO appear: they constrain the target, not the caller.
    assert.ok(
      WRITE_STATEMENT.includes("RETAILER_MANAGER") &&
        WRITE_STATEMENT.includes("SALES_STAFF"),
      "the two eligible TARGET roles must be named — that is a target rule, not a caller gate",
    );
  });

  test("17. L-3 — the eligible role set is EXACT, never a membership test", () => {
    // `= array['X']` and not `'X' = any(...)`. The exact-set comparison is what refuses a
    // multi-role target and a role-less target in the same breath as an Owner.
    assert.ok(
      /v_role_codes\s*=\s*array\['RETAILER_MANAGER'\]/.test(WRITE_STATEMENT),
      "a RETAILER_MANAGER target must be matched as an EXACT one-element role set",
    );
    assert.ok(
      /v_role_codes\s*=\s*array\['SALES_STAFF'\]/.test(WRITE_STATEMENT),
      "and so must a SALES_STAFF target",
    );
    assert.ok(
      !/=\s*any\s*\(\s*v_role_codes/.test(WRITE_STATEMENT),
      "the role check must not degrade into a membership test, which would admit multi-role targets",
    );
    // The role set read must be restricted to ACTIVE roles, as every resolver is.
    assert.ok(
      /r\.status\s*=\s*'ACTIVE'/.test(WRITE_STATEMENT),
      "only ACTIVE roles may count toward the target's role set",
    );
  });

  test("18. L-4 — the caller may not address their own membership", () => {
    assert.ok(
      /v_target_user\s*=\s*v_actor/.test(WRITE_STATEMENT),
      "the body must compare the target's user id to the actor and refuse a self target",
    );
    // Compared on the USER id rather than the membership id, so it holds regardless of how
    // the caller's own membership was addressed.
    assert.ok(
      /m\.user_id/.test(WRITE_STATEMENT),
      "the self check must be made on user_id, not on the membership id the caller supplied",
    );
  });

  test("19. SECURITY DEFINER, VOLATILE, empty search_path, no dynamic SQL", () => {
    assert.ok(/security\s+definer/i.test(WRITE_STATEMENT));
    assert.ok(/\bvolatile\b/i.test(WRITE_STATEMENT));
    assert.ok(/set\s+search_path\s*=\s*''/.test(WRITE_STATEMENT));
    assert.ok(
      !/\bexecute\s+(format|'|")/i.test(WRITE_STATEMENT),
      "no dynamic SQL — a tenant predicate assembled by concatenation is one waiting to be lost",
    );
  });

  test("20. granted to authenticated only — never anon, PUBLIC or service_role", () => {
    for (const fn of [
      `${WRITE_FN}(uuid, text)`,
      `${READ_FN}()`,
    ]) {
      assert.ok(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn.replace(/[()[\]]/g, "\\$&")}\\s+from\\s+public`, "i").test(
          CODE,
        ),
        `EXECUTE must be revoked from PUBLIC on ${fn}`,
      );
      assert.ok(
        new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn.replace(/[()[\]]/g, "\\$&")}\\s+from\\s+anon`, "i").test(
          CODE,
        ),
        `EXECUTE must be revoked from anon on ${fn}`,
      );
      assert.ok(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn.replace(/[()[\]]/g, "\\$&")}\\s+to\\s+authenticated`, "i").test(
          CODE,
        ),
        `EXECUTE must be granted to authenticated on ${fn}`,
      );
    }
    assert.ok(
      !/grant[\s\S]*?to\s+service_role/i.test(CODE),
      "neither function may be granted to service_role — their whole authority is auth.uid()",
    );
  });

  test("21. every id is derived, none is accepted", () => {
    assert.ok(
      /v_actor\s*:=\s*auth\.uid\(\)/.test(WRITE_STATEMENT),
      "the actor must be auth.uid()",
    );
    assert.ok(
      /v_retailer\s*:=\s*public\.resolve_retailer_member_organization/.test(WRITE_STATEMENT),
      "the Retailer must come from the resolver, never from an argument",
    );
    // The audit row's actor and organization are the DERIVED values, not supplied ones.
    assert.ok(
      /values\s*\(\s*\n?\s*v_retailer,\s*\n?\s*v_actor,/.test(WRITE_STATEMENT),
      "the audit row's organization_id and actor_profile_id must be the derived values",
    );
  });
});

// ============================================================================
// The write: preservation — the whole point of the milestone
// ============================================================================
describe("staff membership lifecycle write — preservation", () => {
  test("22. L-1 — auth.users is never referenced, let alone banned or deleted", () => {
    assert.ok(
      !/auth\.users/i.test(CODE),
      "no executable line in this migration may reference auth.users",
    );
    assert.ok(
      !/banned_until|deleted_at|ban_duration/i.test(CODE),
      "no Auth ban or soft-delete field may be written",
    );
    // auth.uid() is the ONE auth reference that is legitimate — it is the caller's identity,
    // not a row to write.
    assert.ok(
      /auth\.uid\(\)/.test(CODE),
      "auth.uid() is the only permitted auth reference, and it must be present",
    );
  });

  test("23. L-2 — there is NO DELETE and NO TRUNCATE anywhere", () => {
    assert.ok(
      !/\bdelete\s+from\b/i.test(CODE),
      "a membership is deactivated, never destroyed — no DELETE may appear",
    );
    assert.ok(!/\btruncate\b/i.test(CODE), "no TRUNCATE may appear");
  });

  test("24. member_roles is READ but never written — reactivation restores it for free", () => {
    assert.ok(
      /from\s+public\.member_roles/i.test(WRITE_STATEMENT),
      "the body reads member_roles to prove the target's role set",
    );
    assert.ok(
      !/(insert\s+into|update|delete\s+from)\s+public\.member_roles/i.test(CODE),
      "member_roles must never be written — the role assignment survives deactivation",
    );
  });

  test("25. retailer_shop_members is not referenced at all", () => {
    assert.ok(
      !/retailer_shop_members/i.test(CODE),
      "Shop assignments — live and retired — must be untouched and unmentioned in executable code",
    );
  });

  test("26. profiles is read for the actor but never written", () => {
    assert.ok(
      /from\s+public\.profiles/i.test(WRITE_STATEMENT),
      "the body re-affirms the ACTIVE actor profile",
    );
    assert.ok(
      !/(insert\s+into|update|delete\s+from)\s+public\.profiles/i.test(CODE),
      "profiles.status is not this feature's to change — a membership is not an identity",
    );
  });

  test("27. receipts and invitations are neither read nor written", () => {
    assert.ok(
      !/receipt_submissions|retailer_staff_invitations/i.test(CODE),
      "receipt and invitation history must be untouched and unmentioned",
    );
  });
});

// ============================================================================
// The write: state machine, idempotency, locking
// ============================================================================
describe("staff membership lifecycle write — state machine", () => {
  test("28. the requested status vocabulary is EXACTLY the two words", () => {
    const check = WRITE_STATEMENT.slice(
      WRITE_STATEMENT.search(/p_status\s+is\s+null\s+or\s+p_status\s+not\s+in/i),
    );
    assert.ok(check.length > 0, "the body must validate p_status against a closed list");

    const listed = [...check.slice(0, check.indexOf("then")).matchAll(/'([A-Z_]+)'/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      listed,
      [...STATUS_VOCABULARY],
      "p_status is accepted only as ACTIVE or DEACTIVATED",
    );

    // INVITED and SUSPENDED are column-level values but are NOT this RPC's vocabulary.
    assert.ok(
      !/p_status\s+not\s+in\s*\([^)]*'(INVITED|SUSPENDED)'/i.test(WRITE_STATEMENT),
      "INVITED and SUSPENDED must not be accepted requested states",
    );
    // ...and they are not assignable through any other path either.
    assert.ok(
      !/set\s+status\s*=\s*'(INVITED|SUSPENDED)'/i.test(CODE),
      "no code path may write INVITED or SUSPENDED",
    );
  });

  test("29. only ACTIVE and DEACTIVATED are permitted CURRENT states", () => {
    assert.ok(
      /v_current\s+not\s+in\s*\(\s*'ACTIVE'\s*,\s*'DEACTIVATED'\s*\)/.test(WRITE_STATEMENT),
      "an INVITED or SUSPENDED membership must not be transitioned by this RPC",
    );
  });

  test("30. the status comparison is exact and case-sensitive — no coercion", () => {
    assert.ok(
      !/upper\s*\(\s*p_status|lower\s*\(\s*p_status|btrim\s*\(\s*p_status|trim\s*\(\s*p_status/i.test(
        WRITE_STATEMENT,
      ),
      "p_status must not be upper-cased, lower-cased or trimmed — a silent coercion would make the audit trail disagree with the request",
    );
  });

  test("31. an identical requested status is a true no-op — no UPDATE, no audit row", () => {
    const noopAt = WRITE_STATEMENT.search(/if\s+v_current\s*=\s*p_status\s+then/i);
    assert.notEqual(noopAt, -1, "the body must short-circuit when the status already matches");

    const updateAt = WRITE_STATEMENT.search(/update\s+public\.organization_members/i);
    const auditAt = WRITE_STATEMENT.search(/insert\s+into\s+public\.audit_logs/i);
    assert.ok(
      noopAt < updateAt && noopAt < auditAt,
      "the no-op branch must return BEFORE the UPDATE and BEFORE the audit insert",
    );
    // It returns status_changed = false rather than raising, so a client can tell "already
    // deactivated" from "denied".
    assert.ok(
      /return\s+query\s+select\s+v_member_id,\s*v_current,\s*v_role_code,\s*false/.test(
        WRITE_STATEMENT,
      ),
      "the no-op must return status_changed = false rather than raising",
    );
  });

  test("32. deactivated_at is set and cleared in the SAME statement as the status", () => {
    assert.ok(
      /set\s+status\s*=\s*p_status,\s*\n?\s*deactivated_at\s*=\s*case\s+when\s+p_status\s*=\s*'DEACTIVATED'\s+then\s+now\(\)\s+else\s+null\s+end/i.test(
        WRITE_STATEMENT,
      ),
      "status and deactivated_at must move together, so the pair can never disagree",
    );
  });

  test("33. locking: FOR UPDATE on the target, FOR SHARE on the acting Retailer", () => {
    assert.ok(
      /for\s+update/i.test(WRITE_STATEMENT),
      "the target membership must be locked FOR UPDATE — the serialization point",
    );
    assert.ok(
      /for\s+share/i.test(WRITE_STATEMENT),
      "the acting Retailer's lifecycle row must be pinned FOR SHARE",
    );
    // The Retailer is pinned BEFORE the target is read, so a suspended Retailer cannot be
    // used as an oracle for which membership ids live inside it.
    assert.ok(
      WRITE_STATEMENT.search(/for\s+share/i) < WRITE_STATEMENT.search(/for\s+update/i),
      "the Retailer must be pinned before the target membership is locked",
    );
    // No client-supplied concurrency token of any kind.
    assert.ok(
      !/p_(version|etag|updated_at|expected)/i.test(WRITE_STATEMENT),
      "there must be no client-supplied version, ETag or expected-state argument",
    );
  });

  test("34. the UPDATE row count is checked, and drift fails atomically", () => {
    assert.ok(
      /get\s+diagnostics\s+v_updated\s*=\s*row_count/i.test(WRITE_STATEMENT),
      "the body must read the UPDATE's row count rather than assume it",
    );
    assert.ok(
      /if\s+v_updated\s*<>\s*1\s+then[\s\S]*?raise\s+exception/i.test(WRITE_STATEMENT),
      "an unexpected row count must raise, abandoning the whole transaction",
    );
    // Compare-and-set: the UPDATE re-states the status it read under lock.
    assert.ok(
      /and\s+m\.status\s*=\s*v_current/.test(WRITE_STATEMENT),
      "the UPDATE must be a compare-and-set against the status read under lock",
    );
  });
});

// ============================================================================
// The write: SQLSTATE taxonomy
// ============================================================================
describe("staff membership lifecycle write — the SQLSTATE taxonomy", () => {
  /** Every `raise exception '<message>' ... using errcode = '<code>'` in a statement. */
  function raises(statement: string): Array<{ message: string; errcode: string }> {
    return [
      ...statement.matchAll(
        /raise\s+exception\s+'((?:[^']|'')*)'\s*\n?\s*using\s+errcode\s*=\s*'([a-z_]+)'/gi,
      ),
    ].map((m) => ({ message: m[1], errcode: m[2] }));
  }

  const WRITE_RAISES = raises(WRITE_STATEMENT);

  test("35. the taxonomy is stable SQLSTATE names, never message matching", () => {
    assert.ok(WRITE_RAISES.length > 0, "the write must raise with explicit errcodes");
    for (const r of WRITE_RAISES) {
      assert.ok(
        ["insufficient_privilege", "check_violation", "object_not_in_prerequisite_state"].includes(
          r.errcode,
        ),
        `${r.errcode} is not one of the three declared conditions (42501 / 23514 / 55000)`,
      );
    }
    // Named conditions, not bare five-character codes — a typo in a literal is silent.
    assert.ok(
      !/using\s+errcode\s*=\s*'\d/.test(WRITE_STATEMENT),
      "errcodes must be named conditions, not numeric literals",
    );
  });

  test("36. all disclosure-sensitive refusals share ONE literal message", () => {
    const privilegeMessages = new Set(
      WRITE_RAISES.filter((r) => r.errcode === "insufficient_privilege").map((r) => r.message),
    );
    assert.equal(
      privilegeMessages.size,
      1,
      `every 42501 must use the same safe literal message; found ${[...privilegeMessages].join(" | ")}`,
    );
    // And there must be several of them — unauthenticated, unresolved Retailer, inactive
    // actor profile, unknown/foreign target, self target, ineligible role set, ineligible
    // current state, and update drift.
    assert.ok(
      WRITE_RAISES.filter((r) => r.errcode === "insufficient_privilege").length >= 6,
      "the generic refusal must cover every disclosure-sensitive branch",
    );
  });

  test("37. the safe message names no id, email, role, status or organization", () => {
    for (const r of WRITE_RAISES) {
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(r.message),
        `the refusal message must not carry a uuid: ${r.message}`,
      );
      assert.ok(
        !/@|SALES_STAFF|RETAILER_MANAGER|RETAILER_OWNER|DEACTIVATED|INVITED|SUSPENDED/.test(
          r.message,
        ),
        `the refusal message must not name a role, status or address: ${r.message}`,
      );
      // No format()/concatenation — a message built from a value is a message that can leak.
      assert.ok(
        !/%|\|\|/.test(r.message),
        `the refusal message must be a fixed literal: ${r.message}`,
      );
    }
  });

  test("38. 23514 is reserved for the caller's own invalid input", () => {
    const checks = WRITE_RAISES.filter((r) => r.errcode === "check_violation");
    assert.equal(checks.length, 1, "exactly one branch raises 23514 — the p_status vocabulary");
  });

  test("39. 55000 is the acting Retailer's lifecycle, and it is checked after authorization", () => {
    const prereq = WRITE_RAISES.filter(
      (r) => r.errcode === "object_not_in_prerequisite_state",
    );
    assert.equal(prereq.length, 1, "exactly one branch raises 55000");

    const resolverAt = WRITE_STATEMENT.search(/resolve_retailer_member_organization/);
    const prereqAt = WRITE_STATEMENT.search(/object_not_in_prerequisite_state/);
    assert.ok(
      resolverAt < prereqAt,
      "55000 may only be reached by an ALREADY-AUTHORIZED caller",
    );
  });

  test("40. authorization is decided BEFORE the input is validated", () => {
    // Otherwise the input check becomes an oracle: "your status was invalid" tells a
    // stranger they got past the door.
    const authAt = WRITE_STATEMENT.search(/resolve_retailer_member_organization/);
    const inputAt = WRITE_STATEMENT.search(/p_status\s+is\s+null\s+or\s+p_status\s+not\s+in/i);
    assert.ok(
      authAt < inputAt,
      "a stranger with a malformed status must be refused as a stranger (42501), not as invalid input",
    );
  });
});

// ============================================================================
// The write: audit
// ============================================================================
describe("staff membership lifecycle write — audit", () => {
  test("41. one audit row per real change, with the two directional actions", () => {
    const inserts = [...CODE.matchAll(/insert\s+into\s+public\.audit_logs/gi)];
    assert.equal(inserts.length, 1, "exactly one audit insert exists in the migration");

    assert.ok(WRITE_STATEMENT.includes(`'${AUDIT_DEACTIVATE}'`), "the deactivate action");
    assert.ok(WRITE_STATEMENT.includes(`'${AUDIT_REACTIVATE}'`), "the reactivate action");
    assert.ok(WRITE_STATEMENT.includes(`'${AUDIT_ENTITY}'`), "the shared entity type");
    assert.ok(
      /v_member_id::text/.test(WRITE_STATEMENT),
      "entity_id is the membership id as text",
    );
  });

  test("42. the metadata carries exactly three proved values", () => {
    const at = WRITE_STATEMENT.search(/jsonb_build_object/);
    assert.notEqual(at, -1, "the audit row must build its metadata explicitly");
    const block = WRITE_STATEMENT.slice(at);
    const keys = [...block.matchAll(/'([a-z_]+)',\s+v_|'([a-z_]+)',\s+p_/g)].map(
      (m) => m[1] ?? m[2],
    );
    assert.deepEqual(
      keys,
      ["role_code", "membership_status_before", "membership_status_after"],
      "exactly role_code, membership_status_before and membership_status_after",
    );
  });

  test("43. the metadata carries no identifier or personal information", () => {
    const at = WRITE_STATEMENT.search(/jsonb_build_object/);
    const block = WRITE_STATEMENT.slice(at, WRITE_STATEMENT.indexOf(");", at));
    for (const forbidden of [
      "email",
      "token",
      "hash",
      "secret",
      "password",
      "v_actor",
      "v_target_user",
      "auth",
      "shop",
      "invitation",
      "receipt",
      "provider",
    ]) {
      assert.ok(
        !new RegExp(forbidden, "i").test(block),
        `the audit metadata must not carry ${forbidden}`,
      );
    }
    // No caller-supplied value beyond the VALIDATED p_status, which the function proved
    // against its closed vocabulary before this point.
    assert.ok(
      !/p_membership_id/.test(block),
      "the raw membership argument must not appear in metadata — entity_id already carries it",
    );
  });

  test("44. no audit row on a no-op — a double-tap is not two decisions", () => {
    const noopAt = WRITE_STATEMENT.search(/if\s+v_current\s*=\s*p_status\s+then/i);
    const auditAt = WRITE_STATEMENT.search(/insert\s+into\s+public\.audit_logs/i);
    assert.ok(noopAt < auditAt, "the no-op branch returns before any audit row is written");
  });
});

// ============================================================================
// The self-only diagnostic
// ============================================================================
describe("lifecycle access-state diagnostic — the contract", () => {
  test("45. L-5 — ZERO arguments", () => {
    assert.deepEqual(
      parameterNames(READ_STATEMENT, READ_FN),
      [],
      "the diagnostic must take no argument at all — there is nothing to substitute",
    );
    assert.ok(
      /create\s+function\s+public\.get_my_lifecycle_access_state\s*\(\s*\)/.test(CODE),
      "declared with an empty parameter list",
    );
  });

  test("46. returns exactly one column, named access_state, of type text", () => {
    assert.deepEqual(returnColumns(READ_STATEMENT, READ_FN), [["access_state", "text"]]);
  });

  test("47. the result carries no identifier or personal information", () => {
    const block = returnsTableBlock(READ_STATEMENT, READ_FN);
    assert.ok(
      !/uuid|timestamptz|jsonb|email|name|organization|membership_id|profile|role/i.test(block),
      "no id, name, email, organization, role, timestamp or payload may be returned",
    );
    // And nothing in the body returns a value that is not a vocabulary literal.
    const returned = [...READ_STATEMENT.matchAll(/return\s+query\s+select\s+([^;]+);/gi)].map(
      (m) => m[1].trim(),
    );
    assert.ok(returned.length > 0, "the diagnostic must return through return query select");
    for (const expr of returned) {
      assert.ok(
        /^'[A-Z_]+'::text$/.test(expr),
        `every returned value must be a bare vocabulary literal, not ${expr}`,
      );
    }
  });

  test("48. the access_state vocabulary is EXACTLY the six declared words", () => {
    const returned = [...READ_STATEMENT.matchAll(/return\s+query\s+select\s+'([A-Z_]+)'::text/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      [...new Set(returned)].sort(),
      [...ACCESS_STATE_VOCABULARY].sort(),
      "the body returns exactly the six declared words, and no seventh",
    );
  });

  test("49. STABLE, SECURITY DEFINER, empty search_path, and it writes nothing", () => {
    assert.ok(/security\s+definer/i.test(READ_STATEMENT));
    assert.ok(/\bstable\b/i.test(READ_STATEMENT));
    assert.ok(!/\bvolatile\b/i.test(READ_STATEMENT));
    assert.ok(/set\s+search_path\s*=\s*''/.test(READ_STATEMENT));
    for (const write of [/insert\s+into/i, /\bupdate\s+public\./i, /delete\s+from/i]) {
      assert.ok(!write.test(READ_STATEMENT), "the diagnostic must perform no write");
    }
    assert.ok(
      !/\bexecute\s+(format|'|")/i.test(READ_STATEMENT),
      "the diagnostic must contain no dynamic SQL",
    );
  });

  test("50. the subject is auth.uid(), and no tenant or identifier is accepted", () => {
    assert.ok(
      /v_uid\s*:=\s*auth\.uid\(\)/.test(READ_STATEMENT),
      "the subject must be auth.uid()",
    );
    assert.ok(
      /m\.user_id\s*=\s*v_uid/.test(READ_STATEMENT),
      "memberships must be filtered to the caller's own",
    );
    assert.ok(
      /p\.id\s*=\s*v_uid/.test(READ_STATEMENT),
      "and the profile read must be the caller's own",
    );
  });

  test("51. an unauthenticated call is 42501, not a vocabulary word", () => {
    assert.ok(
      /if\s+v_uid\s+is\s+null\s+then[\s\S]{0,300}?errcode\s*=\s*'insufficient_privilege'/i.test(
        READ_STATEMENT,
      ),
      "a signed-out caller must be refused, not described",
    );
  });

  test("52. exactly the three supported Retailer roles are interpreted", () => {
    const at = READ_STATEMENT.search(/r\.code\s+in\s*\(/);
    assert.notEqual(at, -1, "the body must restrict to a closed role list");
    const list = READ_STATEMENT.slice(at, READ_STATEMENT.indexOf(")", at));
    const roles = [...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(roles, [...SUPPORTED_ROLES]);
    assert.ok(
      !/VENDOR_SUPER_ADMIN/.test(READ_STATEMENT),
      "the Vendor role is not interpreted — a Vendor-only user has NO_SUPPORTED_ACCESS",
    );
  });

  test("53. organization-inactive takes precedence over membership-inactive", () => {
    const orgAt = READ_STATEMENT.search(/'ORGANIZATION_INACTIVE'/);
    const memberAt = READ_STATEMENT.search(/'MEMBERSHIP_INACTIVE'/);
    assert.ok(
      orgAt < memberAt,
      "the Retailer-wide cause must be tested first — it is broader, and the only one an Owner could act on",
    );
    // And the profile is broader still.
    const profileAt = READ_STATEMENT.search(/'PROFILE_INACTIVE'/);
    assert.ok(profileAt < orgAt, "the profile is the broadest cause of all");
  });

  test("54. it does not resolve through the authorization resolvers", () => {
    // The resolvers require an ACTIVE membership in an ACTIVE organization, so every state
    // this function exists to distinguish would collapse into one NULL.
    assert.ok(
      !/resolve_retailer_member_organization|resolve_retailer_owner_organization|get_vendor_super_admin_context/.test(
        READ_STATEMENT,
      ),
      "the diagnostic must read the rows directly, not through a resolver that fails closed",
    );
  });

  test("55. L-5 — it is not an authorization gate, and says so", () => {
    assert.ok(
      /NOT AN AUTHORIZATION GATE/i.test(MIGRATION_SQL),
      "the migration must state that the diagnostic authorizes nothing",
    );
    // The write does not consult it.
    assert.ok(
      !WRITE_STATEMENT.includes(READ_FN),
      "no write may authorize through the diagnostic",
    );
  });
});

// ============================================================================
// The blast radius
// ============================================================================
describe("staff membership lifecycle — the blast radius", () => {
  test("56. no table grant or RLS policy is added anywhere", () => {
    assert.ok(
      !/grant\s+(select|insert|update|delete|all)[\s\S]{0,80}?\bon\s+table\b/i.test(CODE),
      "no table privilege may be granted",
    );
    assert.ok(
      !/create\s+policy|alter\s+policy/i.test(CODE),
      "no RLS policy may be created or altered — the RPC is the only way in",
    );
    assert.ok(
      !/enable\s+row\s+level\s+security|disable\s+row\s+level\s+security/i.test(CODE),
      "RLS posture must not be changed",
    );
  });

  test("57. L-6 — get_my_portal_context() is not edited by this migration", () => {
    assert.ok(
      !CODE.includes("get_my_portal_context"),
      "no executable line may reference get_my_portal_context",
    );
    // Its own migration still declares it the same way, with the same version.
    assert.ok(
      /create\s+function\s+public\.get_my_portal_context\s*\(\s*\)/.test(PORTAL_SQL),
      "get_my_portal_context() keeps its zero-argument signature",
    );
    assert.ok(
      /returns\s+jsonb/i.test(statementFrom(stripComments(PORTAL_SQL), "get_my_portal_context")),
      "and its jsonb return",
    );
    assert.ok(
      /'context_version',\s*1/.test(PORTAL_SQL),
      "and context_version stays at 1 — no shipped client contract moved",
    );
  });

  test("58. no existing function is replaced", () => {
    assert.ok(
      !/create\s+or\s+replace\s+function/i.test(CODE),
      "the migration replaces no function",
    );
    assert.ok(
      !/drop\s+function/i.test(CODE),
      "and drops none",
    );
  });

  test("59. receipt authorization is still delegated to the database resolver", () => {
    // The block that takes effect on an existing session is the EXISTING one: the receipt
    // RPC resolves RECEIPT_SUBMIT itself and requires an ACTIVE membership. This milestone
    // relies on that and must not have re-implemented it.
    assert.ok(
      RECEIPT_OPS_SQL.includes("resolve_retailer_member_organization('RECEIPT_SUBMIT')"),
      "reserve_receipt_submission must still resolve its own authorization",
    );
    assert.ok(
      /m\.status\s*=\s*'ACTIVE'/.test(RECEIPT_OPS_SQL),
      "and must still require an ACTIVE membership — this is what blocks a deactivated member",
    );

    // The application still calls it on the SESSION client, so the database decides. A
    // service-role call would bypass auth.uid() and with it the entire lifecycle block.
    const ts = stripTsComments(RECEIPT_SUBMISSIONS_TS);
    assert.ok(
      /supabase\.rpc\(RESERVE_RPC/.test(ts),
      "the reserve RPC must be called on the SESSION client — that is what makes auth.uid(), and therefore the membership status, decide",
    );
    // RESERVE is the authorization step and must never move to the service-role client: a
    // service-role connection has no auth.uid(), so the lifecycle block would silently stop
    // applying. The later finalize / record-failure calls DO use the admin client by design
    // (post-upload bookkeeping against a submission the session already reserved), so this
    // is asserted narrowly about RESERVE rather than as a blanket ban.
    assert.ok(
      !/admin\.rpc\(\s*RESERVE_RPC/.test(ts),
      "the reserve RPC must NOT be invoked through the service-role client",
    );
    // No client-side re-implementation of the membership check.
    assert.ok(
      !/organization_members/.test(ts),
      "the application must not read membership status to decide receipt eligibility",
    );
  });

  test("60. each RPC is reached through exactly ONE server-only wrapper", () => {
    // WHEN THIS MILESTONE SHIPPED this assertion read "neither RPC has an application call
    // site yet", which was true of a backend-only change and false the moment a client
    // consumed it. The web staff-lifecycle milestone added those consumers deliberately, so
    // the rule is now the durable one: each RPC name may appear in exactly ONE module, and
    // that module must be the server-only wrapper. A second call site would be a second
    // place for the SQLSTATE mapping and the response parsing to live, and only one of the
    // two could stay right.
    const WRAPPERS: Record<string, string> = {
      [WRITE_FN]: "lib/staff/retailer-staff-membership-status.ts",
      [READ_FN]: "lib/staff/my-lifecycle-access-state.ts",
    };

    const roots = ["app", "lib", "components"];
    const hits: Record<string, string[]> = { [WRITE_FN]: [], [READ_FN]: [] };

    const walk = (dir: string): void => {
      if (!existsSync(join(ROOT, dir))) return;
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // Test suites name the functions in order to test them, and are not call sites.
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const code = stripTsComments(readFileSync(join(ROOT, rel), "utf8"));
        for (const fn of [WRITE_FN, READ_FN]) {
          if (code.includes(fn)) hits[fn].push(rel);
        }
      }
    };
    for (const root of roots) walk(root);

    for (const fn of [WRITE_FN, READ_FN]) {
      assert.deepEqual(
        hits[fn],
        [WRAPPERS[fn]],
        `${fn} must be named in exactly its own wrapper; found: ${hits[fn].join(", ")}`,
      );
    }
  });

  test("61. no service-role client is introduced anywhere by this milestone", () => {
    assert.ok(
      !/service_role/i.test(CODE),
      "the migration must not mention service_role in executable code",
    );
  });
});

// ============================================================================
// Tests and documentation
// ============================================================================
describe("staff membership lifecycle — tests and documentation", () => {
  test("62. the behavioural suite exists and covers the load-bearing cases", () => {
    assert.ok(PGTAP.includes(WRITE_FN), "the pgTAP suite must exercise the write");
    assert.ok(PGTAP.includes(READ_FN), "and the diagnostic");

    for (const marker of [
      // Every access_state word is walked behaviourally.
      ...ACCESS_STATE_VOCABULARY,
      // The preservation guarantees.
      "member_roles",
      "retailer_shop_members",
      "receipt",
      "invitation",
      "banned_until",
      // The refusal matrix.
      "SUSPENDED",
      "INVITED",
      // Idempotency and atomicity.
      "status_changed",
      "rolled back",
      // The existing-session claim.
      "reserve_receipt_submission",
      "get_my_portal_context",
    ]) {
      assert.ok(PGTAP.includes(marker), `the pgTAP suite must cover ${marker}`);
    }

    // The suite must be honest about what one transaction cannot prove.
    assert.ok(
      /HONEST LIMITATION/.test(PGTAP),
      "the suite must state the 55000 limitation rather than let it read as coverage",
    );
  });

  test("63. the audit doc records the decisions, not just the recommendation", () => {
    for (const marker of [
      WRITE_FN,
      READ_FN,
      "p_membership_id",
      "p_status",
      "status_changed",
      "access_state",
      MIGRATION_NAME,
      PERMISSION,
      AUDIT_DEACTIVATE,
      AUDIT_REACTIVATE,
      ...ACCESS_STATE_VOCABULARY,
    ]) {
      assert.ok(AUDIT_DOC.includes(marker), `the audit doc must state ${marker}`);
    }

    assert.ok(
      /SHIPS NO UI/i.test(AUDIT_DOC),
      "the audit doc must state that this milestone ships no UI",
    );
    // The two decisions most likely to be questioned later.
    assert.ok(
      /auth\.users/.test(AUDIT_DOC) && /ban/i.test(AUDIT_DOC),
      "the audit doc must explain why auth.users is not banned or deleted",
    );
    assert.ok(
      /later milestone|future milestone/i.test(AUDIT_DOC) && /Vendor/.test(AUDIT_DOC),
      "the audit doc must state that the Vendor Retailer lifecycle is a later milestone",
    );
    assert.ok(
      /diagnostic/i.test(AUDIT_DOC) && /not.{0,40}(authorization|gate)/i.test(AUDIT_DOC),
      "the audit doc must explain why the diagnostic is separate from authorization",
    );
  });

  test("64. the backend contract carries both new operations", () => {
    assert.ok(BACKEND_CONTRACT.includes("RO-11"), "the backend contract must add RO-11");
    // The diagnostic is a shared, auth-adjacent context read, so it joins the AUTH-0x
    // family alongside AUTH-05 (get_my_portal_context) rather than starting a new series.
    assert.ok(BACKEND_CONTRACT.includes("AUTH-06"), "and the shared diagnostic entry AUTH-06");

    for (const marker of [
      WRITE_FN,
      READ_FN,
      PERMISSION,
      AUDIT_DEACTIVATE,
      AUDIT_REACTIVATE,
      AUDIT_ENTITY,
      "status_changed",
      "access_state",
      ...STATUS_VOCABULARY,
      ...ACCESS_STATE_VOCABULARY,
    ]) {
      assert.ok(BACKEND_CONTRACT.includes(marker), `the contract must state ${marker}`);
    }

    // The rule a client is most likely to get wrong: this is a diagnostic, not a gate.
    // `[\s\S]` rather than the `s` flag: the tsconfig target predates ES2018.
    assert.ok(
      /never[\s\S]{0,80}(authorization|gate)|not an authorization gate/i.test(BACKEND_CONTRACT),
      "the contract must warn that the diagnostic authorizes nothing",
    );
    // And the one a client must not assume: a deactivated person can still sign in.
    // Whitespace-tolerant, because the sentence is wrapped in the rendered table cell.
    assert.ok(
      /can\s+still\s+sign\s+in/i.test(BACKEND_CONTRACT),
      "the contract must state that a deactivated person can still sign in",
    );
  });

  test("65. the feature matrix rows are honest about every client", () => {
    assert.ok(FEATURE_MATRIX.includes(WRITE_FN), "the feature matrix must name the write");
    assert.ok(FEATURE_MATRIX.includes(READ_FN), "and the diagnostic");

    for (const fn of [WRITE_FN, READ_FN]) {
      const row = FEATURE_MATRIX.split("\n").find(
        (line) => line.startsWith("|") && line.includes(fn),
      );
      assert.ok(row, `the feature matrix must carry a row for ${fn}`);
      assert.match(
        row!,
        /Not implemented|not yet implemented/i,
        `the ${fn} row must state that no client implements it yet`,
      );
    }
  });
});
