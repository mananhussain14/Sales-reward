/**
 * STATIC CONTRACT GUARDS for the mobile Vendor Role reads
 * (supabase/migrations/20260802090000_mobile_vendor_role_reads.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * lib/members/vendor-user-reads-contract.test.ts,
 * lib/retailers/vendor-retailer-reads-contract.test.ts and
 * lib/portal/portal-context-contract.test.ts. They read the SQL and assert structural
 * properties that a careless later edit could silently break.
 *
 * They do NOT execute the functions. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_role_reads_test.sql — pgTAP, 153 assertions, covering the
 * global-catalogue schema facts the contract rests on, every role denial, inactive callers,
 * status accuracy, permission-count and member-count semantics, tenant isolation of the
 * member count in both directions, duplicate-free aggregation, stable ordering, the
 * non-leaking zero-row answer for unknown, foreign-table and null ids, and the split
 * permission requirement. It requires Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of
 * properties decidable from the source, and which would be a SECURITY or CONTRACT
 * regression rather than a behavioural one:
 *
 *   1. The migration is new, forward-only, and edits no applied migration.
 *   2. It adds three functions and nothing else — no table, policy, index, grant on a
 *      table, seed row, or write of any kind. In particular it changes no role seed and no
 *      role→permission mapping.
 *   3. No function accepts identity, Vendor, tenant, role-code or permission-code input, and
 *      the one selector it does accept is the opaque role id.
 *   4. All three functions are correctly-hardened, read-only SECURITY DEFINER.
 *   5. Privileges are explicit and exact: authenticated only, never anon, never PUBLIC,
 *      never service_role.
 *   6. The output columns are exactly the agreed contract, and no role code, permission
 *      code, module, authorization internal, or member personal field appears in any of
 *      them.
 *   7. Authorization is DELEGATED to the existing helpers rather than reimplemented, and is
 *      split by least privilege: the two reads that return a member count require
 *      ORGANIZATION_MEMBERS_READ, the one that does not require only RBAC_READ.
 *   8. The counts are set-based scalar aggregates, so no read can be N+1 or duplicate a
 *      role, and the member count is scoped to the DERIVED Vendor.
 *   9. The web Roles page is untouched.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const MIGRATION_NAME = "20260802090000_mobile_vendor_role_reads.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose discusses the very patterns some of these tests forbid
 * (it explains why a role CODE must not be an input, and it names the columns it
 * deliberately does not return). Asserting against the raw text would match those
 * explanations and pass — or fail — for the wrong reason. Every structural assertion below
 * runs against executable SQL only.
 */
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/** The three functions this migration creates, and the signature each must carry. */
const READS = [
  { name: "list_vendor_roles", args: "" },
  { name: "get_vendor_role_detail", args: "uuid" },
  { name: "list_vendor_role_permissions", args: "uuid" },
] as const;

/**
 * The two reads that return `assigned_member_count`, and therefore read
 * public.organization_members. list_vendor_role_permissions is deliberately NOT here: it
 * touches no membership table, so demanding a membership permission of it would be asking
 * for a privilege it has no use for.
 */
const MEMBER_COUNTING_READS = ["list_vendor_roles", "get_vendor_role_detail"] as const;

