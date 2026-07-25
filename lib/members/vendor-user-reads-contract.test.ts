/**
 * STATIC CONTRACT GUARDS for the mobile Vendor User reads
 * (supabase/migrations/20260801090000_mobile_vendor_user_reads.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * lib/retailers/vendor-retailer-reads-contract.test.ts and
 * lib/portal/portal-context-contract.test.ts. They read the SQL and assert structural
 * properties that a careless later edit could silently break.
 *
 * They do NOT execute the functions. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_user_reads_test.sql — pgTAP, 106 assertions, covering
 * tenant isolation, every role denial, inactive callers, the single-user directory, status
 * accuracy across all four lifecycle states, role-array correctness and ordering,
 * duplicate-free joins for multi-role and multi-organization people, stable ordering, and
 * the non-leaking zero-row answer for foreign, unknown, Retailer-owned and null ids. It
 * requires Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of
 * properties decidable from the source, and which would be a SECURITY or CONTRACT
 * regression rather than a behavioural one:
 *
 *   1. The migration is new, forward-only, and edits no applied migration.
 *   2. It adds two functions and nothing else — no table, policy, index, grant on a table,
 *      or write of any kind.
 *   3. Neither function accepts identity, Vendor, tenant, role, or permission input, and
 *      the one selector it does accept is the membership id rather than a profile or auth
 *      user id.
 *   4. Both functions are correctly-hardened, read-only SECURITY DEFINER.
 *   5. Privileges are explicit and exact: authenticated only, never anon, never PUBLIC,
 *      never service_role.
 *   6. The output columns are exactly the agreed contract, and no authentication field,
 *      permission internal, invitation field, or unshown personal field appears in either.
 *   7. Authorization is DELEGATED to the existing helpers rather than reimplemented, so
 *      these reads inherit the ACTIVE-status chain and the multi-Vendor rule.
 *   8. The roles are aggregated set-based, so neither read can be N+1 or duplicate a user.
 *   9. The web Vendor Users page is untouched.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const MIGRATION_NAME = "20260801090000_mobile_vendor_user_reads.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose discusses the very patterns some of these tests forbid
 * (it explains why an auth user id must not be an input, and it names the invitation tables
 * it deliberately does not touch). Asserting against the raw text would match those
 * explanations and pass — or fail — for the wrong reason. Every structural assertion below
 * runs against executable SQL only.
 */
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/** The two functions this migration creates, and the signature each must carry. */
const READS = [
  { name: "list_vendor_users", args: "" },
  { name: "get_vendor_user_detail", args: "uuid" },
] as const;

