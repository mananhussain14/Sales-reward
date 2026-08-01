/**
 * STATIC CONTRACT GUARDS for the Vendor Product-to-Retailer ASSIGNMENT WRITE contract
 *
 *   public.assign_vendor_product_to_retailer(uuid, uuid)       [20260727210000 — REUSED AS-IS]
 *   public.unassign_vendor_product_from_retailer(uuid, uuid)   [20260727210000 — REUSED AS-IS]
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * ./vendor-product-writes-contract.test.ts and ./product-source-safety.test.ts. They read the
 * SQL and assert structural properties that a careless later edit could silently destroy.
 *
 * They do NOT execute the functions. The BEHAVIOURAL suite is
 *
 *     supabase/tests/database/vendor_product_assignment_writes_test.sql
 *
 * which signs in as eleven different callers, walks the whole eligibility matrix, proves the
 * audit row rolls back with its mutation, and proves the three canonical reads agree with the
 * table after every mutation. It requires Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of properties
 * that are cheap to assert on every `npm test` and expensive to notice once broken: that this
 * milestone added NO migration, that the two shipped functions were not edited, that no
 * caller-supplied tenant argument appeared, and that the web assignment surface is untouched.
 *
 * ============================================================================
 * THE AUDIT CONCLUSION THESE GUARDS ENCODE
 * ============================================================================
 * The mobile assignment-writes audit (docs/mobile-vendor-product-assignment-writes-audit.md)
 * found NO backend gap. The web assignment flow already goes
 *
 *     app/(admin)/products/[productId]/page.tsx
 *       -> app/(admin)/products/actions.ts        (Server Action, no table access)
 *       -> lib/products/vendor-products.ts        (one RPC per operation, caller's own token)
 *       -> public.assign_/unassign_vendor_product_…()
 *
 * with no direct table write, no service-role client, no caller-supplied Vendor id and no
 * TypeScript-only validation rule anywhere on the path. So the milestone adds a behavioural
 * specification and documentation, and changes no code. Several tests below are therefore
 * ABSENCE assertions — "no new migration exists", "the web module still calls exactly these
 * RPCs" — which is exactly what a no-gap outcome should be defended by.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");

/** The migration that DEFINES both assignment writes. Not modified by this milestone. */
const CATALOG_MIGRATION_NAME = "20260727210000_vendor_product_catalog_operations.sql";
/** The migration that defines the two tables, their constraints, indexes and triggers. */
const STORAGE_MIGRATION_NAME = "20260727090000_vendor_product_catalog_foundation.sql";
/**
 * The most recent migration this contract has been checked against.
 *
 * Bumped from 20260807090000 by the staff account-recovery milestone, which added
 * 20260808090000_repair_retailer_staff_registration_context.sql. That migration repairs
 * public.get_retailer_staff_registration_context and adds two staff-invitation helpers;
 * it touches no product table and neither assignment function, which rule 1 below now
 * asserts directly rather than inferring from "no migration exists at all".
 */
const LATEST_APPLIED_MIGRATION = "20260808090000_repair_retailer_staff_registration_context.sql";

const CATALOG_SQL = readFileSync(join(MIGRATIONS_DIR, CATALOG_MIGRATION_NAME), "utf8");
const STORAGE_SQL = readFileSync(join(MIGRATIONS_DIR, STORAGE_MIGRATION_NAME), "utf8");

const WEB_MODULE = readFileSync(join(ROOT, "lib/products/vendor-products.ts"), "utf8");
const WEB_ACTIONS = readFileSync(join(ROOT, "app/(admin)/products/actions.ts"), "utf8");
const WEB_PAGE = readFileSync(
  join(ROOT, "app/(admin)/products/[productId]/page.tsx"),
  "utf8",
);
const NORMALIZATION = readFileSync(join(ROOT, "lib/products/product-normalization.ts"), "utf8");

const PGTAP_NAME = "vendor_product_assignment_writes_test.sql";
const PGTAP_PATH = join(ROOT, "supabase/tests/database", PGTAP_NAME);
const PGTAP = readFileSync(PGTAP_PATH, "utf8");

const AUDIT_DOC_NAME = "mobile-vendor-product-assignment-writes-audit.md";

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose quotes the very patterns some of these tests forbid, and the
 * migration's own header discusses `delete`, `service_role` and `grant` at length while doing
 * none of them.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

/**
 * The TypeScript equivalent, so prose describing a rule cannot trip the rule it describes.
 * lib/products/vendor-products.ts documents "this module contains zero `.from(` calls" in a
 * comment — asserting against the raw text would fail on the sentence that states the
 * guarantee. Same idiom as ./product-source-safety.test.ts.
 */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const CATALOG_CODE = stripComments(CATALOG_SQL);
const STORAGE_CODE = stripComments(STORAGE_SQL);
const WEB_MODULE_CODE = stripTsComments(WEB_MODULE);
const WEB_ACTIONS_CODE = stripTsComments(WEB_ACTIONS);
const WEB_PAGE_CODE = stripTsComments(WEB_PAGE);
const NORMALIZATION_CODE = stripTsComments(NORMALIZATION);

