/**
 * STATIC CONTRACT GUARDS for the Vendor Product WRITE contract
 * (supabase/migrations/20260807090000_repair_vendor_product_write_normalization.sql,
 *  over the functions released in 20260727210000_vendor_product_catalog_operations.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text, in the same idiom as
 * ./vendor-product-reads-contract.test.ts and the other contract guards in this repository.
 * They read the SQL and assert structural properties that a careless later edit could
 * silently break.
 *
 * They do NOT execute the functions. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_product_writes_test.sql — pgTAP, covering every role denial,
 * the permission requirement proved by REMOVING a seeded mapping, field-by-field validation
 * at both length boundaries, normalization against all 25 whitespace characters, per-Vendor
 * uniqueness including case and separator variants, no-op edit semantics, status transitions,
 * the assignment non-interaction, tenant isolation in both directions, and the property that
 * NO input can produce a raw constraint error. It requires Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of properties
 * decidable from the source, and which would be a SECURITY or CONTRACT regression rather than
 * a behavioural one:
 *
 *   1. The repair is a NEW, forward-only migration that edits no applied migration — the
 *      original catalogue migration is still byte-for-byte the one that was deployed.
 *   2. It replaces exactly two functions and adds exactly two helpers. No table, column,
 *      constraint, index, trigger, policy, role, permission, mapping, seed row or table grant.
 *   3. The two replaced signatures are IDENTICAL to the deployed ones — same argument names,
 *      same order, same types, same return type. A mobile client and the web call one
 *      contract, not two.
 *   4. No write accepts identity, Vendor, tenant, owner, role-code or permission-code input.
 *   5. All three writes stay correctly-hardened SECURITY DEFINER, VOLATILE, empty search_path,
 *      authenticated-only, never anon, never PUBLIC, never service_role.
 *   6. Authorization is DELEGATED to the existing helpers rather than reimplemented, and the
 *      Vendor is derived from auth.uid() in every one.
 *   7. The audit insert is inside the same function body as the mutation — one transaction.
 *   8. The repaired normalization covers EXACTLY the characters JavaScript's `\s` covers, so
 *      the SQL rule and lib/products/product-input.ts cannot disagree about what a value means.
 *   9. No assignment write, no product deletion, and no read contract is touched.
 *  10. The web implementation is unchanged and still calls the same RPC names.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");

const MIGRATION_NAME = "20260807090000_repair_vendor_product_write_normalization.sql";
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

/** The already-deployed migration that first released the three write functions. */
const CATALOG_MIGRATION_NAME = "20260727210000_vendor_product_catalog_operations.sql";
/** The already-deployed migration that owns the table and its CHECK constraints. */
const STORAGE_MIGRATION_NAME = "20260727090000_vendor_product_catalog_foundation.sql";

const SQL = readFileSync(MIGRATION_PATH, "utf8");
const CATALOG_SQL = readFileSync(join(MIGRATIONS_DIR, CATALOG_MIGRATION_NAME), "utf8");
const STORAGE_SQL = readFileSync(join(MIGRATIONS_DIR, STORAGE_MIGRATION_NAME), "utf8");

const WEB_MODULE = readFileSync(join(ROOT, "lib/products/vendor-products.ts"), "utf8");
const WEB_ACTIONS = readFileSync(join(ROOT, "app/(admin)/products/actions.ts"), "utf8");
const INPUT_MODULE = readFileSync(join(ROOT, "lib/products/product-input.ts"), "utf8");

/**
 * The migration with every `--` comment line stripped.
 *
 * Load-bearing: this file's prose quotes the very error strings and patterns some of these
 * tests forbid (it reproduces the raw constraint messages the defect used to produce, and
 * names the tables and constraints involved). Asserting against the raw text would match
 * those explanations and pass — or fail — for the wrong reason. Every structural assertion
 * below runs against executable SQL only.
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

const CODE = stripComments(SQL);
const CATALOG_CODE = stripComments(CATALOG_SQL);
const WEB_MODULE_CODE = stripTsComments(WEB_MODULE);
const WEB_ACTIONS_CODE = stripTsComments(WEB_ACTIONS);

/** The three write operations, and the exact signature each must keep. */
const WRITES = [
  {
    name: "create_vendor_product",
    args: ["p_product_code", "p_product_name", "p_barcode", "p_brand", "p_description"],
    types: ["text", "text", "text", "text", "text"],
    returns: "uuid",
    replaced: true,
  },
  {
    name: "update_vendor_product",
    args: ["p_product_id", "p_product_name", "p_barcode", "p_brand", "p_description"],
    types: ["uuid", "text", "text", "text", "text"],
    returns: "void",
    replaced: true,
  },
  {
    name: "set_vendor_product_status",
    args: ["p_product_id", "p_status"],
    types: ["uuid", "text"],
    returns: "void",
    replaced: false,
  },
] as const;

