#!/usr/bin/env node
/**
 * LOCAL INTEGRATION TEST for the `submit-receipt` Edge Function.
 *
 * Run with:
 *   npx supabase start                          # if the stack is not already up
 *   npx supabase db reset                       # apply every migration
 *   npx supabase functions serve submit-receipt # in another terminal
 *   npm run test:receipts:integration
 *
 * Exits 0 on success and NON-ZERO on the first failure, so it is usable in CI.
 *
 * ============================================================================
 * WHY THIS EXISTS WHEN THERE IS ALREADY A pgTAP SUITE AND A SOURCE-SAFETY TEST
 * ============================================================================
 * The pgTAP suite proves what the DATABASE enforces. The source-safety test
 * proves what the function's SOURCE says. Neither can prove what the deployed
 * unit actually DOES with a real JWT, a real multipart body, a real Storage
 * bucket and a real service-role key — which is the only thing that matters for
 * a function that holds that key. This drives the real HTTP endpoint end to end.
 *
 * ============================================================================
 * NO SECRET IS TRACKED IN THIS FILE
 * ============================================================================
 * Every key, URL and password is obtained at RUNTIME:
 *   - API URL / anon / service-role keys come from `supabase status -o json`;
 *   - fixture passwords are generated per run with crypto.randomUUID().
 * Nothing is hard-coded, defaulted, or written to disk.
 *
 * ============================================================================
 * WHY FIXTURES GO THROUGH psql RATHER THAN PostgREST
 * ============================================================================
 * `service_role` holds NO table privileges in this schema — every migration
 * revokes them, and a REST insert as service_role returns 42501. That is the
 * posture the design wants, so the fixtures are applied with psql inside the
 * local database container instead of by weakening it.
 *
 * ============================================================================
 * WHY EVERY REQUEST CARRIES AN `Origin` HEADER
 * ============================================================================
 * This suite once passed against a function a browser could not use. `fetch`
 * from Node speaks HTTP and enforces nothing: it reads a response whose CORS
 * headers are absent, wrong, or incomplete exactly as happily as a correct one.
 * A Flutter Web build does not — its preflight succeeded, its POST was blocked,
 * and no receipt appeared, while this file reported ten green sections.
 *
 * So every request to the function below is sent as a browser would send it —
 * with an `Origin`, an `apikey` and an `x-client-info` — and the response headers
 * a browser CONSULTS are asserted on each outcome that matters: the preflight,
 * and the unauthenticated, denied, invalid-file, successful, duplicate and
 * upload-failed replies. `checkBrowserReadable` is the assertion Node will not
 * make on its own.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// ============================================================================
// Tiny test harness
// ============================================================================
let passed = 0;
const failures = [];
let currentCase = "(startup)";

function check(condition, description, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${description}\n`);
  } else {
    failures.push({ case: currentCase, description, detail });
    process.stdout.write(`  FAIL ${description}\n`);
    if (detail !== undefined) process.stdout.write(`       ${detail}\n`);
  }
}

function equal(actual, expected, description) {
  check(
    actual === expected,
    description,
    actual === expected ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function section(name) {
  currentCase = name;
  process.stdout.write(`\n${name}\n`);
}

function fatal(message) {
  process.stderr.write(`\nFATAL: ${message}\n`);
  process.exit(2);
}

// ============================================================================
// Local environment, read at runtime
// ============================================================================
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
const ANON_KEY = STATUS.ANON_KEY;
const SERVICE_ROLE_KEY = STATUS.SERVICE_ROLE_KEY;
const FUNCTION_URL = `${API_URL}/functions/v1/submit-receipt`;

if (!API_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  fatal("supabase status did not report API_URL / ANON_KEY / SERVICE_ROLE_KEY");
}

/** The local database container, derived from supabase/config.toml. */
const DB_CONTAINER = (() => {
  const config = readFileSync(join(ROOT, "supabase/config.toml"), "utf8");
  const id = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (!id) fatal("could not read project_id from supabase/config.toml");
  return `supabase_db_${id}`;
})();

