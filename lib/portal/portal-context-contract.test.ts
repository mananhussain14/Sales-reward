/**
 * STATIC CONTRACT GUARDS for public.get_my_portal_context()
 * (supabase/migrations/20260729090000_shared_portal_context.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom
 * as lib/staff/staff-source-safety.test.ts. They read the SQL and assert
 * structural properties that a careless later edit could silently break.
 *
 * They do NOT execute the function. They cannot: this repository has no database
 * test harness, and asserting behaviour by reading SQL would be a fiction.
 *
 * The BEHAVIOURAL suite is supabase/tests/database/portal_context_test.sql —
 * pgTAP, 58 assertions, covering role resolution, tenant isolation, inactive
 * memberships, the multi-Retailer ambiguity rule, precedence, and generic
 * denial. It requires Docker and is run with:
 *
 *     supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set
 * of properties that are decidable from the source and that would be a security
 * regression rather than a behavioural one:
 *
 *   1. The function accepts no client input at all.
 *   2. It is a correctly-hardened SECURITY DEFINER function.
 *   3. It DELEGATES every authorization decision instead of reimplementing the
 *      membership/role/permission chain — which is what makes it inherit the
 *      ambiguity rule, the ACTIVE-status rules, and tenant isolation.
 *   4. Its privileges are explicit, and anon/service_role get nothing.
 *   5. Its result shape and version are stable, and the capability keys are
 *      resolver-derived rather than permission-derived.
 *   6. The migration adds only a function — it touches no table, policy, or
 *      existing object.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const MIGRATION_NAME = "20260729090000_shared_portal_context.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose discusses the very patterns some of these
 * tests forbid (it explains why a permission-derived capability would be wrong,
 * and it names the tables it deliberately does not join). Asserting against the
 * raw text would match those explanations and pass — or fail — for the wrong
 * reason. Every structural assertion below runs against executable SQL only.
 */
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/** The body of the CREATE FUNCTION statement, dollar-quoted. */
const BODY = (() => {
  const start = CODE.indexOf("as $$");
  const end = CODE.indexOf("$$;", start);
  assert.ok(start !== -1 && end !== -1, "migration must contain a $$-quoted body");
  return CODE.slice(start, end);
})();

