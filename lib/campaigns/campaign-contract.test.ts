/**
 * STATIC CONTRACT GUARDS for the Vendor campaign management milestone
 * (supabase/migrations/20260815090000_vendor_campaign_foundation.sql and
 *  supabase/migrations/20260815210000_vendor_campaign_operations.sql).
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions over the migration text and the web modules, in the
 * same idiom as lib/products/vendor-product-reads-contract.test.ts and
 * lib/receipts/receipt-source-safety.test.ts. They read the files and assert structural
 * properties that a careless later edit could silently break.
 *
 * They do NOT execute anything. The BEHAVIOURAL suite is
 * supabase/tests/database/vendor_campaign_management_test.sql — pgTAP, 145 assertions,
 * covering every role denial, tenant isolation in both directions, group membership
 * semantics, every validation rule, the publication resolution rule, snapshot
 * immutability under a later group edit AND a later assignment change, the whole
 * lifecycle, and the exact visibility split between a Retailer Owner and a Sales Staff
 * member. It requires Docker and is run with:
 *
 *     npx supabase test db
 *
 * Nothing below is a substitute for that. What these guards DO cover is the set of
 * properties decidable from the source, and which would be a SECURITY or CONTRACT
 * regression rather than a behavioural one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");

const HISTORY_NAME = "20260814210000_vendor_product_assignment_history.sql";
const FOUNDATION_NAME = "20260815090000_vendor_campaign_foundation.sql";
const OPERATIONS_NAME = "20260815210000_vendor_campaign_operations.sql";

const FOUNDATION = readFileSync(join(MIGRATIONS_DIR, FOUNDATION_NAME), "utf8");
const OPERATIONS = readFileSync(join(MIGRATIONS_DIR, OPERATIONS_NAME), "utf8");

const readLib = (relative: string) => readFileSync(join(ROOT, "lib/campaigns", relative), "utf8");

const VENDOR_WRAPPER = readLib("vendor-campaigns.ts");
const GROUP_WRAPPER = readLib("retailer-groups.ts");
const RETAILER_WRAPPER = readLib("retailer-campaigns.ts");
const ALL_WRAPPERS = `${VENDOR_WRAPPER}\n${GROUP_WRAPPER}\n${RETAILER_WRAPPER}`;

/** Strips `--` line comments so a rule is never confused with prose describing it. */
function sqlCode(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

const FOUNDATION_CODE = sqlCode(FOUNDATION);
const OPERATIONS_CODE = sqlCode(OPERATIONS);
const BOTH_CODE = `${FOUNDATION_CODE}\n${OPERATIONS_CODE}`;

/** The eleven tables this milestone owns. */
const CAMPAIGN_TABLES = [
  "campaign_retailer_groups",
  "campaign_retailer_group_members",
  "campaigns",
  "campaign_versions",
  "campaign_version_retailers",
  "campaign_version_retailer_groups",
  "campaign_version_products",
  "campaign_rules",
  "campaign_rule_tiers",
  "campaign_eligible_retailers",
  "campaign_eligible_products",
];

/** Every function granted to a browser role, with the exact name the client must call. */
const GRANTED_FUNCTIONS = [
  "list_vendor_retailer_groups",
  "get_vendor_retailer_group",
  "list_vendor_retailer_group_members",
  "create_vendor_retailer_group",
  "update_vendor_retailer_group",
  "set_vendor_retailer_group_members",
  "list_vendor_campaigns",
  "get_vendor_campaign",
  "get_vendor_campaign_version",
  "list_vendor_campaign_version_retailers",
  "list_vendor_campaign_version_groups",
  "list_vendor_campaign_version_products",
  "list_vendor_campaign_eligible_retailers",
  "preview_vendor_campaign_publication",
  "create_vendor_campaign_draft",
  "update_vendor_campaign_draft",
  "publish_vendor_campaign",
  "set_vendor_campaign_lifecycle",
  "create_vendor_campaign_version",
  "list_my_retailer_campaigns",
  "get_my_retailer_campaign",
  "list_my_retailer_campaign_products",
  "list_my_staff_campaigns",
  "get_my_staff_campaign",
  "list_my_staff_campaign_products",
];

/** The three internal helpers, granted to NO browser role. */
const INTERNAL_FUNCTIONS = [
  "resolve_campaign_vendor_organization",
  "campaign_derived_state",
  "campaign_product_eligibility_as_of",
  "campaign_apply_draft_config",
];

/* ===========================================================================
 * 1. The migrations are new and forward-only
 * ======================================================================== */

describe("1. migration hygiene", () => {
  test("1.1 the three migrations exist and are correctly ordered relative to each other", () => {
    // ORDER RELATIVE TO EACH OTHER — NOT "newest in the tree".
    //
    // This assertion used to require the campaign migrations to be the last two files in
    // the directory. That is true today and false the moment anyone adds a migration for
    // anything else, so it would have failed the NEXT milestone for doing nothing wrong —
    // the same over-broad-guard mistake that
    // lib/receipts/receipt-confirmation-currency-contract.test.ts made with `git diff`.
    // What actually matters is that these three exist and that each depends only on ones
    // that run before it.
    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

    for (const name of [HISTORY_NAME, FOUNDATION_NAME, OPERATIONS_NAME]) {
      assert.ok(migrations.includes(name), `${name} is missing`);
    }

    // The assignment timeline must precede the campaign schema that references it, and the
    // foundation must precede the operations that create functions over its tables.
    assert.ok(
      migrations.indexOf(HISTORY_NAME) < migrations.indexOf(FOUNDATION_NAME),
      "the assignment history migration must run before the campaign foundation",
    );
    assert.ok(
      migrations.indexOf(FOUNDATION_NAME) < migrations.indexOf(OPERATIONS_NAME),
      "the campaign foundation must run before the campaign operations",
    );
  });

  test("1.1b the ordering rule tolerates any later unrelated migration", () => {
    // Proves the fix rather than asserting it in prose, and does so WITHOUT committing a
    // fake migration: the rule is a pure predicate over a sorted list, so it can be
    // exercised against a synthetic list that includes a plausible future filename.
    //
    // If someone reintroduced a "must be the newest two" rule, the second case below would
    // fail and say exactly why.
    function orderingHolds(names: string[]): boolean {
      const sorted = [...names].sort();
      return (
        sorted.includes(HISTORY_NAME) &&
        sorted.includes(FOUNDATION_NAME) &&
        sorted.includes(OPERATIONS_NAME) &&
        sorted.indexOf(HISTORY_NAME) < sorted.indexOf(FOUNDATION_NAME) &&
        sorted.indexOf(FOUNDATION_NAME) < sorted.indexOf(OPERATIONS_NAME)
      );
    }

    const today = [HISTORY_NAME, FOUNDATION_NAME, OPERATIONS_NAME];
    assert.equal(orderingHolds(today), true, "today's tree should satisfy the rule");

    // A perfectly ordinary next milestone, months later.
    assert.equal(
      orderingHolds([...today, "20260901090000_reward_calculation_foundation.sql"]),
      true,
      "a later unrelated migration must not break this guard",
    );

    // Several of them, including one on the same day.
    assert.equal(
      orderingHolds([
        ...today,
        "20260815210001_some_same_day_repair.sql",
        "20261101090000_much_later_milestone.sql",
      ]),
      true,
      "later migrations, including same-day ones, must not break this guard",
    );

    // The rule must still FAIL for the things it is actually there to catch.
    assert.equal(
      orderingHolds([FOUNDATION_NAME, OPERATIONS_NAME]),
      false,
      "a missing history migration must be caught",
    );
    assert.equal(
      orderingHolds([HISTORY_NAME, OPERATIONS_NAME]),
      false,
      "a missing foundation must be caught",
    );
  });

  test("1.2 neither uses IF NOT EXISTS, CREATE OR REPLACE or ON CONFLICT on its own objects", () => {
    // A conflicting existing object must FAIL the migration rather than be silently
    // adopted or overwritten — the posture every migration in this repository uses.
    assert.ok(!/create or replace/i.test(BOTH_CODE));
    assert.ok(!/create table if not exists/i.test(BOTH_CODE));
    assert.ok(!/create function if not exists/i.test(BOTH_CODE));
    assert.ok(!/on conflict/i.test(BOTH_CODE));
  });

  test("1.3 neither contains a fixed UUID literal", () => {
    // Ids come from gen_random_uuid(); permission rows are joined by CODE.
    const uuidLiteral = /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i;
    assert.ok(!uuidLiteral.test(BOTH_CODE));
  });

  test("1.4 no identifier exceeds PostgreSQL's 63-byte limit", () => {
    const identifiers = [
      ...BOTH_CODE.matchAll(/(?:create (?:unique )?index|constraint|create trigger)\s+([a-z0-9_]+)/gi),
    ].map((m) => m[1]);
    assert.ok(identifiers.length > 40, "expected many identifiers to check");
    for (const identifier of identifiers) {
      assert.ok(identifier.length <= 63, `${identifier} is ${identifier.length} bytes`);
    }
  });

  test("1.5 neither migration alters or drops an object it does not own", () => {
    const alters = [...BOTH_CODE.matchAll(/alter table (?:public\.)?([a-z0-9_]+)/gi)].map(
      (m) => m[1],
    );
    for (const table of alters) {
      assert.ok(CAMPAIGN_TABLES.includes(table), `altered foreign table ${table}`);
    }
    assert.ok(!/\bdrop (table|function|policy|index|constraint|trigger)\b/i.test(BOTH_CODE));
  });

  test("1.6 no existing migration file was modified to add campaign objects", () => {
    const others = readdirSync(MIGRATIONS_DIR)
      .filter(
        (f) =>
          f.endsWith(".sql") &&
          f !== HISTORY_NAME &&
          f !== FOUNDATION_NAME &&
          f !== OPERATIONS_NAME,
      );
    for (const file of others) {
      const sql = sqlCode(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      assert.ok(
        !/create table public\.campaign/i.test(sql),
        `${file} creates a campaign table`,
      );
    }
  });
});

/* ===========================================================================
 * 2. Default-deny storage
 * ======================================================================== */

describe("2. every campaign table is RPC-only", () => {
  test("2.1 all eleven tables enable row level security", () => {
    for (const table of CAMPAIGN_TABLES) {
      assert.ok(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`).test(
          FOUNDATION_CODE,
        ),
        `${table} does not enable RLS`,
      );
    }
  });

  test("2.2 NO policy is created on any table, in any schema", () => {
    // Default deny is the whole design. A policy would be a second, independent
    // definition of who may see what, and the RPCs already answer that correctly.
    assert.ok(!/create policy/i.test(BOTH_CODE));
  });

  test("2.3 all eleven tables revoke everything from public, anon and authenticated", () => {
    for (const table of CAMPAIGN_TABLES) {
      assert.ok(
        new RegExp(
          `revoke all on table public\\.${table}\\s+from public, anon, authenticated`,
        ).test(FOUNDATION_CODE),
        `${table} does not revoke browser privileges`,
      );
    }
  });

  test("2.4 no table privilege is GRANTED to any role", () => {
    const tableGrants = [...BOTH_CODE.matchAll(/grant\s+[a-z, ]+\s+on\s+table/gi)];
    assert.deepEqual(tableGrants.map((m) => m[0]), []);
  });

  test("2.5 no sequence or schema privilege is granted either", () => {
    assert.ok(!/grant[\s\S]{0,40}on sequence/i.test(BOTH_CODE));
    assert.ok(!/grant[\s\S]{0,40}on schema/i.test(BOTH_CODE));
  });
});

/* ===========================================================================
 * 3. Function hardening and privileges
 * ======================================================================== */

describe("3. every function is correctly hardened", () => {
  const functionBlocks = [...OPERATIONS.matchAll(/create function public\.([a-z0-9_]+)\(/g)];

  test("3.1 the operations migration declares exactly the agreed function set", () => {
    const declared = functionBlocks.map((m) => m[1]).sort();
    const expected = [...GRANTED_FUNCTIONS, ...INTERNAL_FUNCTIONS].sort();
    assert.deepEqual(declared, expected);
  });

  test("3.2 every function is SECURITY DEFINER with an EMPTY search_path", () => {
    // An empty search_path is what stops anything being resolved from an
    // attacker-controlled schema. Counted rather than spot-checked.
    const definers = OPERATIONS_CODE.match(/security definer/g) ?? [];
    const searchPaths = OPERATIONS_CODE.match(/set search_path = ''/g) ?? [];
    assert.equal(definers.length, functionBlocks.length);
    assert.equal(searchPaths.length, functionBlocks.length);
  });

  test("3.3 every trigger function in the foundation is hardened the same way", () => {
    const triggerFns = [...FOUNDATION.matchAll(/create function public\.([a-z0-9_]+)\(/g)];
    const definers = FOUNDATION_CODE.match(/security definer/g) ?? [];
    const searchPaths = FOUNDATION_CODE.match(/set search_path = ''/g) ?? [];
    assert.equal(definers.length, triggerFns.length);
    assert.equal(searchPaths.length, triggerFns.length);
  });

  test("3.4 every granted function revokes PUBLIC and anon before granting authenticated", () => {
    for (const name of GRANTED_FUNCTIONS) {
      assert.ok(
        new RegExp(`revoke all\\s+on function public\\.${name}\\(`).test(OPERATIONS_CODE),
        `${name} does not revoke PUBLIC`,
      );
      assert.ok(
        new RegExp(`revoke execute on function public\\.${name}\\([\\s\\S]{0,400}?from anon`).test(
          OPERATIONS_CODE,
        ),
        `${name} does not revoke anon`,
      );
      assert.ok(
        new RegExp(`grant  execute on function public\\.${name}\\(`).test(OPERATIONS_CODE),
        `${name} is not granted to authenticated`,
      );
    }
  });

  test("3.5 the three internal helpers are granted to NOBODY", () => {
    for (const name of INTERNAL_FUNCTIONS) {
      assert.ok(
        new RegExp(
          `revoke execute on function public\\.${name}\\([\\s\\S]{0,400}?from authenticated`,
        ).test(OPERATIONS_CODE),
        `${name} is not revoked from authenticated`,
      );
      assert.ok(
        !new RegExp(`grant\\s+execute on function public\\.${name}\\(`).test(OPERATIONS_CODE),
        `${name} is granted to a browser role`,
      );
    }
  });

  test("3.6 service_role is granted nothing", () => {
    // Every campaign operation derives its authority from auth.uid(); a service-role
    // path would let a campaign be published, paused or read with no session at all.
    assert.ok(!/service_role/i.test(OPERATIONS_CODE.replace(/from public;/g, "")));
  });

  test("3.7 there is no dynamic SQL anywhere", () => {
    assert.ok(!/\bexecute\s+format\b/i.test(BOTH_CODE));
    assert.ok(!/\bexecute\s+'/i.test(BOTH_CODE));
    assert.ok(!/\bquote_ident\b/i.test(BOTH_CODE));
  });

  test("3.8 every read RPC is STABLE, and every write is VOLATILE", () => {
    // A read marked volatile would defeat planning; a write marked stable could be
    // folded away. Both matter, and both are decidable from the source.
    const blocks = OPERATIONS.split(/create function public\./).slice(1);
    for (const block of blocks) {
      const name = block.slice(0, block.indexOf("(")).trim();
      if (!GRANTED_FUNCTIONS.includes(name)) continue;
      const head = block.slice(0, block.indexOf("as $$"));
      const isWrite = /^(create|update|set|publish)_/.test(name);
      if (isWrite) {
        assert.ok(/\bvolatile\b/.test(head), `${name} should be volatile`);
      } else {
        assert.ok(/\bstable\b/.test(head), `${name} should be stable`);
      }
    }
  });
});

/* ===========================================================================
 * 4. Authorization is derived, never supplied
 * ======================================================================== */

describe("4. no contract accepts an authority claim from a client", () => {
  test("4.1 no function takes an actor, tenant, role, permission or audit argument", () => {
    const signatures = [
      ...OPERATIONS.matchAll(/create function public\.[a-z0-9_]+\(([\s\S]*?)\)\s*returns/g),
    ].map((m) => m[1]);
    assert.ok(signatures.length > 20);

    const forbidden =
      /p_(actor|user|profile|vendor_organization|organization|tenant|role|permission|audit|status_before|created_by|published_at|snapshot)/i;
    for (const signature of signatures) {
      const offenders = [...signature.matchAll(/(p_[a-z0-9_]+)/g)]
        .map((m) => m[1])
        .filter((arg) => forbidden.test(arg));
      assert.deepEqual(offenders, [], `forbidden argument in: ${signature.trim()}`);
    }
  });

  test("4.2 the internal Vendor resolver takes ONLY a permission code, and no id", () => {
    const start = OPERATIONS.indexOf("create function public.resolve_campaign_vendor_organization");
    const signature = OPERATIONS.slice(start, OPERATIONS.indexOf("returns uuid", start));
    assert.match(signature, /target_permission_code text/);
    assert.ok(!/uuid/.test(signature), "the resolver accepts an id");
  });

  test("4.3 every Vendor RPC resolves through the shared helper — none reimplements it", () => {
    const vendorFunctions = GRANTED_FUNCTIONS.filter((name) => name.includes("vendor"));
    const blocks = OPERATIONS.split(/create function public\./).slice(1);
    for (const block of blocks) {
      const name = block.slice(0, block.indexOf("(")).trim();
      if (!vendorFunctions.includes(name)) continue;
      const body = block.slice(0, block.indexOf("$$;"));
      assert.ok(
        body.includes("resolve_campaign_vendor_organization"),
        `${name} does not use the shared Vendor resolver`,
      );
    }
  });

  test("4.4 every assigned-visibility RPC resolves through the Retailer-side helper", () => {
    const blocks = OPERATIONS.split(/create function public\./).slice(1);
    for (const block of blocks) {
      const name = block.slice(0, block.indexOf("(")).trim();
      if (!name.includes("_my_")) continue;
      const body = block.slice(0, block.indexOf("$$;"));
      assert.ok(
        body.includes("resolve_retailer_member_organization"),
        `${name} does not use the Retailer resolver`,
      );
    }
  });

  test("4.5 the permission codes used are exactly the four this milestone seeds", () => {
    // Scoped to the two RESOLVER CALL SITES rather than to every upper-case literal in
    // the file — 'RETAILER_GROUPS' is also an audience_mode value, and a test that could
    // not tell a permission apart from an enum would be testing its own regex.
    const used = new Set([
      ...[
        ...OPERATIONS_CODE.matchAll(
          /resolve_campaign_vendor_organization\('([A-Z_]+)'\)/g,
        ),
      ].map((m) => m[1]),
      ...[
        ...OPERATIONS_CODE.matchAll(
          /resolve_retailer_member_organization\('([A-Z_]+)'\)/g,
        ),
      ].map((m) => m[1]),
    ]);
    assert.deepEqual(
      [...used].sort(),
      [
        "CAMPAIGNS_MANAGE",
        "CAMPAIGNS_VIEW_ASSIGNED",
        "RETAILER_GROUPS_MANAGE",
        "STAFF_CAMPAIGNS_VIEW",
      ],
    );
  });

  test("4.6 RETAILER_MANAGER receives no campaign permission mapping", () => {
    // The approved scope for this milestone. A Manager gains visibility later by
    // acquiring a role_permissions row, not by an edit to any function.
    const mappings = FOUNDATION_CODE.slice(
      FOUNDATION_CODE.indexOf("insert into public.role_permissions"),
      FOUNDATION_CODE.indexOf("create table public.campaign_retailer_groups"),
    );
    assert.ok(!/RETAILER_MANAGER/.test(mappings));
  });

  test("4.7 SALES_STAFF gets its OWN permission, not the Retailer Owner's", () => {
    assert.ok(/where r\.code = 'SALES_STAFF'/.test(FOUNDATION_CODE));
    const staffBlock = FOUNDATION_CODE.slice(
      FOUNDATION_CODE.indexOf("'STAFF_CAMPAIGNS_VIEW'\nwhere"),
    );
    assert.ok(!/CAMPAIGNS_VIEW_ASSIGNED[\s\S]{0,80}SALES_STAFF/.test(FOUNDATION_CODE));
    assert.ok(staffBlock.length >= 0);
  });
});

/* ===========================================================================
 * 5. The disclosure boundary
 * ======================================================================== */

describe("5. assigned-visibility reads withhold Vendor-private facts", () => {
  const ASSIGNED_READS = [
    "list_my_retailer_campaigns",
    "get_my_retailer_campaign",
    "list_my_staff_campaigns",
    "get_my_staff_campaign",
  ];

  /** The `returns table (...)` block of one function. */
  function returnsBlock(name: string): string {
    const start = OPERATIONS.indexOf(`create function public.${name}(`);
    assert.notEqual(start, -1, `${name} not found`);
    const returnsAt = OPERATIONS.indexOf("returns table (", start);
    const end = OPERATIONS.indexOf(")\nlanguage", returnsAt);
    return OPERATIONS.slice(returnsAt, end);
  }

  test("5.1 no assigned read returns an exclusivity key or a priority", () => {
    for (const name of ASSIGNED_READS) {
      const block = returnsBlock(name);
      assert.ok(!/exclusivity_key/.test(block), `${name} returns exclusivity_key`);
      assert.ok(!/\bpriority\b/.test(block), `${name} returns priority`);
    }
  });

  test("5.2 no assigned read returns an eligibility source or a group name", () => {
    for (const name of ASSIGNED_READS) {
      const block = returnsBlock(name);
      assert.ok(!/\bsource\b/.test(block), `${name} returns the eligibility source`);
      assert.ok(!/group/i.test(block), `${name} returns a group fact`);
    }
  });

  test("5.3 no assigned read returns another Retailer's id or a Retailer count", () => {
    for (const name of ASSIGNED_READS) {
      const block = returnsBlock(name);
      assert.ok(!/vendor_retailer_id/.test(block), `${name} returns a relationship id`);
      assert.ok(
        !/retailer_organization_id/.test(block),
        `${name} returns a Retailer organization id`,
      );
      assert.ok(
        !/eligible_retailer_count/.test(block),
        `${name} discloses how many Retailers the campaign reaches`,
      );
    }
  });

  test("5.4 no assigned read exposes internal campaign versioning", () => {
    for (const name of ASSIGNED_READS) {
      const block = returnsBlock(name);
      assert.ok(!/version/i.test(block), `${name} exposes versioning`);
      assert.ok(!/draft/i.test(block), `${name} exposes draft state`);
    }
  });

  test("5.5 the Sales Staff reads withhold the Vendor's name; the Owner's returns it", () => {
    // Naming the Vendor to a shop-floor seller leaks the supply relationship, exactly as
    // list_my_receipt_products() reasoned. An Owner is entitled to it.
    assert.ok(!/vendor_name/.test(returnsBlock("list_my_staff_campaigns")));
    assert.ok(!/vendor_name/.test(returnsBlock("get_my_staff_campaign")));
    assert.ok(/vendor_name/.test(returnsBlock("list_my_retailer_campaigns")));
    assert.ok(/vendor_name/.test(returnsBlock("get_my_retailer_campaign")));
  });

  test("5.6 the single-row read has the SAME shape as its list read", () => {
    // So one client-side model deserializes both, and a future column must be added to
    // both or to neither.
    const normalize = (block: string) =>
      block
        .replace(/returns table \(/, "")
        .split(",")
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((name) => name.length > 0);

    assert.deepEqual(
      normalize(returnsBlock("get_my_retailer_campaign")),
      normalize(returnsBlock("list_my_retailer_campaigns")),
    );
    assert.deepEqual(
      normalize(returnsBlock("get_my_staff_campaign")),
      normalize(returnsBlock("list_my_staff_campaigns")),
    );
  });

  test("5.7 the Sales Staff reads are restricted to ACTIVE and SCHEDULED campaigns", () => {
    for (const name of ["list_my_staff_campaigns", "get_my_staff_campaign", "list_my_staff_campaign_products"]) {
      const start = OPERATIONS.indexOf(`create function public.${name}(`);
      const body = OPERATIONS.slice(start, OPERATIONS.indexOf("$$;", start));
      assert.ok(
        /in \('ACTIVE', 'SCHEDULED'\)/.test(body),
        `${name} does not restrict to ACTIVE/SCHEDULED`,
      );
    }
  });

  test("5.8 every assigned read is scoped to the version currently IN FORCE", () => {
    // A superseded version's snapshot is history; presenting it would show an offer that
    // has been replaced.
    for (const name of [...ASSIGNED_READS, "list_my_retailer_campaign_products", "list_my_staff_campaign_products"]) {
      const start = OPERATIONS.indexOf(`create function public.${name}(`);
      const body = OPERATIONS.slice(start, OPERATIONS.indexOf("$$;", start));
      assert.ok(
        /c\.published_version_id = cv\.id/.test(body),
        `${name} does not restrict to the in-force version`,
      );
    }
  });
});

/* ===========================================================================
 * 6. No reward engine
 * ======================================================================== */

describe("6. nothing here computes, credits or stores a reward outcome", () => {
  test("6.1 no table holds a progress, balance, earned, credited, payout or claim column", () => {
    const columnish =
      /\n\s{2}[a-z_]*(progress|balance|earned|credited|units_sold_total|payout|claim|ledger)[a-z_]*\s+(uuid|text|integer|bigint|numeric|boolean|timestamptz)/i;
    assert.ok(!columnish.test(FOUNDATION_CODE));
  });

  test("6.2 no function name or return column suggests a computed outcome", () => {
    const banned = /(progress|balance|earned|credited|coins_earned|payout|claim|ledger|reversal)/i;
    for (const name of [...GRANTED_FUNCTIONS, ...INTERNAL_FUNCTIONS]) {
      assert.ok(!banned.test(name), `${name} names a reward outcome`);
    }
    const returnBlocks = [...OPERATIONS.matchAll(/returns table \(([\s\S]*?)\)\s*\nlanguage/g)].map(
      (m) => m[1],
    );
    assert.ok(returnBlocks.length > 15);
    for (const block of returnBlocks) {
      assert.ok(!banned.test(block), `a return block names a reward outcome:\n${block}`);
    }
  });

  test("6.3 no floating-point or numeric column exists — coins never round", () => {
    assert.ok(!/\b(numeric|decimal|real|double precision|float)\b/i.test(FOUNDATION_CODE));
  });

  test("6.4 no arithmetic combines a rate with a quantity anywhere in SQL", () => {
    // The one multiplication that would turn configuration into an amount owed.
    assert.ok(!/coins_per_unit\s*\*/i.test(BOTH_CODE));
    assert.ok(!/\*\s*coins_per_unit/i.test(BOTH_CODE));
    assert.ok(!/sum\s*\(\s*[a-z_.]*coins/i.test(BOTH_CODE));
  });

  test("6.5 the web modules contain no reward arithmetic either", () => {
    const code = `${ALL_WRAPPERS}\n${readLib("campaign-normalization.ts")}\n${readLib("campaign-vocabulary.ts")}`
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!/coinsPerUnit\s*\*/.test(code));
    assert.ok(!/\breduce\([\s\S]{0,80}coins/i.test(code));
    assert.ok(!/(earned|balance|progress)[A-Za-z]*\s*[:=]/i.test(code));
  });

  test("6.6 no receipt, matching or OCR vocabulary appears in this milestone", () => {
    // Product matching and receipt evaluation are explicit non-goals. The campaign
    // schema reads the product CATALOGUE, never a receipt.
    assert.ok(!/\breceipt/i.test(BOTH_CODE));
    assert.ok(!/\bocr\b|tesseract|textract|extraction/i.test(BOTH_CODE));
  });
});

/* ===========================================================================
 * 7. Immutability and idempotence
 * ======================================================================== */

describe("7. the guarantees the versioning design rests on", () => {
  test("7.1 a published version is frozen by a trigger, not merely by convention", () => {
    assert.ok(/create trigger campaign_version_assert_immutable_on_update/.test(FOUNDATION_CODE));
    assert.ok(/create trigger campaign_version_assert_undeletable_on_delete/.test(FOUNDATION_CODE));
  });

  test("7.2 every table describing a version is frozen too, not just the header row", () => {
    for (const table of [
      "campaign_version_retailers",
      "campaign_version_retailer_groups",
      "campaign_version_products",
      "campaign_rules",
    ]) {
      assert.ok(
        new RegExp(`before insert or update or delete on public\\.${table}`).test(
          FOUNDATION_CODE,
        ),
        `${table} has no draft-only guard`,
      );
    }
    assert.ok(
      /before insert or update or delete on public\.campaign_rule_tiers/.test(FOUNDATION_CODE),
    );
  });

  test("7.3 both snapshot tables refuse every UPDATE and every DELETE", () => {
    for (const table of ["campaign_eligible_retailers", "campaign_eligible_products"]) {
      assert.ok(
        new RegExp(`create trigger ${table.replace("campaign_", "campaign_")}_frozen_on_update`).test(
          FOUNDATION_CODE,
        ) || new RegExp(`before update on public\\.${table}`).test(FOUNDATION_CODE),
        `${table} allows UPDATE`,
      );
      assert.ok(
        new RegExp(`before delete on public\\.${table}`).test(FOUNDATION_CODE),
        `${table} allows DELETE`,
      );
    }
  });

  test("7.4 at most one draft version per campaign, enforced by a partial unique index", () => {
    assert.ok(
      /create unique index campaign_versions_one_draft_idx[\s\S]{0,120}where published_at is null/.test(
        FOUNDATION_CODE,
      ),
    );
  });

  test("7.5 the snapshot is unique per (version, Retailer) — the anti-duplicate authority", () => {
    assert.ok(
      /create unique index campaign_eligible_retailers_unique_idx[\s\S]{0,120}\(campaign_version_id, vendor_retailer_id\)/.test(
        FOUNDATION_CODE,
      ),
    );
  });

  test("7.6 group membership is soft-removed, with one LIVE row per pair", () => {
    assert.ok(
      /create unique index campaign_group_members_live_unique_idx[\s\S]{0,160}where removed_at is null/.test(
        FOUNDATION_CODE,
      ),
    );
    // Removal must never be a DELETE.
    assert.ok(!/delete from public\.campaign_retailer_group_members/i.test(OPERATIONS_CODE));
  });

  test("7.7 publish locks the campaign row deterministically", () => {
    const start = OPERATIONS.indexOf("create function public.publish_vendor_campaign(");
    const body = OPERATIONS.slice(start, OPERATIONS.indexOf("$$;", start));
    assert.ok(/for update/.test(body), "publish does not lock");
  });

  test("7.8 publish returns an explicit no-op rather than raising on a second call", () => {
    const start = OPERATIONS.indexOf("create function public.publish_vendor_campaign(");
    const body = OPERATIONS.slice(start, OPERATIONS.indexOf("$$;", start));
    assert.ok(/draft_version_id is null/.test(body));
    assert.ok(/false;\s*\n\s*return;/.test(body), "no explicit no-op return");
  });

  test("7.9 every lifecycle write is audited only when something changed", () => {
    const start = OPERATIONS.indexOf("create function public.set_vendor_campaign_lifecycle(");
    const body = OPERATIONS.slice(start, OPERATIONS.indexOf("$$;", start));
    // Each no-op branch returns BEFORE the audit insert.
    const auditAt = body.indexOf("insert into public.audit_logs");
    const noOps = [...body.matchAll(/return query select v_campaign\.id, v_campaign\.status, false;/g)];
    assert.equal(noOps.length, 3, "expected a no-op branch for pause, resume and cancel");
    for (const match of noOps) {
      assert.ok(match.index !== undefined && match.index < auditAt);
    }
  });

  test("7.10 the ten required audit events are all emitted", () => {
    for (const action of [
      "RETAILER_GROUP_CREATED",
      "RETAILER_GROUP_UPDATED",
      "RETAILER_GROUP_MEMBERS_CHANGED",
      "CAMPAIGN_DRAFT_CREATED",
      "CAMPAIGN_DRAFT_UPDATED",
      "CAMPAIGN_PUBLISHED",
      "CAMPAIGN_PAUSED",
      "CAMPAIGN_RESUMED",
      "CAMPAIGN_CANCELLED",
      "CAMPAIGN_VERSION_CREATED",
    ]) {
      assert.ok(OPERATIONS_CODE.includes(`'${action}'`), `${action} is never written`);
    }
  });

  test("7.11 no audit row accepts an actor, tenant or timestamp from an argument", () => {
    // Sliced from each `insert into public.audit_logs` to the start of its metadata
    // object. A non-greedy `\);` would stop inside jsonb_build_object(...) and test the
    // wrong text.
    const starts = [
      ...OPERATIONS_CODE.matchAll(/insert into public\.audit_logs \(([\s\S]*?)\)\s*\n\s*values \(/g),
    ];
    // EIGHT inserts produce the TEN events asserted by 7.10: set_vendor_campaign_lifecycle
    // writes one row whose action is PAUSED, RESUMED or CANCELLED depending on the branch.
    assert.equal(starts.length, 8, `found ${starts.length} audit inserts`);

    for (const match of starts) {
      const columns = match[1];
      assert.match(columns, /organization_id, actor_profile_id/);

      const from = (match.index ?? 0) + match[0].length;
      const metadataAt = OPERATIONS_CODE.indexOf("jsonb_build_object", from);
      const leadingValues = OPERATIONS_CODE.slice(from, metadataAt);

      // The tenant is the DERIVED Vendor and the actor is auth.uid() via v_actor. No
      // p_ argument may appear among the positional values before the metadata.
      assert.match(leadingValues, /v_vendor,\s*v_actor/);
      assert.ok(
        !/\bp_[a-z_]+/.test(leadingValues),
        `an audit insert carries a client argument: ${leadingValues.trim()}`,
      );
      // And no client-supplied timestamp: created_at takes the table default.
      assert.ok(!/created_at/.test(columns));
    }
  });
});

/* ===========================================================================
 * 8. The web modules
 * ======================================================================== */

describe("8. the server modules are safe by construction", () => {
  test("8.1 no wrapper performs a direct table read or write", () => {
    // Comments stripped first: each module DOCUMENTS that it contains zero `.from(`
    // calls, and a test that could not tell a claim apart from a call would fail on the
    // very sentence promising the opposite.
    for (const [name, source] of [
      ["vendor-campaigns", VENDOR_WRAPPER],
      ["retailer-groups", GROUP_WRAPPER],
      ["retailer-campaigns", RETAILER_WRAPPER],
    ] as const) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.ok(!/\.from\(/.test(code), `${name} performs a direct table access`);
      assert.ok(!/\.select\(|\.insert\(|\.update\(|\.delete\(/.test(code));
    }
  });

  test("8.2 no wrapper constructs a service-role client", () => {
    assert.ok(!/service_role|SERVICE_ROLE|createServiceClient|serviceClient/i.test(ALL_WRAPPERS));
  });

  test("8.3 every RPC name the wrappers call exists in the migration", () => {
    const called = [...ALL_WRAPPERS.matchAll(/= "([a-z_]+)" as const/g)].map((m) => m[1]);
    assert.ok(called.length >= 20, `only found ${called.length} RPC constants`);
    for (const name of called) {
      assert.ok(
        OPERATIONS_CODE.includes(`create function public.${name}(`),
        `${name} is called but not defined`,
      );
      assert.ok(GRANTED_FUNCTIONS.includes(name), `${name} is called but not granted`);
    }
  });

  test("8.4 the retailer module calls ONLY the three assigned-visibility reads", () => {
    const called = [...RETAILER_WRAPPER.matchAll(/= "([a-z_]+)" as const/g)].map((m) => m[1]);
    assert.deepEqual(called.sort(), [
      "get_my_retailer_campaign",
      "list_my_retailer_campaign_products",
      "list_my_retailer_campaigns",
    ]);
  });

  test("8.5 the retailer module contains no write of any kind", () => {
    for (const verb of ["publish", "pause", "resume", "cancel", "create", "update", "delete"]) {
      assert.ok(
        !new RegExp(`rpc\\([^)]*${verb}`, "i").test(RETAILER_WRAPPER),
        `the Retailer module calls a ${verb} RPC`,
      );
    }
  });

  test("8.6 no wrapper returns a raw Supabase error or message to its caller", () => {
    // A PostgREST message can name tables, columns, functions and policies, so none may
    // reach a returned value. Passing `result.error` INTO a classifier is fine and is
    // how every module in this repository does it — the classifier reads `.code` and,
    // in one narrowly-scoped place, matches this repository's own fixed literals.
    const code = ALL_WRAPPERS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // No error object is ever placed on a returned shape.
    assert.ok(!/\berror:\s*(result\.)?error\b/.test(code));
    assert.ok(!/message:\s*(result\.)?error\.message/.test(code));
    assert.ok(!/return\s*\{[^}]*result\.error/.test(code));

    // Every use of result.error is either a truthiness test or a hand-off to a
    // classifier — never a render and never a log of the object itself.
    for (const line of code.split("\n").filter((l) => l.includes("result.error"))) {
      assert.ok(
        /if \(result\.error\)/.test(line) ||
          /classifyWriteError\(result\.error/.test(line) ||
          /\(result\.error as \{ code\?: string/.test(line),
        `unclassified use of result.error: ${line.trim()}`,
      );
    }

    // The operator log carries a category, never the error.
    assert.ok(!/console\.error\([^)]*\berror\b[^)]*\)/.test(code.replace(/console\.error\(`/g, "console.error(TPL`")));
  });

  test("8.7 the only database MESSAGES inspected are this repository's own literals", () => {
    const matched = [...VENDOR_WRAPPER.matchAll(/message\.includes\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    assert.ok(matched.length >= 6);
    for (const literal of matched) {
      assert.ok(
        OPERATIONS.includes(literal),
        `"${literal}" is matched but no RPC raises it`,
      );
    }
  });

  test("8.8 a committed write is never reported as a failure on a bad reread", () => {
    // A malformed response to a call that did NOT error means the write HAPPENED.
    // Reporting it as a failure would invite a retry of something already committed —
    // the one mistake that produces a duplicate publish.
    function bodyOf(source: string, fn: string): string {
      const start = source.indexOf(`export async function ${fn}(`);
      assert.notEqual(start, -1, `${fn} not found`);
      const next = source.indexOf("\nexport ", start + 1);
      return source.slice(start, next === -1 ? source.length : next);
    }

    // publishCampaign: after a non-error call, a malformed body still returns "ok".
    const publish = bodyOf(VENDOR_WRAPPER, "publishCampaign");
    const afterMalformed = publish.slice(publish.indexOf('status === "malformed"'));
    assert.ok(
      /status: "ok"/.test(afterMalformed),
      "publishCampaign reports a committed write as a failure",
    );
    assert.ok(!/status: "unavailable"/.test(afterMalformed.split("return {")[1] ?? ""));

    // setRetailerGroupMembers: same rule.
    const setMembers = bodyOf(GROUP_WRAPPER, "setRetailerGroupMembers");
    const groupAfter = setMembers.slice(setMembers.indexOf('status === "malformed"'));
    assert.ok(/status: "ok"/.test(groupAfter));

    // And no wrapper retries anything on its own.
    const code = ALL_WRAPPERS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\bretry|\battempt\s*\+\+|for \(let attempt/i.test(code));
  });

  test("8.9 every wrapper module is server-only — none is a client component", () => {
    for (const source of [VENDOR_WRAPPER, GROUP_WRAPPER, RETAILER_WRAPPER]) {
      assert.ok(!/^"use client"/m.test(source));
      assert.ok(/SERVER-ONLY MODULE/.test(source));
    }
  });

  test("8.10 request-scoped caches are React `cache`, never a module-level map", () => {
    // An authorization-bearing result belongs to exactly one caller for exactly one
    // request. A module-level cache would outlive both.
    assert.ok(/import { cache } from "react"/.test(VENDOR_WRAPPER));
    assert.ok(!/new Map\(|globalThis\.|const __cache/.test(ALL_WRAPPERS));
  });
});
