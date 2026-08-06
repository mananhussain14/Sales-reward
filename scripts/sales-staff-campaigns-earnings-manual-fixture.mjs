#!/usr/bin/env node
/**
 * LOCAL-ONLY MANUAL-TEST FIXTURE for the Sales Staff Current Campaigns and My Campaign
 * Earnings screens.
 *
 * Run with:
 *   npx supabase start           # if the local stack is not already up
 *   npx supabase migration up --local
 *   node scripts/sales-staff-campaigns-earnings-manual-fixture.mjs
 *
 * Then follow the instructions it prints.
 *
 * ============================================================================
 * THIS IS NOT A MIGRATION AND MUST NEVER BECOME ONE
 * ============================================================================
 * It creates synthetic Vendor, Retailer, staff, product, receipt, sale and campaign rows
 * so a human can exercise the screens. None of it belongs in schema history, and none of
 * it may ever reach a hosted project.
 *
 * ============================================================================
 * IT REFUSES TO RUN AGAINST ANYTHING BUT THE LOCAL STACK
 * ============================================================================
 * Two independent guards, both checked before a single row is written:
 *
 *   1. `supabase status -o json` must report an API_URL on 127.0.0.1 / localhost / [::1].
 *      A linked or remote project reports a supabase.co host and is refused outright.
 *   2. Every write goes through `docker exec` into the LOCAL database container named in
 *      supabase/config.toml. There is no network path to a hosted database in this file
 *      at all — no connection string, no `--linked` anything, and no hosted REST write.
 *
 * ============================================================================
 * REWARDS ARE EARNED, NOT INSERTED
 * ============================================================================
 * Not one campaign_rewards, campaign_sale_evaluations or campaign_subject_accumulators
 * row is written directly. The two receipts are carried through the REAL
 * confirm / verify / finalize path and then evaluated with evaluate_receipt_campaigns()
 * as the real Claim Reviewer, so every figure the screens display was produced by the
 * deployed engine. A hand-inserted reward would let the UI agree with a number the
 * database would never have produced.
 *
 * ============================================================================
 * IT IS IDEMPOTENT
 * ============================================================================
 * Every run first deletes anything a previous run created, matched on the `sse-` prefix,
 * then rebuilds it. Run it as often as you like. `--cleanup` deletes and stops.
 *
 * ============================================================================
 * NO REAL PERSONAL DATA
 * ============================================================================
 * Names are "SSE <role>", emails end in @test.invalid, and the password is generated per
 * run with crypto.randomUUID(). Nothing is hard-coded, and nothing is written to disk —
 * this script never touches .env.local.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "sse-";

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

// A hosted project reports a supabase.co host. Named explicitly so the refusal is
// obvious to a reader, not merely implied by the allow-list.
if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
  fatal(
    `refusing to run: API_URL host is "${host}", which is not the local stack.\n` +
      "  A hosted project reports a supabase.co host. This fixture writes synthetic\n" +
      "  data and must NEVER touch one.",
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
    fatal("SQL failed:\n" + String(error?.stderr ?? error?.message ?? error));
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
  // The evidence tables are APPEND-ONLY BY TRIGGER: Migration 65 refuses an UPDATE or
  // DELETE on an evaluation, an item qualification or a reward from every writer,
  // including the owner. That guard is right for the product and in the way of a local
  // teardown, so user triggers are suspended for this block and restored immediately
  // after. It runs ONLY here, and it is one more reason this file may never touch a
  // hosted project.
  sql(`
    set session_replication_role = replica;
    do $$
    declare v_orgs uuid[]; v_users uuid[];
    begin
      select coalesce(array_agg(id), '{}') into v_orgs
        from public.organizations where name like 'SSE %';
      select coalesce(array_agg(id), '{}') into v_users
        from public.profiles where first_name = 'SSE';

      delete from public.campaign_rewards where vendor_organization_id = any(v_orgs);
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

      delete from public.verified_sale_items where vendor_organization_id = any(v_orgs);
      delete from public.verified_sales where vendor_organization_id = any(v_orgs);
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
      -- delete and the Storage API is the only supported path. The rows left behind are
      -- inert local placeholders whose names are per-run uuids.
      delete from public.receipt_submissions where retailer_organization_id = any(v_orgs);

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
      -- campaigns_draft_has_no_published_version forbids nulling the pointers on a
      -- PUBLISHED campaign, so the campaign row goes last and goes outright.
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
      delete from public.retailer_shop_members
       where organization_member_id in (select id from public.organization_members
                                        where organization_id = any(v_orgs));
      delete from public.retailer_shops where retailer_organization_id = any(v_orgs);

      delete from public.member_roles
       where organization_member_id in (select id from public.organization_members
                                        where organization_id = any(v_orgs));
      delete from public.organization_members where organization_id = any(v_orgs);
      delete from public.organizations where id = any(v_orgs);
      delete from public.profiles where id = any(v_users);
      -- auth.identities BEFORE auth.users, and explicitly: user triggers are suspended
      -- for this block, so the ON DELETE CASCADE that would normally clear them does not
      -- fire. An orphaned identity makes GoTrue refuse the same email on the next run
      -- with "Database error checking email" — silently, and only on a re-run.
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
 * Auth users, through the LOCAL Auth admin API
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
 * One receipt, carried to a complete ACCEPTED authoritative sale
 * ------------------------------------------------------------------------- */