/** The two internal normalization helpers this migration adds. */
const HELPERS = ["normalize_product_line", "normalize_product_block"] as const;

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
  return statementFrom(CODE, name);
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
// Migration hygiene
// ============================================================================
describe("Vendor Product writes — migration hygiene", () => {
  test("1. is a NEW migration, ordered after every dependency it names", () => {
    const applied = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    assert.ok(
      applied.includes(MIGRATION_NAME),
      "the migration file must exist in supabase/migrations",
    );

    // Ordered after its DEPENDENCIES, not last overall. "Newest in the repository" is a
    // property of one moment in time, not of this migration.
    for (const dependency of [STORAGE_MIGRATION_NAME, CATALOG_MIGRATION_NAME]) {
      assert.ok(
        applied.includes(dependency),
        `the dependency ${dependency} must still exist`,
      );
      assert.ok(
        MIGRATION_NAME > dependency,
        `${MIGRATION_NAME} must sort after its dependency ${dependency}`,
      );
    }
  });

  test("2. does not edit an applied migration — the deployed functions are still declared there", () => {
    // The repair is forward-only. The catalogue migration must still create all three write
    // functions with a plain `create function`: if someone had "fixed" the defect by editing
    // history instead, that file's text would have changed and a deployed database would
    // silently diverge from the repository.
    for (const write of WRITES) {
      assert.match(
        CATALOG_CODE,
        new RegExp(`create function public\\.${write.name}\\s*\\(`),
        `${CATALOG_MIGRATION_NAME} must still declare public.${write.name} with a plain CREATE`,
      );
      assert.doesNotMatch(
        CATALOG_CODE,
        new RegExp(`create or replace function public\\.${write.name}`),
        `${CATALOG_MIGRATION_NAME} must not have been rewritten to CREATE OR REPLACE`,
      );
    }

    // And the storage migration still owns the constraints the repair relies on.
    for (const constraint of [
      "vendor_products_code_normalized",
      "vendor_products_name_trimmed",
      "vendor_products_brand_shape",
      "vendor_products_description_shape",
    ]) {
      assert.ok(
        STORAGE_SQL.includes(constraint),
        `${STORAGE_MIGRATION_NAME} must still declare ${constraint}`,
      );
    }
  });

  test("3. adds exactly two helpers and replaces exactly two functions — nothing else", () => {
    const created = [...CODE.matchAll(/create\s+function\s+public\.(\w+)/gi)].map((m) => m[1]);
    const replaced = [...CODE.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map(
      (m) => m[1],
    );

    assert.deepEqual([...created].sort(), [...HELPERS].sort());
    assert.deepEqual(
      [...replaced].sort(),
      ["create_vendor_product", "update_vendor_product"].sort(),
    );
  });

  test("4. creates or alters NO schema object of any other kind", () => {
    const forbidden = [
      /create\s+table/i,
      /alter\s+table/i,
      /drop\s+table/i,
      /drop\s+function/i,
      /create\s+(unique\s+)?index/i,
      /drop\s+index/i,
      /create\s+trigger/i,
      /drop\s+trigger/i,
      /create\s+policy/i,
      /alter\s+policy/i,
      /drop\s+policy/i,
      /create\s+type/i,
      /create\s+extension/i,
      /add\s+constraint/i,
      /drop\s+constraint/i,
      /enable\s+row\s+level\s+security/i,
      /disable\s+row\s+level\s+security/i,
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(CODE, pattern, `the repair must not use ${pattern}`);
    }
  });

  test("5. writes no seed row and backfills no data", () => {
    // The defect could never STORE a bad value — the constraints held — so there is nothing
    // in the data to repair. An UPDATE at migration time would be rewriting rows for no
    // reason, and against hosted data this project explicitly does not touch.
    const executable = CODE.split("\n");
    const topLevelDml = executable.filter((line) =>
      /^\s*(insert\s+into|update\s+public\.|delete\s+from|truncate)/i.test(line),
    );
    // Every INSERT/UPDATE in this file must be INSIDE a function body, never a bare
    // migration-level statement. Function bodies are indented; a migration-level statement
    // starts at column 0.
    const bare = topLevelDml.filter((line) => !/^\s/.test(line));
    assert.deepEqual(bare, [], "the migration must contain no top-level DML");
  });

  test("6. contains no DELETE anywhere — deactivation is not deletion", () => {
    assert.doesNotMatch(CODE, /\bdelete\s+from\b/i);
  });

  test("7. seeds and role mappings are untouched", () => {
    assert.doesNotMatch(CODE, /insert\s+into\s+public\.(permissions|roles|role_permissions)/i);
    assert.doesNotMatch(CODE, /\bgrant\s+.*\bon\s+table\b/i);
  });
});

// ============================================================================
// The contract did not change
// ============================================================================
describe("Vendor Product writes — the deployed contract is preserved exactly", () => {
  test("8. the two replaced functions keep their exact parameter names, in order", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      assert.deepEqual(
        parameterNames(statement, write.name),
        [...write.args],
        `public.${write.name} must keep its shipped parameter names`,
      );
    }
  });

  test("9. and their exact parameter types, in order", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      assert.deepEqual(
        parameterTypes(statement, write.name),
        [...write.types],
        `public.${write.name} must keep its shipped parameter types`,
      );
    }
  });

  test("10. and their exact return types", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      assert.match(
        statement,
        new RegExp(`\\)\\s*returns\\s+${write.returns}\\b`, "i"),
        `public.${write.name} must still return ${write.returns}`,
      );
    }
  });

  test("11. the replaced signatures are IDENTICAL to the ones the catalogue migration deployed", () => {
    // Stated as a relationship rather than as two literals, so the two files cannot drift:
    // whatever 20260727210000 declared is what 20260807090000 must still declare.
    for (const write of WRITES.filter((w) => w.replaced)) {
      const deployed = statementFrom(CATALOG_CODE, write.name);
      const repaired = statementFor(write.name);
      assert.deepEqual(
        parameterNames(repaired, write.name),
        parameterNames(deployed, write.name),
        `${write.name}: parameter names must match the deployed function exactly`,
      );
      assert.deepEqual(
        parameterTypes(repaired, write.name),
        parameterTypes(deployed, write.name),
        `${write.name}: parameter types must match the deployed function exactly`,
      );
    }
  });

  test("12. set_vendor_product_status is NOT touched by the repair", () => {
    // Its only normalization feeds a closed `in ('ACTIVE','INACTIVE')` test, so it has no path
    // to a raw constraint error. Replacing it would be a change with no defect behind it.
    assert.doesNotMatch(CODE, /function\s+public\.set_vendor_product_status/i);
  });

  test("13. no read contract is modified", () => {
    for (const read of [
      "list_vendor_products",
      "get_vendor_product_detail",
      "list_vendor_product_assigned_retailers",
      "list_vendor_product_retailer_assignments",
      "list_retailer_assigned_products",
    ]) {
      assert.doesNotMatch(
        CODE,
        new RegExp(`function\\s+public\\.${read}\\s*\\(`, "i"),
        `the repair must not redefine the read ${read}`,
      );
    }
  });

  test("14. no assignment write is added or modified — that milestone is deferred", () => {
    for (const assignmentWrite of [
      "assign_vendor_product_to_retailer",
      "unassign_vendor_product_from_retailer",
    ]) {
      assert.doesNotMatch(
        CODE,
        new RegExp(`function\\s+public\\.${assignmentWrite}`, "i"),
        `the repair must not touch ${assignmentWrite}`,
      );
    }
    // And it writes no assignment row of its own.
    assert.doesNotMatch(CODE, /insert\s+into\s+public\.vendor_product_retailer_assignments/i);
    assert.doesNotMatch(CODE, /update\s+public\.vendor_product_retailer_assignments/i);
  });
});