/** The two assignment writes, and the exact signature each must keep. */
const ASSIGNMENT_WRITES = [
  {
    name: "assign_vendor_product_to_retailer",
    args: ["p_product_id", "p_retailer_organization_id"],
    types: ["uuid", "uuid"],
    returns: "void",
    permission: "PRODUCT_RETAILER_ASSIGN",
    action: "PRODUCT_ASSIGNED_TO_RETAILER",
  },
  {
    name: "unassign_vendor_product_from_retailer",
    args: ["p_product_id", "p_retailer_organization_id"],
    types: ["uuid", "uuid"],
    returns: "void",
    permission: "PRODUCT_RETAILER_ASSIGN",
    action: "PRODUCT_UNASSIGNED_FROM_RETAILER",
  },
] as const;

/**
 * One `create [or replace] function` statement, from its CREATE through the closing `$$;` of
 * its body. Everything asserted per-function is asserted against this slice rather than the
 * whole file, so a clause belonging to one function can never satisfy an assertion about
 * another.
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

function statementFor(name: string): string {
  return statementFrom(CATALOG_CODE, name);
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

/** Parameter NAMES, in declaration order. */
function parameterNames(statement: string, name: string): string[] {
  return parameterBlock(statement, name)
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((entry) => entry.length > 0);
}

/** Parameter TYPES, in declaration order, with any `default ...` clause discarded. */
function parameterTypes(statement: string, name: string): string[] {
  return parameterBlock(statement, name)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(/\s+default\s+/i)[0].trim().split(/\s+/).slice(1).join(" "));
}

// ============================================================================
// The milestone added no migration
// ============================================================================
describe("Vendor Product assignment writes — this milestone adds no migration", () => {
  const applied = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  test("1. no migration after the checked one redefines, drops or re-grants either assignment write", () => {
    // The audit found the two assignment writes already correct, so that milestone added
    // nothing to migrate. This remains the deliberate stop for anyone who changes them:
    // a later migration is allowed to exist — the schema keeps moving for other reasons —
    // but it must not redefine, drop, or re-grant either function without this contract
    // being re-checked and LATEST_APPLIED_MIGRATION bumped with a stated reason.
    //
    // ASSERTED AGAINST EXECUTABLE SQL, NOT AGAINST PROSE. This test used to reject any later
    // migration whose text merely CONTAINED one of these names, which made it impossible for
    // a neighbouring milestone to explain in a comment why it does NOT touch the assignment
    // path — the more careful the documentation, the louder this failed. Comments are stripped
    // first and the check is for the statements that could actually change the contract:
    // CREATE / CREATE OR REPLACE / DROP / ALTER on either function, GRANT or REVOKE on either,
    // and any DDL or write against the assignment table. Every real change is still caught;
    // a sentence about them no longer is.
    const newer = applied.filter((file) => file > LATEST_APPLIED_MIGRATION);
    const FUNCTIONS = [
      "assign_vendor_product_to_retailer",
      "unassign_vendor_product_from_retailer",
    ];

    for (const file of newer) {
      const code = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

      for (const fn of FUNCTIONS) {
        assert.ok(
          !new RegExp(
            `\\b(create|drop|alter)\\b[^;]*\\bfunction\\b[^;]*\\b${fn}\\b`,
            "i",
          ).test(code),
          `${file} redefines, drops or alters ${fn}; re-check this contract and bump LATEST_APPLIED_MIGRATION`,
        );
        assert.ok(
          !new RegExp(`\\b(grant|revoke)\\b[^;]*\\b${fn}\\b`, "i").test(code),
          `${file} re-grants or revokes ${fn}; re-check this contract and bump LATEST_APPLIED_MIGRATION`,
        );
      }

      // MATCHED ON THE STATEMENT'S TARGET, NOT ON A MENTION ANYWHERE IN IT.
      //
      // These patterns used to allow anything between the verb and the table name, which
      // made `insert into <other table> ... join vendor_product_retailer_assignments`
      // indistinguishable from a write TO the assignment table. A later milestone that
      // merely READS assignments — resolving campaign eligibility, for instance — would
      // fail this guard for doing exactly what it is supposed to do, while a genuine
      // write would fail it for the right reason, and the message could not tell them
      // apart.
      //
      // Anchoring the table name to the position a write target actually occupies keeps
      // every real change caught: `insert into [public.]vendor_product_retailer_assignments`,
      // `update [public.]vendor_product_retailer_assignments`, `delete from ...`, and any
      // DDL naming it. A join against it in some other statement's FROM clause no longer is.
      const TARGET = String.raw`(?:public\.)?vendor_product_retailer_assignments\b`;

      assert.ok(
        !new RegExp(
          String.raw`\b(create|drop|alter|truncate)\b[\w\s]*?\b${TARGET}`,
          "i",
        ).test(code) &&
          !new RegExp(String.raw`\binsert\s+into\s+${TARGET}`, "i").test(code) &&
          !new RegExp(String.raw`\bupdate\s+${TARGET}`, "i").test(code) &&
          !new RegExp(String.raw`\bdelete\s+from\s+${TARGET}`, "i").test(code),
        `${file} changes the assignment table or its rows; re-check this contract`,
      );
    }
  });

  test("2. every migration this contract depends on is still present, in order", () => {
    assert.ok(
      applied.includes(STORAGE_MIGRATION_NAME),
      "the assignment table's storage migration must exist",
    );
    assert.ok(
      applied.includes(CATALOG_MIGRATION_NAME),
      "the migration defining both assignment writes must exist",
    );
    assert.ok(
      applied.indexOf(STORAGE_MIGRATION_NAME) < applied.indexOf(CATALOG_MIGRATION_NAME),
      "the tables must be created before the functions that write them",
    );
    assert.ok(
      applied.indexOf(CATALOG_MIGRATION_NAME) < applied.indexOf(LATEST_APPLIED_MIGRATION),
      "and both must precede the latest applied migration",
    );
  });

  test("3. no historical migration was rewritten to mention this milestone", () => {
    // A repaired-in-place history is the one failure mode a forward-only migration discipline
    // cannot recover from. The two migrations this contract rests on predate the milestone, so
    // neither may name it.
    for (const [file, source] of [
      [STORAGE_MIGRATION_NAME, STORAGE_SQL],
      [CATALOG_MIGRATION_NAME, CATALOG_SQL],
    ] as const) {
      assert.ok(
        !/assignment[-\s]writes\s+milestone/i.test(source),
        `${file} must not have been edited to reference this milestone`,
      );
    }
  });
});