function sellThrough({ receiptId, retailer, shop, seller, vendor, reviewer, lines }) {
  const items = lines
    .map((l) => `jsonb_build_object('product_id', ${lit(l.product)}, 'quantity', ${l.qty})`)
    .join(", ");

  sql(`
    do $$
    declare v_local timestamp; v_path text;
    begin
      v_local := date_trunc('minute', (now() + interval '2 hours') at time zone 'Asia/Dubai');
      v_path := 'sse/${receiptId}.png';

      insert into public.receipt_submissions (
        id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
        storage_bucket, storage_object_path, original_file_name, mime_type,
        file_size_bytes, file_sha256, status, submitted_at)
      values (${lit(receiptId)}, ${lit(retailer)}, ${lit(shop)}, ${lit(seller)},
        'receipts', v_path, 'sse-receipt.png', 'image/png',
        20480, encode(gen_random_bytes(32), 'hex'), 'SUBMITTED', now() - interval '1 day');
      insert into storage.objects (bucket_id, name, owner) values ('receipts', v_path, null);

      perform set_config('request.jwt.claims',
        json_build_object('sub', ${lit(seller)})::text, true);
      perform public.confirm_receipt_with_products(
        ${lit(receiptId)}, v_local::date, 'AED', 2::smallint, 8900::bigint,
        jsonb_build_array(${items}),
        'SSE Superstore', 'SSE-DOC', v_local::time, 7500::bigint, 1400::bigint);

      insert into public.receipt_review_decisions
        (receipt_submission_id, vendor_organization_id, decision, decided_by_profile_id)
      values (${lit(receiptId)}, ${lit(vendor)}, 'VERIFIED', ${lit(reviewer)});

      perform set_config('request.jwt.claims',
        json_build_object('sub', ${lit(reviewer)})::text, true);
      perform public.finalize_claim_receipt_sale_header(${lit(receiptId)}, null);
      perform public.finalize_claim_receipt_sale_items(${lit(receiptId)}, 'ACCEPTED');
      perform set_config('request.jwt.claims', '', true);
    end;
    $$;
  `);
}

/* ---------------------------------------------------------------------------
 * Build
 * ------------------------------------------------------------------------- */
