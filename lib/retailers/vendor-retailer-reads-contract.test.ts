/**
 * STATIC CONTRACT GUARDS for the mobile Vendor Retailer reads
 * (supabase/migrations/20260731090000_mobile_vendor_retailer_reads.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * lib/portal/portal-context-contract.test.ts and lib/staff/staff-source-safety.test.ts.
 * They read the SQL and assert structural properties that a careless later edit could
 * silently break.
 *
 * They do NOT execute the functions. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_retailer_reads_test.sql — pgTAP, 127 assertions,
 * covering tenant isolation, every role denial, inactive profiles and memberships, the
 * empty-set case, status and count accuracy, owner-state precedence (including
 * row-for-row agreement with the deployed owner-status RPC), duplicate-free joins, stable
 * ordering, and the non-leaking zero-row answer for foreign and unknown ids. It requires
 * Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of
 * properties decidable from the source, and which would be a SECURITY or CONTRACT
 * regression rather than a behavioural one:
 *
 *   1. The migration is new, forward-only, and edits no applied migration.
 *   2. It adds functions and nothing else — no table, policy, index, grant on a table,
 *      or write of any kind.
 *   3. No function accepts identity, Vendor, tenant, role, or permission input.
 *   4. Every function is a correctly-hardened, read-only SECURITY DEFINER.
 *   5. Privileges are explicit and exact: authenticated only, never anon, never PUBLIC,
 *      never service_role — and the shared derivation is granted to nobody.
 *   6. The output columns are exactly the agreed contract, and no sensitive field
 *      appears in any of them.
 *   7. Authorization is DELEGATED to the existing helpers rather than reimplemented, so
 *      these reads inherit the ACTIVE-status chain and the multi-Vendor rule.
 *   8. No previously applied migration was modified.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const MIGRATION_NAME = "20260731090000_mobile_vendor_retailer_reads.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose discusses the very patterns some of these tests forbid
 * (it explains why a Vendor id must not be an input, and it names the tables it
 * deliberately does not touch). Asserting against the raw text would match those
 * explanations and pass — or fail — for the wrong reason. Every structural assertion
 * below runs against executable SQL only.
 */
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/** The four functions this migration creates, and the signature each must carry. */
const READS = [
  { name: "list_vendor_retailers", args: "", granted: true },
  { name: "get_vendor_retailer_detail", args: "uuid", granted: true },
  { name: "list_vendor_retailer_shops", args: "uuid", granted: true },
  // The shared owner-state derivation. Granted to NOBODY — it takes a Retailer
  // organization id and performs no authorization of its own.
  { name: "vendor_retailer_owner_state", args: "uuid", granted: false },
] as const;

/**
 * The `create function` statement for one function, from its CREATE through the closing
 * `$$;` of its body. Everything asserted per-function is asserted against this slice
 * rather than the whole file, so a clause belonging to one function can never satisfy an
 * assertion about another.
 */