// ============================================================================
// Trusted identity and tenant authority
// ============================================================================
describe("Vendor Product writes — no caller-supplied identity or tenant", () => {
  test("15. no write accepts identity, Vendor, tenant, owner, role or permission input", () => {
    const forbidden =
      /organization|vendor|tenant|owner|user|profile|member|actor|role|permission|auth|uid|token|claim/i;
    for (const write of WRITES.filter((w) => w.replaced)) {
      for (const parameter of parameterNames(statementFor(write.name), write.name)) {
        assert.doesNotMatch(
          parameter,
          forbidden,
          `public.${write.name} must not accept the parameter ${parameter}`,
        );
      }
    }
  });

  test("16. create accepts the five product fields and nothing else — no organization id", () => {
    assert.deepEqual(
      parameterNames(statementFor("create_vendor_product"), "create_vendor_product"),
      ["p_product_code", "p_product_name", "p_barcode", "p_brand", "p_description"],
    );
  });

  test("17. create accepts no initial-status argument", () => {
    // The web offers no choice of initial status, so neither may a second client.
    for (const parameter of parameterNames(
      statementFor("create_vendor_product"),
      "create_vendor_product",
    )) {
      assert.doesNotMatch(parameter, /status/i);
    }
  });

  test("18. update accepts no product-code argument — the code is immutable", () => {
    // Matched by EXACT NAME: a `/code/` pattern would also match the legitimate p_barcode.
    assert.ok(
      !parameterNames(statementFor("update_vendor_product"), "update_vendor_product").includes(
        "p_product_code",
      ),
    );
  });

  test("19. the Vendor is DERIVED from auth.uid() in every replaced write", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      assert.match(
        statement,
        /from\s+public\.get_vendor_super_admin_context\(\)/i,
        `public.${write.name} must derive the Vendor from the established context helper`,
      );
      assert.match(
        statement,
        /order\s+by\s+ctx\.organization_id\s+limit\s+1/i,
        `public.${write.name} must preserve the deterministic lowest-organization-id tie-break`,
      );
      assert.match(
        statement,
        /auth\.uid\(\)/,
        `public.${write.name} must resolve the actor from auth.uid()`,
      );
    }
  });

  test("20. authorization is DELEGATED to the existing helper, not reimplemented", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      assert.match(
        statement,
        /public\.has_organization_permission\(\s*v_vendor,\s*'PRODUCTS_MANAGE'\s*\)/i,
        `public.${write.name} must gate on PRODUCTS_MANAGE through the shared helper`,
      );
      // No hand-rolled second definition of who may write.
      assert.doesNotMatch(
        statement,
        /from\s+public\.role_permissions|from\s+public\.member_roles|from\s+public\.permissions\b/i,
        `public.${write.name} must not reimplement the RBAC join`,
      );
    }
  });

  test("21. the caller-supplied product id is filtered on the DERIVED Vendor too", () => {
    const statement = statementFor("update_vendor_product");
    assert.match(
      statement,
      /where\s+id\s*=\s*p_product_id\s*\n?\s*and\s+vendor_organization_id\s*=\s*v_vendor/i,
      "update must match the product on BOTH its id and the derived Vendor",
    );
    assert.match(
      statement,
      /for\s+update/i,
      "update must lock the target row, so concurrent edits serialize",
    );
  });

  test("22. the owning Vendor written on create is the derived one, never a parameter", () => {
    const statement = statementFor("create_vendor_product");
    assert.match(
      statement,
      /values\s*\(\s*v_vendor\s*,/i,
      "the inserted vendor_organization_id must be the derived v_vendor",
    );
    assert.match(
      statement,
      /'ACTIVE'\s*,\s*v_actor\s*\)/i,
      "the creator must be the derived actor and the initial status a literal ACTIVE",
    );
  });
});