// ============================================================================
// The deployed contract is preserved exactly
// ============================================================================
describe("Vendor Product assignment writes — the deployed contract is preserved exactly", () => {
  test("4. both functions are still defined, exactly once, in the catalog migration", () => {
    for (const { name } of ASSIGNMENT_WRITES) {
      const definitions = CATALOG_CODE.match(
        new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "gi"),
      );
      assert.equal(definitions?.length, 1, `public.${name} must be defined exactly once`);
    }
  });

  test("5. neither is redefined, replaced or dropped by any later migration", () => {
    // A CREATE OR REPLACE in a later file would silently change what both clients call. The
    // whole repository is scanned, not just the two files this test already reads.
    const later = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && file > CATALOG_MIGRATION_NAME)
      .sort();

    for (const file of later) {
      const source = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      for (const { name } of ASSIGNMENT_WRITES) {
        assert.ok(
          !new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${name}\\b`, "i").test(
            source,
          ),
          `${file} must not redefine public.${name}`,
        );
        assert.ok(
          !new RegExp(`drop\\s+function\\s+(if\\s+exists\\s+)?public\\.${name}\\b`, "i").test(
            source,
          ),
          `${file} must not drop public.${name}`,
        );
        assert.ok(
          !new RegExp(`alter\\s+function\\s+public\\.${name}\\b`, "i").test(source),
          `${file} must not alter public.${name}`,
        );
      }
    }
  });

  test("6. the parameter names and order are the shipped ones", () => {
    // Supabase clients call an RPC by NAMED argument, so a renamed parameter is a silently
    // broken client even when the types still line up.
    for (const { name, args } of ASSIGNMENT_WRITES) {
      assert.deepEqual(parameterNames(statementFor(name), name), [...args]);
    }
  });

  test("7. the parameter types and order are the shipped ones", () => {
    for (const { name, types } of ASSIGNMENT_WRITES) {
      assert.deepEqual(parameterTypes(statementFor(name), name), [...types]);
    }
  });

  test("8. neither takes a defaulted argument", () => {
    for (const { name } of ASSIGNMENT_WRITES) {
      assert.ok(
        !/\bdefault\b/i.test(parameterBlock(statementFor(name), name)),
        `public.${name} must require both addresses — a defaulted one is a half-addressed write`,
      );
    }
  });

  test("9. both still return void", () => {
    // Deliberately not widened. Changing a return type requires DROP + CREATE, which would
    // break the web's calls and any pinned client. The consequence — a no-op is
    // indistinguishable from a change — is a documented limitation, and the canonical reads
    // are what a client refreshes from.
    for (const { name, returns } of ASSIGNMENT_WRITES) {
      assert.match(
        statementFor(name),
        new RegExp(`\\)\\s*returns\\s+${returns}\\b`, "i"),
        `public.${name} must return ${returns}`,
      );
    }
  });
});

// ============================================================================
// No caller-supplied identity or tenant
// ============================================================================
describe("Vendor Product assignment writes — no caller-supplied identity or tenant", () => {
  test("10. neither accepts an identity, tenant, role or permission argument", () => {
    const forbidden =
      /vendor|tenant|owner|user|profile|member|actor|role|permission|auth|uid|token|claim/i;
    for (const { name } of ASSIGNMENT_WRITES) {
      for (const parameter of parameterNames(statementFor(name), name)) {
        assert.ok(
          !forbidden.test(parameter),
          `public.${name} must not accept "${parameter}" — the Vendor is derived, never supplied`,
        );
      }
    }
  });

  test("11. neither accepts anything beyond the two opaque addresses", () => {
    // No status, no timestamp, no note, no effective-date range, no assignment id, no
    // relationship id, no idempotency key. Each of those would be a capability the product
    // does not have, invented at the contract layer.
    for (const { name, args } of ASSIGNMENT_WRITES) {
      assert.deepEqual(
        parameterNames(statementFor(name), name).filter((p) => !(args as readonly string[]).includes(p)),
        [],
        `public.${name} must accept the product id and the Retailer organization id, and nothing else`,
      );
    }
  });

  test("12. both derive the Vendor from get_vendor_super_admin_context(), lowest id first", () => {
    // The established pattern, reproduced rather than reimplemented. That context function
    // takes no arguments and filters on auth.uid() internally, so no call can nominate a
    // Vendor; the ORDER BY / LIMIT 1 is the shipped multi-Vendor tie-break.
    for (const { name } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      assert.match(
        statement,
        /from\s+public\.get_vendor_super_admin_context\(\)\s+ctx\s+order\s+by\s+ctx\.organization_id\s+limit\s+1/i,
        `public.${name} must derive the Vendor server-side with the shipped tie-break`,
      );
      assert.ok(
        !/get_vendor_super_admin_context\s*\(\s*[^)\s]/i.test(statement),
        `public.${name} must never pass an argument to the context function`,
      );
    }
  });

  test("13. the actor is auth.uid(), and comes from nowhere else", () => {
    for (const { name } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      assert.match(
        statement,
        /v_actor\s*:=\s*auth\.uid\(\)/i,
        `public.${name} must take the actor from auth.uid()`,
      );
      // The audit row's actor is that variable, never a parameter.
      assert.ok(
        !/actor_profile_id[^,)]*p_/i.test(statement),
        `public.${name} must not derive the audit actor from any parameter`,
      );
    }
  });

  test("14. both gate on PRODUCT_RETAILER_ASSIGN, and neither on PRODUCTS_MANAGE", () => {
    // The two permissions are genuinely distinct — pgTAP proves it by removing each seeded
    // mapping in turn. This guard stops a later edit from quietly collapsing them, which would
    // widen who can expose a catalogue to a Retailer.
    for (const { name, permission } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      assert.match(
        statement,
        new RegExp(`has_organization_permission\\(v_vendor,\\s*'${permission}'\\)`, "i"),
        `public.${name} must require ${permission}`,
      );
      assert.ok(
        !/PRODUCTS_MANAGE/i.test(statement),
        `public.${name} must not also require PRODUCTS_MANAGE — assignment is a separate capability`,
      );
    }
  });

  test("15. the caller-supplied product id is always paired with the derived Vendor", () => {
    // The two-column filter is the whole security boundary for an id that arrived from a
    // browser: an id belonging to another Vendor matches zero rows and can select nothing.
    for (const { name } of ASSIGNMENT_WRITES) {
      assert.match(
        statementFor(name),
        /where\s+id\s*=\s*p_product_id\s+and\s+vendor_organization_id\s*=\s*v_vendor/i,
        `public.${name} must match the product on its id AND the derived Vendor`,
      );
    }
  });

  test("16. the caller-supplied Retailer id is always paired with the derived Vendor", () => {
    for (const { name } of ASSIGNMENT_WRITES) {
      assert.match(
        statementFor(name),
        /vr\.vendor_organization_id\s*=\s*v_vendor\s+and\s+vr\.retailer_organization_id\s*=\s*p_retailer_organization_id/i,
        `public.${name} must reach a Retailer only through the derived Vendor's own relationship row`,
      );
    }
  });
});

