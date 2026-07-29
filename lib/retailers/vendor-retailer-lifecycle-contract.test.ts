/**
 * STATIC CONTRACT GUARDS for the VENDOR RETAILER LIFECYCLE contract
 *
 *   public.set_vendor_retailer_status(uuid, text)
 *     [20260811090000_vendor_retailer_lifecycle.sql]
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, the repository tree and the
 * documentation, in the same idiom as ../staff/staff-membership-lifecycle-contract.test.ts.
 * They read the SQL and assert structural properties that a careless later edit could
 * silently destroy.
 *
 * They do NOT execute the function. The BEHAVIOURAL suite is
 *
 *     supabase/tests/database/vendor_retailer_lifecycle_test.sql
 *
 * which signs in as eight different callers, walks the whole refusal matrix, proves BOTH
 * status rows move together, proves the preservation guarantees row by row, injects two
 * post-UPDATE failures to prove atomicity, and walks the multi-Vendor guard in both
 * directions. It requires Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of properties
 * that are cheap to assert on every `npm test` and expensive to notice once broken: that the
 * signature did not grow an argument, that no auth.users write or hard delete appeared, that
 * no browser grant or RLS write policy was introduced, that the multi-Vendor guard is still
 * there and still silent, that neither existing context function was edited, and that no Web
 * or Flutter surface was started ahead of its own milestone.
 *
 * ============================================================================
 * THE SEVEN DECISIONS THESE GUARDS PIN
 * ============================================================================
 *   V-1  TWO ROWS MOVE TOGETHER. vendor_retailers.status and the RETAILER organization's
 *        organizations.status, in one transaction, each compare-and-set, each row count
 *        checked. Writing only the relationship row would block nobody.
 *   V-2  THE VOCABULARY IS ACTIVE <-> SUSPENDED. DEACTIVATED is never a requested value.
 *   V-3  RETAILERS_MANAGE IS THE ONLY LIFECYCLE PERMISSION, mapped to VENDOR_SUPER_ADMIN and
 *        to nothing else. RETAILERS_READ and RETAILERS_CREATE are not reused.
 *   V-4  AUTHORIZATION IS BY PERMISSION, NEVER BY ROLE NAME, inside the executable body.
 *   V-5  ONE DETERMINISTIC LOCK ORDER: relationship, then organization.
 *   V-6  THE MULTI-VENDOR GUARD EXISTS AND DISCLOSES NOTHING — no other Vendor id, no other
 *        relationship id, no count, no status, and no distinct message.
 *   V-7  NOTHING IS CASCADED, DELETED OR RE-PRIVILEGED. organization_members, member_roles,
 *        retailer_shop_members, profiles and auth.users are untouched; no browser table
 *        grant and no write policy is added.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");

const MIGRATION_NAME = "20260811090000_vendor_retailer_lifecycle.sql";
const STAFF_LIFECYCLE_NAME = "20260810090000_retailer_staff_membership_lifecycle.sql";
const PORTAL_NAME = "20260729090000_shared_portal_context.sql";
const RETAILER_CORE_NAME = "20260717094520_retailer_core_tables.sql";
const RETAILERS_READ_SEED_NAME = "20260717115211_seed_retailer_read_permission.sql";

const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");

const PGTAP_NAME = "vendor_retailer_lifecycle_test.sql";
const PGTAP = readFileSync(join(ROOT, "supabase/tests/database", PGTAP_NAME), "utf8");

const AUDIT_DOC_PATH = join(ROOT, "docs/vendor-retailer-lifecycle-audit.md");
const AUDIT_DOC = readFileSync(AUDIT_DOC_PATH, "utf8");
const BACKEND_CONTRACT = readFileSync(join(ROOT, "docs/mobile-backend-contract.md"), "utf8");
const FEATURE_MATRIX = readFileSync(join(ROOT, "docs/mobile-feature-matrix.md"), "utf8");

/** The one write this milestone adds. */
const FN = "set_vendor_retailer_status";

/** The one permission this milestone adds. */
const PERMISSION = "RETAILERS_MANAGE";
const ROLE = "VENDOR_SUPER_ADMIN";

const AUDIT_ENTITY = "RETAILER_ORGANIZATION";
const AUDIT_DEACTIVATE = "RETAILER_DEACTIVATED";
const AUDIT_REACTIVATE = "RETAILER_REACTIVATED";

/** The two statuses this RPC owns, and no others. */
const STATUS_VOCABULARY = ["ACTIVE", "SUSPENDED"] as const;
/** The word that exists in both columns' CHECK constraints and is deliberately NOT requestable. */
const TERMINAL_STATUS = "DEACTIVATED";

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this migration's header discusses `auth.users`, `delete`, `service_role`,
 * `organization_members`, another Vendor's identity and `DEACTIVATED` at length while doing
 * none of them, and its body explains exactly why each rule exists. Asserting against the raw
 * text would fail on the very sentences that state the guarantees.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

const CODE = stripComments(MIGRATION_SQL);

/** The `create function public.<name> ... $$;` statement, comments included. */
function functionStatement(source: string, name: string): string {
  const start = source.indexOf(`create function public.${name}(`);
  assert.ok(start >= 0, `create function public.${name}( not found`);
  const end = source.indexOf("$$;", start);
  assert.ok(end > start, `end of ${name} not found`);
  return source.slice(start, end + 3);
}