async function build() {
  cleanup();

  const password = `Sse-${randomUUID()}`;
  const staff = await createUser("staff", password);
  const colleague = await createUser("colleague", password);
  const reviewer = await createUser("reviewer", password);
  const admin = await createUser("admin", password);

  const ids = {
    vendor: randomUUID(),
    retailer: randomUUID(),
    shop: randomUUID(),
    p1: randomUUID(),
    p2: randomUUID(),
    p3: randomUUID(),
    receiptStaff: randomUUID(),
    receiptColleague: randomUUID(),
  };

  // ---- Tenants, people and products ---------------------------------------
  sql(`
    insert into public.profiles (id, first_name, last_name, status) values
      (${lit(staff.id)},     'SSE', 'Seller',    'ACTIVE'),
      (${lit(colleague.id)}, 'SSE', 'Colleague', 'ACTIVE'),
      (${lit(reviewer.id)},  'SSE', 'Reviewer',  'ACTIVE'),
      (${lit(admin.id)},     'SSE', 'Admin',     'ACTIVE')
    on conflict (id) do nothing;

    insert into public.organizations (id, name, organization_type, status, country_code, default_currency) values
      (${lit(ids.vendor)},   'SSE Vendor',   'VENDOR',   'ACTIVE', 'AE', 'AED'),
      (${lit(ids.retailer)}, 'SSE Retailer', 'RETAILER', 'ACTIVE', 'AE', 'AED');

    insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
    values (${lit(ids.vendor)}, ${lit(ids.retailer)}, 'ACTIVE');

    insert into public.retailer_shops (id, retailer_organization_id, name, code, status, timezone_name)
    values (${lit(ids.shop)}, ${lit(ids.retailer)}, 'SSE High Street', 'SSE', 'ACTIVE', 'Asia/Dubai');

    insert into public.vendor_products (id, vendor_organization_id, product_code, product_name, status, created_by_profile_id) values
      (${lit(ids.p1)}, ${lit(ids.vendor)}, 'SSE-1', 'SSE Shampoo 400ml', 'ACTIVE', ${lit(admin.id)}),
      (${lit(ids.p2)}, ${lit(ids.vendor)}, 'SSE-2', 'SSE Conditioner 250ml', 'ACTIVE', ${lit(admin.id)}),
      (${lit(ids.p3)}, ${lit(ids.vendor)}, 'SSE-3', 'SSE Hair Oil 100ml', 'ACTIVE', ${lit(admin.id)});

    insert into public.vendor_product_retailer_assignments
      (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id, assigned_at, updated_at)
    select p, ${lit(ids.retailer)}, 'ACTIVE', ${lit(admin.id)}, now() - interval '10 days', now()
    from unnest(array[${lit(ids.p1)}, ${lit(ids.p2)}, ${lit(ids.p3)}]::uuid[]) as p;
  `);

  // ---- Memberships and roles ----------------------------------------------
  // BOTH sellers are SALES_STAFF at the SAME Retailer. That is the arrangement the
  // isolation check depends on: a Retailer-level filter would leak one to the other.
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
      insert into public.retailer_shop_members (organization_member_id, retailer_shop_id, assigned_by)
      values (m, ${lit(ids.shop)}, ${lit(admin.id)});

      insert into public.organization_members (organization_id, user_id, status, joined_at)
      values (${lit(ids.retailer)}, ${lit(colleague.id)}, 'ACTIVE', now() - interval '30 days')
      returning id into m;
      insert into public.member_roles (organization_member_id, role_id)
      select m, id from public.roles where code = 'SALES_STAFF';
      insert into public.retailer_shop_members (organization_member_id, retailer_shop_id, assigned_by)
      values (m, ${lit(ids.shop)}, ${lit(admin.id)});
    end;
    $$;
  `);

  // ---- Two sales: the seller's 5 units, the colleague's 4 ------------------
  sellThrough({
    receiptId: ids.receiptStaff,
    retailer: ids.retailer,
    shop: ids.shop,
    seller: staff.id,
    vendor: ids.vendor,
    reviewer: reviewer.id,
    lines: [
      { product: ids.p1, qty: 2 },
      { product: ids.p2, qty: 3 },
    ],
  });

  sellThrough({
    receiptId: ids.receiptColleague,
    retailer: ids.retailer,
    shop: ids.shop,
    seller: colleague.id,
    vendor: ids.vendor,
    reviewer: reviewer.id,
    lines: [{ product: ids.p1, qty: 4 }],
  });

  // ---- Campaigns, published AFTER the sales exist --------------------------
  sql(`
    do $$
    declare c uuid;
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', ${lit(admin.id)})::text, true);

      -- 1. LIVE_TEMPORAL per-unit. 5 units x 7 = 35 coins for the seller.
      c := public.create_vendor_campaign_draft(
        'SSE Everyday Coins', 'Earn on every eligible product you sell.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
        'STACKABLE', null, 20, 'PER_UNIT_COINS', 7, null, null, null, null, null, null);
      perform public.publish_vendor_campaign(c);

      -- 2. A CAP THAT BITES. 5 x 5 = 25 uncapped, maximum 12 -> 12 awarded.
      c := public.create_vendor_campaign_draft(
        'SSE Capped Boost', 'Pays 5 a unit, up to 12 coins in total.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
        'STACKABLE', null, 15, 'PER_UNIT_COINS', 5, null, null, 12, null, null, null);
      perform public.publish_vendor_campaign(c);

      -- 3. A PERSONAL TARGET the seller crosses. 5 units >= 3 -> 100 coins.
      c := public.create_vendor_campaign_draft(
        'SSE Personal Target', 'Sell 3 units to earn a bonus.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
        'STACKABLE', null, 14, 'TARGET_BONUS', null, 3, 100, null, null, null, null);
      perform public.publish_vendor_campaign(c);

      -- 4. A TEAM TARGET the COLLEAGUE crosses. 5 + 4 = 9 >= 8, and the bonus goes once,
      --    to the colleague whose sale crossed it. The seller must see team progress of
      --    9/8 and be told plainly that the bonus is not theirs.
      c := public.create_vendor_campaign_draft(
        'SSE Team Target', 'The whole shop works towards 8 units.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'RETAILER_TEAM', 'ALL_ELIGIBLE_PRODUCTS',
        'STACKABLE', null, 13, 'TARGET_BONUS', null, 8, 150, null, null, null, null);
      perform public.publish_vendor_campaign(c);

      -- 5. A SNAPSHOT campaign, shampoo only. 2 units x 4 = 8 coins.
      c := public.create_vendor_campaign_draft(
        'SSE Shampoo Snapshot', 'A frozen product selection: shampoo only.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'SELECTED_PRODUCTS',
        'STACKABLE', null, 12, 'PER_UNIT_COINS', 4, null, null, null,
        null, null, array[${lit(ids.p1)}]::uuid[]);
      perform public.publish_vendor_campaign(c);

      -- 6. A TARGET FAR OUT OF REACH. 5 of 50 units — an unfinished progress bar.
      c := public.create_vendor_campaign_draft(
        'SSE Stretch Target', 'A long way to go: 50 units.',
        now() - interval '60 days', now() + interval '30 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
        'STACKABLE', null, 11, 'TARGET_BONUS', null, 50, 500, null, null, null, null);
      perform public.publish_vendor_campaign(c);

      -- 7. SCHEDULED, not yet started. Appears under "Starting soon" and pays nothing.
      c := public.create_vendor_campaign_draft(
        'SSE Next Month Launch', 'Starts soon. Nothing counts towards it yet.',
        now() + interval '10 days', now() + interval '40 days', 'Asia/Dubai',
        'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
        'STACKABLE', null, 10, 'PER_UNIT_COINS', 6, null, null, null, null, null, null);
      perform public.publish_vendor_campaign(c);

      perform set_config('request.jwt.claims', '', true);
    end;
    $$;
  `);

  // ---- Evaluate, through the deployed engine, as the reviewer --------------
  // The SELLER'S receipt first, then the COLLEAGUE'S — so the team target is crossed by
  // the colleague's sale and the bonus lands on them, which is the case the screen must
  // report honestly.
  sql(`
    do $$
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', ${lit(reviewer.id)})::text, true);
      perform 1 from public.evaluate_receipt_campaigns(${lit(ids.receiptStaff)});
      perform 1 from public.evaluate_receipt_campaigns(${lit(ids.receiptColleague)});
      perform set_config('request.jwt.claims', '', true);
    end;
    $$;
  `);

  return { staff, colleague, reviewer, admin, ids, password };
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
if (process.argv.includes("--cleanup")) {
  cleanup();
  console.log("\n  Removed every SSE fixture row from the LOCAL database.\n");
  process.exit(0);
}

const built = await build();

/* ---------------------------------------------------------------------------
 * Data-layer smoke test — the six exact RPCs, as the fixture seller
 * ------------------------------------------------------------------------- */
function asSeller(query) {
  const raw = sql(`
    set local role authenticated;
    select set_config('request.jwt.claims',
      json_build_object('sub', ${lit(built.staff.id)})::text, true);
    ${query}
  `);
  // psql echoes the SET command tag and the set_config result before the row we want.
  // Both are stripped so the printed report shows only the answer.
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "SET" && !line.trim().startsWith('{"sub"'))
    .join("\n")
    .trim();
}

const smoke = {
  campaigns: asSeller(`
    select string_agg(campaign_name || ' [' || derived_state || ']', E'\\n' order by campaign_name)
    from public.list_my_staff_campaigns();
  `),
  rewards: asSeller(`
    select string_agg(
             campaign_name || ' = ' || reward_coins || ' coins'
             || case when coins_uncapped is distinct from reward_coins
                     then ' (capped from ' || coins_uncapped || ')' else '' end,
             E'\\n' order by campaign_name)
    from public.get_my_campaign_rewards(20, null, null);
  `),
  summary: asSeller(`
    select 'total=' || total_reward_coins
        || ' month=' || current_month_reward_coins
        || ' sales=' || rewarded_sale_count
        || ' campaigns=' || rewarded_campaign_count
    from public.get_my_campaign_earnings_summary();
  `),
  progress: asSeller(`
    select string_agg(
             campaign_name || ': ' || progress_units || '/' || target_units
             || ' [' || performance_scope || ']'
             || ' reached=' || target_reached
             || ' mine=' || bonus_awarded_to_me,
             E'\\n' order by campaign_name)
    from public.get_my_campaign_target_progress();
  `),
  colleagueLeak: asSeller(`
    select count(*)::text from public.get_my_campaign_rewards(100, null, null) r
    where r.receipt_submission_id = ${lit(built.ids.receiptColleague)};
  `),
  pageOne: asSeller(`
    select count(distinct campaign_reward_id)::text || '/' || count(*)::text
    from public.get_my_campaign_rewards(20, null, null);
  `),
};

const indent = (text) =>
  (text || "(none)")
    .split("\n")
    .map((line) => `      ${line.trim()}`)
    .join("\n");

console.log(`
  ============================================================================
  LOCAL SALES STAFF CAMPAIGNS AND EARNINGS FIXTURE READY
  ============================================================================

  Start the app:
      npm run dev

  Sign in as the Sales Staff seller:
      Email     ${built.staff.email}
      Password  ${built.password}

  A colleague at the SAME Retailer also exists, so you can confirm isolation:
      Email     ${built.colleague.email}
      Password  ${built.password}

  ---------------------------------------------------------------------------
  ROUTES TO TEST
  ---------------------------------------------------------------------------
      http://localhost:3000/retailer/my-campaigns      Current campaigns
      http://localhost:3000/retailer/my-earnings       My campaign earnings

      Open any campaign card to reach its detail page.

  ---------------------------------------------------------------------------
  WHAT THE DATABASE ACTUALLY RETURNS FOR THIS SELLER
  ---------------------------------------------------------------------------
  Campaigns (list_my_staff_campaigns):
${indent(smoke.campaigns)}

  Rewards (get_my_campaign_rewards):
${indent(smoke.rewards)}

  Summary (get_my_campaign_earnings_summary):
${indent(smoke.summary)}

  Target progress (get_my_campaign_target_progress):
${indent(smoke.progress)}

  ---------------------------------------------------------------------------
  WHAT TO CHECK ON SCREEN
  ---------------------------------------------------------------------------
  Current campaigns
      * "SSE Next Month Launch" sits under "Starting soon" with a Scheduled badge.
      * Every other campaign sits under "Running now" with an Active badge.
      * "SSE Everyday Coins", "SSE Capped Boost" and "SSE Shampoo Snapshot" show
        NO progress bar — they have no target.
      * "SSE Personal Target" shows "Your progress" 5 of 3 and "Bonus awarded to you".
      * "SSE Stretch Target" shows "Your progress" 5 of 50 and "Target not reached yet".
      * "SSE Team Target" shows "TEAM PROGRESS" 9 of 8, "Team target reached", and says
        the bonus went to another team member. It must NOT say you earned it.

  Campaign detail
      * "SSE Shampoo Snapshot" explains "Published campaign product selection" and
        lists ONE product.
      * "SSE Everyday Coins" explains "Eligibility checked at sale time" and lists
        all three.

  My campaign earnings
      * Total campaign coins earned  155
      * Coins earned this month      155
      * Rewarded sales               1
      * Rewarded campaigns           4
      * "SSE Capped Boost" shows 12 coins and says it was reduced by the campaign
        maximum from 25.
      * "SSE Personal Target" shows 100 coins as a target bonus.
      * NOTHING says wallet, balance, redeemable or payout, and the notice states
        those features do not exist yet.
      * The colleague's reward for "SSE Team Target" (150 coins) does NOT appear.

  ---------------------------------------------------------------------------
  ISOLATION AND PAGINATION CHECKS (run against the database, above)
  ---------------------------------------------------------------------------
      Colleague receipts visible to this seller : ${smoke.colleagueLeak}   (must be 0)
      Distinct reward ids / rows on page one    : ${smoke.pageOne}   (must be equal)

  ---------------------------------------------------------------------------
  POINTING THE APP AT LOCAL SUPABASE
  ---------------------------------------------------------------------------
  This script does NOT modify .env.local. To test against the local stack, set these
  three variables yourself and restart \`npm run dev\`:

      NEXT_PUBLIC_SUPABASE_URL           the API URL from \`npx supabase status\`
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   the PUBLISHABLE_KEY from the same output
      SUPABASE_SERVICE_ROLE_KEY          the SECRET_KEY from the same output

  Read them with:
      npx supabase status

  Keep a copy of your hosted values before you overwrite them, and restore them when
  you are finished. Never paste any of these values into a commit, an issue or a chat.

  ---------------------------------------------------------------------------
  CLEAN UP
  ---------------------------------------------------------------------------
      node scripts/sales-staff-campaigns-earnings-manual-fixture.mjs --cleanup
`);