// ============================================================================
// SQL hardening
// ============================================================================
describe("Vendor Product assignment writes — SQL hardening", () => {
  test("17. both are SECURITY DEFINER, VOLATILE, with an empty search_path", () => {
    for (const { name } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      assert.match(statement, /security\s+definer/i, `public.${name} must be SECURITY DEFINER`);
      assert.match(statement, /\bvolatile\b/i, `public.${name} must be VOLATILE`);
      assert.match(
        statement,
        /set\s+search_path\s*=\s*''/i,
        `public.${name} must run with an empty search_path`,
      );
      assert.ok(
        !/\bstable\b|\bimmutable\b/i.test(statement),
        `public.${name} writes, so it must not be declared STABLE or IMMUTABLE`,
      );
    }
  });

  test("18. every object reference is schema-qualified", () => {
    // An empty search_path makes this mandatory rather than stylistic: an unqualified name
    // would not resolve at all.
    // `(?![\w.])` after the captured name stops the engine backtracking to a shorter prefix:
    // without it, "public.vendor_products" matches with the capture "publi" and the assertion
    // fires on a reference that is in fact qualified.
    const REFERENCE = /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)(?![\w.])/gi;
    // The only bare identifiers a body may legitimately name are its own plpgsql variables.
    const LOCALS = ["v_product", "v_existing", "v_retailer_id", "v_retailer_name", "v_vendor"];

    for (const { name } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      for (const [, target] of statement.matchAll(REFERENCE)) {
        assert.ok(
          LOCALS.includes(target),
          `public.${name} references "${target}" unqualified — every table must be public.-qualified`,
        );
      }
      // And the qualification is genuinely there: every table this body touches is public.-prefixed.
      for (const table of [
        "vendor_products",
        "vendor_retailers",
        "vendor_product_retailer_assignments",
        "audit_logs",
      ]) {
        if (!new RegExp(`\\b${table}\\b`).test(statement)) continue;
        assert.ok(
          !new RegExp(`(?<!public\\.)\\b${table}\\b`).test(statement),
          `public.${name} must reference ${table} only as public.${table}`,
        );
      }
    }
  });

  test("19. neither contains dynamic SQL", () => {
    for (const { name } of ASSIGNMENT_WRITES) {
      assert.ok(
        !/\bexecute\s+(?:format|'|"|\w+\s*\|\|)/i.test(statementFor(name)),
        `public.${name} must not build SQL at runtime — a tenant predicate composed as text is a tenant predicate that can be lost`,
      );
    }
  });

  test("20. neither contains a DELETE or a TRUNCATE", () => {
    // Withdrawal is a status change. The pairing's history can never be destroyed by an
    // assign/withdraw cycle, and there is no hard deletion anywhere in this contract.
    for (const { name } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      assert.ok(
        !/\bdelete\s+from\b/i.test(statement),
        `public.${name} must not delete an assignment row — withdrawal sets INACTIVE`,
      );
      assert.ok(
        !/\btruncate\b/i.test(statement),
        `public.${name} must not truncate anything`,
      );
    }
  });

  test("21. the whole catalog migration grants nothing to anon or service_role", () => {
    assert.ok(
      !/grant\s+execute\s+on\s+function[\s\S]*?\bto\s+anon\b/i.test(CATALOG_CODE),
      "no product function may be granted to anon",
    );
    assert.ok(
      !/\bto\s+service_role\b/i.test(CATALOG_CODE),
      "no product function may be granted to service_role — all derive authority from auth.uid()",
    );
  });

  test("22. each write revokes PUBLIC and anon, and grants only authenticated", () => {
    for (const { name, types } of ASSIGNMENT_WRITES) {
      const signature = `public\\.${name}\\(${types.join(",\\s*")}\\)`;
      assert.match(
        CATALOG_CODE,
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${signature}\\s+from\\s+public`, "i"),
        `public.${name} must revoke all from PUBLIC`,
      );
      assert.match(
        CATALOG_CODE,
        new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+${signature}\\s+from\\s+anon`, "i"),
        `public.${name} must revoke execute from anon`,
      );
      assert.match(
        CATALOG_CODE,
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${signature}\\s+to\\s+authenticated`, "i"),
        `public.${name} must grant execute to authenticated`,
      );
    }
  });

  test("23. no broad table grant, and no RLS weakening, anywhere in the two migrations", () => {
    for (const [file, code] of [
      [STORAGE_MIGRATION_NAME, STORAGE_CODE],
      [CATALOG_MIGRATION_NAME, CATALOG_CODE],
    ] as const) {
      assert.ok(
        !/grant\s+(?:all|select|insert|update|delete)[\s\S]{0,80}?\bon\s+table\b/i.test(code),
        `${file} must not grant a table privilege to any role`,
      );
      assert.ok(
        !/disable\s+row\s+level\s+security/i.test(code),
        `${file} must not disable RLS`,
      );
      assert.ok(
        !/\bdrop\s+policy\b/i.test(code),
        `${file} must not drop a policy`,
      );
    }
  });

  test("24. both assignment tables stay default-deny with zero policies", () => {
    assert.match(
      STORAGE_CODE,
      /alter\s+table\s+public\.vendor_product_retailer_assignments\s+enable\s+row\s+level\s+security/i,
      "the assignment table must have RLS enabled",
    );
    assert.ok(
      !/create\s+policy/i.test(STORAGE_CODE) && !/create\s+policy/i.test(CATALOG_CODE),
      "neither migration may create a policy — the RPCs are the only way in, deliberately",
    );
    for (const role of ["public", "anon", "authenticated"]) {
      assert.match(
        STORAGE_CODE,
        new RegExp(
          `revoke\\s+all\\s+on\\s+table\\s+public\\.vendor_product_retailer_assignments\\s+from\\s+${role}`,
          "i",
        ),
        `the assignment table must revoke all from ${role}`,
      );
    }
  });

  test("25. the uniqueness authority is unconditional, and is the pairing", () => {
    // One row per (product, Retailer) FOR ALL TIME, not one per active pair. A partial index
    // would let a withdraw/re-insert cycle accumulate duplicate history rows.
    const index = STORAGE_CODE.match(
      /create\s+unique\s+index\s+vendor_product_retailer_assign_unique_idx[\s\S]*?;/i,
    )?.[0];
    assert.ok(index, "the assignment uniqueness index must exist");
    assert.match(
      index!,
      /\(\s*vendor_product_id\s*,\s*retailer_organization_id\s*\)/i,
      "the uniqueness scope must be exactly (vendor_product_id, retailer_organization_id)",
    );
    assert.ok(
      !/\bwhere\b/i.test(index!),
      "the index must be UNPARTIAL — a status-scoped uniqueness rule would permit duplicate history",
    );
  });
});

// ============================================================================
// The audit row is part of the same transaction
// ============================================================================
describe("Vendor Product assignment writes — the audit row is part of the same transaction", () => {
  test("26. each write inserts exactly one audit row, in its own body", () => {
    // One INSERT, inside the function, with no commit, no savepoint and no exception handler
    // wrapping it — which is what makes "the audit row rolls back with the mutation" true.
    for (const { name } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      const inserts = statement.match(/insert\s+into\s+public\.audit_logs/gi);
      assert.equal(inserts?.length, 1, `public.${name} must write exactly one audit row`);
      assert.ok(
        !/\bcommit\b|\bsavepoint\b|\bstart\s+transaction\b/i.test(statement),
        `public.${name} must not manage its own transaction boundary`,
      );
    }
  });

  test("27. the audit organization is the derived Vendor, never a parameter", () => {
    for (const { name } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      const values = statement.slice(statement.search(/insert\s+into\s+public\.audit_logs/i));
      assert.match(
        values,
        /organization_id,\s*actor_profile_id,\s*action,\s*entity_type,\s*entity_id,\s*metadata/i,
        `public.${name} must write the shipped audit column set`,
      );
      assert.match(
        values,
        /values\s*\(\s*\n?\s*v_vendor,\s*\n?\s*v_actor,/i,
        `public.${name} must audit against the derived Vendor and the auth.uid() actor`,
      );
    }
  });

  test("28. each write uses its own shipped action code and the shared entity type", () => {
    for (const { name, action } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      assert.match(
        statement,
        new RegExp(`'${action}'`),
        `public.${name} must write the ${action} action code`,
      );
      assert.match(
        statement,
        /'VENDOR_PRODUCT'/,
        `public.${name} must audit against the VENDOR_PRODUCT entity type`,
      );
    }
  });

  test("29. the audit metadata is a five-key display whitelist with no ids", () => {
    // Names travel; identifiers and authorization internals do not. A key that ended in _id
    // would put an opaque identifier into a screen that renders history as text.
    const expected = [
      "product_code",
      "product_name",
      "product_status",
      "retailer_name",
      "assignment_status",
    ];
    for (const { name } of ASSIGNMENT_WRITES) {
      const statement = statementFor(name);
      const metadata = statement.slice(statement.search(/jsonb_build_object/i));
      const keys = [...metadata.matchAll(/'([a-z_]+)'\s*,/g)].map((m) => m[1]);
      assert.deepEqual(
        [...keys].sort(),
        [...expected].sort(),
        `public.${name} must carry exactly the five whitelisted metadata keys`,
      );
      for (const key of keys) {
        assert.ok(
          !/_id$|^id$|organization|profile|member|role|permission|token|email|phone/.test(key),
          `public.${name} must not put "${key}" into audit metadata`,
        );
      }
    }
  });

  test("30. neither action code is new — the shipped audit vocabulary did not grow", () => {
    // Both codes are already in the set the mobile Audit Logs contract documents, so no client
    // needs a new label and the neutral-humanization fallback is never reached for them.
    const auditReads = readFileSync(
      join(MIGRATIONS_DIR, "20260804090000_mobile_vendor_audit_log_reads.sql"),
      "utf8",
    );
    for (const { action } of ASSIGNMENT_WRITES) {
      assert.ok(
        auditReads.includes(action),
        `${action} must already be recorded in the shipped audit-log read vocabulary`,
      );
    }
  });
});

// ============================================================================
// Eligibility and history live in SQL, not in TypeScript
// ============================================================================
describe("Vendor Product assignment writes — every rule a client could bypass is in SQL", () => {
  test("31. assignment requires an ACTIVE product, relationship and Retailer organization", () => {
    const assign = statementFor("assign_vendor_product_to_retailer");
    assert.match(
      assign,
      /if\s+v_product\.status\s*<>\s*'ACTIVE'\s+then/i,
      "assign must refuse an inactive product in SQL",
    );
    assert.match(
      assign,
      /vr\.status\s*=\s*'ACTIVE'/i,
      "assign must require an ACTIVE relationship in SQL",
    );
    assert.match(
      assign,
      /o\.status\s*=\s*'ACTIVE'/i,
      "assign must require an ACTIVE Retailer organization in SQL",
    );
    assert.match(
      assign,
      /o\.organization_type\s*=\s*'RETAILER'/i,
      "and must require the target to actually be a RETAILER organization",
    );
  });

  test("32. withdrawal requires none of those three, deliberately", () => {
    // A Vendor must be able to withdraw a product from a Retailer it has since suspended,
    // which is exactly when withdrawal matters most. Adding a status gate here would strand
    // historical assignments as un-endable.
    const unassign = statementFor("unassign_vendor_product_from_retailer");
    assert.ok(
      !/v_product\.status\s*<>\s*'ACTIVE'/i.test(unassign),
      "withdrawal must not gate on product status",
    );
    assert.ok(
      !/vr\.status\s*=\s*'ACTIVE'/i.test(unassign),
      "withdrawal must not gate on relationship status",
    );
    assert.ok(
      !/o\.status\s*=\s*'ACTIVE'/i.test(unassign),
      "withdrawal must not gate on Retailer organization status",
    );
    // It must still prove the relationship EXISTS, so a Vendor cannot poke at another
    // Vendor's Retailers.
    assert.match(
      unassign,
      /from\s+public\.vendor_retailers\s+vr/i,
      "withdrawal must still reach the Retailer only through this Vendor's own relationship",
    );
  });

  test("33. create and reactivate are ONE operation, reusing the same row", () => {
    const assign = statementFor("assign_vendor_product_to_retailer");
    assert.match(
      assign,
      /if\s+v_existing\.id\s+is\s+not\s+null\s+then/i,
      "assign must branch on whether the pairing already has a row",
    );
    assert.match(
      assign,
      /update\s+public\.vendor_product_retailer_assignments\s+set\s+status\s*=\s*'ACTIVE'/i,
      "an existing INACTIVE row must be flipped back rather than duplicated",
    );
    assert.match(
      assign,
      /if\s+v_existing\.status\s*=\s*'ACTIVE'\s+then\s+return;/i,
      "and an already-ACTIVE pairing must be a silent no-op — no write, no audit row",
    );
  });

  test("34. withdrawal is a status change and a silent no-op when nothing changes", () => {
    const unassign = statementFor("unassign_vendor_product_from_retailer");
    assert.match(
      unassign,
      /if\s+v_existing\.id\s+is\s+null\s+or\s+v_existing\.status\s*=\s*'INACTIVE'\s+then\s+return;/i,
      "withdrawing an absent or already-withdrawn pairing must write and audit nothing",
    );
    assert.match(
      unassign,
      /update\s+public\.vendor_product_retailer_assignments\s+set\s+status\s*=\s*'INACTIVE'/i,
      "and a real withdrawal must set the status rather than remove the row",
    );
  });

  test("35. both writes lock before they decide", () => {
    // assign takes FOR UPDATE on the product before anything else, so two concurrent
    // assignments of one product serialize; both then lock the assignment row, which orders an
    // assign against a withdraw. The four real races are recorded in the audit document.
    assert.match(
      statementFor("assign_vendor_product_to_retailer"),
      /from\s+public\.vendor_products[\s\S]{0,120}?for\s+update/i,
      "assign must lock the product row FOR UPDATE",
    );
    for (const { name } of ASSIGNMENT_WRITES) {
      assert.match(
        statementFor(name),
        /from\s+public\.vendor_product_retailer_assignments[\s\S]{0,160}?for\s+update/i,
        `public.${name} must lock the existing assignment row FOR UPDATE`,
      );
    }
  });

  test("36. the unique index is caught and reported safely, never raised raw", () => {
    const assign = statementFor("assign_vendor_product_to_retailer");
    assert.match(
      assign,
      /exception\s+when\s+unique_violation\s+then/i,
      "assign must catch the unique violation rather than let PostgreSQL's own text escape",
    );
    const handler = assign.slice(assign.search(/exception\s+when\s+unique_violation/i));
    assert.ok(
      !/vendor_product_retailer_assign_unique_idx/i.test(handler),
      "and its message must not name the index",
    );
  });

  test("37. no assignment rule is enforced only in TypeScript", () => {
    // canAssignToRetailer() disables a button; it does not decide anything. The web module and
    // the Server Action must contain no status literal that would constitute a second, bypassable
    // definition of eligibility — and the one helper that does name statuses must be documented
    // as mirroring SQL rather than replacing it.
    assert.ok(
      !/ACTIVE|INACTIVE|SUSPENDED|DEACTIVATED/.test(
        WEB_MODULE_CODE.replace(/"ACTIVE"\s*\|\s*"INACTIVE"/g, ""),
      ),
      "lib/products/vendor-products.ts must not encode an assignment eligibility rule",
    );
    assert.match(
      NORMALIZATION,
      /Mirrors assign_vendor_product_to_retailer's own rule/,
      "canAssignToRetailer must document that SQL is the authority it mirrors",
    );
    assert.match(
      NORMALIZATION_CODE,
      /export function canAssignToRetailer/,
      "and must remain a pure predicate over already-fetched rows",
    );
  });
});

// ============================================================================
// The web implementation is untouched
// ============================================================================
describe("Vendor Product assignment writes — the web implementation is untouched", () => {
  test("38. the web calls exactly the two shipped RPCs, by name", () => {
    assert.match(
      WEB_MODULE_CODE,
      /const ASSIGN_RPC = "assign_vendor_product_to_retailer" as const;/,
      "the web must call the shipped assign RPC",
    );
    assert.match(
      WEB_MODULE_CODE,
      /const UNASSIGN_RPC = "unassign_vendor_product_from_retailer" as const;/,
      "and the shipped withdrawal RPC",
    );
    assert.match(
      WEB_MODULE_CODE,
      /const LIST_ASSIGNMENTS_RPC = "list_vendor_product_retailer_assignments" as const;/,
      "and must still read its editor matrix from the unchanged editor RPC",
    );
  });

  test("39. the web passes exactly the two addresses, and no tenant id", () => {
    for (const rpc of ["ASSIGN_RPC", "UNASSIGN_RPC"]) {
      const call = WEB_MODULE_CODE.slice(WEB_MODULE_CODE.indexOf(`runWrite(${rpc},`));
      const params = call.slice(0, call.indexOf("}"));
      assert.match(params, /p_product_id:/, `${rpc} must pass p_product_id`);
      assert.match(
        params,
        /p_retailer_organization_id:/,
        `${rpc} must pass p_retailer_organization_id`,
      );
      assert.ok(
        !/organization_id:\s*\w*vendor/i.test(params) && !/p_vendor|tenant|actor|profile/i.test(params),
        `${rpc} must not pass a Vendor, tenant, actor or profile id`,
      );
    }
  });

  test("40. no direct table access and no service-role client on the assignment path", () => {
    for (const [file, code] of [
      ["lib/products/vendor-products.ts", WEB_MODULE_CODE],
      ["app/(admin)/products/actions.ts", WEB_ACTIONS_CODE],
      ["app/(admin)/products/[productId]/page.tsx", WEB_PAGE_CODE],
    ] as const) {
      assert.ok(!/\.from\(/.test(code), `${file} must contain no direct table access`);
      assert.ok(
        !/service_role|SERVICE_ROLE|serviceRole|SECRET_KEY/.test(code),
        `${file} must not construct or reference a service-role client`,
      );
    }
  });

  test("41. the Server Action re-checks access and revalidates the shipped paths", () => {
    for (const action of ["assignProductAction", "unassignProductAction"]) {
      const body = WEB_ACTIONS_CODE.slice(
        WEB_ACTIONS_CODE.indexOf(`export async function ${action}`),
      ).split("\n}\n")[0];
      assert.match(body, /await requireVendorAdmin\(\);/, `${action} must re-resolve access`);
      assert.match(
        body,
        /revalidatePath\(PRODUCTS_PATH\)/,
        `${action} must revalidate the catalogue`,
      );
      assert.match(
        body,
        /revalidatePath\(`\$\{PRODUCTS_PATH\}\/\$\{productId\}`\)/,
        `${action} must revalidate the product detail path`,
      );
    }
  });

  test("42. the visible web assignment surface is unchanged", () => {
    // The milestone is backend-only. These are the exact strings the operator reads; a change
    // to any of them would be a visible product change smuggled in with a test-and-docs PR.
    assert.match(WEB_PAGE, /Retailer assignments/, "the section heading is unchanged");
    assert.match(
      WEB_PAGE,
      /Assigned Retailers see this product while it is active\. Withdrawing keeps the record and can be reversed\./,
      "the section description is unchanged",
    );
    assert.match(WEB_PAGE, /Not assigned/, "the unassigned label is unchanged");
    assert.match(WEB_ACTIONS, /"Product assigned\."/, "the assign confirmation is unchanged");
    assert.match(WEB_ACTIONS, /"Product withdrawn\."/, "the withdrawal confirmation is unchanged");
    assert.match(
      WEB_ACTIONS,
      /"Activate this product before assigning it to a Retailer\."/,
      "the inactive-product message is unchanged",
    );
  });

  test("43. withdrawal is never labelled deletion", () => {
    // The row survives; calling it "delete" or "remove" in the UI would misrepresent what the
    // database does and what the audit trail will show.
    for (const [file, source] of [
      ["app/(admin)/products/[productId]/page.tsx", WEB_PAGE],
      ["app/(admin)/products/actions.ts", WEB_ACTIONS],
    ] as const) {
      assert.ok(
        !/\b(Delete|Remove|Deleted|Removed)\b[^\n]{0,40}\b(assignment|Retailer)\b/i.test(source),
        `${file} must not describe withdrawal as deletion or removal`,
      );
    }
  });
});

// ============================================================================
// The behavioural suite exists and covers what this file cannot
// ============================================================================
describe("Vendor Product assignment writes — the behavioural suite is present", () => {
  test("44. the pgTAP suite exists, is transactional, and rolls back", () => {
    assert.match(PGTAP, /^begin;/m, "the suite must open a transaction");
    assert.match(PGTAP, /^rollback;/m, "and roll it back, so no fixture survives");
    assert.match(PGTAP, /select no_plan\(\);/, "and use no_plan()");
  });

  test("45. it specifies both functions by name", () => {
    for (const { name } of ASSIGNMENT_WRITES) {
      assert.ok(PGTAP.includes(name), `the pgTAP suite must exercise public.${name}`);
    }
  });

  test("46. it covers the claims this file cannot make statically", () => {
    // Each entry is a behaviour only a running database can demonstrate. Naming them here
    // means deleting a section from the pgTAP file breaks `npm test`, not just `supabase test db`.
    const required = [
      "a signed-out caller cannot assign",
      "a Retailer Owner cannot assign",
      "a Sales Staff member cannot assign",
      "without PRODUCT_RETAILER_ASSIGN, assigning is refused",
      "PRODUCT_RETAILER_ASSIGN alone is sufficient to assign",
      // Doubled apostrophe: the claim lives inside a single-quoted SQL string literal.
      "Vendor A cannot assign Vendor B''s product",
      "a foreign product and a nonexistent product are refused with the SAME message",
      "an INACTIVE product cannot receive a NEW assignment",
      "a product CAN be withdrawn from a SUSPENDED relationship",
      "the row survives withdrawal",
      "reactivation RESETS assigned_at to now()",
      "withdrawal PRESERVES assigned_at",
      "AND NO ASSIGNMENT ROW SURVIVES",
      "the withdrawn assignment is STILL LISTED",
      "not one duplicate (product, Retailer) pairing exists",
    ];
    for (const claim of required) {
      assert.ok(
        PGTAP.includes(claim),
        `the pgTAP suite must still assert: "${claim}"`,
      );
    }
  });

  test("47. the audit document exists and records the no-migration decision", () => {
    const docs = readdirSync(join(ROOT, "docs"));
    assert.ok(docs.includes(AUDIT_DOC_NAME), `docs/${AUDIT_DOC_NAME} must exist`);
    const doc = readFileSync(join(ROOT, "docs", AUDIT_DOC_NAME), "utf8");
    for (const { name } of ASSIGNMENT_WRITES) {
      assert.ok(doc.includes(name), `the audit document must name public.${name}`);
    }
    assert.match(
      doc,
      /No migration|no migration/,
      "the audit document must record that no migration was added",
    );
  });
});