/** Runs SQL inside the local database container. Throws on any SQL error. */
function sql(statement, { quiet = true } = {}) {
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
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Browser behaviour
// ============================================================================
/**
 * The origin a Flutter Web dev build calls from. The value is arbitrary — the
 * policy is a wildcard — but sending one is not: a request with no `Origin` is
 * not a cross-origin request, and proves nothing about what a browser would do.
 */
const BROWSER_ORIGIN = "http://localhost:8080";

/**
 * The request headers the Supabase JS and Dart clients attach to every call,
 * including `functions.invoke`. A preflight that omits ONE of them fails, and
 * the browser blocks the POST that would have followed — the exact failure this
 * suite exists to catch. `authorization` and `content-type` alone were allowed;
 * `apikey` and `x-client-info` were not.
 */
const CLIENT_REQUEST_HEADERS = ["authorization", "apikey", "x-client-info", "content-type"];

function headerTokens(response, name) {
  return (response.headers.get(name) ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Asserts that a browser would hand this response to the page that asked for it.
 *
 * Node already has the body; `Access-Control-Allow-Origin` is what a browser
 * consults before deciding whether the caller may see it at all — its absence is
 * why a stored receipt never reached the app.
 *
 * The allowed methods and headers are strictly only read on a PREFLIGHT. They
 * are asserted on every reply anyway, because identical values across the
 * preflight, a success and every refusal is the observable consequence of one
 * shared helper producing all of them — the property that stops the policy being
 * re-stated, and drifting, per response.
 */
function checkBrowserReadable(response, label) {
  const allowOrigin = response.headers.get("access-control-allow-origin");
  check(
    allowOrigin === "*" || allowOrigin === BROWSER_ORIGIN,
    `${label}: the browser may read it (Access-Control-Allow-Origin)`,
    `got ${JSON.stringify(allowOrigin)}`,
  );

  const allowedHeaders = headerTokens(response, "access-control-allow-headers");
  for (const header of CLIENT_REQUEST_HEADERS) {
    check(
      allowedHeaders.includes(header),
      `${label}: allows the \`${header}\` request header`,
      `allowed: ${allowedHeaders.join(", ") || "(none)"}`,
    );
  }

  const allowedMethods = headerTokens(response, "access-control-allow-methods");
  for (const method of ["post", "options"]) {
    check(
      allowedMethods.includes(method),
      `${label}: advertises ${method.toUpperCase()}`,
      `allowed: ${allowedMethods.join(", ") || "(none)"}`,
    );
  }

  // The one header that would make the wildcard origin dangerous. This endpoint
  // is bearer-token only and needs no cookie, and a browser refuses `*`
  // together with credentials anyway.
  check(
    response.headers.get("access-control-allow-credentials") === null,
    `${label}: enables no ambient credentials`,
    `got ${JSON.stringify(response.headers.get("access-control-allow-credentials"))}`,
  );
}

/** Interpolating an id into SQL is only safe if it is really a uuid. */
function uuidLiteral(value) {
  if (!UUID_SHAPE.test(String(value))) fatal(`refusing to interpolate a non-uuid: ${value}`);
  return `'${value}'::uuid`;
}

// ============================================================================
// Auth helpers
// ============================================================================
const PREFIX = "itest_receipt_";

async function createUser(label) {
  const email = `${PREFIX}${label}@test.invalid`;
  const password = `Pw-${randomUUID()}`;
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
    fatal(`could not create auth user ${label}: ${response.status} ${JSON.stringify(body)}`);
  }
  return { id: body.id, email, password };
}

async function signIn(user) {
  const response = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const body = await response.json();
  if (!response.ok || !body?.access_token) {
    fatal(`could not sign in ${user.email}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

// ============================================================================
// Fixture files
// ============================================================================
function padded(signature, totalBytes) {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(signature, 0);
  // Deterministic filler so the SHA-256 of each fixture is stable across runs.
  for (let i = signature.length; i < totalBytes; i += 1) bytes[i] = i % 251;
  return bytes;
}

const JPEG_BYTES = padded([0xff, 0xd8, 0xff, 0xe0], 1024);
const PNG_BYTES = padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 900);
const PDF_BYTES = padded([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34], 700);

/**
 * Posts a multipart submission.
 *
 * `declaredType` is the multipart part's own Content-Type — the value the
 * function must IGNORE in favour of the bytes' own signature.
 */
async function submit({ token, shopId, bytes, fileName, declaredType, omitFile = false }) {
  const form = new FormData();
  if (shopId !== undefined) form.append("shop_id", shopId);
  if (!omitFile) {
    form.append("file", new Blob([bytes], { type: declaredType }), fileName);
  }

  // Sent as a browser sends it: a cross-origin request from a Flutter Web build,
  // carrying the `apikey` and `x-client-info` the Supabase client always adds.
  const headers = {
    Origin: BROWSER_ORIGIN,
    apikey: ANON_KEY,
    "x-client-info": "supabase-flutter/2.0.0",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(FUNCTION_URL, { method: "POST", headers, body: form });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* left null; the raw text is asserted instead */
  }
  // `response` is returned so the caller can assert the CORS headers a browser
  // would consult before letting the page see any of this.
  return { status: response.status, body: json, raw: text, response };
}

/** Calls a Postgres RPC over REST as the given user. */
async function rpc(token, name, args = {}) {
  const response = await fetch(`${API_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** True when an object exists at that path in the private receipts bucket. */
async function objectExists(objectPath) {
  const response = await fetch(
    `${API_URL}/storage/v1/object/receipts/${objectPath}`,
    { headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  return response.status === 200;
}

// ============================================================================
// Fixture lifecycle
// ============================================================================
function cleanup() {
  // FK-safe order. Keyed on this run's own prefix so nothing else is touched.
  sql(`
    delete from public.receipt_submissions rs
      using public.organizations o
     where o.id = rs.retailer_organization_id and o.name like '${PREFIX}%';
    delete from public.retailer_shop_members sm
      using public.retailer_shops s, public.organizations o
     where sm.retailer_shop_id = s.id and s.retailer_organization_id = o.id
       and o.name like '${PREFIX}%';
    delete from public.retailer_shops s
      using public.organizations o
     where s.retailer_organization_id = o.id and o.name like '${PREFIX}%';
    delete from public.member_roles mr
      using public.organization_members m, public.organizations o
     where mr.organization_member_id = m.id and m.organization_id = o.id
       and o.name like '${PREFIX}%';
    delete from public.organization_members m
      using public.organizations o
     where m.organization_id = o.id and o.name like '${PREFIX}%';
    delete from public.vendor_product_retailer_assignments a
      using public.organizations o
     where a.retailer_organization_id = o.id and o.name like '${PREFIX}%';
    delete from public.vendor_products vp
      using public.organizations o
     where vp.vendor_organization_id = o.id and o.name like '${PREFIX}%';
    delete from public.vendor_retailers vr
      using public.organizations o
     where (vr.vendor_organization_id = o.id or vr.retailer_organization_id = o.id)
       and o.name like '${PREFIX}%';
    delete from public.organizations where name like '${PREFIX}%';
    delete from public.profiles p using auth.users u
     where p.id = u.id and u.email like '${PREFIX}%';
    delete from auth.users where email like '${PREFIX}%';
  `);
}

async function main() {
  process.stdout.write(`submit-receipt integration test\n  API      ${API_URL}\n  function ${FUNCTION_URL}\n  database ${DB_CONTAINER}\n`);

  // The function must already be served. Fail loudly rather than reporting
  // every case as a transport error.
  try {
    const probe = await fetch(FUNCTION_URL, { method: "OPTIONS" });
    if (probe.status >= 500) throw new Error(`status ${probe.status}`);
  } catch (error) {
    fatal(
      "the submit-receipt function is not reachable. Start it with:\n" +
        "  npx supabase functions serve submit-receipt\n" +
        String(error?.message ?? error),
    );
  }

  cleanup();

  // --------------------------------------------------------------------------
  // Fixtures
  // --------------------------------------------------------------------------
  const users = {
    vendor: await createUser("vendor"),
    owner: await createUser("owner"),
    manager: await createUser("manager"),
    sales1: await createUser("sales1"),
    sales1b: await createUser("sales1b"),
    sales2: await createUser("sales2"),
    salesInactive: await createUser("salesinactive"),
  };

  const vendorOrg = randomUUID();
  const retailer1 = randomUUID();
  const retailer2 = randomUUID();
  const shopAssigned = randomUUID();
  const shopUnassigned = randomUUID();
  const shopOtherRetailer = randomUUID();

  sql(`
    insert into public.organizations (id, name, organization_type, status) values
      (${uuidLiteral(vendorOrg)}, '${PREFIX}vendor',    'VENDOR',   'ACTIVE'),
      (${uuidLiteral(retailer1)},  '${PREFIX}retailer1', 'RETAILER', 'ACTIVE'),
      (${uuidLiteral(retailer2)},  '${PREFIX}retailer2', 'RETAILER', 'ACTIVE');

    insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status) values
      (${uuidLiteral(vendorOrg)}, ${uuidLiteral(retailer1)}, 'ACTIVE'),
      (${uuidLiteral(vendorOrg)}, ${uuidLiteral(retailer2)}, 'ACTIVE');

    insert into public.profiles (id, first_name, last_name, status) values
      (${uuidLiteral(users.vendor.id)},        'IT', 'Vendor',   'ACTIVE'),
      (${uuidLiteral(users.owner.id)},         'IT', 'Owner',    'ACTIVE'),
      (${uuidLiteral(users.manager.id)},       'IT', 'Manager',  'ACTIVE'),
      (${uuidLiteral(users.sales1.id)},        'IT', 'Sales1',   'ACTIVE'),
      (${uuidLiteral(users.sales1b.id)},       'IT', 'Sales1b',  'ACTIVE'),
      (${uuidLiteral(users.sales2.id)},        'IT', 'Sales2',   'ACTIVE'),
      (${uuidLiteral(users.salesInactive.id)}, 'IT', 'Inactive', 'SUSPENDED');

    insert into public.retailer_shops (id, retailer_organization_id, name, code, status) values
      (${uuidLiteral(shopAssigned)},      ${uuidLiteral(retailer1)}, '${PREFIX}shop assigned',   'ITS-A', 'ACTIVE'),
      (${uuidLiteral(shopUnassigned)},    ${uuidLiteral(retailer1)}, '${PREFIX}shop unassigned', 'ITS-U', 'ACTIVE'),
      (${uuidLiteral(shopOtherRetailer)}, ${uuidLiteral(retailer2)}, '${PREFIX}shop other',      'ITS-O', 'ACTIVE');
  `);

  // Memberships, roles and the one live shop assignment.
  const memberships = [
    [users.vendor.id, vendorOrg, "VENDOR_SUPER_ADMIN", "ACTIVE"],
    [users.owner.id, retailer1, "RETAILER_OWNER", "ACTIVE"],
    [users.manager.id, retailer1, "RETAILER_MANAGER", "ACTIVE"],
    [users.sales1.id, retailer1, "SALES_STAFF", "ACTIVE"],
    [users.sales1b.id, retailer1, "SALES_STAFF", "ACTIVE"],
    [users.sales2.id, retailer2, "SALES_STAFF", "ACTIVE"],
    [users.salesInactive.id, retailer1, "SALES_STAFF", "ACTIVE"],
  ];

  for (const [userId, orgId, roleCode, status] of memberships) {
    sql(`
      with m as (
        insert into public.organization_members (organization_id, user_id, status)
        values (${uuidLiteral(orgId)}, ${uuidLiteral(userId)}, '${status}')
        returning id
      )
      insert into public.member_roles (organization_member_id, role_id)
      select m.id, r.id from m, public.roles r where r.code = '${roleCode}';
    `);
  }

  // sales1, sales1b and salesInactive are assigned to the SAME shop; sales2 is
  // assigned to their own Retailer's shop. Nobody is assigned to shopUnassigned.
  for (const [userId, orgId, shopId] of [
    [users.sales1.id, retailer1, shopAssigned],
    [users.sales1b.id, retailer1, shopAssigned],
    [users.salesInactive.id, retailer1, shopAssigned],
    [users.sales2.id, retailer2, shopOtherRetailer],
  ]) {
    sql(`
      insert into public.retailer_shop_members (organization_member_id, retailer_shop_id)
      select m.id, ${uuidLiteral(shopId)}
      from public.organization_members m
      where m.organization_id = ${uuidLiteral(orgId)}
        and m.user_id = ${uuidLiteral(userId)};
    `);
  }

  // Products: one assigned to retailer1, one to retailer2 only.
  const productR1 = randomUUID();
  const productR2 = randomUUID();
  sql(`
    insert into public.vendor_products
      (id, vendor_organization_id, product_code, product_name, status, created_by_profile_id)
    values
      (${uuidLiteral(productR1)}, ${uuidLiteral(vendorOrg)}, 'ITEST-R1', 'Retailer1 Product', 'ACTIVE', ${uuidLiteral(users.vendor.id)}),
      (${uuidLiteral(productR2)}, ${uuidLiteral(vendorOrg)}, 'ITEST-R2', 'Retailer2 Product', 'ACTIVE', ${uuidLiteral(users.vendor.id)});

    insert into public.vendor_product_retailer_assignments
      (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
    values
      (${uuidLiteral(productR1)}, ${uuidLiteral(retailer1)}, 'ACTIVE', ${uuidLiteral(users.vendor.id)}),
      (${uuidLiteral(productR2)}, ${uuidLiteral(retailer2)}, 'ACTIVE', ${uuidLiteral(users.vendor.id)});
  `);

  const tokens = {};
  for (const [name, user] of Object.entries(users)) tokens[name] = await signIn(user);

  // ==========================================================================
  section("0. The preflight");
  // ==========================================================================
  //
  // TWO REQUESTS, BECAUSE THE LOCAL STACK AND THE HOSTED ONE DIFFER HERE.
  //
  // The local stack fronts Edge Functions with Kong, whose CORS plugin
  // SHORT-CIRCUITS any OPTIONS carrying `Access-Control-Request-Method` — the
  // shape a browser actually sends. Kong answers it 200 and simply ECHOES the
  // requested headers back, so that exchange proves the endpoint is reachable
  // from a browser but proves NOTHING about this function's own policy: it
  // would look identical if the function allowed no headers at all.
  //
  // Hosted, there is no such short-circuit — the function answers its own
  // preflight, which is why Chrome recorded a 204 there. So the function's
  // handler is exercised separately, with an OPTIONS Kong passes through.
  {
    // ---- (a) the function's OWN preflight handler: the one that runs hosted --
    const own = await fetch(FUNCTION_URL, {
      method: "OPTIONS",
      headers: { Origin: BROWSER_ORIGIN },
    });

    equal(own.status, 204, "the function answers OPTIONS with 204");
    equal(await own.text(), "", "...and no body");
    checkBrowserReadable(own, "preflight");

    // The regression itself, at the wire level: `apikey` and `x-client-info`
    // were missing from this list, so the browser refused to send the POST.
    // checkBrowserReadable already asserted each one is present; this asserts
    // the function DECLARED them rather than a gateway having echoed them.
    const declared = headerTokens(own, "access-control-allow-headers");
    check(
      CLIENT_REQUEST_HEADERS.every((header) => declared.includes(header)),
      "the function's own allowed-header list covers every header the client sends",
      `declared: ${declared.join(", ") || "(none)"}`,
    );

    // A preflight carries NO Authorization header, so `verify_jwt = true` must
    // not turn it into a 401 — that would block every browser caller before the
    // real request was ever attempted.
    check(own.status !== 401, "the preflight is not refused for being unauthenticated");

    const maxAge = own.headers.get("access-control-max-age");
    check(
      Number.isFinite(Number(maxAge)) && Number(maxAge) > 0,
      "the preflight is cacheable — later submissions cost one round trip, not two",
      `Access-Control-Max-Age: ${maxAge}`,
    );

    // ---- (b) the exchange a real browser performs against the local stack ----
    const browser = await fetch(FUNCTION_URL, {
      method: "OPTIONS",
      headers: {
        Origin: BROWSER_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": CLIENT_REQUEST_HEADERS.join(", "),
      },
    });

    check(
      browser.status < 400,
      "a real browser preflight is not refused",
      `status ${browser.status}`,
    );
    checkBrowserReadable(browser, "browser preflight");
    check(
      browser.headers.get("access-control-allow-credentials") === null,
      "neither the function nor the local gateway enables ambient credentials",
    );
  }

  // ==========================================================================
  section("1. Unauthenticated callers");
  // ==========================================================================
  {
    const noHeader = await submit({
      shopId: shopAssigned,
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(noHeader.status, 401, "no Authorization header -> 401 at the gateway");
    check(
      !/submitted/.test(noHeader.raw),
      "an unauthenticated request never reports a submission",
    );
    // THIS ONE IS NOT OURS. The gateway refuses it before the function is
    // invoked, so the function's helper cannot have shaped the reply — only
    // `Access-Control-Allow-Origin` is asserted, and only because it is the one
    // header a browser reads on an ACTUAL (non-preflight) response. A missing
    // one here would show the app an opaque network error instead of a 401,
    // and would be a platform limitation to work around, not a defect to fix
    // in this function.
    check(
      noHeader.response.headers.get("access-control-allow-origin") !== null,
      "the gateway's own 401 is readable by the browser too",
      `got ${JSON.stringify(noHeader.response.headers.get("access-control-allow-origin"))}`,
    );

    const garbage = await submit({
      token: "not-a-real-token",
      shopId: shopAssigned,
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(garbage.status, 401, "a malformed token -> 401");

    // A structurally valid JWT that belongs to no user: the anon key. The gateway
    // admits it; the function's own auth.getUser() is what refuses it.
    const anonKeyAsToken = await submit({
      token: ANON_KEY,
      shopId: shopAssigned,
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(anonKeyAsToken.status, 401, "a valid JWT with no user -> 401");
    equal(anonKeyAsToken.body?.status, "unauthenticated", "...reported as `unauthenticated`");
    // The refusal the FUNCTION generates. A browser that cannot read it shows the
    // person a network error instead of "please sign in again".
    checkBrowserReadable(anonKeyAsToken.response, "unauthenticated");
  }

  // ==========================================================================
  section("2. Roles that are not Sales Staff cannot submit");
  // ==========================================================================
  for (const [label, tokenName] of [
    ["Vendor Super Admin", "vendor"],
    ["Retailer Owner", "owner"],
    ["Retailer Manager", "manager"],
  ]) {
    const result = await submit({
      token: tokens[tokenName],
      shopId: shopAssigned,
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(result.status, 403, `${label} cannot submit a receipt -> 403`);
    equal(result.body?.status, "denied", `${label} is told 'denied' and nothing more`);
  }

  {
    const result = await submit({
      token: tokens.salesInactive,
      shopId: shopAssigned,
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(result.status, 403, "a Sales Staff member with a SUSPENDED profile -> 403");
    equal(result.body?.status, "denied", "...reported as `denied`");
    checkBrowserReadable(result.response, "denied");
  }

  // ==========================================================================
  section("3. Shop scoping");
  // ==========================================================================
  {
    const unassigned = await submit({
      token: tokens.sales1,
      shopId: shopUnassigned,
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(unassigned.status, 403, "an ACTIVE shop they are NOT assigned to -> 403");

    const otherRetailer = await submit({
      token: tokens.sales1,
      shopId: shopOtherRetailer,
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(otherRetailer.status, 403, "another Retailer's shop -> 403");

    const nonexistent = await submit({
      token: tokens.sales1,
      shopId: randomUUID(),
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(nonexistent.status, 403, "a shop id that does not exist -> 403");

    check(
      unassigned.raw === otherRetailer.raw && otherRetailer.raw === nonexistent.raw,
      "all three shop refusals are BYTE-IDENTICAL — the endpoint is not an estate oracle",
      `${unassigned.raw} / ${otherRetailer.raw} / ${nonexistent.raw}`,
    );

    const badShape = await submit({
      token: tokens.sales1,
      shopId: "not-a-uuid",
      bytes: JPEG_BYTES,
      fileName: "r.jpg",
      declaredType: "image/jpeg",
    });
    equal(badShape.status, 400, "a malformed shop id -> 400");
    equal(badShape.body?.reason, "invalid-shop", "...with reason `invalid-shop`");
  }

  // ==========================================================================
  section("4. Product scoping (list_my_receipt_products over the wire)");
  // ==========================================================================
  // The receipt model attaches no product to a submission, so "unauthorized
  // product denied" is enforced on the READ that tells a client which products
  // exist. Exercised here with real JWTs against the real endpoint.
  {
    const mine = await rpc(tokens.sales1, "list_my_receipt_products");
    equal(mine.status, 200, "Sales Staff may read their own Retailer's receipt products");
    const codes = (mine.body ?? []).map((row) => row.product_code).sort();
    check(
      codes.length === 1 && codes[0] === "ITEST-R1",
      "they receive only their own Retailer's product",
      JSON.stringify(codes),
    );
    check(
      !JSON.stringify(mine.body).includes("ITEST-R2"),
      "another Retailer's product is not returned",
    );
    check(
      !/vendor_organization|assignment_status|description/.test(JSON.stringify(mine.body ?? [])),
      "no Vendor id, assignment status or catalogue prose is exposed",
    );

    const other = await rpc(tokens.sales2, "list_my_receipt_products");
    const otherCodes = (other.body ?? []).map((row) => row.product_code);
    check(
      otherCodes.length === 1 && otherCodes[0] === "ITEST-R2",
      "the other Retailer's Sales Staff see only their own product",
      JSON.stringify(otherCodes),
    );

    for (const [label, tokenName] of [
      ["Vendor Super Admin", "vendor"],
      ["Retailer Owner", "owner"],
      ["Retailer Manager", "manager"],
    ]) {
      const denied = await rpc(tokens[tokenName], "list_my_receipt_products");
      check(
        denied.status >= 400,
        `${label} is refused the Sales Staff product read`,
        `status ${denied.status}`,
      );
    }
  }

  // ==========================================================================
  section("5. File validation, and the declared MIME type being ignored");
  // ==========================================================================
  {
    const noFile = await submit({ token: tokens.sales1, shopId: shopAssigned, omitFile: true });
    equal(noFile.status, 400, "no file part -> 400");
    equal(noFile.body?.reason, "missing", "...with reason `missing`");

    const empty = await submit({
      token: tokens.sales1,
      shopId: shopAssigned,
      bytes: new Uint8Array(0),
      fileName: "e.jpg",
      declaredType: "image/jpeg",
    });
    equal(empty.status, 400, "an empty file -> 400");
    equal(empty.body?.reason, "empty", "...with reason `empty`");

    // THE CENTRAL ANTI-SPOOFING CASE: the part declares image/jpeg and is named
    // .jpg, but the bytes are a PDF. The declared type is never read.
    const spoofed = await submit({
      token: tokens.sales1,
      shopId: shopAssigned,
      bytes: PDF_BYTES,
      fileName: "receipt.jpg",
      declaredType: "image/jpeg",
    });
    equal(spoofed.status, 400, "PDF bytes declared as image/jpeg -> 400");
    equal(
      spoofed.body?.reason,
      "unsupported-type",
      "...rejected on the BYTES, not on the declared type or the extension",
    );
    checkBrowserReadable(spoofed.response, "invalid file");

    const tooMany = await (async () => {
      const form = new FormData();
      form.append("shop_id", shopAssigned);
      form.append("file", new Blob([JPEG_BYTES], { type: "image/jpeg" }), "a.jpg");
      form.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "b.png");
      const response = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.sales1}`, Origin: BROWSER_ORIGIN },
        body: form,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    })();
    equal(tooMany.status, 400, "two file parts in one submission -> 400");
    equal(tooMany.body?.reason, "too-many-files", "...with reason `too-many-files`");
  }

  // ==========================================================================
  section("6. A valid submission");
  // ==========================================================================
  let submissionId;
  {
    // Declared image/jpeg, but the bytes are a PNG. The submission must SUCCEED
    // and be recorded as image/png — the sniffed type wins over the claim.
    const result = await submit({
      token: tokens.sales1,
      shopId: shopAssigned,
      bytes: PNG_BYTES,
      fileName: "  ../../etc/My Receipt.png  ",
      declaredType: "image/jpeg",
    });

    equal(result.status, 200, "an authorized Sales Staff submission -> 200");
    equal(result.body?.status, "submitted", "...reported as `submitted`");
    check(UUID_SHAPE.test(result.body?.submission_id ?? ""), "a stable submission id is returned");
    submissionId = result.body.submission_id;

    // THE CASE THE OLD SUITE COULD NOT SEE. The receipt was stored either way;
    // whether the app ever learned that is decided by these headers.
    checkBrowserReadable(result.response, "successful submission");

    equal(
      Object.keys(result.body).sort().join(","),
      "status,submission_id",
      "the success response carries EXACTLY status and submission_id",
    );

    const row = sql(`
      select status || '|' || mime_type || '|' || file_size_bytes || '|' ||
             storage_bucket || '|' || storage_object_path || '|' ||
             original_file_name || '|' || submitted_by_profile_id || '|' ||
             retailer_organization_id || '|' || retailer_shop_id || '|' ||
             (submitted_at is not null)
      from public.receipt_submissions where id = ${uuidLiteral(submissionId)};
    `);
    const [status, mime, size, bucket, objectPath, fileName, submitter, org, shop, hasSubmittedAt] =
      row.split("|");

    equal(status, "SUBMITTED", "the row reaches the SUBMITTED status");
    // psql renders a boolean inside a text concatenation as "true"/"false", not "t"/"f".
    equal(hasSubmittedAt, "true", "submitted_at is set");
    equal(mime, "image/png", "the recorded MIME type is the SNIFFED one, not the declared image/jpeg");
    equal(Number(size), PNG_BYTES.byteLength, "the recorded size matches the bytes");

    // IDENTITY IS DERIVED FROM THE TOKEN. Nothing in the request body named a
    // user, a profile, an organization or a shop owner.
    equal(submitter, users.sales1.id, "submitted_by_profile_id is the TOKEN's user");
    equal(org, retailer1, "the Retailer was derived server-side");
    equal(shop, shopAssigned, "the shop is the one chosen, and it was proven assigned");

    // THE STORAGE PATH IS SERVER-GENERATED.
    equal(bucket, "receipts", "the object went into the `receipts` bucket");
    check(
      objectPath.startsWith(`${retailer1}/${users.sales1.id}/${submissionId}/`),
      "the object path is <retailer>/<user>/<submission>/<random> — every segment derived",
      objectPath,
    );
    check(
      !objectPath.includes("etc") && !objectPath.includes("My Receipt") && !objectPath.includes(".."),
      "nothing from the uploaded filename shaped the storage path",
      objectPath,
    );
    equal(fileName, "../../etc/My Receipt.png".split("/").pop(), "the stored display name is sanitized to the last segment");

    check(await objectExists(objectPath), "the object really is in the private bucket", objectPath);
    equal(
      sql(`select public::text from storage.buckets where id = 'receipts';`),
      "false",
      "the receipts bucket is still private",
    );
    equal(
      sql(`select count(*)::text from pg_policies where schemaname='storage' and tablename='objects';`),
      "0",
      "storage.objects still has zero policies — no direct client write path was opened",
    );

    // NOTHING SECRET CAME BACK.
    for (const secret of [objectPath, bucket === "receipts" ? "receipts/" : bucket, SERVICE_ROLE_KEY]) {
      check(
        !result.raw.includes(secret),
        `the response body does not contain ${secret === SERVICE_ROLE_KEY ? "the service-role key" : `"${secret}"`}`,
      );
    }
    check(
      !/sha|hash|bucket|path|key|token/i.test(Object.keys(result.body).join(" ")),
      "no response key names a hash, bucket, path, key or token",
    );
  }

  // ==========================================================================
  section("7. Reading the result back");
  // ==========================================================================
  {
    const mine = await rpc(tokens.sales1, "get_my_receipt_submission", {
      p_submission_id: submissionId,
    });
    equal(mine.status, 200, "the submitter can read their own submission");
    equal(mine.body?.length, 1, "...and gets exactly one row");
    equal(mine.body?.[0]?.status, "SUBMITTED", "...showing the SUBMITTED status");
    check(
      !/storage|bucket|object_path|sha256|profile|organization|failure/i.test(
        Object.keys(mine.body[0]).join(" "),
      ),
      "the returned row exposes no storage location, hash, profile or organization",
      Object.keys(mine.body[0]).join(","),
    );

    const colleague = await rpc(tokens.sales1b, "get_my_receipt_submission", {
      p_submission_id: submissionId,
    });
    equal(colleague.status, 200, "a colleague's call is not an error");
    equal(colleague.body?.length, 0, "...but returns ZERO ROWS for someone else's submission");

    const crossTenant = await rpc(tokens.sales2, "get_my_receipt_submission", {
      p_submission_id: submissionId,
    });
    equal(crossTenant.body?.length, 0, "a Sales Staff member at another Retailer gets zero rows");

    const unknown = await rpc(tokens.sales1b, "get_my_receipt_submission", {
      p_submission_id: "00000000-0000-0000-0000-000000000000",
    });
    check(
      JSON.stringify(colleague.body) === JSON.stringify(unknown.body),
      "a real submission that is not mine is indistinguishable from one that does not exist",
    );

    for (const [label, tokenName] of [
      ["Vendor Super Admin", "vendor"],
      ["Retailer Owner", "owner"],
      ["Retailer Manager", "manager"],
    ]) {
      const denied = await rpc(tokens[tokenName], "get_my_receipt_submission", {
        p_submission_id: submissionId,
      });
      check(denied.status >= 400, `${label} cannot read it either`, `status ${denied.status}`);
    }
  }

  // ==========================================================================
  section("8. Duplicate / replay");
  // ==========================================================================
  {
    const replay = await submit({
      token: tokens.sales1,
      shopId: shopAssigned,
      bytes: PNG_BYTES,
      fileName: "same-photo-again.png",
      declaredType: "image/png",
    });
    equal(replay.status, 409, "the same person resubmitting the same bytes -> 409");
    equal(replay.body?.status, "duplicate", "...reported as `duplicate`");
    checkBrowserReadable(replay.response, "duplicate");

    equal(
      sql(`select count(*)::text from public.receipt_submissions
           where submitted_by_profile_id = ${uuidLiteral(users.sales1.id)}
             and file_sha256 = (select file_sha256 from public.receipt_submissions
                                where id = ${uuidLiteral(submissionId)});`),
      "1",
      "the duplicate created no second row",
    );

    // The duplicate index is scoped to (Retailer, submitter, hash), so a
    // DIFFERENT person submitting the identical photo must be allowed.
    const colleagueSame = await submit({
      token: tokens.sales1b,
      shopId: shopAssigned,
      bytes: PNG_BYTES,
      fileName: "colleague-same-photo.png",
      declaredType: "image/png",
    });
    equal(
      colleagueSame.status,
      200,
      "a DIFFERENT staff member may submit the identical photo — the index is per-submitter",
    );
  }

  // ==========================================================================
  section("9. Upload failure: cleanup, status, and no orphan object");
  // ==========================================================================
  {
    // A deterministic post-reserve failure: shrink the bucket's own size limit so
    // Storage refuses an upload the database happily reserved. This exercises the
    // real removeObject + recordFailure path rather than simulating it.
    sql(`update storage.buckets set file_size_limit = 100 where id = 'receipts';`);

    let failed;
    try {
      failed = await submit({
        token: tokens.sales1,
        shopId: shopAssigned,
        bytes: JPEG_BYTES,
        fileName: "will-fail.jpg",
        declaredType: "image/jpeg",
      });
    } finally {
      sql(`update storage.buckets set file_size_limit = 10485760 where id = 'receipts';`);
    }

    equal(failed.status, 502, "a Storage rejection after a successful reserve -> 502");
    equal(failed.body?.status, "upload-failed", "...reported as `upload-failed`, which is retryable");
    check(
      !/limit|size|bucket|storage|policy/i.test(failed.raw),
      "the response reveals nothing about WHY Storage refused it",
      failed.raw,
    );
    // `upload-failed` is the one outcome the client is meant to offer a retry
    // for, so a browser being unable to read it is worse than useless.
    checkBrowserReadable(failed.response, "upload-failed");

    const failedRow = sql(`
      select rs.status || '|' || coalesce(rs.failure_code, '-') || '|' ||
             (rs.submitted_at is null)::text || '|' || rs.storage_object_path
      from public.receipt_submissions rs
      where rs.submitted_by_profile_id = ${uuidLiteral(users.sales1.id)}
        and rs.original_file_name = 'will-fail.jpg';
    `);
    const [fStatus, fCode, fNoSubmittedAt, fPath] = failedRow.split("|");

    equal(fStatus, "UPLOAD_FAILED", "the row is recorded as UPLOAD_FAILED");
    equal(fCode, "STORAGE_UPLOAD_FAILED", "...with the fixed classification, not provider text");
    equal(fNoSubmittedAt, "true", "submitted_at was not set");
    check(
      !(await objectExists(fPath)),
      "NO ORPHAN OBJECT was left in the bucket",
      fPath,
    );

    // UPLOAD_FAILED rows are excluded from the duplicate index, so the same file
    // can be retried immediately. This is the contract the existing schema states.
    const retry = await submit({
      token: tokens.sales1,
      shopId: shopAssigned,
      bytes: JPEG_BYTES,
      fileName: "retry-after-failure.jpg",
      declaredType: "image/jpeg",
    });
    equal(retry.status, 200, "the SAME file may be retried after an upload failure -> 200");

    equal(
      sql(`select count(*)::text from public.receipt_submissions
           where retailer_organization_id = ${uuidLiteral(retailer1)} and status = 'RESERVED';`),
      "0",
      "no submission was left stranded in RESERVED",
    );
  }

  // ==========================================================================
  section("10. Method and transport surface");
  // ==========================================================================
  {
    const get = await fetch(FUNCTION_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokens.sales1}`, Origin: BROWSER_ORIGIN },
    });
    check(get.status === 405 || get.status === 400, "GET is refused", `status ${get.status}`);
    // Refused, but still readable: a browser must be able to see the 405 rather
    // than report an opaque network failure.
    checkBrowserReadable(get, "refused method");

    const notMultipart = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.sales1}`,
        Origin: BROWSER_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ shop_id: shopAssigned, submitted_by: users.owner.id }),
    });
    const notMultipartBody = await notMultipart.json().catch(() => null);
    equal(notMultipart.status, 400, "a JSON body is refused — the endpoint is multipart only");
    check(
      notMultipartBody?.status === "invalid",
      "...and an attempt to name another submitter in the body changes nothing",
    );
  }

  // --------------------------------------------------------------------------
  cleanup();

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    process.stdout.write("\nFailures:\n");
    for (const failure of failures) {
      process.stdout.write(`  [${failure.case}] ${failure.description}\n`);
      if (failure.detail) process.stdout.write(`      ${failure.detail}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  try {
    cleanup();
  } catch {
    /* cleanup is best effort once we are already failing */
  }
  fatal(String(error?.stack ?? error));
});