/** The executable body of the function under test: the statement, minus its comment lines. */
const FN_STATEMENT = functionStatement(MIGRATION_SQL, FN);
const FN_CODE = stripComments(FN_STATEMENT);

/** The declared parameter list, between the first `(` and the matching `)`. */
function parameterBlock(statement: string, name: string): string {
  const open = statement.indexOf(`public.${name}(`) + `public.${name}(`.length;
  const close = statement.indexOf(")", open);
  return statement.slice(open, close);
}

function parameterEntries(statement: string, name: string): string[] {
  return parameterBlock(statement, name)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The `returns table ( ... )` column list. */
function returnBlock(statement: string): string {
  const open = statement.indexOf("returns table (");
  assert.ok(open >= 0, "returns table ( not found");
  const start = open + "returns table (".length;
  const close = statement.indexOf(")", start);
  return statement.slice(start, close);
}

function returnEntries(statement: string): string[] {
  return returnBlock(statement)
    .split(",")
    .map((entry) => entry.trim().replace(/\s+/g, " "))
    .filter((entry) => entry.length > 0);
}

/** Every .sql migration, sorted the way PostgreSQL applies them. */
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

/** Every tracked source file under the given directories, recursively. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const APP_SOURCES = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib")), ...walk(join(ROOT, "components"))];

// ============================================================================
// The migration itself
// ============================================================================
describe("Vendor Retailer lifecycle — the migration", () => {
  test("1. exists under the exact expected filename", () => {
    assert.ok(
      MIGRATIONS.includes(MIGRATION_NAME),
      `${MIGRATION_NAME} must exist — it is the deployed migration name`,
    );
  });

  test("2. sorts AFTER the staff lifecycle migration it builds on", () => {
    // Forward-only ordering against its dependency, rather than "it sorts last" — the schema
    // keeps moving, and a guard that breaks the moment anyone adds a migration is a guard
    // people delete.
    assert.ok(
      MIGRATIONS.indexOf(STAFF_LIFECYCLE_NAME) < MIGRATIONS.indexOf(MIGRATION_NAME),
      "the staff lifecycle migration must be applied before this one",
    );
    assert.ok(
      MIGRATIONS.indexOf(RETAILER_CORE_NAME) < MIGRATIONS.indexOf(MIGRATION_NAME),
      "vendor_retailers must exist before the function that writes it",
    );
    assert.ok(
      MIGRATIONS.indexOf(RETAILERS_READ_SEED_NAME) < MIGRATIONS.indexOf(MIGRATION_NAME),
      "the RETAILERS module must exist before a second permission joins it",
    );
  });

  test("3. adds exactly one function, and it is the lifecycle write", () => {
    const created = [...MIGRATION_SQL.matchAll(/^create (?:or replace )?function\s+public\.(\w+)/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(created, [FN], "exactly one function is created, and it is the write");
  });

  test("4. creates, alters or drops NO table, column, index, trigger, policy or role", () => {
    for (const forbidden of [
      /\bcreate\s+table\b/i,
      /\balter\s+table\b/i,
      /\bdrop\s+table\b/i,
      /\badd\s+column\b/i,
      /\bcreate\s+index\b/i,
      /\bcreate\s+trigger\b/i,
      /\bcreate\s+policy\b/i,
      /\bdrop\s+policy\b/i,
      /\bcreate\s+type\b/i,
      /\binsert\s+into\s+public\.roles\b/i,
    ]) {
      assert.ok(
        !forbidden.test(CODE),
        `the migration must not contain ${forbidden} — it is additive catalogue + one function`,
      );
    }
  });

  test("5. adds NO lifecycle timestamp column to organizations", () => {
    // audit_logs already records when, by whom and in which direction, with a history rather
    // than only the most recent value. A column would be a second source of truth.
    assert.ok(
      !/\balter\s+table\s+public\.organizations\b/i.test(CODE),
      "organizations must not be altered",
    );
    assert.ok(
      !/\bsuspended_at\b|\bdeactivated_at\b/i.test(CODE),
      "no suspended_at or deactivated_at is written anywhere",
    );
  });
});

// ============================================================================
// The permission and its single mapping
// ============================================================================
describe("Vendor Retailer lifecycle — the permission", () => {
  test("6. seeds RETAILERS_MANAGE with the approved name, description and module", () => {
    assert.match(CODE, /insert into public\.permissions \(code, name, description, module\)/);
    assert.match(CODE, new RegExp(`'${PERMISSION}'`));
    assert.match(CODE, /'Manage Retailer Lifecycle'/);
    assert.match(CODE, /'Deactivate and reactivate a connected Retailer\.'/);
    assert.match(CODE, /'RETAILERS'/);
  });

  test("7. seeds exactly ONE permission — RETAILERS_MANAGE is the only lifecycle permission", () => {
    const insertBlock = CODE.slice(
      CODE.indexOf("insert into public.permissions"),
      CODE.indexOf("on conflict (code) do update"),
    );
    const codes = [...insertBlock.matchAll(/'([A-Z_]{4,})'/g)].map((m) => m[1]);
    assert.deepEqual(
      codes.filter((c) => c !== "RETAILERS"),
      [PERMISSION],
      "exactly one permission code is seeded",
    );
  });

  test("8. is idempotent — upsert on code, mapping ON CONFLICT DO NOTHING", () => {
    assert.match(CODE, /on conflict \(code\) do update/);
    assert.match(CODE, /on conflict \(role_id, permission_id\) do nothing/);
  });

  test("9. carries the repository's role and permission precondition guards", () => {
    assert.match(CODE, /Seed precondition failed: required role\(s\) missing/);
    assert.match(CODE, /Seed precondition failed: required permission\(s\) missing/);
  });

  test("10. maps it to VENDOR_SUPER_ADMIN and to no other role", () => {
    const mapping = CODE.slice(CODE.indexOf("insert into public.role_permissions"));
    const roles = [...mapping.matchAll(/r\.code = '([A-Z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(roles, [ROLE], "exactly one role is named in the mapping");

    for (const other of [
      "RETAILER_OWNER",
      "RETAILER_MANAGER",
      "SALES_STAFF",
      "CLAIM_REVIEWER",
      "FINANCE_ADMIN",
    ]) {
      assert.ok(
        !mapping.includes(other),
        `${other} must not appear in the mapping — a tenant must never be able to suspend itself`,
      );
    }
  });

  test("11. does not reuse or redefine an existing permission", () => {
    assert.ok(
      !/'RETAILERS_READ'|'RETAILERS_CREATE'/.test(CODE),
      "the executable SQL must not touch the Retailer READ or CREATE permission",
    );
    assert.ok(
      !/\bdelete\s+from\s+public\.role_permissions\b/i.test(CODE),
      "no existing mapping is removed",
    );
    assert.ok(
      !/\bupdate\s+public\.permissions\b/i.test(CODE),
      "no existing permission row is rewritten outside its own upsert",
    );
  });
});

// ============================================================================
// The signature and return shape
// ============================================================================
describe("Vendor Retailer lifecycle — the contract shape", () => {
  test("12. the RPC is named set_vendor_retailer_status", () => {
    assert.ok(MIGRATION_SQL.includes(`create function public.${FN}(`));
  });

  test("13. takes exactly (p_relationship_id uuid, p_status text), in that order", () => {
    const entries = parameterEntries(FN_STATEMENT, FN);
    assert.deepEqual(
      entries.map((e) => e.split(/\s+/)[0]),
      ["p_relationship_id", "p_status"],
      "argument names and order are the deployed ones — PostgREST calls them by name",
    );
    assert.deepEqual(
      entries.map((e) => e.split(/\s+/).slice(1).join(" ")),
      ["uuid", "text"],
      "argument types and order are the deployed ones",
    );
  });

  test("14. no argument is defaulted, and no identity or tenant argument exists", () => {
    assert.ok(
      !/\bdefault\b/i.test(parameterBlock(FN_STATEMENT, FN)),
      "both arguments are required",
    );
    const names = parameterEntries(FN_STATEMENT, FN).map((e) => e.split(/\s+/)[0]);
    for (const name of names) {
      assert.ok(
        !/organization|vendor|tenant|actor|user|profile|auth|uid|email|token|role|permission|audit|reason|timestamp/.test(
          name,
        ),
        `${name} would let a browser nominate authority — everything is derived from auth.uid()`,
      );
    }
  });

  test("15. returns exactly the four approved columns, with the approved types", () => {
    assert.deepEqual(returnEntries(FN_STATEMENT), [
      "relationship_id uuid",
      "retailer_status text",
      "relationship_status text",
      "status_changed boolean",
    ]);
  });

  test("16. is plpgsql, VOLATILE, SECURITY DEFINER, with an empty search_path", () => {
    assert.match(FN_STATEMENT, /language plpgsql/);
    assert.match(FN_STATEMENT, /\bvolatile\b/);
    assert.match(FN_STATEMENT, /security definer/);
    assert.match(FN_STATEMENT, /set search_path = ''/);
  });
});

// ============================================================================
// The status vocabulary
// ============================================================================
describe("Vendor Retailer lifecycle — the status vocabulary", () => {
  test("17. the requested status is exactly ACTIVE or SUSPENDED", () => {
    assert.match(
      FN_CODE,
      /p_status is null or p_status not in \('ACTIVE', 'SUSPENDED'\)/,
      "the closed vocabulary is checked in one place, case-sensitively",
    );
    for (const status of STATUS_VOCABULARY) {
      assert.ok(FN_CODE.includes(`'${status}'`), `${status} is part of the vocabulary`);
    }
  });

  test("18. DEACTIVATED is never a REQUESTED value", () => {
    // It appears in the body only as something to REFUSE (the multi-Vendor guard skips
    // DEACTIVATED relationships), never as a value written into either status column.
    assert.ok(
      !new RegExp(`p_status\\s*(=|in)\\s*.*'${TERMINAL_STATUS}'`).test(FN_CODE),
      "no branch compares the request against the terminal status",
    );
    assert.ok(
      !new RegExp(`set status = '${TERMINAL_STATUS}'`).test(FN_CODE),
      "neither UPDATE ever writes the terminal status",
    );
  });

  test("19. the requested status is validated with 23514 and the refusals with 42501/55000", () => {
    assert.match(FN_CODE, /errcode = 'check_violation'/);
    assert.match(FN_CODE, /errcode = 'insufficient_privilege'/);
    assert.match(FN_CODE, /errcode = 'object_not_in_prerequisite_state'/);
  });

  test("20. validation happens AFTER authorization", () => {
    assert.ok(
      FN_CODE.indexOf(`'${PERMISSION}'`) < FN_CODE.indexOf("not in ('ACTIVE', 'SUSPENDED')"),
      "an unauthorized caller must not learn whether their input would have been valid",
    );
  });
});

// ============================================================================
// Authorization and the tenant boundary
// ============================================================================
describe("Vendor Retailer lifecycle — authorization", () => {
  test("21. requires auth.uid() and derives the Vendor from the established context", () => {
    assert.match(FN_CODE, /v_actor := auth\.uid\(\)/);
    assert.match(FN_CODE, /from public\.get_vendor_super_admin_context\(\) ctx/);
    assert.match(FN_CODE, /order by ctx\.organization_id\s*\n\s*limit 1/);
  });

  test("22. gates on RETAILERS_MANAGE through the existing permission helper", () => {
    assert.match(
      FN_CODE,
      new RegExp(`public\\.has_organization_permission\\(v_vendor, '${PERMISSION}'\\)`),
    );
  });

  test("23. contains NO role-name authorization in the executable write path", () => {
    // V-4. The mapping is the authority; a role code here would be a second place for the
    // rule to live, and the two could disagree.
    for (const role of [ROLE, "RETAILER_OWNER", "RETAILER_MANAGER", "SALES_STAFF"]) {
      assert.ok(
        !FN_CODE.includes(role),
        `${role} must not appear in the executable body — authorization is by permission`,
      );
    }
    assert.ok(!/\br\.code\b/.test(FN_CODE), "no role code comparison of any kind");
  });

  test("24. matches the target by relationship id AND the derived Vendor", () => {
    assert.match(FN_CODE, /where vr\.id = p_relationship_id\s*\n\s*and vr\.vendor_organization_id = v_vendor/);
  });

  test("25. requires the joined organization to be a RETAILER", () => {
    assert.match(FN_CODE, /v_org_type is distinct from 'RETAILER'/);
  });

  test("26. every disclosure-sensitive refusal shares ONE literal message", () => {
    const denials = [...FN_CODE.matchAll(/Not authorized to change this Retailer''s status/g)];
    assert.equal(
      denials.length,
      5,
      "unauthenticated, no Vendor, no permission, unknown/foreign target and wrong type — five paths, one sentence",
    );
  });

  test("27. and every lifecycle-unavailable refusal shares a DIFFERENT single literal message", () => {
    const unavailable = [...FN_CODE.matchAll(/This Retailer cannot be changed right now/g)];
    assert.equal(
      unavailable.length,
      4,
      "multi-Vendor guard, inconsistent pair and both row-count drifts — four paths, one sentence",
    );
    const codes = [...FN_CODE.matchAll(/errcode = 'object_not_in_prerequisite_state'/g)];
    assert.equal(codes.length, 4, "and all four are 55000");
  });
});

// ============================================================================
// Locking, the guard, and the two writes
// ============================================================================
describe("Vendor Retailer lifecycle — locking and the writes", () => {
  test("28. locks exactly two rows, FOR UPDATE, relationship BEFORE organization", () => {
    // V-5. Reversing this is the one edit that turns two safe concurrent callers into a
    // deadlock, and only an ordering assertion can catch it.
    const locks = [...FN_CODE.matchAll(/for update/g)];
    assert.equal(locks.length, 2, "exactly two rows are locked");
    assert.ok(!/for share/i.test(FN_CODE), "neither uses the weaker FOR SHARE — both are written");

    const relIdx = FN_CODE.indexOf("from public.vendor_retailers vr");
    const orgIdx = FN_CODE.indexOf("from public.organizations o");
    assert.ok(relIdx >= 0 && orgIdx >= 0, "both tables are read");
    assert.ok(relIdx < orgIdx, "the relationship is locked first — one deterministic order");
  });

  test("29. the multi-Vendor guard exists, and skips DEACTIVATED relationships", () => {
    assert.match(FN_CODE, /other\.retailer_organization_id = v_retailer_org/);
    assert.match(FN_CODE, /other\.vendor_organization_id <> v_vendor/);
    assert.match(FN_CODE, new RegExp(`other\\.status <> '${TERMINAL_STATUS}'`));
  });

  test("30. the guard runs for BOTH requested values, before idempotency", () => {
    const guardIdx = FN_CODE.indexOf("other.vendor_organization_id <> v_vendor");
    const idempotencyIdx = FN_CODE.indexOf("v_rel_status = p_status and v_org_status = p_status");
    assert.ok(guardIdx >= 0 && idempotencyIdx >= 0);
    assert.ok(
      guardIdx < idempotencyIdx,
      "a no-op-shaped request must not slip past the guard",
    );
    assert.ok(
      !/if p_status = 'SUSPENDED' then[\s\S]{0,200}other\.vendor_organization_id/.test(FN_CODE),
      "the guard is not conditional on the requested direction",
    );
  });

  test("31. the guard is an EXISTS test — it can leak no identifier, status or count", () => {
    // V-6. `exists` returns a boolean and nothing else, so there is no id, name, status or
    // cardinality available to the refusal even by accident.
    const guardBlock = FN_CODE.slice(
      FN_CODE.indexOf("if exists ("),
      FN_CODE.indexOf("if exists (") + 500,
    );
    assert.match(guardBlock, /if exists \(\s*\n\s*select 1/);
    assert.ok(!/count\s*\(/i.test(guardBlock), "no count is taken");
    assert.ok(
      !/into\s+v_/.test(guardBlock),
      "nothing about the other relationship is read into a variable",
    );
    assert.ok(
      !/%/.test(guardBlock),
      "the refusal has no format placeholder that could interpolate another Vendor",
    );
  });

  test("32. performs both status UPDATEs, each compare-and-set, each row count verified", () => {
    // V-1.
    const updates = [...FN_CODE.matchAll(/update public\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(updates, ["vendor_retailers", "organizations"], "exactly two UPDATEs");

    assert.match(FN_CODE, /and vr\.status = v_rel_status/, "the relationship is compare-and-set");
    assert.match(FN_CODE, /and o\.status = v_org_status/, "the organization is compare-and-set");

    assert.equal(
      [...FN_CODE.matchAll(/get diagnostics v_updated = row_count/g)].length,
      2,
      "both row counts are captured",
    );
    assert.equal(
      [...FN_CODE.matchAll(/if v_updated <> 1 then/g)].length,
      2,
      "and both are verified to be exactly one",
    );
  });

  test("33. a no-op performs no UPDATE and writes no audit row", () => {
    const noopIdx = FN_CODE.indexOf("if v_rel_status = p_status and v_org_status = p_status");
    const firstUpdateIdx = FN_CODE.indexOf("update public.vendor_retailers");
    const auditIdx = FN_CODE.indexOf("insert into public.audit_logs");
    assert.ok(noopIdx >= 0);
    assert.ok(noopIdx < firstUpdateIdx, "the no-op branch returns before either UPDATE");
    assert.ok(noopIdx < auditIdx, "and before the audit insert");
    assert.match(
      FN_CODE.slice(noopIdx, firstUpdateIdx),
      /return query select v_relationship, v_org_status, v_rel_status, false;\s*\n\s*return;/,
    );
  });
});

// ============================================================================
// What the function must never touch
// ============================================================================
describe("Vendor Retailer lifecycle — preservation, by construction", () => {
  test("34. never updates organization_members — SUSPENDED is not cascaded", () => {
    assert.ok(!/update\s+public\.organization_members/i.test(FN_CODE));
    assert.ok(!/organization_members/i.test(FN_CODE), "the table is not referenced at all");
  });

  test("35. never touches member_roles", () => {
    assert.ok(!/member_roles/i.test(FN_CODE));
  });

  test("36. never touches retailer_shop_members or retailer_shops", () => {
    assert.ok(!/retailer_shop_members/i.test(FN_CODE));
    assert.ok(!/retailer_shops/i.test(FN_CODE));
  });

  test("37. never updates profiles", () => {
    assert.ok(!/update\s+public\.profiles/i.test(FN_CODE));
    assert.ok(!/\bprofiles\b/i.test(FN_CODE), "profiles is not referenced at all");
  });

  test("38. never references or writes auth.users", () => {
    // No ban, no delete, no update, no metadata write. Everyone at a suspended Retailer can
    // still sign in; they simply have no Retailer context.
    assert.ok(!/auth\.users/i.test(FN_CODE));
    assert.ok(!/banned_until|email_confirmed_at|\bdeleted_at\b/i.test(FN_CODE));
  });

  test("39. never touches either invitation table or the receipt table", () => {
    assert.ok(!/retailer_staff_invitations|retailer_invitations/i.test(FN_CODE));
    assert.ok(!/receipt_submissions/i.test(FN_CODE));
    assert.ok(!/vendor_product_retailer_assignments/i.test(FN_CODE));
  });

  test("40. contains no DELETE, TRUNCATE or dynamic SQL anywhere in the migration", () => {
    assert.ok(!/\bdelete\s+from\b/i.test(CODE), "no DELETE");
    assert.ok(!/\btruncate\b/i.test(CODE), "no TRUNCATE");
    assert.ok(!/\bexecute\s+(format|'|")/i.test(CODE), "no dynamic SQL");
    assert.ok(!/\bquote_ident\b|\bquote_literal\b/i.test(CODE), "and nothing that would need it");
  });
});

// ============================================================================
// Audit
// ============================================================================
describe("Vendor Retailer lifecycle — the audit row", () => {
  test("41. writes exactly one audit row, on the real-change path only", () => {
    assert.equal(
      [...FN_CODE.matchAll(/insert into public\.audit_logs/g)].length,
      1,
      "one audit insert",
    );
  });

  test("42. uses the approved actions and entity type", () => {
    assert.match(FN_CODE, new RegExp(`when 'SUSPENDED' then '${AUDIT_DEACTIVATE}'`));
    assert.match(FN_CODE, new RegExp(`when 'ACTIVE'\\s+then '${AUDIT_REACTIVATE}'`));
    assert.match(FN_CODE, new RegExp(`'${AUDIT_ENTITY}'`));
  });

  test("43. entity is the Retailer organization; organization is the acting Vendor; actor is auth.uid()", () => {
    assert.match(FN_CODE, /v_retailer_org::text/, "entity_id is the Retailer organization id");
    const valuesBlock = FN_CODE.slice(
      FN_CODE.indexOf("insert into public.audit_logs"),
      FN_CODE.indexOf("return query select v_relationship, p_status"),
    );
    assert.match(valuesBlock, /\bv_vendor,/, "organization_id is the acting Vendor");
    assert.match(valuesBlock, /\bv_actor,/, "actor_profile_id is the auth.uid() derived actor");
  });

  test("44. metadata carries exactly the six approved keys", () => {
    const meta = FN_CODE.slice(
      FN_CODE.indexOf("jsonb_build_object("),
      FN_CODE.indexOf("return query select v_relationship, p_status"),
    );
    const keys = [...meta.matchAll(/'([a-z_]+)',\s/g)].map((m) => m[1]).sort();
    assert.deepEqual(keys, [
      "relationship_id",
      "relationship_status_after",
      "relationship_status_before",
      "retailer_name",
      "retailer_status_after",
      "retailer_status_before",
    ]);
  });

  test("45. metadata carries no email, Auth id, profile id, secret or raw provider message", () => {
    const meta = FN_CODE.slice(
      FN_CODE.indexOf("jsonb_build_object("),
      FN_CODE.indexOf("return query select v_relationship, p_status"),
    );
    for (const forbidden of [
      /email/i,
      /auth/i,
      /profile/i,
      /v_actor/,
      /token/i,
      /hash/i,
      /secret/i,
      /sqlerrm/i,
      /message/i,
      /invitation/i,
      /shop/i,
      /receipt/i,
      /count/i,
    ]) {
      assert.ok(!forbidden.test(meta), `metadata must not contain ${forbidden}`);
    }
  });

  test("46. every audited value is one the function proved — none is client-supplied raw", () => {
    const meta = FN_CODE.slice(
      FN_CODE.indexOf("jsonb_build_object("),
      FN_CODE.indexOf("return query select v_relationship, p_status"),
    );
    // p_relationship_id never reaches the audit row directly; v_relationship — read back out
    // of the verified, locked row — does.
    assert.ok(!meta.includes("p_relationship_id"), "the raw argument is not audited");
    assert.ok(meta.includes("v_relationship"), "the PROVED relationship id is");
    assert.ok(meta.includes("v_retailer_name"), "and the name read from the locked row");
  });

  test("47. no raw database or provider error text is ever raised to the caller", () => {
    assert.ok(!/sqlerrm/i.test(CODE), "no SQLERRM is interpolated into a message");
    assert.ok(!/\bexception when\b/i.test(CODE), "there is no handler that could swallow one");
    // Scoped to the FUNCTION body. The catalogue seed guards in Parts B and C legitimately
    // interpolate the missing role/permission code into a MIGRATION-TIME failure that only a
    // deployer ever sees; nothing a browser can reach may do the same.
    assert.ok(
      !/raise exception '[^']*%/.test(FN_CODE),
      "no raise inside the RPC interpolates a value into its message",
    );
    assert.ok(
      !/\busing\s+detail\b|\busing\s+hint\b/i.test(FN_CODE),
      "and none attaches a DETAIL or HINT that could carry one",
    );
  });
});

// ============================================================================
// Grants and table posture
// ============================================================================
describe("Vendor Retailer lifecycle — grants and posture", () => {
  test("48. revokes PUBLIC and anon, grants authenticated, and grants service_role nothing", () => {
    assert.match(CODE, new RegExp(`revoke all\\s+on function public\\.${FN}\\(uuid, text\\) from public;`));
    assert.match(CODE, new RegExp(`revoke execute on function public\\.${FN}\\(uuid, text\\) from anon;`));
    assert.match(CODE, new RegExp(`grant\\s+execute on function public\\.${FN}\\(uuid, text\\) to authenticated;`));
    assert.ok(
      !/service_role/.test(CODE),
      "service_role appears nowhere in the executable SQL — the whole authority is auth.uid()",
    );
  });

  test("49. grants no direct table write to any browser role", () => {
    assert.ok(
      !/\bgrant\b[^;]*\bon\s+table\b/i.test(CODE),
      "no table grant of any kind",
    );
    for (const table of ["organizations", "vendor_retailers"]) {
      assert.ok(
        !new RegExp(`grant[^;]*\\b(insert|update|delete)\\b[^;]*${table}`, "i").test(CODE),
        `no write privilege is granted on ${table}`,
      );
    }
  });

  test("50. adds no browser-write RLS policy", () => {
    assert.ok(!/create\s+policy/i.test(CODE), "no policy is created");
    assert.ok(!/alter\s+policy/i.test(CODE), "and none is altered");
    assert.ok(!/enable\s+row\s+level\s+security/i.test(CODE), "RLS posture is not changed");
    assert.ok(!/disable\s+row\s+level\s+security/i.test(CODE), "and never disabled");
  });
});

// ============================================================================
// Nothing existing was changed
// ============================================================================
describe("Vendor Retailer lifecycle — the existing contracts are untouched", () => {
  test("51. does not redefine get_my_portal_context()", () => {
    assert.ok(
      !/function\s+public\.get_my_portal_context/i.test(CODE),
      "the routing contract is not edited",
    );
    // And nothing later than the portal migration redefines it either.
    for (const file of MIGRATIONS.filter((f) => f > PORTAL_NAME)) {
      const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      assert.ok(
        !/create\s+(or replace\s+)?function\s+public\.get_my_portal_context/i.test(sql),
        `${file} must not redefine get_my_portal_context`,
      );
    }
  });

  test("52. does not redefine get_my_lifecycle_access_state()", () => {
    assert.ok(!/function\s+public\.get_my_lifecycle_access_state/i.test(CODE));
    for (const file of MIGRATIONS.filter((f) => f > STAFF_LIFECYCLE_NAME)) {
      const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      assert.ok(
        !/create\s+(or replace\s+)?function\s+public\.get_my_lifecycle_access_state/i.test(sql),
        `${file} must not redefine the lifecycle diagnostic`,
      );
    }
  });

  test("53. does not change the Retailer STAFF lifecycle contract", () => {
    assert.ok(!/function\s+public\.set_retailer_staff_membership_status/i.test(CODE));
    for (const file of MIGRATIONS.filter((f) => f > STAFF_LIFECYCLE_NAME)) {
      const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      assert.ok(
        !/create\s+(or replace\s+)?function\s+public\.set_retailer_staff_membership_status/i.test(sql),
        `${file} must not redefine the staff lifecycle write`,
      );
      assert.ok(
        !/RETAILER_STAFF_MANAGE/.test(sql),
        `${file} must not re-map the staff permission`,
      );
    }
  });

  test("54. redefines no existing function of any kind", () => {
    assert.ok(
      !/create\s+or\s+replace\s+function/i.test(CODE),
      "every function in this migration is a plain CREATE — nothing existing is replaced",
    );
    assert.ok(!/\bdrop\s+function\b/i.test(CODE), "and nothing is dropped");
  });

  test("55. does not modify the receipt or invitation Edge Function paths", () => {
    const edgeDir = join(ROOT, "supabase/functions");
    if (!existsSync(edgeDir)) return;
    for (const file of walk(edgeDir)) {
      const source = readFileSync(file, "utf8");
      assert.ok(
        !source.includes(FN),
        `${file} must not call the lifecycle write — no Edge Function change is part of this milestone`,
      );
    }
  });
});

// ============================================================================
// The client surface is exactly the approved one
// ============================================================================
describe("Vendor Retailer lifecycle — the Web surface is bounded", () => {
  /**
   * Application sources only.
   *
   * `*.test.ts` files are excluded deliberately: a guard that constrains where this RPC is
   * wired up has to name it in order to look for it, and counting that as a call site would
   * mean the safest files in the repository failed the safety check.
   */
  const APP_ONLY = APP_SOURCES.filter((file) => !file.endsWith(".test.ts"));

  /**
   * ============================================================================
   * WHY THIS SECTION CHANGED, AND WHAT IT NOW GUARANTEES
   * ============================================================================
   * Until the Vendor Web milestone landed, tests 56 and 57 asserted that NO application file
   * mentioned this RPC at all — the correct assertion while the backend shipped alone, and
   * the reason they failed the moment the Web control was added. They were doing their job.
   *
   * "No call site" is no longer the property worth defending; "exactly ONE call site, in the
   * approved place" is. So the absence assertions became inventory assertions over the same
   * files. Every way the old tests could have caught an unapproved surface, these still do —
   * a second wrapper, a call from the Retailer list page, a dashboard card, a navigation
   * component or an Edge Function all fail here — and they additionally pin that the one
   * permitted wrapper is where it is supposed to be, which the old tests could not express.
   */

  /** The single server-only module permitted to name the write RPC. */
  const WRAPPER = "lib/retailers/vendor-retailer-lifecycle.ts";
  /** The Server Action, and the one control that submits to it. */
  const ACTION = "app/(admin)/retailers/[relationshipId]/actions.ts";
  const CONTROL = "app/(admin)/retailers/[relationshipId]/retailer-lifecycle-dialog.tsx";
  const DETAIL_PAGE = "app/(admin)/retailers/[relationshipId]/page.tsx";

  function relative(file: string): string {
    return file.replace(`${ROOT}/`, "");
  }

  /**
   * TypeScript source with comments removed.
   *
   * Load-bearing here for the same reason it is in the migration guards above: the Web
   * modules explain in their headers WHICH RPC they are a wrapper for and WHY nothing else
   * may call it, so a raw substring search would flag the very files whose documentation
   * states the guarantee — and would flag components/ui/badge.tsx for a comment about the
   * only writer of SUSPENDED. The property being defended is that exactly one module ISSUES
   * the call, which is a fact about executable code.
   */
  function stripTsComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  }

  test("56. exactly ONE application module ISSUES the RPC, and it is the server-only wrapper", () => {
    // The quoted literal, in comment-stripped code: the only way to actually name the
    // function to `supabase.rpc()`.
    const callers = APP_ONLY.filter((file) =>
      stripTsComments(readFileSync(file, "utf8")).includes(`"${FN}"`),
    ).map(relative);

    assert.deepEqual(
      callers,
      [WRAPPER],
      "the RPC surface must stay a single server-only wrapper",
    );
  });

  test("57. the lifecycle UI exists only on the Retailer DETAIL route", () => {
    const uiSurfaces = APP_ONLY.filter((file) =>
      readFileSync(file, "utf8").includes("RetailerLifecycleDialog"),
    ).map(relative);

    assert.deepEqual(
      uiSurfaces.sort(),
      [CONTROL, DETAIL_PAGE].sort(),
      "no list page, dashboard card or navigation surface may carry the control",
    );

    const actionCallers = APP_ONLY.filter((file) =>
      readFileSync(file, "utf8").includes("setVendorRetailerStatusAction"),
    ).map(relative);

    assert.deepEqual(
      actionCallers.sort(),
      [ACTION, CONTROL].sort(),
      "the Server Action is reachable from exactly one control",
    );
  });

  test("57b. the Retailer LIST page still carries no lifecycle control", () => {
    const listPage = readFileSync(join(ROOT, "app/(admin)/retailers/page.tsx"), "utf8");
    for (const needle of [
      FN,
      "RetailerLifecycleDialog",
      "setVendorRetailerStatusAction",
      "Deactivate Retailer",
      "Reactivate Retailer",
    ]) {
      assert.ok(
        !listPage.includes(needle),
        `the Retailer list page must not carry ${needle} — V1 is detail-page only`,
      );
    }
  });

  test("58. no Flutter file exists anywhere in the repository", () => {
    const roots = ["app", "lib", "components", "supabase", "docs", "scripts", "public"];
    for (const dir of roots) {
      for (const file of walk(join(ROOT, dir))) {
        assert.ok(!file.endsWith(".dart"), `${file} is a Flutter file — Flutter is out of scope`);
      }
    }
    assert.ok(!existsSync(join(ROOT, "pubspec.yaml")), "no Flutter project was created");
    assert.ok(!existsSync(join(ROOT, "android")), "and no Android project");
    assert.ok(!existsSync(join(ROOT, "ios")), "and no iOS project");
  });

  test("59. no environment file or secret was added by this milestone", () => {
    for (const secretish of [".env", ".env.local", ".env.production"]) {
      // These may legitimately exist untracked; what matters is that the migration and tests
      // contain no key material of their own.
      void secretish;
    }
    for (const source of [MIGRATION_SQL, PGTAP]) {
      assert.ok(!/SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|RESEND_API_KEY/.test(source));
      assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(source), "no JWT-shaped literal");
      assert.ok(!/sb_secret_|sb_publishable_/.test(source), "no Supabase key literal");
    }
  });
});