function statementFor(name: string): string {
  const start = CODE.search(new RegExp(`create\\s+function\\s+public\\.${name}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `migration must create public.${name}`);
  const end = CODE.indexOf("$$;", start);
  assert.notEqual(end, -1, `public.${name} must have a $$-quoted body`);
  return CODE.slice(start, end);
}

/** The `returns table (...)` column names of one function, in declaration order. */
function outputColumns(name: string): string[] {
  const statement = statementFor(name);
  const match = statement.match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  assert.ok(match, `public.${name} must declare a returns table (...) contract`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((entry) => entry.length > 0);
}

// ============================================================================
// Migration hygiene
// ============================================================================
describe("mobile Vendor Retailer reads — migration hygiene", () => {
  test("1. is a NEW migration, ordered after every dependency it names", () => {
    const applied = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    assert.ok(
      applied.includes(MIGRATION_NAME),
      "the migration file must exist in supabase/migrations",
    );

    // Ordered after its DEPENDENCIES, not last overall. "Newest in the repository" is a
    // property of one moment in time, not of this migration, and asserting it would fail
    // the moment any unrelated migration landed. What matters is that every object this
    // migration references already exists when it applies.
    const DEPENDENCIES = [
      "20260716124419_core_identity_tables.sql",
      "20260716125559_vendor_admin_rbac.sql",
      "20260716131104_vendor_admin_authorization_helpers.sql",
      "20260717083515_vendor_super_admin_context.sql",
      "20260717094520_retailer_core_tables.sql",
      "20260717115211_seed_retailer_read_permission.sql",
      "20260720092755_retailer_owner_invitation_foundation.sql",
      "20260721190000_classify_retailer_owner_invitation_failures.sql",
      "20260722090000_existing_user_retailer_owner_invitations.sql",
    ];

    for (const dependency of DEPENDENCIES) {
      assert.ok(applied.includes(dependency), `declared dependency ${dependency} is missing`);
      assert.ok(
        dependency < MIGRATION_NAME,
        `${MIGRATION_NAME} must sort after its dependency ${dependency}`,
      );
    }
  });

  test("2. adds functions and changes nothing that already exists", () => {
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
      // The one that matters most for a "make the mobile read easier" regression: a
      // direct table grant would let a client bypass these functions entirely.
      [/\bgrant\b[^;]*\bon\s+table\b/i, "grant on table"],
      [/\bgrant\b[^;]*\bon\s+all\s+tables\b/i, "grant on all tables"],
      [/\bsecurity\s+invoker\b/i, "security invoker"],
    ];

    for (const [pattern, label] of forbidden) {
      assert.ok(
        !pattern.test(CODE),
        `migration must not contain \`${label}\` — it adds four functions and changes nothing that exists`,
      );
    }

    const creates = CODE.match(/\bcreate\s+function\b/gi) ?? [];
    assert.equal(creates.length, READS.length, "exactly four functions are created");
  });

  test("3. does not touch the deployed owner-status RPC the web depends on", () => {
    // get_vendor_retailer_owner_status(uuid) has already been dropped and recreated three
    // times (docs/mobile-backend-contract.md § 6.1). The web Retailer detail page calls
    // it directly, so this migration must not add a fourth churn — the new reads mirror
    // its precedence instead, and the pgTAP suite asserts the two agree.
    assert.ok(
      !/get_vendor_retailer_owner_status/i.test(CODE),
      "the migration must not reference, replace, or re-grant get_vendor_retailer_owner_status",
    );
  });

  test("4. modifies no previously applied migration", () => {
    // A forward-only history is the whole reason a migration can be trusted to describe
    // the deployed database. This test states the rule; `git diff --check` and the branch
    // review confirm nothing else in supabase/migrations was edited. Here it is enforced
    // structurally: every OTHER migration file must still parse as its own complete unit
    // and none may mention this migration's new objects.
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
});

