#!/usr/bin/env node
/**
 * LOCAL-ONLY MANUAL-TEST FIXTURE for the Claim Reviewer campaign-evaluation UI.
 *
 * Run with:
 *   npx supabase start           # if the local stack is not already up
 *   npx supabase migration up --local
 *   node scripts/campaign-evaluation-manual-fixture.mjs
 *
 * Then open the URL it prints, sign in with the credentials it prints, and press
 * "Evaluate campaigns".
 *
 * ============================================================================
 * THIS IS NOT A MIGRATION AND MUST NEVER BECOME ONE
 * ============================================================================
 * It creates synthetic Vendor, Retailer, staff, product, receipt, sale and campaign
 * rows so a human can exercise the screen. None of it belongs in schema history, and
 * none of it may ever reach a hosted project.
 *
 * ============================================================================
 * IT REFUSES TO RUN AGAINST ANYTHING BUT THE LOCAL STACK
 * ============================================================================
 * Two independent guards, both checked before a single row is written:
 *
 *   1. `supabase status -o json` must report an API_URL on 127.0.0.1 or localhost.
 *      A linked or remote project reports a supabase.co host and is refused.
 *   2. Every write goes through `docker exec` into the LOCAL database container
 *      named in supabase/config.toml. There is no network path to a hosted database
 *      in this file at all — no connection string, no service-role REST write to a
 *      remote host, and no `--linked` anything.
 *
 * ============================================================================
 * IT IS IDEMPOTENT
 * ============================================================================
 * Every run first deletes anything a previous run created, matched on the `cme-`
 * prefix, then rebuilds it. Run it as often as you like. `--cleanup` deletes and
 * stops.
 *
 * ============================================================================
 * NO REAL PERSONAL DATA
 * ============================================================================
 * Names are "CME <role>", emails end in @test.invalid, and passwords are generated
 * per run with crypto.randomUUID(). Nothing is hard-coded or written to disk.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "cme-";

function fatal(message) {
  console.error(`\n  FIXTURE FAILED: ${message}\n`);
  process.exit(1);
}

/* ---------------------------------------------------------------------------
 * Guard 1 — the local stack, and only the local stack
 * ------------------------------------------------------------------------- */