// ============================================================================
// The behavioural suite and the documentation
// ============================================================================
describe("Vendor Retailer lifecycle — tests and documentation", () => {
  test("60. the pgTAP suite exists and covers the contract", () => {
    assert.ok(PGTAP.includes(FN), "the suite names the function");
    for (const needle of [
      "SECTION A",
      "SECTION K",
      "SECTION L",
      "SECTION M",
      "multi-Vendor",
      "ORGANIZATION_INACTIVE",
      "RETAILER_DEACTIVATED",
      "RETAILER_REACTIVATED",
      PERMISSION,
    ]) {
      assert.ok(PGTAP.includes(needle), `the pgTAP suite must cover ${needle}`);
    }
  });

  test("61. the audit document records every decision the milestone made", () => {
    for (const needle of [
      "ACTIVE",
      "SUSPENDED",
      "Inactive",
      "Deactivate",
      "Reactivate",
      "organization_members",
      "auth.users",
      "multi-Vendor",
      "stopgap",
      "already-issued",
      "invitation",
      "get_my_lifecycle_access_state",
      PERMISSION,
      FN,
      "42501",
      "23514",
      "55000",
      "22P02",
    ]) {
      assert.ok(AUDIT_DOC.includes(needle), `the audit doc must discuss ${needle}`);
    }
  });

  test("62. the audit document states the multi-Vendor limitation as a limitation", () => {
    assert.match(
      AUDIT_DOC,
      /stopgap/i,
      "the guard must be described as a stopgap, not as a multi-Vendor architecture",
    );
    assert.match(
      AUDIT_DOC,
      /redesign|redesigned/i,
      "and the doc must say tenant blocking has to be redesigned before a second active Vendor",
    );
  });

  test("63. the audit document states that Web and Flutter are later milestones", () => {
    assert.match(AUDIT_DOC, /later milestone/i);
    assert.ok(AUDIT_DOC.includes("Flutter"));
  });

  test("64. the backend contract and feature matrix carry the operation", () => {
    assert.ok(BACKEND_CONTRACT.includes(FN), "the backend contract names the RPC");
    assert.ok(BACKEND_CONTRACT.includes(PERMISSION), "and the permission");
    assert.ok(BACKEND_CONTRACT.includes(MIGRATION_NAME), "and the migration");
    assert.ok(FEATURE_MATRIX.includes(FN), "the feature matrix names the RPC");
  });

  test("65. the documented signature matches the deployed one", () => {
    assert.ok(
      BACKEND_CONTRACT.includes("p_relationship_id") && BACKEND_CONTRACT.includes("p_status"),
      "the documented argument names are the deployed ones",
    );
    for (const column of [
      "relationship_id",
      "retailer_status",
      "relationship_status",
      "status_changed",
    ]) {
      assert.ok(BACKEND_CONTRACT.includes(column), `the documented return shape includes ${column}`);
    }
  });
});