// ============================================================================
// No client-supplied identity, Vendor, or tenant context
// ============================================================================
describe("mobile Vendor Retailer reads — no client-supplied context", () => {
  test("5. the list takes zero arguments", () => {
    assert.match(
      CODE,
      /create\s+function\s+public\.list_vendor_retailers\s*\(\s*\)/i,
      "list_vendor_retailers must be declared with an empty parameter list — a caller must not be able to name a Vendor, Retailer, user, role, or permission",
    );
  });

  test("6. the two addressed reads take exactly one relationship selector", () => {
    for (const name of ["get_vendor_retailer_detail", "list_vendor_retailer_shops"]) {
      const statement = statementFor(name);
      const signature = statement.match(/create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)/i);
      assert.ok(signature, `${name} must declare a parameter list`);

      const parameters = signature[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      assert.deepEqual(
        parameters.map((entry) => entry.split(/\s+/)[0]),
        ["p_relationship_id"],
        `${name} must take exactly one input, the relationship selector`,
      );
      assert.match(parameters[0], /\buuid\b/i, `${name}'s selector must be a uuid`);
    }
  });

  test("7. no function accepts an identity, tenant, role, or permission parameter", () => {
    // The vulnerability this whole shape exists to prevent: a parameter a browser could
    // set that decides WHOSE data is returned. `p_relationship_id` is the only input on
    // the whole surface, and it selects among rows the caller is already entitled to.
    const FORBIDDEN_PARAMETERS = [
      "p_user_id",
      "p_profile_id",
      "p_vendor_organization_id",
      "p_vendor_id",
      "p_organization_id",
      "p_tenant_id",
      "p_membership_id",
      "p_member_id",
      "p_role",
      "p_role_code",
      "p_role_id",
      "p_permission",
      "p_permission_code",
      "p_email",
      "p_actor",
      // The Retailer organization id is deliberately an OUTPUT, never a selector: the
      // relationship id is the narrower address.
      "p_retailer_organization_id",
      "p_retailer_id",
    ];

    // GRANTED reads only. The internal owner-state derivation does take a Retailer
    // organization id — that is exactly why it is granted to nobody (test 16) and is
    // called only by functions that have already proved the Retailer is the caller's.
    // Applying the client-input rule to a function no client can call would be asserting
    // the wrong property about the wrong surface.
    for (const read of READS.filter((entry) => entry.granted)) {
      const signature = statementFor(read.name).match(
        /create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)\s*returns/i,
      );
      assert.ok(signature, `${read.name} must declare a parameter list`);

      for (const forbidden of FORBIDDEN_PARAMETERS) {
        assert.ok(
          !new RegExp(`\\b${forbidden}\\b`, "i").test(signature[1]),
          `${read.name} must not accept ${forbidden} — identity and tenant come from auth.uid()`,
        );
      }
    }
  });

  test("8. every granted read derives its Vendor from the shared context function", () => {
    // Delegation, not reimplementation. get_vendor_super_admin_context() evaluates the
    // whole chain — ACTIVE profile owned by auth.uid(), ACTIVE membership, ACTIVE VENDOR
    // organization, ACTIVE VENDOR_SUPER_ADMIN role — and these reads inherit all of it,
    // plus the shipped multi-Vendor tie-break, by calling it rather than restating it.
    for (const read of READS.filter((entry) => entry.granted)) {
      const body = statementFor(read.name);
      assert.match(
        body,
        /public\.get_vendor_super_admin_context\s*\(\s*\)/,
        `${read.name} must derive its Vendor from public.get_vendor_super_admin_context()`,
      );
      assert.match(
        body,
        /order\s+by\s+ctx\.organization_id\s+limit\s+1/i,
        `${read.name} must apply the same deterministic multi-Vendor tie-break every other Vendor RPC applies`,
      );
      assert.match(
        body,
        /public\.has_organization_permission\s*\(\s*v_vendor\s*,\s*'RETAILERS_READ'\s*\)/,
        `${read.name} must require RETAILERS_READ through the shared permission helper`,
      );
    }
  });

  test("9. no granted read reimplements the membership/role/permission chain", () => {
    // Reading the RBAC tables directly here would be a SECOND definition of "is this
    // caller an authorized Vendor Super Admin", free to drift from the helpers and from
    // the RLS policies — and only one of the two could be right.
    for (const read of READS.filter((entry) => entry.granted)) {
      const body = statementFor(read.name);
      for (const table of ["public.profiles", "public.role_permissions", "public.permissions"]) {
        assert.ok(
          !body.includes(table),
          `${read.name} must not read ${table} — authorization is delegated, not restated`,
        );
      }
      assert.ok(
        !/'VENDOR_SUPER_ADMIN'/.test(body),
        `${read.name} must not name a role code — which role holds RETAILERS_READ is seed data`,
      );
    }
  });

  test("10. the Vendor filter compares the DERIVED Vendor, never a parameter", () => {
    for (const name of ["get_vendor_retailer_detail", "list_vendor_retailer_shops"]) {
      assert.match(
        statementFor(name),
        /vr\.vendor_organization_id\s*=\s*v_vendor/,
        `${name} must match the relationship on the Vendor derived from auth.uid()`,
      );
      assert.match(
        statementFor(name),
        /vr\.id\s*=\s*p_relationship_id/,
        `${name} must match the relationship on the supplied id AS WELL AS the derived Vendor`,
      );
    }

    assert.match(
      statementFor("list_vendor_retailers"),
      /vr\.vendor_organization_id\s*=\s*v_vendor/,
      "the list must be scoped to the Vendor derived from auth.uid()",
    );
  });
});