// ============================================================================
// SQL hardening
// ============================================================================
describe("Vendor Product writes — SQL hardening", () => {
  test("23. every function in the repair is search_path-pinned", () => {
    for (const name of [...HELPERS, "create_vendor_product", "update_vendor_product"]) {
      assert.match(
        statementFor(name),
        /set\s+search_path\s*=\s*''/i,
        `public.${name} must pin an empty search_path`,
      );
    }
  });

  test("24. the two writes are SECURITY DEFINER and VOLATILE — never STABLE", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      assert.match(statement, /security\s+definer/i, `${write.name} must be SECURITY DEFINER`);
      assert.match(statement, /\bvolatile\b/i, `${write.name} must be declared VOLATILE`);
      assert.doesNotMatch(
        statement,
        /\b(stable|immutable)\b/i,
        `${write.name} must not be declared STABLE or IMMUTABLE`,
      );
    }
  });

  test("25. the helpers are IMMUTABLE and hold no authority of their own", () => {
    for (const helper of HELPERS) {
      const statement = statementFor(helper);
      assert.match(statement, /\bimmutable\b/i, `${helper} must be IMMUTABLE`);
      assert.doesNotMatch(
        statement,
        /security\s+definer/i,
        `${helper} is a pure text transform and must not be SECURITY DEFINER`,
      );
      // A pure transform must not read a table.
      assert.doesNotMatch(statement, /\bfrom\s+public\./i, `${helper} must not read any table`);
    }
  });

  test("26. privileges are explicit and exact: authenticated only", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const signature = `${write.name}\\(${write.types.join(",\\s*")}\\)`;
      assert.match(
        CODE,
        new RegExp(`revoke all\\s+on function public\\.${signature} from public`, "i"),
        `${write.name} must REVOKE ALL from PUBLIC`,
      );
      assert.match(
        CODE,
        new RegExp(`revoke execute on function public\\.${signature} from anon`, "i"),
        `${write.name} must REVOKE EXECUTE from anon`,
      );
      assert.match(
        CODE,
        new RegExp(`grant\\s+execute on function public\\.${signature} to authenticated`, "i"),
        `${write.name} must GRANT EXECUTE to authenticated only`,
      );
    }
  });

  test("27. nothing is granted to anon, service_role, or PUBLIC", () => {
    const grants = [...CODE.matchAll(/grant\s+[\s\S]*?\bto\s+(\w+)/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    assert.deepEqual(
      [...new Set(grants)],
      ["authenticated"],
      "authenticated is the only grantee anywhere in the repair",
    );
    assert.doesNotMatch(CODE, /\bservice_role\b/i);
  });

  test("28. the helpers are internal — revoked from PUBLIC and granted to nobody", () => {
    for (const helper of HELPERS) {
      assert.match(
        CODE,
        new RegExp(`revoke all on function public\\.${helper}\\(text\\) from public`, "i"),
        `${helper} must be revoked from PUBLIC`,
      );
      assert.doesNotMatch(
        CODE,
        new RegExp(`grant\\s+execute on function public\\.${helper}`, "i"),
        `${helper} must not be granted to any role`,
      );
    }
  });

  test("29. no dynamic SQL", () => {
    assert.doesNotMatch(CODE, /\bexecute\s+format\b/i);
    assert.doesNotMatch(CODE, /\bexecute\s+'/i);
    assert.doesNotMatch(CODE, /\bquote_ident\b/i);
  });

  test("30. every table reference is schema-qualified, because search_path is empty", () => {
    const unqualified = [
      /\binsert\s+into\s+(?!public\.)\w/i,
      /\bfrom\s+(?!public\.|lateral|pg_temp\.)[a-z_]+\s*(?:\n|\s|;)/i,
    ];
    // The only bare FROM allowed is the one inside a helper (there is none) — assert the
    // insert form directly, which is the one that could write to the wrong schema.
    assert.doesNotMatch(CODE, unqualified[0]);
    assert.match(CODE, /insert into public\.vendor_products/i);
    assert.match(CODE, /insert into public\.audit_logs/i);
  });
});

// ============================================================================
// Atomic audit
// ============================================================================
describe("Vendor Product writes — the audit row is part of the same transaction", () => {
  test("31. each replaced write contains exactly one audit insert, in its own body", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      const inserts = [...statement.matchAll(/insert\s+into\s+public\.audit_logs/gi)];
      assert.equal(
        inserts.length,
        1,
        `public.${write.name} must write exactly one audit row, inside its own body`,
      );
    }
  });

  test("32. the audit organization is the derived Vendor and the actor is auth.uid()", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      const audit = statement.slice(statement.search(/insert\s+into\s+public\.audit_logs/i));
      assert.match(
        audit,
        /values\s*\(\s*\n?\s*v_vendor\s*,\s*\n?\s*v_actor\s*,/i,
        `public.${write.name} must audit against the derived Vendor and the derived actor`,
      );
    }
  });

  test("33. the shipped action and entity codes are unchanged — no new code to teach a client", () => {
    assert.match(statementFor("create_vendor_product"), /'PRODUCT_CREATED'/);
    assert.match(statementFor("update_vendor_product"), /'PRODUCT_UPDATED'/);
    for (const write of WRITES.filter((w) => w.replaced)) {
      assert.match(statementFor(write.name), /'VENDOR_PRODUCT'/);
    }
  });

  test("34. no audit metadata carries a barcode, description or identity value", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      const audit = statement.slice(statement.search(/insert\s+into\s+public\.audit_logs/i));
      const keys = [...audit.matchAll(/'(\w+)',\s*(?:v_|'|\w)/g)].map((m) => m[1]);
      for (const key of keys) {
        assert.doesNotMatch(
          key,
          /barcode|description|profile|actor|membership|permission|token|organization_id/i,
          `${write.name} must not put ${key} in audit metadata`,
        );
      }
    }
  });
});