/** The two permissions both reads must require, mirroring the migration-5 RLS policies. */
const REQUIRED_PERMISSIONS = ["ORGANIZATION_MEMBERS_READ", "RBAC_READ"] as const;

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
describe("mobile Vendor User reads — migration hygiene", () => {
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
        `migration must not contain \`${label}\` — it adds two functions and changes nothing that exists`,
      );
    }

    const creates = CODE.match(/\bcreate\s+function\b/gi) ?? [];
    assert.equal(creates.length, READS.length, "exactly two functions are created");
  });

  test("3. seeds no role, permission, or mapping", () => {
    // ORGANIZATION_MEMBERS_READ and RBAC_READ already exist and are already mapped to
    // VENDOR_SUPER_ADMIN (20260716133023). Re-seeding them here would put a second
    // definition of the catalogue in the history, free to drift from the first.
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
describe("mobile Vendor User reads — no client-supplied context", () => {
  test("5. the list takes zero arguments", () => {
    assert.match(
      CODE,
      /create\s+function\s+public\.list_vendor_users\s*\(\s*\)/i,
      "list_vendor_users must be declared with an empty parameter list — a caller must not be able to name a Vendor, user, role, or permission",
    );
  });

  test("6. the detail takes exactly one membership selector, typed uuid", () => {
    const signature = statementFor("get_vendor_user_detail").match(
      /create\s+function\s+public\.\w+\s*\(([\s\S]*?)\)\s*returns/i,
    );
    assert.ok(signature, "get_vendor_user_detail must declare a parameter list");

    const parameters = signature[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    assert.deepEqual(
      parameters.map((entry) => entry.split(/\s+/)[0]),
      ["p_membership_id"],
      "get_vendor_user_detail must take exactly one input, the membership selector",
    );
    assert.match(parameters[0], /\buuid\b/i, "the selector must be a uuid");
  });

  test("7. neither function accepts an identity, tenant, role, or permission parameter", () => {
    // The vulnerability this whole shape exists to prevent: a parameter a browser could set
    // that decides WHOSE data is returned. `p_membership_id` is the only input on the whole
    // surface, and it selects among rows the caller is already entitled to.
    //
    // p_profile_id and p_user_id are forbidden for a reason specific to this milestone: a
    // profile belongs to potentially several organizations, so a profile id names a person
    // GLOBALLY and would have to be narrowed back to a membership before it could be
    // authorized. The membership id is already tenant-scoped. p_auth_user_id is worse
    // still — that is the subject Supabase Auth mints tokens for.
    const FORBIDDEN_PARAMETERS = [
      "p_user_id",
      "p_auth_user_id",
      "p_profile_id",
      "p_email",
      "p_vendor_organization_id",
      "p_vendor_id",
      "p_organization_id",
      "p_tenant_id",
      "p_role",
      "p_role_code",
      "p_role_id",
      "p_permission",
      "p_permission_code",
      "p_actor",
      "p_status",
    ];

    for (const read of READS) {
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

  test("8. both reads derive their Vendor from the shared context function", () => {
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
      assert.match(
        body,
        /auth\.uid|get_vendor_super_admin_context/,
        `${read.name} must resolve identity from the verified session, never from an argument`,
      );
    }
  });

  test("9. both reads require BOTH permissions through the shared helper", () => {
    // These functions are SECURITY DEFINER and so run outside the migration-5 policies that
    // would otherwise require ORGANIZATION_MEMBERS_READ (profiles, organization_members) and
    // RBAC_READ (member_roles, roles). Requiring both explicitly is what stops the contract
    // from being a way to read role assignments RLS would have refused.
    for (const read of READS) {
      const body = statementFor(read.name);
      for (const permission of REQUIRED_PERMISSIONS) {
        assert.match(
          body,
          new RegExp(`public\\.has_organization_permission\\s*\\(\\s*v_vendor\\s*,\\s*'${permission}'\\s*\\)`),
          `${read.name} must require ${permission} through the shared permission helper`,
        );
      }
    }
  });

  test("10. neither read reimplements the membership/role/permission chain", () => {
    // Reading the RBAC mapping tables here would be a SECOND definition of "is this caller
    // authorized", free to drift from the helpers and from the RLS policies — and only one
    // of the two could be right. public.profiles, public.organization_members,
    // public.member_roles and public.roles ARE read, but as DATA about the target users, and
    // never as a condition on the caller.
    for (const read of READS) {
      const body = statementFor(read.name);
      for (const table of ["public.role_permissions", "public.permissions"]) {
        assert.ok(
          !body.includes(table),
          `${read.name} must not read ${table} — the permission check is a boolean helper, not a row read`,
        );
      }
      assert.ok(
        !/'VENDOR_SUPER_ADMIN'/.test(body),
        `${read.name} must not name a role code — which role holds these permissions is seed data`,
      );
      assert.ok(
        !/auth\.users/.test(body),
        `${read.name} must not read auth.users — no email, provider, or authentication metadata belongs in this contract`,
      );
    }
  });

  test("11. the tenant filter compares the DERIVED Vendor, never a parameter", () => {
    for (const read of READS) {
      assert.match(
        statementFor(read.name),
        /m\.organization_id\s*=\s*v_vendor/,
        `${read.name} must scope memberships to the Vendor derived from auth.uid()`,
      );
    }

    assert.match(
      statementFor("get_vendor_user_detail"),
      /m\.id\s*=\s*p_membership_id/,
      "the detail must match the membership on the supplied id AS WELL AS the derived Vendor",
    );

    // Belt and braces: the supplied id must never be the ONLY predicate.
    const detail = statementFor("get_vendor_user_detail");
    const idPredicate = detail.indexOf("m.id = p_membership_id");
    const tenantPredicate = detail.indexOf("m.organization_id = v_vendor");
    assert.ok(
      idPredicate !== -1 && tenantPredicate !== -1 && tenantPredicate > idPredicate,
      "the detail's WHERE clause must carry both the selector and the derived-Vendor predicate",
    );
  });
});

// ============================================================================
// SECURITY DEFINER hardening
// ============================================================================
describe("mobile Vendor User reads — SECURITY DEFINER hardening", () => {
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

  test("13. neither function writes", () => {
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

  test("15. the denial is generic and carries the standard SQLSTATE", () => {
    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.match(
        statement,
        /raise\s+exception\s+'Not authorized to view Vendor users'\s*\n?\s*using\s+errcode\s*=\s*'insufficient_privilege'/i,
        `${read.name} must fail closed with one generic, machine-readable denial`,
      );
      // The message must not name a table, a policy, a Vendor, or a person — the difference
      // between "you are not signed in", "you are not a Vendor Super Admin" and "your role
      // lost a permission" is not a client's business.
      assert.ok(
        !/raise\s+exception\s+'[^']*(profiles|organization_members|member_roles|policy|vendor_id|organization_id)[^']*'/i.test(
          statement,
        ),
        `${read.name}'s denial message must not name internals`,
      );
    }
  });

  test("16. an unaddressable membership returns zero rows rather than raising", () => {
    // The security property of the detail read: a distinguishable refusal would confirm that
    // another Vendor's user EXISTS, and by sweeping ids, roughly how many.
    const detail = statementFor("get_vendor_user_detail");
    assert.match(
      detail,
      /if\s+p_membership_id\s+is\s+null\s+then\s*\n\s*return\s*;/i,
      "a null selector must return zero rows, not raise — it must be indistinguishable from a foreign id",
    );

    const raises = detail.match(/\braise\s+exception\b/gi) ?? [];
    assert.equal(
      raises.length,
      1,
      "the detail must raise exactly once — for authorization — and never for an id it cannot address",
    );
  });
});

// ============================================================================
// Privileges
// ============================================================================
describe("mobile Vendor User reads — privileges are explicit and exact", () => {
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

  test("18. both reads grant execute to authenticated and to nobody else", () => {
    for (const read of READS) {
      const signature = `public.${read.name}\\(${read.args}\\)`;
      assert.match(
        CODE,
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${signature}\\s+to\\s+authenticated\\s*;`, "i"),
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

  test("19. every privilege statement names the exact signature it means to affect", () => {
    // A mismatched signature would silently privilege a different overload, or fail to revoke
    // the one that exists.
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
describe("mobile Vendor User reads — output contract", () => {
  const LIST_COLUMNS = [
    "membership_id",
    "display_name",
    "profile_status",
    "membership_status",
    "membership_created_at",
    "joined_at",
    "role_names",
  ];

  test("20. the list returns exactly the agreed columns, in order", () => {
    assert.deepEqual(outputColumns("list_vendor_users"), LIST_COLUMNS);
  });

  test("21. the detail returns the list columns plus deactivated_at, and nothing else", () => {
    assert.deepEqual(outputColumns("get_vendor_user_detail"), [
      "membership_id",
      "display_name",
      "profile_status",
      "membership_status",
      "membership_created_at",
      "joined_at",
      "deactivated_at",
      "role_names",
    ]);

    // Stated as a relationship as well as a literal, so one Flutter model can deserialize
    // both and a future column cannot be added to one alone.
    assert.deepEqual(
      outputColumns("get_vendor_user_detail").filter((column) => column !== "deactivated_at"),
      LIST_COLUMNS,
      "the detail column set must be the list column set plus deactivated_at",
    );
  });

  test("22. no output column carries authentication or identity internals", () => {
    // profiles.id IS the auth.users id (20260716124419), so returning it under any name
    // would publish the subject Supabase Auth mints tokens for. The membership id is the
    // only identifier either read emits.
    const FORBIDDEN = [
      /auth_user/i,
      /\buser_id\b/i,
      /profile_id/i,
      /\bpassword\b/i,
      /provider/i,
      /session/i,
      /\bjwt\b/i,
      /ip_address/i,
      /last_sign_in/i,
      /confirmed_at/i,
    ];

    for (const read of READS) {
      for (const column of outputColumns(read.name)) {
        for (const pattern of FORBIDDEN) {
          assert.ok(
            !pattern.test(column),
            `${read.name} must not return \`${column}\` — authentication metadata is not display data`,
          );
        }
      }
    }
  });

  test("23. no output column carries an invitation token, hash, or any invitation field", () => {
    // There are no Vendor user invitations in this schema at all (both invitation tables are
    // Retailer-scoped by trigger), so this is belt and braces rather than a live risk — but
    // it is the assertion that would fail first if a later edit tried to widen the list into
    // an invitation feed without designing the contract for it.
    const FORBIDDEN = [/token/i, /hash/i, /secret/i, /invitation/i, /invited_by/i, /expires_at/i];

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

    // And the bodies must not read the invitation tables either.
    for (const read of READS) {
      const body = statementFor(read.name);
      for (const table of [
        "retailer_invitations",
        "retailer_staff_invitations",
        "retailer_invitation_shop_assignments",
      ]) {
        assert.ok(
          !body.includes(table),
          `${read.name} must not read public.${table} — those are Retailer invitations and are not Vendor user state`,
        );
      }
    }
  });

  test("24. no output column carries permission internals or raw role identifiers", () => {
    for (const read of READS) {
      for (const column of outputColumns(read.name)) {
        assert.ok(
          !/permission/i.test(column),
          `${read.name} must not return \`${column}\` — authorization internals are not display data`,
        );
        assert.ok(
          !/role_id|role_code/i.test(column),
          `${read.name} must not return \`${column}\` — role NAMES are what a screen renders`,
        );
      }
      assert.ok(
        outputColumns(read.name).includes("role_names"),
        `${read.name} must return role_names`,
      );
    }
  });

  test("25. neither read returns a field the web Vendor Users page does not show", () => {
    // The milestone rule: email only if the existing Vendor Users UI already exposes it. It
    // does not — lib/members/vendor-organization-members.ts never queries auth.users and the
    // page renders name, membership status, profile status and role names only. mobile_number
    // is a private profile field the Vendor UI has never shown.
    for (const read of READS) {
      for (const column of outputColumns(read.name)) {
        assert.ok(
          !/email|mobile|phone|address/i.test(column),
          `${read.name} must not return \`${column}\` — the web Vendor Users page does not show it`,
        );
      }
    }
  });

  test("26. role_names is a typed text array that is never null", () => {
    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.match(
        statement,
        /role_names\s+text\[\]/i,
        `${read.name} must declare role_names as a typed text[] rather than json or a delimited string`,
      );
      assert.match(
        statement,
        /coalesce\s*\(\s*\(\s*select\s+array_agg[\s\S]*?'\{\}'::text\[\]\s*\)/i,
        `${read.name} must coalesce an absent role list to an EMPTY array — a client must never have to branch on null`,
      );
    }
  });
});

// ============================================================================
// Set-based aggregation — no N+1, no duplicated users, no default role
// ============================================================================
describe("mobile Vendor User reads — set-based aggregation", () => {
  test("27. roles are aggregated per membership, never joined into the row set", () => {
    // member_roles is keyed by (organization_member_id, role_id), so a membership may hold
    // several roles. A JOIN would emit one row per role and duplicate the user; a correlated
    // aggregate is evaluated once per membership and cannot.
    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.match(
        statement,
        /select\s+array_agg\s*\(\s*r\.name\s+order\s+by\s+r\.name\s*,\s*r\.id\s*\)/i,
        `${read.name} must aggregate role names with a deterministic, total ordering`,
      );
      assert.ok(
        !/\bjoin\s+public\.member_roles\s+mr\s+on\s+mr\.organization_member_id\s*=\s*m\.id/i.test(
          statement,
        ),
        `${read.name} must not join member_roles into the outer row set — that would duplicate a multi-role user`,
      );
      assert.ok(
        !/\bdistinct\b/i.test(statement),
        `${read.name} must not need DISTINCT — row multiplicity is fixed by the schema, and a DISTINCT would hide a genuine duplication bug`,
      );
    }
  });

  test("28. only ACTIVE role definitions are advertised, matching the web", () => {
    // lib/members/vendor-organization-members.ts filters `roles.status = 'ACTIVE'` and the
    // page renders "No active role" when nothing remains. Dropping that filter here would
    // make the two clients disagree about what a live role is.
    for (const read of READS) {
      assert.match(
        statementFor(read.name),
        /r\.status\s*=\s*'ACTIVE'/,
        `${read.name} must exclude INACTIVE role definitions from role_names`,
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
      assert.equal(
        permissionCalls.length,
        REQUIRED_PERMISSIONS.length,
        `${read.name} must check each permission exactly once, before the query rather than inside it`,
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
        `${read.name} must produce its result with a single statement, whatever the user count`,
      );
    }
  });

  test("31. the ordering is deterministic and total", () => {
    // Two users may legitimately share a display name; without a tie-break they could swap
    // places between requests and a paginated or re-fetched mobile list would flicker.
    assert.match(
      statementFor("list_vendor_users"),
      /order\s+by\s+u\.display_name\s*,\s*u\.membership_id\s*;/i,
      "list_vendor_users must order by display name then membership id",
    );
  });

  test("32. a missing role is never defaulted to anything", () => {
    // The rule that matters most in this whole file: an unknown or absent role must never be
    // reported as Vendor Super Admin, or as any other role.
    for (const read of READS) {
      const statement = statementFor(read.name);
      assert.ok(
        !/coalesce\s*\([^)]*'Vendor Super Admin'/i.test(statement),
        `${read.name} must not substitute a role name for an absent assignment`,
      );
      assert.ok(
        !/array\s*\[\s*'[^']+'\s*\]\s*::\s*text\[\]/i.test(statement),
        `${read.name} must not build a non-empty literal role array anywhere`,
      );
    }
  });
});

// ============================================================================
// Web compatibility
// ============================================================================
describe("mobile Vendor User reads — the web is untouched", () => {
  test("33. the existing Vendor Users data module still performs its own reads", () => {
    // This PR adds a shared contract; it does not migrate the web onto it. The visible
    // behaviour of /users must be byte-identical after this branch.
    const web = readFileSync(join(ROOT, "lib/members/vendor-organization-members.ts"), "utf8");

    assert.ok(
      !/list_vendor_users|get_vendor_user_detail/.test(web),
      "lib/members/vendor-organization-members.ts must not call the new RPCs in this milestone",
    );
    for (const table of ["organization_members", "profiles", "member_roles", "roles"]) {
      assert.ok(
        web.includes(`.from("${table}")`),
        `the web module must still read ${table} exactly as it did before`,
      );
    }
  });

  test("34. no Vendor user detail route is introduced by this milestone", () => {
    // The milestone is backend-only. There is no web user-detail page today and this branch
    // does not add one; the detail contract exists for Flutter.
    const usersRoute = readdirSync(join(ROOT, "app/(admin)/users"));
    assert.deepEqual(
      usersRoute.sort(),
      ["loading.tsx", "page.tsx"],
      "app/(admin)/users must still contain only the list page and its loading state",
    );
  });
});