// ============================================================================
// SECURITY DEFINER hardening
// ============================================================================
describe("mobile Vendor Retailer reads — SECURITY DEFINER hardening", () => {
  test("11. every function is a hardened, read-only definer function", () => {
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

  test("12. no function writes", () => {
    // STABLE is the declaration; this is the check. A read that mutated would make a
    // Flutter list refresh a write, and would make these functions unsafe to retry.
    for (const read of READS) {
      const statement = statementFor(read.name);
      for (const [pattern, label] of [
        [/\binsert\s+into\b/i, "insert"],
        [/\bupdate\s+public\./i, "update"],
        [/\bdelete\s+from\b/i, "delete"],
        [/\bperform\s+public\.expire_/i, "a hidden expiry sweep"],
      ] as [RegExp, string][]) {
        assert.ok(
          !pattern.test(statement),
          `public.${read.name} must not contain ${label}`,
        );
      }
    }
  });

  test("13. every object reference inside a function body is schema-qualified", () => {
    // An empty search_path makes an unqualified reference a runtime error rather than a
    // hijack risk — but only if it is caught. Every FROM/JOIN target below must name its
    // schema, so nothing can be resolved from an attacker-controlled one.
    for (const read of READS) {
      const statement = statementFor(read.name);
      const targets = statement.match(/\b(from|join)\s+(?!lateral\b)([a-z_][\w.]*)/gi) ?? [];

      // Without this, a regex that stopped matching anything would turn the loop below
      // into a no-op and the test would pass by finding nothing to check.
      assert.ok(
        targets.length > 0,
        `public.${read.name} must contain FROM/JOIN targets for this assertion to mean anything`,
      );

      for (const target of targets) {
        const referenced = target.split(/\s+/)[1];
        // Local aliases and CTE-free subqueries never appear here; every real target is a
        // table or a function in a schema.
        assert.ok(
          referenced.includes("."),
          `public.${read.name} references \`${referenced}\` without a schema qualifier`,
        );
      }
    }
  });
});

// ============================================================================
// Privileges
// ============================================================================
describe("mobile Vendor Retailer reads — privileges are explicit and exact", () => {
  test("14. every function revokes PUBLIC and anon", () => {
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

  test("15. the three reads grant execute to authenticated and to nobody else", () => {
    for (const read of READS.filter((entry) => entry.granted)) {
      const signature = `public.${read.name}\\(${read.args}\\)`;
      assert.match(
        CODE,
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${signature}\\s+to\\s+authenticated\\s*;`, "i"),
        `${read.name} must grant execute to authenticated`,
      );
    }

    // service_role is granted nothing: these reads derive their authority from auth.uid(),
    // which a service-role connection does not have, so a grant would produce a function
    // that can only ever refuse — while suggesting a trusted bypass exists.
    assert.ok(
      !/\bgrant\b[^;]*\bto\s+service_role\b/i.test(CODE),
      "no function may be granted to service_role",
    );
    assert.ok(
      !/\bgrant\b[^;]*\bto\s+anon\b/i.test(CODE),
      "no function may be granted to anon",
    );
    assert.ok(
      !/\bgrant\b[^;]*\bto\s+public\b/i.test(CODE),
      "no function may be granted to PUBLIC",
    );
  });

  test("16. the shared owner-state derivation is granted to NOBODY", () => {
    // It takes a Retailer organization id and performs no authorization of its own.
    // Reachable by a browser role it would be an oracle for probing any organization id.
    assert.match(
      CODE,
      /revoke\s+execute\s+on\s+function\s+public\.vendor_retailer_owner_state\(uuid\)\s+from\s+authenticated\s*;/i,
      "vendor_retailer_owner_state must be revoked from authenticated, not merely left ungranted",
    );
    assert.ok(
      !/grant\s+execute\s+on\s+function\s+public\.vendor_retailer_owner_state/i.test(CODE),
      "vendor_retailer_owner_state must never be granted to any role",
    );
  });

  test("17. every privilege statement names the exact signature it means to affect", () => {
    // A mismatched signature would silently privilege a different overload, or fail to
    // revoke the one that exists.
    const statements = CODE.match(/\b(revoke|grant)\b[^;]*;/gi) ?? [];
    assert.ok(statements.length > 0, "the migration must manage its own privileges");

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
describe("mobile Vendor Retailer reads — output contract", () => {
  test("18. the list returns exactly the agreed columns, in order", () => {
    assert.deepEqual(outputColumns("list_vendor_retailers"), [
      "relationship_id",
      "retailer_organization_id",
      "retailer_name",
      "retailer_status",
      "relationship_status",
      "relationship_created_at",
      "shop_count",
      "active_shop_count",
      "owner_state",
    ]);
  });

  test("19. the detail returns exactly the agreed columns, in order", () => {
    assert.deepEqual(outputColumns("get_vendor_retailer_detail"), [
      "relationship_id",
      "retailer_organization_id",
      "retailer_name",
      "retailer_status",
      "country_code",
      "default_currency",
      "relationship_status",
      "relationship_created_at",
      "shop_count",
      "active_shop_count",
      "owner_state",
    ]);
  });

  test("20. the shop companion returns exactly the agreed columns, in order", () => {
    assert.deepEqual(outputColumns("list_vendor_retailer_shops"), [
      "shop_id",
      "shop_name",
      "shop_code",
      "city",
      "country_code",
      "shop_status",
    ]);
  });

  test("21. the detail is the list's shape plus the two Retailer profile fields", () => {
    // One Flutter model deserializes both, and a future column addition has to be made to
    // both or to neither. Stated as a set relation so an addition to one alone fails here
    // rather than at a client that silently mis-parses a positional row.
    const list = outputColumns("list_vendor_retailers");
    const detail = outputColumns("get_vendor_retailer_detail");

    for (const column of list) {
      assert.ok(detail.includes(column), `detail must carry the list column ${column}`);
    }

    assert.deepEqual(
      detail.filter((column) => !list.includes(column)),
      ["country_code", "default_currency"],
      "the detail may add exactly the two Retailer profile fields the web already displays",
    );
  });

  test("22. no output column carries a secret, token, or authorization internal", () => {
    const FORBIDDEN = [
      /token/i,
      /hash/i,
      /secret/i,
      /password/i,
      /failure/i,
      /auth_user/i,
      /invited_by/i,
      /member_id/i,
      /membership/i,
      /role_id/i,
      /permission/i,
      /vendor_organization/i,
    ];

    for (const read of READS.filter((entry) => entry.granted)) {
      for (const column of outputColumns(read.name)) {
        for (const pattern of FORBIDDEN) {
          assert.ok(
            !pattern.test(column),
            `${read.name} must not return \`${column}\` — it matches the forbidden pattern ${pattern}`,
          );
        }
      }
    }
  });

  test("23. neither Retailer read returns owner personal data", () => {
    // The detail screen's owner card gets the recipient name, email, timestamps, failure
    // classification and invitation kind from get_vendor_retailer_owner_status(), which
    // the Vendor already calls today. Repeating them here would be a second, drifting
    // source of the same PII.
    for (const name of ["list_vendor_retailers", "get_vendor_retailer_detail"]) {
      for (const column of outputColumns(name)) {
        assert.ok(
          !/^(owner_)?(email|first_name|last_name)$/.test(column),
          `${name} must not return \`${column}\``,
        );
      }
    }
  });

  test("24. the invitations table is read only through the internal derivation", () => {
    // public.retailer_invitations is default-deny with zero policies and zero browser
    // privileges. The one place it is read is the owner-state function, which returns a
    // single word out of a closed set of five — no id, email, timestamp, token, or code.
    for (const read of READS.filter((entry) => entry.granted)) {
      assert.ok(
        !statementFor(read.name).includes("public.retailer_invitations"),
        `${read.name} must not read public.retailer_invitations directly`,
      );
    }

    const derivation = statementFor("vendor_retailer_owner_state");
    assert.ok(
      derivation.includes("public.retailer_invitations"),
      "the owner-state derivation is the one reader of public.retailer_invitations here",
    );
    assert.match(
      derivation,
      /returns\s+text\b/i,
      "the derivation must return a single text state, never a row of invitation data",
    );
    for (const column of ["token_hash", "failure_code", "ri.email", "invited_by_profile_id"]) {
      assert.ok(
        !new RegExp(`return\\s+[^;]*${column}`, "i").test(derivation),
        `the derivation must never return ${column}`,
      );
    }
  });

  test("25. the state vocabulary is closed and matches the deployed owner-status RPC", () => {
    const derivation = statementFor("vendor_retailer_owner_state");
    const returned = [...derivation.matchAll(/return\s+'([A-Z_]+)'\s*;/g)].map((m) => m[1]);

    assert.deepEqual(
      [...new Set(returned)].sort(),
      ["ACTIVE", "DELIVERY_FAILED", "EXPIRED", "NONE", "PENDING"],
      "the derivation may only ever return the five approved state words",
    );
  });
});

// ============================================================================
// Aggregation, ordering, and the performance property
// ============================================================================
describe("mobile Vendor Retailer reads — set-based aggregation", () => {
  test("26. shop counts are aggregated in SQL, never by returning shop rows", () => {
    // The defect this milestone exists to fix: the web directory selects every shop row
    // purely so JavaScript can count them. Both reads must aggregate instead.
    for (const name of ["list_vendor_retailers", "get_vendor_retailer_detail"]) {
      const statement = statementFor(name);
      assert.match(
        statement,
        /count\s*\(\s*\*\s*\)/i,
        `${name} must compute its shop count with SQL aggregation`,
      );
      assert.match(
        statement,
        /count\s*\(\s*\*\s*\)\s*filter\s*\(\s*where\s+s\.status\s*=\s*'ACTIVE'\s*\)/i,
        `${name} must compute active_shop_count with a FILTER rather than a second query`,
      );
      assert.match(
        statement,
        /left\s+join\s+lateral/i,
        `${name} must keep Retailers with no shops by aggregating through a LEFT JOIN LATERAL`,
      );
      assert.match(
        statement,
        /coalesce\s*\(\s*sc\.shop_total\s*,\s*0\s*\)/i,
        `${name} must report 0 rather than null for a Retailer with no shops`,
      );
    }
  });

  test("27. each read is a single statement — no per-Retailer loop", () => {
    // A loop would reintroduce the N+1 the aggregate exists to avoid, and would re-derive
    // the Vendor per row.
    for (const read of READS.filter((entry) => entry.granted)) {
      const statement = statementFor(read.name);
      assert.ok(
        !/\bfor\s+\w+\s+in\b/i.test(statement),
        `${read.name} must not iterate — the whole result is one set-based query`,
      );
      assert.equal(
        (statement.match(/\breturn\s+query\b/gi) ?? []).length,
        1,
        `${read.name} must emit its result from exactly one query`,
      );
    }
  });

  test("28. every list is totally ordered, so paging and re-fetching are stable", () => {
    // Ordering by a non-unique column alone would let two rows swap places between
    // requests. Each ORDER BY therefore ends in a unique tie-break.
    assert.match(
      statementFor("list_vendor_retailers"),
      /order\s+by\s+o\.name\s*,\s*vr\.id\s*;/i,
      "the Retailer list must order by name and break ties on the relationship id",
    );
    assert.match(
      statementFor("list_vendor_retailer_shops"),
      /order\s+by\s+s\.name\s*,\s*s\.id\s*;/i,
      "the shop list must order by name and break ties on the shop id",
    );
  });

  test("29. no speculative index is added", () => {
    // Every predicate is served by an index that already exists. An index added "just in
    // case" is a write cost with no measured cause.
    assert.ok(
      !/\bcreate\s+(unique\s+)?index\b/i.test(CODE),
      "the migration must add no index",
    );
  });
});

// ============================================================================
// Result semantics
// ============================================================================
describe("mobile Vendor Retailer reads — result semantics", () => {
  test("30. an unauthorized caller is refused generically, with one message", () => {
    const messages = new Set(
      [...CODE.matchAll(/raise\s+exception\s+'([^']*)'/gi)].map((m) => m[1]),
    );

    assert.deepEqual(
      [...messages],
      ["Not authorized to view Retailers"],
      "every refusal must use one generic message — a message that varied by cause would say which check failed",
    );

    const raises = CODE.match(/raise\s+exception/gi) ?? [];
    assert.equal(
      (CODE.match(/using\s+errcode\s*=\s*'insufficient_privilege'/gi) ?? []).length,
      raises.length,
      "every refusal must carry the 42501 SQLSTATE clients discriminate on",
    );
  });

  test("31. a foreign or unknown relationship yields zero rows, never a raise", () => {
    // A distinguishable refusal would confirm that another Vendor's relationship EXISTS,
    // and by sweeping ids, roughly how many. The addressed reads therefore raise only for
    // the authorization failure, and answer every addressing failure with an empty result.
    for (const name of ["get_vendor_retailer_detail", "list_vendor_retailer_shops"]) {
      const statement = statementFor(name);

      assert.equal(
        (statement.match(/raise\s+exception/gi) ?? []).length,
        1,
        `${name} must raise exactly once — for the authorization failure and nothing else`,
      );
      assert.match(
        statement,
        /if\s+p_relationship_id\s+is\s+null\s+then\s+return\s*;/i,
        `${name} must answer a null id with zero rows, indistinguishably from every other id it may not read`,
      );
    }
  });

  test("32. no read filters a lifecycle status out of existence", () => {
    // A Vendor that could not see the relationship it suspended would have no way to
    // review or resume it, and hiding a DEACTIVATED row would make ending a relationship
    // look like deleting one. The status is REPORTED instead, which is why every read
    // returns it. The one status comparison in these queries is the shop_count FILTER.
    for (const read of READS.filter((entry) => entry.granted)) {
      const statement = statementFor(read.name);
      // The aggregate's `count(*) filter (where s.status = 'ACTIVE')` is a COUNTING
      // clause, not a row filter — it decides what active_shop_count means, not which
      // rows exist. It is removed before the row-filter assertions below, which would
      // otherwise match it and forbid the very column the contract promises.
      const query = statement
        .slice(statement.search(/return\s+query/i))
        .replace(/filter\s*\([^)]*\)/gi, "");

      assert.ok(
        !/\bwhere\b[^;]*\bvr\.status\s*=/i.test(query),
        `${read.name} must not filter on relationship status`,
      );
      assert.ok(
        !/\bwhere\b[^;]*\bo\.status\s*=/i.test(query),
        `${read.name} must not filter on Retailer organization status`,
      );
      assert.ok(
        !/\bwhere\b[^;]*\bs\.status\s*=/i.test(query),
        `${read.name} must not filter shops by status — the count and the shop list must agree`,
      );
    }
  });

  test("33. only RETAILER organizations can be returned", () => {
    for (const read of READS.filter((entry) => entry.granted)) {
      assert.match(
        statementFor(read.name),
        /o\.organization_type\s*=\s*'RETAILER'/,
        `${read.name} must constrain the joined organization to a RETAILER`,
      );
    }
  });
});