describe("get_my_portal_context — migration hygiene", () => {
  test("1. is a NEW migration and never edits an applied one", () => {
    const applied = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    assert.ok(
      applied.includes(MIGRATION_NAME),
      "the migration file must exist in supabase/migrations",
    );

    // ORDERED AFTER ITS DEPENDENCIES, not last overall.
    //
    // This originally asserted `applied[applied.length - 1] === MIGRATION_NAME`. That is
    // the right INTENT — the message says so: "an out-of-order timestamp would apply
    // before its dependencies" — but the wrong TEST. "Newest overall" is a property of
    // the repository at one moment in time, not of this migration, so it forbade every
    // future migration rather than the defect it was aiming at, and the first unrelated
    // migration to land would have failed it for no reason.
    //
    // What actually matters is stated directly: this migration's timestamp sorts strictly
    // after every migration whose objects it depends on. Those are the functions its own
    // header names as dependencies, each of which it calls.
    const DEPENDENCIES = [
      "20260717083515_vendor_super_admin_context.sql",
      "20260717100208_retailer_authorization_helpers.sql",
      "20260723090000_retailer_staff_invitation_storage_foundation.sql",
      "20260726210000_receipt_submission_operations.sql",
    ];

    for (const dependency of DEPENDENCIES) {
      assert.ok(
        applied.includes(dependency),
        `declared dependency ${dependency} is missing`,
      );
      assert.ok(
        dependency < MIGRATION_NAME,
        `${MIGRATION_NAME} must sort after its dependency ${dependency}`,
      );
    }
  });

  test("2. adds a function and nothing else", () => {
    // Anything that would change the shape of the database, rather than add one
    // read-only function, is out of scope for this migration by design.
    const forbidden: [RegExp, string][] = [
      [/\bcreate\s+table\b/i, "create table"],
      [/\balter\s+table\b/i, "alter table"],
      [/\bdrop\s+/i, "drop"],
      [/\bcreate\s+policy\b/i, "create policy"],
      [/\bcreate\s+trigger\b/i, "create trigger"],
      [/\bcreate\s+index\b/i, "create index"],
      [/\bcreate\s+or\s+replace\b/i, "create or replace"],
      [/\binsert\s+into\b/i, "insert into"],
      [/\bupdate\s+public\./i, "update"],
      [/\bdelete\s+from\b/i, "delete from"],
      [/\bgrant\b[^;]*\bon\s+table\b/i, "grant on table"],
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
});

describe("get_my_portal_context — no client-supplied context", () => {
  test("3. takes zero arguments", () => {
    const signature = /create\s+function\s+public\.get_my_portal_context\s*\(\s*\)/i;
    assert.ok(
      signature.test(CODE),
      "must be declared with an empty parameter list — a caller must not be able to name a user, organization, role, membership or email",
    );
  });

  test("4. every revoke and grant addresses the zero-argument signature", () => {
    // A mismatched signature here would silently privilege a different function,
    // or fail to revoke the one that exists.
    const privilegeStatements = CODE.match(
      /\b(revoke|grant)\b[^;]*get_my_portal_context[^;]*;/gi,
    ) ?? [];

    assert.ok(privilegeStatements.length > 0, "must manage its own privileges");

    for (const statement of privilegeStatements) {
      assert.match(
        statement,
        /public\.get_my_portal_context\s*\(\s*\)/,
        `privilege statement must name public.get_my_portal_context(): ${statement.trim()}`,
      );
    }
  });

  test("5. resolves identity only from auth.uid()", () => {
    assert.match(BODY, /auth\.uid\s*\(\s*\)/, "must consult auth.uid()");
    assert.match(
      BODY,
      /if\s+auth\.uid\s*\(\s*\)\s+is\s+null\s+then/i,
      "must carry the explicit signed-out guard every helper in this schema uses",
    );
  });
});

describe("get_my_portal_context — SECURITY DEFINER hardening", () => {
  test("6. is a hardened, read-only definer function", () => {
    for (const clause of [
      /\bsecurity\s+definer\b/i,
      /\bset\s+search_path\s*=\s*''/i,
      /\bstable\b/i,
      /\breturns\s+jsonb\b/i,
      /\blanguage\s+plpgsql\b/i,
    ]) {
      assert.match(CODE, clause, `function must declare ${clause}`);
    }
  });

  test("7. writes nothing and raises nothing", () => {
    // A read that can raise would collapse the operational-failure signal
    // ("unavailable") into an authorization answer, which both clients rely on
    // being distinguishable.
    for (const [pattern, label] of [
      [/\braise\b/i, "raise"],
      [/\binsert\b/i, "insert"],
      [/\bupdate\b/i, "update"],
      [/\bdelete\b/i, "delete"],
    ] as [RegExp, string][]) {
      assert.ok(
        !pattern.test(BODY),
        `function body must not contain \`${label}\` — it is a STABLE read whose only failure mode is operational`,
      );
    }
  });

  test("8. every object reference is schema-qualified", () => {
    // Under `search_path = ''` an unqualified reference cannot resolve at all,
    // so this is both a correctness and an injection-surface guard.
    const bareFrom = BODY.match(/\b(from|join)\s+(?!public\.|pg_catalog\.)([a-z_][a-z0-9_]*)/gi) ?? [];
    const offenders = bareFrom.filter(
      (m) => !/\b(from|join)\s+(select|lateral|unnest)\b/i.test(m),
    );
    assert.deepEqual(
      offenders,
      [],
      `unqualified table references found: ${offenders.join(", ")}`,
    );
  });
});

describe("get_my_portal_context — authorization is delegated, not reimplemented", () => {
  test("9. calls the three established resolvers", () => {
    for (const resolver of [
      "public.get_vendor_super_admin_context",
      "public.resolve_retailer_owner_organization",
      "public.resolve_retailer_member_organization",
    ]) {
      assert.ok(
        BODY.includes(resolver),
        `must delegate to ${resolver}() rather than restating its chain`,
      );
    }
  });

  test("10. never joins the identity or RBAC tables itself", () => {
    // This is the assertion that makes every un-runnable behavioural rule hold:
    // inactive profiles/memberships/organizations/roles, the organization_type
    // filter, the role-code filter, the role->permission mapping and the
    // multi-organization ambiguity rule are all enforced inside the resolvers.
    // Reassembling any part of that chain here is how the two would drift.
    for (const table of [
      "public.profiles",
      "public.organization_members",
      "public.member_roles",
      "public.role_permissions",
      "public.permissions",
      "public.roles",
      "public.vendor_retailers",
    ]) {
      assert.ok(
        !BODY.includes(table),
        `function body must not read ${table} — authorization is the resolvers' job`,
      );
    }
  });

  test("11. reads public.organizations only for the display name", () => {
    // The single table it touches on its own account. It must select nothing but
    // the name, and only by an id a resolver already authorized.
    const reads = BODY.match(/from\s+public\.organizations\b/gi) ?? [];
    assert.equal(reads.length, 1, "exactly one read of public.organizations");
    assert.match(
      BODY,
      /select\s+o\.name\s+into\s+v_retailer_organization_name/i,
      "must select only the organization name",
    );
    assert.match(
      BODY,
      /where\s+o\.id\s*=\s*v_retailer_organization_id/i,
      "must address it by the resolver-authorized id",
    );
  });

  test("12. compares no role code when deciding the experience", () => {
    // Which role gets which experience is a mapping decision that lives in SQL
    // seed data. Comparing a role code here would freeze it into this migration
    // and silently diverge the moment a mapping changed.
    const decisionSection = BODY.slice(
      BODY.indexOf("v_owner_portal_org :="),
      BODY.indexOf("if v_retailer_kind is not null then"),
    );
    for (const roleCode of ["RETAILER_OWNER", "RETAILER_MANAGER", "SALES_STAFF"]) {
      const assignments = decisionSection.match(
        new RegExp(`v_retailer_kind\\s*:=\\s*'${roleCode}'`, "g"),
      ) ?? [];
      assert.equal(
        assignments.length,
        1,
        `${roleCode} must appear exactly once, as an output label`,
      );
      assert.ok(
        !new RegExp(`(r\\.code|role_code)\\s*=\\s*'${roleCode}'`).test(BODY),
        `${roleCode} must never be compared against a role column here`,
      );
    }
  });
});

describe("get_my_portal_context — privileges", () => {
  test("13. revokes from PUBLIC and anon, and grants only to authenticated", () => {
    assert.match(
      CODE,
      /revoke\s+all\s+on\s+function\s+public\.get_my_portal_context\s*\(\s*\)\s+from\s+public\s*;/i,
      "must revoke the implicit PUBLIC EXECUTE that Postgres grants by default",
    );
    assert.match(
      CODE,
      /revoke\s+execute\s+on\s+function\s+public\.get_my_portal_context\s*\(\s*\)\s+from\s+anon\s*;/i,
      "anon must be explicitly revoked",
    );
    assert.match(
      CODE,
      /grant\s+execute\s+on\s+function\s+public\.get_my_portal_context\s*\(\s*\)\s+to\s+authenticated\s*;/i,
      "authenticated must be explicitly granted",
    );
  });

  test("14. grants nothing to anon or service_role", () => {
    const grants = CODE.match(/\bgrant\b[^;]*;/gi) ?? [];
    for (const grant of grants) {
      assert.ok(
        !/\b(anon|service_role)\b/.test(grant),
        `no grant may name anon or service_role: ${grant.trim()}`,
      );
    }
  });

  test("15. revokes from authenticated before granting to it", () => {
    // The house convention (see 20260717100208): the grant must be this
    // migration's own decision, not a privilege inherited from PUBLIC.
    const revokeAt = CODE.search(
      /revoke\s+execute\s+on\s+function\s+public\.get_my_portal_context\s*\(\s*\)\s+from\s+authenticated/i,
    );
    const grantAt = CODE.search(
      /grant\s+execute\s+on\s+function\s+public\.get_my_portal_context\s*\(\s*\)\s+to\s+authenticated/i,
    );
    assert.ok(revokeAt !== -1, "authenticated must be revoked first");
    assert.ok(grantAt > revokeAt, "the grant must follow the revoke");
  });
});

describe("get_my_portal_context — result contract", () => {
  test("16. declares context_version 1 on every return path", () => {
    const returns = CODE.match(/jsonb_build_object\(\s*\n?\s*'context_version',\s*1\b/g) ?? [];
    assert.equal(
      returns.length,
      2,
      "both the signed-out early return and the main return must carry context_version 1",
    );
  });

  test("17. every return path emits the same four top-level keys", () => {
    for (const key of ["context_version", "portal_kind", "vendor", "retailer"]) {
      const occurrences = BODY.match(new RegExp(`'${key}',`, "g")) ?? [];
      assert.ok(
        occurrences.length >= 2,
        `'${key}' must appear on both return paths (found ${occurrences.length})`,
      );
    }
  });

  test("18. portal_kind is drawn from the documented closed set", () => {
    const assigned = [...BODY.matchAll(/v_portal_kind\s*:=\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    const literal = [...BODY.matchAll(/'portal_kind',\s*'([A-Z_]+)'/g)].map((m) => m[1]);

    const allowed = new Set([
      "VENDOR_SUPER_ADMIN",
      "RETAILER_OWNER",
      "RETAILER_MANAGER",
      "SALES_STAFF",
      "NONE",
    ]);

    for (const kind of [...assigned, ...literal]) {
      assert.ok(allowed.has(kind), `unexpected portal_kind literal: ${kind}`);
    }
    assert.ok(
      literal.includes("NONE"),
      "the signed-out path must emit NONE directly",
    );
  });

  test("19. applies vendor-first precedence, matching selectLanding()", () => {
    const precedence = BODY.slice(BODY.lastIndexOf("if v_vendor_organization_id is not null then"));
    assert.match(
      precedence,
      /if\s+v_vendor_organization_id\s+is\s+not\s+null\s+then\s*\n\s*v_portal_kind\s*:=\s*'VENDOR_SUPER_ADMIN'/i,
      "a Vendor context must win the routing decision",
    );
    assert.match(
      precedence,
      /elsif\s+v_retailer_kind\s+is\s+not\s+null\s+then\s*\n\s*v_portal_kind\s*:=\s*v_retailer_kind/i,
      "the retailer kind must be the fallback",
    );
    assert.match(
      precedence,
      /else\s*\n\s*v_portal_kind\s*:=\s*'NONE'/i,
      "NONE must be the total fallback",
    );
  });

  test("20. resolves the retailer block independently of vendor precedence", () => {
    // A caller holding both roles must still receive their retailer block, or
    // the Retailer portal shell is forced straight back to probing.
    const retailerBlockAt = BODY.indexOf("if v_retailer_kind is not null then");
    const precedenceAt = BODY.lastIndexOf("if v_vendor_organization_id is not null then");
    assert.ok(
      retailerBlockAt !== -1 && precedenceAt > retailerBlockAt,
      "the retailer block must be built before, and independently of, the precedence decision",
    );
  });

  test("21. exposes exactly the seven documented capability keys", () => {
    const capabilitySection = BODY.slice(BODY.indexOf("'capabilities', jsonb_build_object("));
    const keys = [...capabilitySection.matchAll(/'([a-z_]+)',\s+v_[a-z_]+\s+is\s+not\s+null/g)].map(
      (m) => m[1],
    );

    assert.deepEqual(
      keys.sort(),
      [
        "assign_staff_shops",
        "manage_staff",
        "submit_receipts",
        "view_assigned_products",
        "view_retailer_overview",
        "view_shops",
        "view_staff",
      ],
      "the capability set must match the documented contract exactly",
    );
  });

  test("22. every capability is resolver-derived, never permission-derived", () => {
    // The trap this guards: RETAILER_SHOPS_READ is mapped to RETAILER_MANAGER,
    // but the shops screen resolves through the OWNER resolver, which
    // hard-filters r.code = 'RETAILER_OWNER'. has_organization_permission()
    // would answer true for a Manager and send both clients to a screen the
    // database refuses. Each capability must therefore come from the same
    // resolver call its operation makes.
    assert.ok(
      !BODY.includes("has_organization_permission"),
      "capabilities must not be derived from has_organization_permission() — see the migration header",
    );

    const pairs: [string, string][] = [
      ["v_owner_portal_org", "resolve_retailer_owner_organization('RETAILER_PORTAL_READ')"],
      ["v_owner_shops_org", "resolve_retailer_owner_organization('RETAILER_SHOPS_READ')"],
      ["v_staff_read_org", "resolve_retailer_member_organization('RETAILER_STAFF_READ')"],
      ["v_staff_manage_org", "resolve_retailer_member_organization('RETAILER_STAFF_MANAGE')"],
      ["v_shop_assign_org", "resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN')"],
      ["v_products_read_org", "resolve_retailer_member_organization('RETAILER_PRODUCTS_READ')"],
      ["v_receipt_org", "resolve_retailer_member_organization('RECEIPT_SUBMIT')"],
    ];

    for (const [variable, call] of pairs) {
      const normalized = BODY.replace(/\s+/g, " ");
      assert.ok(
        normalized.includes(`${variable} := public.${call}`),
        `${variable} must be assigned from public.${call}`,
      );
    }
  });

  test("23. each gate is resolved exactly once", () => {
    // Resolving a gate twice invites the two calls to drift apart under a later
    // edit, and re-probing lazily inside a branch is how a capability silently
    // becomes false because nobody asked.
    const normalized = BODY.replace(/\s+/g, " ");
    for (const permission of [
      "RETAILER_PORTAL_READ",
      "RETAILER_SHOPS_READ",
      "RETAILER_STAFF_READ",
      "RETAILER_STAFF_MANAGE",
      "RETAILER_STAFF_SHOP_ASSIGN",
      "RETAILER_PRODUCTS_READ",
      "RECEIPT_SUBMIT",
    ]) {
      const calls = normalized.match(new RegExp(`'${permission}'`, "g")) ?? [];
      assert.equal(
        calls.length,
        1,
        `${permission} must be resolved exactly once (found ${calls.length})`,
      );
    }
  });
});

describe("get_my_portal_context — the pgTAP suite exists and is wired", () => {
  test("24. the behavioural suite is present and covers the required matrix", () => {
    // These static guards are explicitly NOT a substitute for behaviour. This
    // test fails loudly if the pgTAP file is ever deleted or emptied, so the
    // behavioural coverage cannot silently disappear.
    const pgtap = readFileSync(
      join(ROOT, "supabase/tests/database/portal_context_test.sql"),
      "utf8",
    );

    for (const scenario of [
      "VENDOR_SUPER_ADMIN",
      "RETAILER_OWNER",
      "RETAILER_MANAGER",
      "SALES_STAFF",
      "INVITED membership",
      "SUSPENDED membership",
      "owner of TWO Retailers",
      "never sees retailer1",
      "dual-role caller",
      "no role at all",
      "INACTIVE role",
      "not an oracle",
    ]) {
      assert.ok(
        pgtap.includes(scenario),
        `pgTAP suite must cover: ${scenario}`,
      );
    }

    assert.match(pgtap, /select\s+no_plan\(\)/i, "must open a pgTAP plan");
    assert.match(pgtap, /select\s+\*\s+from\s+finish\(\)/i, "must close the plan");
    assert.match(pgtap, /rollback\s*;/i, "must roll back its fixtures");
  });
});