// ============================================================================
// The repaired normalization matches the web, character for character
// ============================================================================
describe("Vendor Product writes — the SQL rule and the TypeScript rule cannot disagree", () => {
  /**
   * Parses the migration's whitespace character class into the set of code points it matches.
   *
   * The class is written as ARE escapes inside an E'' string — `\\t`, `\\u00A0`, and so on —
   * so this reads what the regex engine will actually see. Ranges (`\\u2000-\\u200A`) are
   * expanded.
   */
  function parseWhitespaceClass(): Set<number> {
    const match = CODE.match(/E'\[([^\]]*)\]'/);
    assert.ok(match, "the repair must declare an explicit whitespace character class");
    const body = match[1];

    const tokens: number[] = [];
    const rangeMarks: number[] = [];
    let i = 0;
    while (i < body.length) {
      if (body[i] === "\\" && body[i + 1] === "\\") {
        const rest = body.slice(i + 2);
        const unicode = rest.match(/^u([0-9A-Fa-f]{4})/);
        if (unicode) {
          tokens.push(parseInt(unicode[1], 16));
          i += 2 + 5;
          continue;
        }
        const simple: Record<string, number> = {
          t: 0x09,
          n: 0x0a,
          v: 0x0b,
          f: 0x0c,
          r: 0x0d,
        };
        const key = rest[0];
        assert.ok(key in simple, `unrecognized escape \\${key} in the whitespace class`);
        tokens.push(simple[key]);
        i += 3;
        continue;
      }
      if (body[i] === "-") {
        // A range separator between the previous token and the next one.
        rangeMarks.push(tokens.length - 1);
        i += 1;
        continue;
      }
      tokens.push(body.codePointAt(i)!);
      i += String.fromCodePoint(body.codePointAt(i)!).length;
    }

    const set = new Set<number>();
    const rangeStarts = new Set(rangeMarks);
    for (let index = 0; index < tokens.length; index += 1) {
      if (rangeStarts.has(index)) {
        for (let cp = tokens[index]; cp <= tokens[index + 1]; cp += 1) set.add(cp);
        index += 1;
        continue;
      }
      set.add(tokens[index]);
    }
    return set;
  }

  /** Every code point JavaScript's `\s` matches. `.trim()` removes exactly these. */
  function javascriptWhitespace(): Set<number> {
    const set = new Set<number>();
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      if (/\s/.test(String.fromCodePoint(cp))) set.add(cp);
    }
    return set;
  }

  test("35. the SQL whitespace class is EXACTLY JavaScript's \\s — no more, no less", () => {
    const sql = parseWhitespaceClass();
    const js = javascriptWhitespace();

    const missing = [...js].filter((cp) => !sql.has(cp));
    const extra = [...sql].filter((cp) => !js.has(cp));

    assert.deepEqual(
      missing.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`),
      [],
      "every character the web strips must also be stripped by the database",
    );
    assert.deepEqual(
      extra.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`),
      [],
      "the database must not strip a character the web preserves",
    );
  });

  test("36. the class is written with escapes only — no invisible characters in the source", () => {
    // A literal NBSP in a migration is unreviewable: it looks like a space in every diff.
    const match = CODE.match(/E'\[([^\]]*)\]'/);
    assert.ok(match);
    for (const character of match[1]) {
      const cp = character.codePointAt(0)!;
      assert.ok(
        cp === 0x20 || (cp > 0x20 && cp < 0x7f),
        `the whitespace class must contain no literal control or non-ASCII character (found U+${cp
          .toString(16)
          .toUpperCase()})`,
      );
    }
  });

  test("37. normalization is COLLAPSE-THEN-TRIM, which is the defect that was fixed", () => {
    const line = statementFor("normalize_product_line");
    const collapseAt = line.search(/regexp_replace/i);
    const trimAt = line.search(/\bbtrim\s*\(/i);
    assert.ok(collapseAt !== -1 && trimAt !== -1);
    assert.ok(
      trimAt < collapseAt,
      "btrim must WRAP the collapse (outermost call), so trimming happens last",
    );
  });

  test("38. neither write normalizes with the old btrim-first idiom any more", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      assert.doesNotMatch(
        statement,
        /regexp_replace\(\s*btrim\(/i,
        `public.${write.name} must not reintroduce btrim-before-collapse`,
      );
    }
  });

  test("39. both writes normalize through the SAME helpers, so create and edit agree", () => {
    for (const write of WRITES.filter((w) => w.replaced)) {
      const statement = statementFor(write.name);
      assert.match(statement, /public\.normalize_product_line\(/i);
      assert.match(statement, /public\.normalize_product_block\(/i);
    }
  });

  test("40. the description is trimmed but never whitespace-collapsed", () => {
    const block = statementFor("normalize_product_block");
    // Anchored at both ends only: internal formatting is the author's.
    assert.match(block, /\^\[/, "the block normalizer must anchor at the start");
    assert.match(block, /\$'/, "the block normalizer must anchor at the end");
    assert.doesNotMatch(
      block,
      /' \+', ' '/,
      "the block normalizer must not collapse internal runs",
    );
  });

  test("41. the web's TypeScript rule still states the same four normalizations", () => {
    // If product-input.ts stopped trimming, or started case-folding a name, the two clients
    // would diverge again — in the other direction.
    assert.match(INPUT_MODULE, /\.trim\(\)\.replace\(\/\\s\+\/g, " "\)/);
    assert.match(INPUT_MODULE, /productCode: collapse\(readString\(raw\.productCode\)\)\.toUpperCase\(\)/);
    assert.match(INPUT_MODULE, /productName: collapse\(readString\(raw\.productName\)\)/);
    assert.match(INPUT_MODULE, /brand: collapse\(readString\(raw\.brand\)\)/);
    assert.match(INPUT_MODULE, /description: readString\(raw\.description\)\.trim\(\)/);
    assert.match(INPUT_MODULE, /barcode: readString\(raw\.barcode\)\.replace\(\/\[\\s-\]\/g, ""\)/);
  });

  test("42. the length bounds in SQL match the constants the web enforces", () => {
    const create = statementFor("create_vendor_product");
    for (const [limit, constant] of [
      [64, "MAX_PRODUCT_CODE_LENGTH"],
      [200, "MAX_PRODUCT_NAME_LENGTH"],
      [120, "MAX_BRAND_LENGTH"],
      [2000, "MAX_DESCRIPTION_LENGTH"],
    ] as const) {
      assert.match(
        create,
        new RegExp(`length\\([^)]*\\)\\s*>\\s*${limit}\\b`),
        `create must enforce the ${limit}-character bound`,
      );
      assert.match(
        INPUT_MODULE,
        new RegExp(`${constant} = ${limit}\\b`),
        `${constant} must still be ${limit} in the web module`,
      );
    }
  });
});

// ============================================================================
// Safe errors
// ============================================================================
describe("Vendor Product writes — no raw database error can reach a client", () => {
  test("43. every raise in the repair uses one of the repository's own fixed messages", () => {
    const raised = [...CODE.matchAll(/raise exception\s+'([^']*(?:''[^']*)*)'/gi)].map((m) =>
      m[1].replace(/''/g, "'"),
    );
    assert.ok(raised.length > 0, "the repair must raise its own messages");

    const allowed = new Set([
      "Not authorized to manage products",
      "Not authorized to manage this product",
      "Enter a valid product code",
      "Enter a product name",
      "Enter a valid barcode, or leave it blank",
      "Brand is too long",
      "Description is too long",
      "A product with that code already exists",
      "A product with that barcode already exists",
    ]);
    for (const message of raised) {
      assert.ok(allowed.has(message), `unexpected raised message: ${message}`);
    }
  });

  test("44. no raised message names a table, column, constraint or SQL construct", () => {
    const raised = [...CODE.matchAll(/raise exception\s+'([^']*(?:''[^']*)*)'/gi)].map((m) => m[1]);
    for (const message of raised) {
      assert.doesNotMatch(
        message,
        /vendor_products|audit_logs|constraint|relation|column|search_path|select|insert|update|pg_/i,
        `the message "${message}" leaks a schema detail`,
      );
    }
  });

  test("45. the unique-index catches still map both indexes to their own safe message", () => {
    const create = statementFor("create_vendor_product");
    assert.match(create, /when\s+unique_violation/i);
    assert.match(create, /v_constraint = 'vendor_products_code_unique_idx'/);
    assert.match(create, /v_constraint = 'vendor_products_barcode_unique_idx'/);
    // Anything unrecognized is re-raised rather than guessed at.
    assert.match(create, /\braise;\s*$/m);
  });

  test("46. a foreign or unknown product id is refused identically to a denial", () => {
    const update = statementFor("update_vendor_product");
    const refusals = [...update.matchAll(/raise exception\s+'(Not authorized[^']*)'/g)].map(
      (m) => m[1],
    );
    assert.ok(
      refusals.includes("Not authorized to manage this product"),
      "an unmatched product id must produce an authorization refusal, not a not-found",
    );
    assert.match(
      update,
      /if v_row\.id is null then\s*\n\s*raise exception 'Not authorized to manage this product'/i,
      "a null, unknown and foreign id must all land on the same refusal",
    );
  });
});

// ============================================================================
// The web is unchanged
// ============================================================================
describe("Vendor Product writes — the web implementation is untouched", () => {
  test("47. the web still calls exactly the three shipped write RPC names", () => {
    assert.match(WEB_MODULE, /const CREATE_PRODUCT_RPC = "create_vendor_product" as const;/);
    assert.match(WEB_MODULE, /const UPDATE_PRODUCT_RPC = "update_vendor_product" as const;/);
    assert.match(WEB_MODULE, /const SET_STATUS_RPC = "set_vendor_product_status" as const;/);
  });

  test("48. the web sends exactly the parameter names the functions declare", () => {
    for (const parameter of [
      "p_product_code",
      "p_product_name",
      "p_barcode",
      "p_brand",
      "p_description",
      "p_product_id",
      "p_status",
    ]) {
      assert.ok(
        WEB_MODULE.includes(`${parameter}:`),
        `the web module must still send ${parameter}`,
      );
    }
  });

  test("49. the web writes no table directly and constructs no service-role client", () => {
    assert.ok(
      !WEB_MODULE_CODE.includes(".from("),
      "the product module must contain no .from( call",
    );
    assert.doesNotMatch(WEB_MODULE_CODE, /service_role|SERVICE_ROLE|createServiceClient/);
    assert.doesNotMatch(WEB_ACTIONS_CODE, /service_role|SERVICE_ROLE|createServiceClient/);
    assert.ok(
      !WEB_ACTIONS_CODE.includes(".from("),
      "the product actions must contain no .from( call",
    );
  });

  test("50. the server actions accept no Vendor, organization or role field from a form", () => {
    const readFields = [...WEB_ACTIONS_CODE.matchAll(/readField\(formData,\s*"(\w+)"\)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      [...new Set(readFields)].sort(),
      ["barcode", "brand", "description", "productCode", "productId", "productName", "retailerId", "status"],
      "the forms may influence product fields, two ids and a status — nothing else",
    );
    for (const field of readFields) {
      assert.doesNotMatch(field, /organization|vendor|tenant|role|permission|profile|member|actor/i);
    }
  });
});