function supabaseStatus() {
  let raw;
  try {
    raw = execFileSync("npx", ["supabase", "status", "-o", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fatal(
      "could not read `supabase status`. Is the local stack running? Try `npx supabase start`.\n" +
        String(error?.stderr ?? error?.message ?? error),
    );
  }
  const start = raw.indexOf("{");
  if (start === -1) fatal("`supabase status -o json` produced no JSON");
  return JSON.parse(raw.slice(start));
}

const STATUS = supabaseStatus();
const API_URL = STATUS.API_URL;
const SERVICE_ROLE_KEY = STATUS.SERVICE_ROLE_KEY;

if (!API_URL || !SERVICE_ROLE_KEY) {
  fatal("supabase status did not report API_URL / SERVICE_ROLE_KEY");
}

const host = (() => {
  try {
    return new URL(API_URL).hostname;
  } catch {
    return "";
  }
})();

if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
  fatal(
    `refusing to run: API_URL host is "${host}", which is not the local stack.\n` +
      "  This fixture writes synthetic data and must NEVER touch a hosted project.",
  );
}

/* ---------------------------------------------------------------------------
 * Guard 2 — every write goes into the local container, by name
 * ------------------------------------------------------------------------- */
const DB_CONTAINER = (() => {
  const config = readFileSync(join(ROOT, "supabase/config.toml"), "utf8");
  const id = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (!id) fatal("could not read project_id from supabase/config.toml");
  return `supabase_db_${id}`;
})();

function sql(statement, { quiet = true } = {}) {
  try {
    return execFileSync(
      "docker",
      [
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        ...(quiet ? ["-t", "-A"] : []),
        "-c",
        statement,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (error) {
    fatal(
      "SQL failed:\n" + String(error?.stderr ?? error?.message ?? error),
    );
  }
}

function lit(value) {
  return value === null || value === undefined
    ? "null"
    : `'${String(value).replace(/'/g, "''")}'`;
}

/* ---------------------------------------------------------------------------
 * Cleanup — matched on the prefix, so a re-run is safe
 * ------------------------------------------------------------------------- */
function cleanup() {
  // Order matters: evidence and rewards reference sales, which reference receipts.
  //
  // THE EVIDENCE TABLES ARE APPEND-ONLY BY TRIGGER, and deliberately so — Migration 65
  // refuses an UPDATE or DELETE on an evaluation, an item qualification or a reward
  // from EVERY writer, including the table owner. That guard is exactly right for the
  // product and exactly in the way of a local teardown, so this block suspends user
  // triggers for the duration of the delete and restores them immediately after. It is
  // the standard fixture-teardown escape, it runs ONLY here, and it is one more reason
  // this file may never touch a hosted project.
  sql(`
    set session_replication_role = replica;
    do $$
    declare v_orgs uuid[]; v_users uuid[];
    begin
      select coalesce(array_agg(id), '{}') into v_orgs
        from public.organizations where name like 'CME %';
      select coalesce(array_agg(id), '{}') into v_users
        from public.profiles where first_name = 'CME';

      delete from public.campaign_rewards
       where vendor_organization_id = any(v_orgs);
      delete from public.campaign_sale_item_qualifications
       where campaign_id in (select id from public.campaigns
                             where vendor_organization_id = any(v_orgs));
      delete from public.campaign_sale_evaluations
       where vendor_organization_id = any(v_orgs);
      delete from public.campaign_subject_accumulators
       where campaign_version_id in (
         select cv.id from public.campaign_versions cv
         join public.campaigns c on c.id = cv.campaign_id
         where c.vendor_organization_id = any(v_orgs));

      delete from public.audit_logs where organization_id = any(v_orgs);

      delete from public.verified_sale_items
       where vendor_organization_id = any(v_orgs);
      delete from public.verified_sales
       where vendor_organization_id = any(v_orgs);
      delete from public.receipt_product_review_decisions
       where vendor_organization_id = any(v_orgs);
      delete from public.receipt_review_decisions
       where vendor_organization_id = any(v_orgs);
      delete from public.receipt_qualification_events
       where vendor_organization_id = any(v_orgs);
      delete from public.receipt_confirmation_products
       where receipt_confirmation_id in (
         select rc.id from public.receipt_confirmations rc
         join public.receipt_submissions rs on rs.id = rc.receipt_submission_id
         where rs.retailer_organization_id = any(v_orgs));
      delete from public.receipt_confirmations
       where receipt_submission_id in (
         select id from public.receipt_submissions
         where retailer_organization_id = any(v_orgs));
      -- storage.objects is NOT deleted: storage.protect_delete() refuses a direct
      -- delete and the Storage API is the only supported path. The rows left behind
      -- are inert local placeholders whose names are per-run uuids, so they never
      -- collide with a later run and never affect the screen under test.
      delete from public.receipt_submissions
       where retailer_organization_id = any(v_orgs);

      delete from public.campaign_eligible_products
       where campaign_version_id in (
         select cv.id from public.campaign_versions cv
         join public.campaigns c on c.id = cv.campaign_id
         where c.vendor_organization_id = any(v_orgs));
      delete from public.campaign_eligible_retailers
       where campaign_version_id in (
         select cv.id from public.campaign_versions cv
         join public.campaigns c on c.id = cv.campaign_id
         where c.vendor_organization_id = any(v_orgs));
      delete from public.campaign_version_status_history
       where campaign_id in (select id from public.campaigns
                             where vendor_organization_id = any(v_orgs));
      -- campaigns_draft_has_no_published_version forbids nulling the pointers on a
      -- PUBLISHED campaign, so the campaign row is deleted outright at the end and the
      -- version rows are removed first in dependency order.
      delete from public.campaign_version_products
       where campaign_version_id in (
         select cv.id from public.campaign_versions cv
         join public.campaigns c on c.id = cv.campaign_id
         where c.vendor_organization_id = any(v_orgs));
      delete from public.campaign_rule_tiers
       where campaign_rule_id in (
         select r.id from public.campaign_rules r
         join public.campaign_versions cv on cv.id = r.campaign_version_id
         join public.campaigns c on c.id = cv.campaign_id
         where c.vendor_organization_id = any(v_orgs));
      delete from public.campaign_rules
       where campaign_version_id in (
         select cv.id from public.campaign_versions cv
         join public.campaigns c on c.id = cv.campaign_id
         where c.vendor_organization_id = any(v_orgs));
      delete from public.campaign_versions
       where campaign_id in (select id from public.campaigns
                             where vendor_organization_id = any(v_orgs));
      delete from public.campaigns where vendor_organization_id = any(v_orgs);

      delete from public.vendor_product_retailer_assignments
       where vendor_product_id in (select id from public.vendor_products
                                   where vendor_organization_id = any(v_orgs));
      delete from public.vendor_product_status_history
       where vendor_product_id in (select id from public.vendor_products
                                   where vendor_organization_id = any(v_orgs));
      delete from public.vendor_products where vendor_organization_id = any(v_orgs);
      delete from public.vendor_retailers
       where vendor_organization_id = any(v_orgs) or retailer_organization_id = any(v_orgs);
      delete from public.retailer_shops where retailer_organization_id = any(v_orgs);

      delete from public.member_roles
       where organization_member_id in (select id from public.organization_members
                                        where organization_id = any(v_orgs));
      delete from public.organization_members where organization_id = any(v_orgs);
      delete from public.organizations where id = any(v_orgs);
      delete from public.profiles where id = any(v_users);
      -- auth.identities BEFORE auth.users, and explicitly: user triggers are suspended
      -- for this block, so the ON DELETE CASCADE that would normally clear them does
      -- not fire. An orphaned identity makes GoTrue refuse the same email on the next
      -- run with "Database error checking email" — silently, and only on a re-run.
      delete from auth.identities where user_id = any(v_users);
      delete from auth.sessions where user_id = any(v_users);
      delete from auth.refresh_tokens where user_id = any(v_users::text[]);
      delete from auth.users where id = any(v_users);
    end;
    $$;
    set session_replication_role = origin;
  `);
}

/* ---------------------------------------------------------------------------
 * Auth users, through the local Auth admin API
 * ------------------------------------------------------------------------- */
async function createUser(label, password) {
  const email = `${PREFIX}${label}@test.invalid`;
  const response = await fetch(`${API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await response.json();
  if (!response.ok || !body?.id) {
    fatal(`could not create the local ${label} user: ${JSON.stringify(body)}`);
  }
  return { id: body.id, email, password };
}

/* ---------------------------------------------------------------------------
 * Build
 * ------------------------------------------------------------------------- */
async function build() {
  cleanup();

  const password = `Cme-${randomUUID()}`;
  const reviewer = await createUser("reviewer", password);
  const staff = await createUser("staff", password);
  const admin = await createUser("admin", password);

  const ids = {
    vendor: randomUUID(),
    retailer: randomUUID(),
    shop: randomUUID(),
    p1: randomUUID(),
    p2: randomUUID(),
    p3: randomUUID(),
    receipt: randomUUID(),
  };

  // ---- Tenants, people and products ---------------------------------------
  sql(`
    insert into public.profiles (id, first_name, last_name, status) values
      (${lit(reviewer.id)}, 'CME', 'Reviewer', 'ACTIVE'),
      (${lit(staff.id)},    'CME', 'Staff',    'ACTIVE'),
      (${lit(admin.id)},    'CME', 'Admin',    'ACTIVE')
    on conflict (id) do nothing;

    insert into public.organizations (id, name, organization_type, status, country_code, default_currency) values
      (${lit(ids.vendor)},   'CME Vendor',   'VENDOR',   'ACTIVE', 'AE', 'AED'),
      (${lit(ids.retailer)}, 'CME Retailer', 'RETAILER', 'ACTIVE', 'AE', 'AED');

    insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
    values (${lit(ids.vendor)}, ${lit(ids.retailer)}, 'ACTIVE');

    insert into public.retailer_shops (id, retailer_organization_id, name, code, status, timezone_name)
    values (${lit(ids.shop)}, ${lit(ids.retailer)}, 'CME Shop', 'CME', 'ACTIVE', 'Asia/Dubai');

    insert into public.vendor_products (id, vendor_organization_id, product_code, product_name, status, created_by_profile_id) values
      (${lit(ids.p1)}, ${lit(ids.vendor)}, 'CME-1', 'CME Shampoo 400ml', 'ACTIVE', ${lit(admin.id)}),
      (${lit(ids.p2)}, ${lit(ids.vendor)}, 'CME-2', 'CME Conditioner 250ml', 'ACTIVE', ${lit(admin.id)}),
      (${lit(ids.p3)}, ${lit(ids.vendor)}, 'CME-3', 'CME Hair Oil 100ml', 'ACTIVE', ${lit(admin.id)});

    insert into public.vendor_product_retailer_assignments
      (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id, assigned_at, updated_at)
    select p, ${lit(ids.retailer)}, 'ACTIVE', ${lit(admin.id)}, now() - interval '10 days', now()
    from unnest(array[${lit(ids.p1)}, ${lit(ids.p2)}, ${lit(ids.p3)}]::uuid[]) as p;
  `);

  // ---- Memberships and roles ----------------------------------------------
  sql(`
    do $$
    declare m uuid;
    begin
      insert into public.organization_members (organization_id, user_id, status, joined_at)
      values (${lit(ids.vendor)}, ${lit(admin.id)}, 'ACTIVE', now() - interval '30 days')
      returning id into m;
      insert into public.member_roles (organization_member_id, role_id)
      select m, id from public.roles where code = 'VENDOR_SUPER_ADMIN';

      insert into public.organization_members (organization_id, user_id, status, joined_at)
      values (${lit(ids.vendor)}, ${lit(reviewer.id)}, 'ACTIVE', now() - interval '30 days')
      returning id into m;
      insert into public.member_roles (organization_member_id, role_id)
      select m, id from public.roles where code = 'CLAIM_REVIEWER';

      insert into public.organization_members (organization_id, user_id, status, joined_at)
      values (${lit(ids.retailer)}, ${lit(staff.id)}, 'ACTIVE', now() - interval '30 days')
      returning id into m;
      insert into public.member_roles (organization_member_id, role_id)
      select m, id from public.roles where code = 'SALES_STAFF';
    end;
    $$;
  `);

  // ---- The receipt, carried to a complete authoritative sale ---------------
  // Through the real RPCs, acting as the real people, so every trigger and guard
  // that a production receipt passes is passed here too. The sale instant sits two
  // hours ahead of now so it falls inside the status-history intervals the campaign
  // publishes below open at publish time.
  sql(`
    do $$
    declare v_local timestamp; v_path text;
    begin
      v_local := date_trunc('minute', (now() + interval '2 hours') at time zone 'Asia/Dubai');
      v_path := 'cme/${ids.receipt}.png';

      insert into public.receipt_submissions (
        id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
        storage_bucket, storage_object_path, original_file_name, mime_type,
        file_size_bytes, file_sha256, status, submitted_at)
      values (${lit(ids.receipt)}, ${lit(ids.retailer)}, ${lit(ids.shop)}, ${lit(staff.id)},
        'receipts', v_path, 'cme-receipt.png', 'image/png',
        20480, encode(gen_random_bytes(32), 'hex'), 'SUBMITTED', now() - interval '1 day');
      insert into storage.objects (bucket_id, name, owner) values ('receipts', v_path, null);

      perform set_config('request.jwt.claims',
        json_build_object('sub', ${lit(staff.id)})::text, true);
      perform public.confirm_receipt_with_products(
        ${lit(ids.receipt)}, v_local::date, 'AED', 2::smallint, 8900::bigint,
        jsonb_build_array(
          jsonb_build_object('product_id', ${lit(ids.p1)}, 'quantity', 2),
          jsonb_build_object('product_id', ${lit(ids.p2)}, 'quantity', 3)),
        'CME Superstore', 'CME-DOC-1', v_local::time, 7500::bigint, 1400::bigint);

      insert into public.receipt_review_decisions
        (receipt_submission_id, vendor_organization_id, decision, decided_by_profile_id)
      values (${lit(ids.receipt)}, ${lit(ids.vendor)}, 'VERIFIED', ${lit(reviewer.id)});

      perform set_config('request.jwt.claims',
        json_build_object('sub', ${lit(reviewer.id)})::text, true);
      perform public.finalize_claim_receipt_sale_header(${lit(ids.receipt)}, null);
      perform public.finalize_claim_receipt_sale_items(${lit(ids.receipt)}, 'ACCEPTED');
      perform set_config('request.jwt.claims', '', true);
    end;
    $$;
  `);

  // ---- Campaigns, published AFTER the sale exists --------------------------
  // Four, chosen so the screen shows every state a reviewer must be able to read.
  sql(`
    do $$
    declare c uuid;
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', ${lit(admin.id)})::text, true);

      -- 1. QUALIFIED with a reward: every eligible product, 7 coins a unit.
      c := public.create_vendor_campaign_draft(
        'CME Everything Bonus', 'Pays on every eligible product.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
        'STACKABLE', null, 20, 'PER_UNIT_COINS', 7, null, null, null, null, null, null);
      perform public.publish_vendor_campaign(c);

      -- 2. NOT_QUALIFIED: scoped to a product this basket does not contain.
      c := public.create_vendor_campaign_draft(
        'CME Hair Oil Only', 'Scoped to a product this sale does not contain.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'SELECTED_PRODUCTS',
        'STACKABLE', null, 5, 'PER_UNIT_COINS', 5, null, null, null,
        null, null, array[${lit(ids.p3)}]::uuid[]);
      perform public.publish_vendor_campaign(c);

      -- 3. The EXCLUSIVE WINNER: higher priority, 3 coins a unit.
      c := public.create_vendor_campaign_draft(
        'CME Exclusive Winner', 'Wins its exclusivity key on priority.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
        'EXCLUSIVE', 'CME-KEY', 900, 'PER_UNIT_COINS', 3, null, null, null, null, null, null);
      perform public.publish_vendor_campaign(c);

      -- 4. The EXCLUSIVE LOSER: pays far more per unit and still loses, because the
      --    winner is chosen by PRIORITY and never by reward value.
      c := public.create_vendor_campaign_draft(
        'CME Exclusive Loser', 'Pays more per unit and still loses the key.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
        'EXCLUSIVE', 'CME-KEY', 100, 'PER_UNIT_COINS', 999, null, null, null, null, null, null);
      perform public.publish_vendor_campaign(c);

      -- 5. QUALIFIED from a SNAPSHOT: scoped to the shampoo alone, so its item rows
      --    carry NULL sale-time statuses — the state the panel must render without
      --    treating the nulls as missing data.
      c := public.create_vendor_campaign_draft(
        'CME Shampoo Snapshot', 'Frozen product selection, shampoo only.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'SELECTED_PRODUCTS',
        'STACKABLE', null, 10, 'PER_UNIT_COINS', 4, null, null, null,
        null, null, array[${lit(ids.p1)}]::uuid[]);
      perform public.publish_vendor_campaign(c);

      perform set_config('request.jwt.claims', '', true);
    end;
    $$;
  `);

  return { reviewer, staff, admin, ids, password };
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
if (process.argv.includes("--cleanup")) {
  cleanup();
  console.log("\n  Removed every CME fixture row from the LOCAL database.\n");
  process.exit(0);
}

const built = await build();

const evidence = sql(`
  select 'evaluations=' || (select count(*) from public.campaign_sale_evaluations e
                            where e.receipt_submission_id = ${lit(built.ids.receipt)})
      || ' rewards=' || (select count(*) from public.campaign_rewards r
                         where r.receipt_submission_id = ${lit(built.ids.receipt)});
`);

const campaigns = sql(`
  select string_agg(c.name || '  [' || cv.stacking_mode || ', priority ' || cv.priority || ']', E'\\n'
                    order by cv.priority desc, cv.starts_at asc, cv.id asc)
  from public.campaigns c
  join public.campaign_versions cv on cv.id = c.published_version_id
  where c.vendor_organization_id = ${lit(built.ids.vendor)};
`).split("\n").map((l) => `      ${l.trim()}`).join("\n");

console.log(`
  ============================================================================
  LOCAL CAMPAIGN-EVALUATION FIXTURE READY
  ============================================================================

  Start the app:
      npm run dev

  Sign in as the Claim Reviewer:
      Email     ${built.reviewer.email}
      Password  ${built.password}

  Open the receipt:
      http://localhost:3000/review/${built.ids.receipt}

  The sale:
      CME Shampoo 400ml     x2   (line 1)
      CME Conditioner 250ml x3   (line 2)
      5 units in total, finalized and accepted.

  Published campaigns (priority order):
${campaigns}

  Scroll to "Campaign evaluation" and press "Evaluate campaigns".

  EXPECTED FIRST RESULT — five cards, in campaign-priority order:

    1. CME Exclusive Winner   Qualified      2 products, 5 units, 15 coins
                              Products: CME-1 line 1 (2 units), CME-2 line 2 (3)
                              Both badged "Eligible at sale time" + Active/Active

    2. CME Exclusive Loser    Not qualified  "Another exclusive campaign had higher
                                              priority for this sale."
                              0 products, 0 units, NO product rows, NO reward.
                              It pays 999 coins a unit and still loses — the winner
                              is chosen by priority, never by reward value.

    3. CME Everything Bonus   Qualified      2 products, 5 units, 35 coins
                              Products: CME-1 line 1 (2 units), CME-2 line 2 (3)

    4. CME Shampoo Snapshot   Qualified      1 product, 2 units, 8 coins
                              Product: CME-1 line 1, badged "Published campaign
                              product selection" with NO sale-time status badges —
                              a SNAPSHOT campaign records no sale-time status, and
                              their absence is not missing data.

    5. CME Hair Oil Only      Not qualified  "No products on this sale qualified for
                                              the campaign."

      Message: "Campaign evaluation completed. 5 campaign evaluations created,
                3 rewards created."

  EXPECTED SECOND PRESS ("Re-evaluate campaigns"):
      Message: "Existing campaign evaluation returned. No duplicate reward was
                created. 5 campaigns already evaluated."
      All five cards and every coin amount are UNCHANGED, and no card gains a
      second reward.

  Stored evidence right now (before you press anything):
      ${evidence}

  Clean up when finished:
      node scripts/campaign-evaluation-manual-fixture.mjs --cleanup
`);