/**
 * The `create function` statement for one function, from its CREATE through the closing
 * `$$;` of its body. Everything asserted per-function is asserted against this slice rather
 * than the whole file, so a clause belonging to one function can never satisfy an assertion
 * about another.
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
describe("mobile Vendor Role reads — migration hygiene", () => {
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

  test("2. adds three functions and changes nothing that already exists", () => {
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
      // table grant would let a client bypass these functions entirely.
      [/\bgrant\b[^;]*\bon\s+table\b/i, "grant on table"],
      [/\bgrant\b[^;]*\bon\s+all\s+tables\b/i, "grant on all tables"],
      [/\bsecurity\s+invoker\b/i, "security invoker"],
      // RLS must not be relaxed anywhere to make these reads possible; they are SECURITY
      // DEFINER precisely so that no policy has to change.
      [/\bdisable\s+row\s+level\s+security\b/i, "disable row level security"],
      [/\bforce\s+row\s+level\s+security\b/i, "force row level security"],
    ];

    for (const [pattern, label] of forbidden) {
      assert.ok(
        !pattern.test(CODE),
        `migration must not contain \`${label}\` — it adds three functions and changes nothing that exists`,
      );
    }

    const creates = CODE.match(/\bcreate\s+function\b/gi) ?? [];
    assert.equal(creates.length, READS.length, "exactly three functions are created");
  });

  test("3. alters no role seed, permission seed, or role→permission mapping", () => {
    // This is the milestone's sharpest rule: a read contract that quietly widened a role's
    // permissions would be a privilege escalation dressed as a feature. The catalogue this
    // migration reads is exactly the catalogue the seed migrations wrote.
    for (const table of [
      "public.roles",
      "public.permissions",
      "public.role_permissions",
      "public.member_roles",
      "public.organization_members",
    ]) {
      const escaped = table.replace(".", "\\.");
      assert.ok(
        !new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+${escaped}\\b`, "i").test(CODE),
        `migration must not write to ${table}`,
      );
    }
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
});

// ============================================================================
// No client-supplied identity, Vendor, or tenant context
// ============================================================================
describe("mobile Vendor Role reads — no client-supplied context", () => {
  test("5. the list takes zero arguments", () => {
    assert.match(
      CODE,
      /create\s+function\s+public\.list_vendor_roles\s*\(\s*\)/i,
      "list_vendor_roles must be declared with an empty parameter list — a caller must not be able to name a Vendor, role, or permission",
    );
  });

  test("6. the detail and its companion take exactly one role selector, typed uuid", () => {
    for (const name of ["get_vendor_role_detail", "list_vendor_role_permissions"]) {
      const signature = statementFor(name).match(
        /create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)\s*returns/i,
      );
      assert.ok(signature, `${name} must declare a parameter list`);

      const parameters = signature[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      assert.deepEqual(
        parameters.map((entry) => entry.split(/\s+/)[0]),
        ["p_role_id"],
        `${name} must take exactly one input, the role selector`,
      );
      assert.match(parameters[0], /\buuid\b/i, "the selector must be a uuid");
    }
  });

  test("7. no function accepts an identity, tenant, role-code or permission-code parameter", () => {
    // The vulnerability this whole shape exists to prevent: a parameter a browser could set
    // that decides WHOSE data is returned, or which authorization vocabulary is evaluated.
    //
    // p_role_code deserves its own note. roles.code is UNIQUE and would address a role just
    // as precisely — and that is exactly why it is refused. The codes (VENDOR_SUPER_ADMIN,
    // RBAC_READ, …) are the literals the migration-5 RLS policies and the migration-4
    // helpers match on; accepting one as input would put authorization vocabulary in a
    // client's hands. The uuid is opaque and means nothing anywhere else.
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
      "p_role_name",
      "p_role_status",
      "p_permission",
      "p_permission_id",
      "p_permission_code",
      "p_permissions",
      "p_module",
      "p_actor",
      "p_status",
      "p_scope",
    ];

    for (const read of READS) {
      const signature = statementFor(read.name).match(
        /create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)\s*returns/i,
      );
      assert.ok(signature, `${read.name} must declare a parameter list`);

      for (const forbidden of FORBIDDEN_PARAMETERS) {
        assert.ok(
          !new RegExp(`\\b${forbidden}\\b`, "i").test(signature[1]),
          `${read.name} must not accept ${forbidden} — identity, tenant and authorization vocabulary come from auth.uid()`,
        );
      }
    }
  });

  test("8. every read derives its Vendor from the shared context function", () => {
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
        /order\s+by\s+ctx\.organization_id\s+limit\s+1/i,
        `${read.name} must apply the same deterministic multi-Vendor tie-break every other Vendor RPC applies`,
      );
    }
  });

  test("9. the permission requirement is split by least privilege", () => {
    // Each function requires exactly the permissions the migration-5 policies would have
    // required of the tables it actually reads:
    //
    //   RBAC_READ                  roles, permissions, role_permissions   — all three reads
    //   ORGANIZATION_MEMBERS_READ  organization_members                   — only the two
    //                                                                       that return a
    //                                                                       member count
    //
    // These functions are SECURITY DEFINER and so run outside those policies; requiring the
    // matching permission explicitly is what stops the contract from being a way to read
    // what RLS would have refused.
    for (const read of READS) {
      assert.match(
        statementFor(read.name),
        /public\.has_organization_permission\s*\(\s*v_vendor\s*,\s*'RBAC_READ'\s*\)/,
        `${read.name} must require RBAC_READ through the shared permission helper`,
      );
    }

    for (const name of MEMBER_COUNTING_READS) {
      assert.match(
        statementFor(name),
        /public\.has_organization_permission\s*\(\s*v_vendor\s*,\s*'ORGANIZATION_MEMBERS_READ'\s*\)/,
        `${name} returns assigned_member_count and must therefore also require ORGANIZATION_MEMBERS_READ`,
      );
    }

    // And the companion must NOT demand it: it reads no membership table, so requiring a
    // membership permission would be asking for a privilege it has no use for.
    assert.ok(
      !/ORGANIZATION_MEMBERS_READ/.test(statementFor("list_vendor_role_permissions")),
      "list_vendor_role_permissions must not require ORGANIZATION_MEMBERS_READ — it reads no membership table",
    );
    assert.ok(
      !statementFor("list_vendor_role_permissions").includes("public.organization_members"),
      "list_vendor_role_permissions must not read public.organization_members at all",
    );
  });

  test("10. no read reimplements the membership/role/permission chain, or names a role code", () => {
    // Restating "is this caller authorized" here would be a SECOND definition, free to
    // drift from the helpers and from the RLS policies — and only one of the two could be
    // right. public.roles, public.permissions, public.role_permissions, public.member_roles
    // and public.organization_members ARE read, but as DATA about the catalogue, never as a
    // condition on the caller.
    for (const read of READS) {
      const body = statementFor(read.name);
      assert.ok(
        !/'VENDOR_SUPER_ADMIN'/.test(body),
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
    }
  });

  test("11. the member count compares the DERIVED Vendor, never a parameter", () => {
    // assigned_member_count is the only tenant-scoped value in this contract, so this is the
    // whole tenant boundary in one predicate.
    for (const name of MEMBER_COUNTING_READS) {
      assert.match(
        statementFor(name),
        /m\.organization_id\s*=\s*v_vendor/,
        `${name} must scope its member count to the Vendor derived from auth.uid()`,
      );
    }

    assert.match(
      statementFor("get_vendor_role_detail"),
      /where\s+r\.id\s*=\s*p_role_id/,
      "the detail must match the role on the supplied id",
    );
    assert.match(
      statementFor("list_vendor_role_permissions"),
      /where\s+rp\.role_id\s*=\s*p_role_id/,
      "the companion must match the mapping rows on the supplied id",
    );
  });
});

// ============================================================================
// SECURITY DEFINER hardening
// ============================================================================
describe("mobile Vendor Role reads — SECURITY DEFINER hardening", () => {
  test("12. every function is a hardened, read-only definer function", () => {
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

  test("13. no function writes", () => {
    // STABLE is the declaration; this is the check. A read that mutated would make a Flutter
    // list refresh a write, and would make these functions unsafe to retry.
    for (const read of READS) {
      const statement = statementFor(read.name);
      for (const [pattern, label] of [
        [/\binsert\s+into\b/i, "insert"],
        [/\bupdate\s+public\./i, "update"],
        [/\bdelete\s+from\b/i, "delete"],
        [/\bperform\s+public\.expire_/i, "a hidden expiry sweep"],
      ] as [RegExp, string][]) {
        assert.ok(!pattern.test(statement), `public.${read.name} must not contain ${label}`);
      }
    }
  });

  test("14. every object reference inside a function body is schema-qualified", () => {
    // An empty search_path makes an unqualified reference a runtime error rather than a
    // hijack risk — but only if it is caught. Every FROM/JOIN target below must name its
    // schema, so nothing can be resolved from an attacker-controlled one.
    for (const read of READS) {
      const statement = statementFor(read.name);
      const targets = statement.match(/\b(from|join)\s+(?!lateral\b)([a-z_][\w.]*)/gi) ?? [];

      // Without this, a regex that stopped matching anything would turn the loop below into
      // a no-op and the test would pass by finding nothing to check.
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

  test("15. the denial is generic, identical across the three reads, and machine-readable", () => {
    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.match(
        statement,
        /raise\s+exception\s+'Not authorized to view Vendor roles'\s*\n?\s*using\s+errcode\s*=\s*'insufficient_privilege'/i,
        `${read.name} must fail closed with one generic, machine-readable denial`,
      );
      // The message must not name a table, a column, a policy, a role code, or a permission
      // code — the difference between "you are not signed in", "you are not a Vendor Super
      // Admin" and "your role lost RBAC_READ" is not a client's business. Every identifier
      // in this schema is either schema-qualified or snake_case, so a message free of `.`
      // and `_` cannot be naming one. ("Vendor roles" is the FEATURE, not the table.)
      const messages = statement.match(/raise\s+exception\s+'([^']*)'/gi) ?? [];
      assert.ok(messages.length > 0, `${read.name} must raise a message for this check to mean anything`);
      for (const message of messages) {
        assert.ok(
          !/[_.]/.test(message.replace(/^raise\s+exception\s+/i, "")),
          `${read.name}'s denial message must not name an internal identifier: ${message}`,
        );
      }
    }
  });

  test("16. an unaddressable role returns zero rows rather than raising", () => {
    // The non-leaking property: an authorized caller who names something that is not a role
    // gets the same answer for an unknown uuid, an id belonging to another table, and null.
    for (const name of ["get_vendor_role_detail", "list_vendor_role_permissions"]) {
      const statement = statementFor(name);
      assert.match(
        statement,
        /if\s+p_role_id\s+is\s+null\s+then\s*\n\s*return\s*;/i,
        `${name} must return zero rows for a null selector, not raise`,
      );

      const raises = statement.match(/\braise\s+exception\b/gi) ?? [];
      assert.equal(
        raises.length,
        1,
        `${name} must raise exactly once — for authorization — and never for an id it cannot address`,
      );
    }
  });
});

// ============================================================================
// Privileges
// ============================================================================
describe("mobile Vendor Role reads — privileges are explicit and exact", () => {
  test("17. every function revokes PUBLIC and anon", () => {
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

  test("18. every read grants execute to authenticated and to nobody else", () => {
    for (const read of READS) {
      const signature = `public.${read.name}\\(${read.args}\\)`;
      assert.match(
        CODE,
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${signature}\\s+to\\s+authenticated\\s*;`, "i"),
        `${read.name} must grant execute to authenticated`,
      );
    }

    // service_role is granted nothing: these reads derive their authority from auth.uid(),
    // which a service-role connection does not have, so a grant would produce a function
    // that can only ever refuse — while suggesting a trusted bypass exists. Flutter calls
    // these directly with the caller's own token, so a service-role-only design is also
    // excluded.
    assert.ok(
      !/\bgrant\b[^;]*\bto\s+service_role\b/i.test(CODE),
      "no function may be granted to service_role",
    );
    assert.ok(!/\bgrant\b[^;]*\bto\s+anon\b/i.test(CODE), "no function may be granted to anon");
    assert.ok(!/\bgrant\b[^;]*\bto\s+public\b/i.test(CODE), "no function may be granted to PUBLIC");
  });

  test("19. every privilege statement names the exact signature it means to affect", () => {
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
describe("mobile Vendor Role reads — output contract", () => {
  const ROLE_COLUMNS = [
    "role_id",
    "role_name",
    "role_description",
    "role_status",
    "role_created_at",
    "permission_count",
    "assigned_member_count",
  ];

  test("20. the list returns exactly the agreed columns, in order", () => {
    assert.deepEqual(outputColumns("list_vendor_roles"), ROLE_COLUMNS);
  });

  test("21. the detail column set IS the list column set", () => {
    // Not a superset. public.roles has seven columns; five are already here, the sixth is
    // `code` (refused below) and the seventh is `updated_at` (a record of the last seed run,
    // since the seed is an upsert that sets it to now()). There is genuinely nothing further
    // to show about a role definition, so a wider detail shape would mean inventing data.
    // One Flutter model therefore deserializes both.
    assert.deepEqual(outputColumns("get_vendor_role_detail"), ROLE_COLUMNS);
    assert.deepEqual(
      outputColumns("get_vendor_role_detail"),
      outputColumns("list_vendor_roles"),
      "the detail and list column sets must not drift apart",
    );
  });

  test("22. the permission companion returns the two fields the web Roles page displays", () => {
    // app/(admin)/roles/page.tsx renders exactly `permission.name` over
    // `permission.description`, through one shared component used for both the per-role list
    // and the whole-catalogue section.
    assert.deepEqual(outputColumns("list_vendor_role_permissions"), [
      "permission_name",
      "permission_description",
    ]);
  });

  test("23. no output column carries a role code, a permission code, or a module", () => {
    // lib/rbac/vendor-rbac-catalog.ts states the rule the web already follows: `code` is
    // "deliberately never selected from either catalogue table" because the codes are "the
    // internal literals the RLS policies match on". `module` is a real NOT NULL column, but
    // the web neither displays nor groups by it and its stored values are SCREAMING_CASE
    // category labels — it is added deliberately when a screen groups by it, not inferred
    // now.
    for (const read of READS) {
      for (const column of outputColumns(read.name)) {
        for (const pattern of [/code/i, /\bmodule\b/i, /category/i]) {
          assert.ok(
            !pattern.test(column),
            `${read.name} must not return \`${column}\` — authorization vocabulary is not display data`,
          );
        }
      }
    }
  });

  test("24. no output column invents a property the schema does not have", () => {
    // public.roles has no kind, is_system, is_custom or is_editable column, and
    // public.permissions has no status column. A system/custom flag could only be derived
    // from the role name or code; an is_editable flag would advertise a write path that does
    // not exist anywhere in this product; and an active_permission_count would always equal
    // permission_count.
    const FORBIDDEN = [
      /kind/i,
      /is_system/i,
      /is_custom/i,
      /is_builtin/i,
      /editable/i,
      /active_permission/i,
      /permission_status/i,
    ];

    for (const read of READS) {
      for (const column of outputColumns(read.name)) {
        for (const pattern of FORBIDDEN) {
          assert.ok(
            !pattern.test(column),
            `${read.name} must not return \`${column}\` — the schema has no such property to report`,
          );
        }
      }
    }
  });

  test("25. no output column carries identity, authentication, or member personal data", () => {
    // This is a role catalogue, not a member directory. Only a COUNT crosses that boundary;
    // not one personal field does. The member directory is list_vendor_users()
    // (20260801090000), which is where a Vendor goes to learn WHO holds a role.
    const FORBIDDEN = [
      /auth_user/i,
      /\buser_id\b/i,
      /profile_id/i,
      /membership/i,
      /display_name/i,
      /first_name/i,
      /last_name/i,
      /email/i,
      /mobile/i,
      /phone/i,
      /\bpassword\b/i,
      /provider/i,
      /session/i,
      /\bjwt\b/i,
      /organization_id/i,
      /tenant/i,
    ];

    for (const read of READS) {
      for (const column of outputColumns(read.name)) {
        for (const pattern of FORBIDDEN) {
          assert.ok(
            !pattern.test(column),
            `${read.name} must not return \`${column}\``,
          );
        }
      }
    }
  });

  test("26. no output column carries an invitation, audit, or policy internal", () => {
    const FORBIDDEN = [
      /token/i,
      /hash/i,
      /secret/i,
      /invitation/i,
      /invited_by/i,
      /expires_at/i,
      /\bpolicy\b/i,
      /\brls\b/i,
      /\bgrant\b/i,
      /search_path/i,
      /definer/i,
      /audit/i,
    ];

    for (const read of READS) {
      for (const column of outputColumns(read.name)) {
        for (const pattern of FORBIDDEN) {
          assert.ok(
            !pattern.test(column),
            `${read.name} must not return \`${column}\``,
          );
        }
      }
    }

    // And no body may read the invitation or audit tables.
    for (const read of READS) {
      const body = statementFor(read.name);
      for (const table of [
        "retailer_invitations",
        "retailer_staff_invitations",
        "retailer_invitation_shop_assignments",
        "audit_logs",
      ]) {
        assert.ok(
          !body.includes(table),
          `${read.name} must not read public.${table} — it is not role catalogue data`,
        );
      }
    }
  });

  test("27. the counts are declared as integers, not bigints or text", () => {
    for (const name of MEMBER_COUNTING_READS) {
      const statement = statementFor(name);
      assert.match(
        statement,
        /permission_count\s+integer/i,
        `${name} must declare permission_count as an integer`,
      );
      assert.match(
        statement,
        /assigned_member_count\s+integer/i,
        `${name} must declare assigned_member_count as an integer`,
      );
      // count(*) is bigint; the cast is what makes the declaration honest.
      const casts = statement.match(/\)::integer/g) ?? [];
      assert.equal(
        casts.length,
        2,
        `${name} must cast both aggregates to integer exactly once each`,
      );
    }
  });
});

// ============================================================================
// Set-based aggregation — no N+1, no duplicated roles, no invented defaults
// ============================================================================
describe("mobile Vendor Role reads — set-based aggregation", () => {
  test("28. both counts are scalar aggregates, never joins into the row set", () => {
    // role_permissions is keyed by (role_id, permission_id) and member_roles by
    // (organization_member_id, role_id), so a role may have many of each. A JOIN would emit
    // one row per mapping and duplicate the role; a scalar subquery is evaluated once per
    // role row and cannot.
    for (const name of MEMBER_COUNTING_READS) {
      const statement = statementFor(name);

      assert.match(
        statement,
        /select\s+count\(\*\)\s*\n\s*from\s+public\.role_permissions\s+rp\s*\n\s*join\s+public\.permissions\s+p\s+on\s+p\.id\s*=\s*rp\.permission_id/i,
        `${name} must count permissions with a scalar aggregate joined to public.permissions, so the number always equals what list_vendor_role_permissions() returns`,
      );

      assert.match(
        statement,
        /select\s+count\(\*\)\s*\n\s*from\s+public\.member_roles\s+mr\s*\n\s*join\s+public\.organization_members\s+m/i,
        `${name} must count members with a scalar aggregate over member_roles`,
      );

      assert.ok(
        !/\bfrom\s+public\.roles\s+r\s*\n\s*join\s+public\.(role_permissions|member_roles)\b/i.test(
          statement,
        ),
        `${name} must not join the mapping tables into the outer row set — that would duplicate a role`,
      );

      assert.ok(
        !/\bdistinct\b/i.test(statement),
        `${name} must not need DISTINCT — row multiplicity is fixed by the schema, and a DISTINCT would hide a genuine duplication bug`,
      );
    }
  });

  test("29. the caller's Vendor is resolved ONCE per call, not per row", () => {
    for (const read of READS) {
      const statement = statementFor(read.name);
      const contextCalls = statement.match(/get_vendor_super_admin_context\s*\(/g) ?? [];
      assert.equal(
        contextCalls.length,
        1,
        `${read.name} must resolve its Vendor exactly once — a per-row resolution would be N+1 authorization`,
      );

      const permissionCalls = statement.match(/has_organization_permission\s*\(/g) ?? [];
      const expected = (MEMBER_COUNTING_READS as readonly string[]).includes(read.name) ? 2 : 1;
      assert.equal(
        permissionCalls.length,
        expected,
        `${read.name} must check each permission it needs exactly once, before the query rather than inside it`,
      );
    }
  });

  test("30. each read issues exactly one row-producing statement", () => {
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

  test("31. the ordering is deterministic and total", () => {
    // Two roles — or two permissions — may legitimately share a display name; without a
    // tie-break they could swap places between requests and a re-fetched mobile list would
    // flicker.
    assert.match(
      statementFor("list_vendor_roles"),
      /order\s+by\s+r\.name\s*,\s*r\.id\s*;/i,
      "list_vendor_roles must order by role name then role id",
    );
    assert.match(
      statementFor("list_vendor_role_permissions"),
      /order\s+by\s+p\.name\s*,\s*p\.id\s*;/i,
      "list_vendor_role_permissions must order by permission name then permission id",
    );
  });

  test("32. the catalogue is not filtered, matching the web", () => {
    // lib/rbac/vendor-rbac-catalog.ts deliberately does NOT filter roles by status: "a
    // catalogue that hid INACTIVE definitions would misrepresent what is stored", and the
    // status is shown per row instead. The mobile contract must agree, or the two clients
    // would disagree about what the catalogue contains.
    const list = statementFor("list_vendor_roles");
    assert.ok(
      !/where[\s\S]*r\.status\s*=/i.test(list),
      "list_vendor_roles must not filter roles by status — the status is returned per row instead",
    );
    assert.ok(
      !/\bwhere\b/i.test(list.slice(list.indexOf("from public.roles r"))),
      "list_vendor_roles must apply no WHERE clause to the catalogue at all",
    );

    // Nor may the member count quietly exclude a lifecycle state: the Vendor Users directory
    // filters neither membership nor profile status, and a count that disagreed with the
    // screen it sits beside would be worse than no count.
    for (const name of MEMBER_COUNTING_READS) {
      const statement = statementFor(name);
      assert.ok(
        !/m\.status\s*=/i.test(statement),
        `${name} must not filter the member count by membership status`,
      );
      assert.ok(
        !statement.includes("public.profiles"),
        `${name} must not read public.profiles — a count needs no profile row, and a status filter there would contradict the Vendor Users directory`,
      );
    }
  });

  test("33. nothing is defaulted, substituted, or fabricated", () => {
    // The rule that matters most: an absent description must stay NULL, an unknown status
    // must never be mapped to ACTIVE, and a role with no permissions must never be reported
    // as holding any.
    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.ok(
        !/coalesce\s*\(\s*r\.(description|status)/i.test(statement),
        `${read.name} must not substitute a value for an absent description or status`,
      );
      assert.ok(
        !/'ACTIVE'/.test(statement),
        `${read.name} must not name a status literal — the stored status is returned as-is`,
      );
      assert.ok(
        !/coalesce\s*\(\s*p\.(name|description)/i.test(statement),
        `${read.name} must not fabricate a permission name or description`,
      );
    }
  });
});

// ============================================================================
// Web compatibility
// ============================================================================
describe("mobile Vendor Role reads — the web is untouched", () => {
  test("34. the existing Roles catalogue module still performs its own reads", () => {
    // This PR adds a shared contract; it does not migrate the web onto it. The visible
    // behaviour of /roles must be byte-identical after this branch.
    const web = readFileSync(join(ROOT, "lib/rbac/vendor-rbac-catalog.ts"), "utf8");

    for (const read of READS) {
      assert.ok(
        !web.includes(read.name),
        `lib/rbac/vendor-rbac-catalog.ts must not call ${read.name} in this milestone`,
      );
    }
    for (const table of ["roles", "permissions", "role_permissions"]) {
      assert.ok(
        web.includes(`.from("${table}")`),
        `the web module must still read ${table} exactly as it did before`,
      );
    }
  });

  test("35. no Vendor role detail route is introduced by this milestone", () => {
    // The milestone is backend-only, and read-only. There is no web role-detail page today,
    // and no role create, edit, delete or activate page anywhere — this branch adds none.
    const rolesRoute = readdirSync(join(ROOT, "app/(admin)/roles"));
    assert.deepEqual(
      rolesRoute.sort(),
      ["loading.tsx", "page.tsx"],
      "app/(admin)/roles must still contain only the list page and its loading state",
    );
  });

  test("36. the dashboard's role and permission counts are untouched", () => {
    // lib/dashboard/vendor-admin-summary.ts counts ACTIVE roles and ALL permissions through
    // its own reads. Those counts and this contract answer different questions, and neither
    // may quietly start calling the other.
    const dashboard = readFileSync(join(ROOT, "lib/dashboard/vendor-admin-summary.ts"), "utf8");
    for (const read of READS) {
      assert.ok(
        !dashboard.includes(read.name),
        `lib/dashboard/vendor-admin-summary.ts must not call ${read.name} in this milestone`,
      );
    }
  });
});
