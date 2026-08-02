/**
 * Contract tests for GENERIC Auth invitation completion.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added — matching
 * lib/auth/landing-decision.test.ts and lib/review/claim-reviewer-access-contract.test.ts.
 *
 * WHY SOURCE SCANNING RATHER THAN EXECUTION
 * The routes under test are Server Components and Server Actions: they import
 * `next/headers` transitively and throw outside a request, so they cannot be invoked
 * here. What they must NOT do is nevertheless checkable, and that is the more valuable
 * half — "this file never imports a service-role client", "this action never calls a
 * membership RPC" are properties a future edit could silently break, and a grep-style
 * guard fails loudly when it does.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY RULE IS APPLIED. These files are heavily
 * commented, and the comments discuss the very identifiers the rules forbid — an
 * unstripped scan would fail on the prose that explains the rule. `codeOf()` removes
 * block and line comments first, so every assertion below is about executable code.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const SETUP_DIR = join(ROOT, "app", "invitations", "account-setup");
const SETUP_PAGE = join(SETUP_DIR, "page.tsx");
const SETUP_ACTIONS = join(SETUP_DIR, "actions.ts");
const SETUP_FORM = join(SETUP_DIR, "account-setup-form.tsx");
const SETUP_STATE = join(SETUP_DIR, "account-setup-state.ts");

const ACCEPT_ROUTE = join(ROOT, "app", "invitations", "accept", "route.ts");
const COMPLETE_PAGE = join(ROOT, "app", "invitations", "complete", "page.tsx");
const COMPLETE_ACTIONS = join(ROOT, "app", "invitations", "complete", "actions.ts");
const LOGIN_PAGE = join(ROOT, "app", "login", "page.tsx");
const PROXY_ROUTING = join(ROOT, "lib", "supabase", "proxy-routing.ts");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Source with block and line comments removed. Every rule below runs on this. */
function codeOf(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every file that makes up the generic account-setup route. */
const GENERIC_FILES = [SETUP_PAGE, SETUP_ACTIONS, SETUP_FORM, SETUP_STATE];

describe("1. the generic account-setup route exists and is complete", () => {
  test("1.1 all four files are present", () => {
    for (const file of GENERIC_FILES) {
      assert.ok(existsSync(file), `missing ${file}`);
    }
  });

  test("1.2 the action is a Server Action and the form is a Client Component", () => {
    assert.match(read(SETUP_ACTIONS), /^"use server";/);
    assert.match(read(SETUP_FORM), /^"use client";/);
  });

  test("1.3 the shared state module declares neither directive", () => {
    // codeOf(), not read(): the module's own header comment explains WHY it carries
    // no directive, and naming them in prose must not fail the rule.
    const state = codeOf(SETUP_STATE);
    assert.ok(!state.includes('"use server"'));
    assert.ok(!state.includes('"use client"'));
  });
});

describe("2. verification routing is unchanged", () => {
  test("2.1 successful verifyOtp still redirects to /invitations/complete", () => {
    const code = codeOf(ACCEPT_ROUTE);
    assert.match(code, /COMPLETION_PATH/);
    assert.match(read(ACCEPT_ROUTE), /COMPLETION_PATH\s*=\s*"\/invitations\/complete"/);
    assert.match(code, /verifyOtp\(\{/);
  });

  test("2.2 invalid verification still redirects to /invitations/error", () => {
    assert.match(read(ACCEPT_ROUTE), /FAILURE_PATH\s*=\s*"\/invitations\/error"/);
  });

  test("2.3 the accept route still verifies type strictly and was not widened", () => {
    const code = codeOf(ACCEPT_ROUTE);
    assert.match(code, /INVITE_TYPE\s*=\s*"invite"/);
    assert.match(code, /type\s*!==\s*INVITE_TYPE/);
  });

  test("2.4 no second token-verification route was introduced", () => {
    const callers = [SETUP_PAGE, SETUP_ACTIONS, SETUP_FORM, SETUP_STATE];
    for (const file of callers) {
      assert.ok(
        !codeOf(file).includes("verifyOtp"),
        `${file} must not verify tokens; that stays in /invitations/accept`,
      );
    }
  });
});

describe("3. Retailer invitation completion is preserved", () => {
  test("3.1 the completion page still reads the Retailer invitation RPC", () => {
    assert.match(codeOf(COMPLETE_PAGE), /get_my_pending_retailer_invitation/);
  });

  test("3.2 a valid invitation still renders the Retailer completion form", () => {
    const code = codeOf(COMPLETE_PAGE);
    assert.match(code, /CompleteInvitationForm/);
    assert.match(code, /invitation\.retailer_name/);
  });

  test("3.3 the Retailer action still accepts the invitation", () => {
    assert.match(codeOf(COMPLETE_ACTIONS), /accept_retailer_owner_invitation/);
  });

  test("3.4 an RPC failure is NOT treated as 'no invitation'", () => {
    const code = codeOf(COMPLETE_PAGE);
    assert.match(
      code,
      /if\s*\(\s*result === null \|\| result\.error\s*\)\s*\{\s*redirect\("\/invitations\/error"\)/,
      "a transport or PostgREST failure must reach the error page, not generic setup",
    );
  });
});

describe("4. completion routing order", () => {
  const code = codeOf(COMPLETE_PAGE);

  test("4.1 no session redirects to the generic error page", () => {
    assert.match(code, /if\s*\(!hasSession\)\s*\{\s*redirect\("\/invitations\/error"\)/);
  });

  test("4.2 portal NONE routes to generic account setup", () => {
    assert.match(read(COMPLETE_PAGE), /GENERIC_ACCOUNT_SETUP_PATH\s*=\s*"\/invitations\/account-setup"/);
    assert.match(code, /case "unauthorized":\s*redirect\(GENERIC_ACCOUNT_SETUP_PATH\)/);
  });

  test("4.3 every configured portal kind is routed to its own landing", () => {
    for (const kind of [
      "vendor",
      "retailer",
      "retailerStaff",
      "salesStaff",
      "claimReviewer",
    ]) {
      assert.ok(
        code.includes(`case "${kind}":`),
        `completion routing must handle the ${kind} portal`,
      );
    }
    assert.match(code, /redirect\(landing\.destination\)/);
  });

  test("4.4 a resolver outage never falls through to generic setup", () => {
    const unavailable = code.slice(code.indexOf('case "unavailable":'));
    const nextCase = unavailable.indexOf('case "unauthorized":');
    const branch = nextCase === -1 ? unavailable : unavailable.slice(0, nextCase);
    assert.ok(
      !branch.includes("GENERIC_ACCOUNT_SETUP_PATH"),
      "an unavailable resolver must not be treated as 'has no portal'",
    );
  });

  test("4.5 the destination is a literal, never assembled from input", () => {
    assert.ok(
      !code.includes("searchParams"),
      "the completion page must not read a caller-supplied destination",
    );
    for (const forbidden of ["redirectTo", "returnUrl", "next="]) {
      assert.ok(!code.includes(forbidden), `open-redirect vector: ${forbidden}`);
    }
  });
});

describe("5. generic setup requires a verified session and refuses configured users", () => {
  const page = codeOf(SETUP_PAGE);
  const actions = codeOf(SETUP_ACTIONS);

  test("5.1 the page verifies the JWT with getClaims", () => {
    assert.match(page, /getClaims\(\)/);
    assert.match(page, /if\s*\(!hasSession\)\s*\{\s*redirect\(FAILURE_PATH\)/);
  });

  test("5.2 the page requires an already-confirmed address", () => {
    assert.match(page, /email_confirmed_at/);
    assert.match(page, /getUser\(\)/);
  });

  test("5.3 the page refuses a user who already has a portal", () => {
    assert.match(page, /resolveAuthenticatedLanding\(\)/);
    for (const kind of [
      "vendor",
      "retailer",
      "retailerStaff",
      "salesStaff",
      "claimReviewer",
    ]) {
      assert.ok(page.includes(`case "${kind}":`), `page must handle ${kind}`);
    }
    assert.match(page, /redirect\(landing\.destination\)/);
  });

  test("5.4 the action re-checks the session itself", () => {
    assert.match(actions, /getClaims\(\)/);
    assert.match(actions, /if\s*\(!hasSession\)\s*\{\s*redirect\(FAILURE_PATH\)/);
  });

  test("5.5 the action re-checks that the caller has no portal", () => {
    assert.match(actions, /resolveAuthenticatedLanding\(\)/);
    assert.match(actions, /landing\.kind !== "unauthorized"/);
  });

  test("5.6 the page is NOT on the proxy public allowlist", () => {
    const proxy = codeOf(PROXY_ROUTING);
    const publicSet = proxy.slice(proxy.indexOf("PUBLIC_PATHS"));
    assert.ok(
      !publicSet.includes("/invitations/account-setup"),
      "generic setup requires the session /invitations/accept establishes",
    );
  });
});

describe("6. the generic route grants nothing", () => {
  test("6.1 no service-role client is imported anywhere in the route", () => {
    for (const file of GENERIC_FILES) {
      const code = codeOf(file);
      for (const forbidden of [
        "supabase/admin",
        "createAdminClient",
        "SERVICE_ROLE",
        "service_role",
      ]) {
        assert.ok(
          !code.includes(forbidden),
          `${file} must not reach the service-role client (${forbidden})`,
        );
      }
    }
  });

  test("6.2 no application table is written", () => {
    for (const file of GENERIC_FILES) {
      const code = codeOf(file);
      for (const table of [
        "profiles",
        "organization_members",
        "member_roles",
        "audit_logs",
        "organizations",
        "role_permissions",
      ]) {
        assert.ok(
          !code.includes(table),
          `${file} must not touch ${table}; authorization is granted elsewhere`,
        );
      }
    }
  });

  test("6.3 no RPC of any kind is called", () => {
    for (const file of GENERIC_FILES) {
      assert.ok(
        !/\.rpc\(/.test(codeOf(file)),
        `${file} must call no database function`,
      );
    }
  });

  test("6.4 no invitation-finalization or acceptance function is referenced", () => {
    for (const file of GENERIC_FILES) {
      const code = codeOf(file);
      for (const fn of [
        "accept_retailer_owner_invitation",
        "accept_retailer_staff_invitation",
        "accept_existing_user_retailer_owner_invitation",
        "finalize_retailer_owner_invitation",
        "get_my_pending_retailer_invitation",
      ]) {
        assert.ok(!code.includes(fn), `${file} must not call ${fn}`);
      }
    }
  });

  test("6.5 CLAIM_REVIEWER is never named in the generic route", () => {
    for (const file of GENERIC_FILES) {
      assert.ok(
        !read(file).includes("CLAIM_REVIEWER"),
        `${file} must stay role-neutral`,
      );
    }
  });

  test("6.6 the only write is the Auth password update", () => {
    const actions = codeOf(SETUP_ACTIONS);
    assert.match(actions, /supabase\.auth\.updateUser\(\{ password \}\)/);
    const updates = actions.match(/updateUser\(/g) ?? [];
    assert.equal(updates.length, 1, "exactly one Auth mutation");
  });
});

describe("7. password handling", () => {
  const actions = codeOf(SETUP_ACTIONS);

  test("7.1 the shared policy is used, not a local rule", () => {
    assert.match(read(SETUP_ACTIONS), /from "@\/lib\/auth\/password-policy"/);
    assert.match(actions, /validatePassword\(password\)/);
  });

  test("7.2 mismatch is rejected before anything is sent", () => {
    assert.match(actions, /password !== confirmPassword/);
    const mismatchAt = actions.indexOf("password !== confirmPassword");
    const updateAt = actions.indexOf("updateUser");
    assert.ok(mismatchAt < updateAt, "the match check must precede the Auth call");
  });

  test("7.3 field errors return before the Auth call", () => {
    const guardAt = actions.indexOf("Object.keys(fieldErrors).length > 0");
    assert.ok(guardAt !== -1);
    assert.ok(guardAt < actions.indexOf("updateUser"));
  });

  test("7.4 only password and confirmPassword are read from the form", () => {
    const reads = [...actions.matchAll(/formData\.get\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(reads.sort(), ["confirmPassword", "password"]);
  });

  test("7.5 the form submits no identity field", () => {
    const form = codeOf(SETUP_FORM);
    const names = [...form.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(names.sort(), ["confirmPassword", "password"]);
    assert.ok(!form.includes('type="hidden"'), "no hidden field to forge");
  });

  test("7.6 the browser-visible state carries no identifier", () => {
    const state = read(SETUP_STATE);
    for (const leak of [
      "userId",
      "user_id",
      "organizationId",
      "organization_id",
      "roleId",
      "role_id",
      "email",
      "token",
    ]) {
      assert.ok(!state.includes(`${leak}:`), `state must not carry ${leak}`);
    }
  });
});

describe("8. failures are safe and sign-out happens on success", () => {
  const actions = codeOf(SETUP_ACTIONS);

  test("8.1 an Auth failure returns a generic, retryable message", () => {
    assert.match(actions, /GENERIC_ERROR/);
    assert.match(actions, /updated\.error/);
    assert.match(actions, /formError: GENERIC_ERROR/);
  });

  test("8.2 no raw provider error is bound, returned or logged", () => {
    for (const leak of [
      "error.message",
      "error.code",
      "error.status",
      "String(error",
      "JSON.stringify(error",
    ]) {
      assert.ok(!actions.includes(leak), `raw provider detail leaked: ${leak}`);
    }
    const logs = [...actions.matchAll(/console\.(error|log|warn)\(([^)]*)\)/g)];
    for (const [, , arg] of logs) {
      assert.match(arg.trim(), /^"[^"]*"$/, "log arguments must be fixed strings");
    }
  });

  test("8.3 a transport throw is caught and never inspected", () => {
    assert.match(actions, /\.catch\(\(\) => null\)/);
    assert.match(actions, /updated === null/);
  });

  test("8.4 success signs the user out", () => {
    assert.match(actions, /signOut\(\)/);
    const signOutAt = actions.indexOf("signOut()");
    const updateAt = actions.indexOf("updateUser");
    assert.ok(updateAt < signOutAt, "sign-out must follow the password update");
  });

  test("8.5 success redirects to login with a fixed literal", () => {
    assert.match(read(SETUP_ACTIONS), /SUCCESS_PATH\s*=\s*"\/login\?notice=account-ready"/);
    assert.match(actions, /redirect\(SUCCESS_PATH\)/);
    const signOutAt = actions.indexOf("signOut()");
    assert.ok(signOutAt < actions.lastIndexOf("redirect(SUCCESS_PATH)"));
  });

  test("8.6 the login notice selects a message and never renders the parameter", () => {
    const login = codeOf(LOGIN_PAGE);
    assert.match(login, /ACCOUNT_READY_NOTICE/);
    assert.match(login, /noticeParam === ACCOUNT_READY_NOTICE/);
    assert.ok(
      !login.includes("{noticeParam}"),
      "the query value must never be rendered",
    );
  });
});

describe("9. existing portal and Flutter contracts are untouched", () => {
  test("9.1 the generic route never reads or alters portal context", () => {
    for (const file of GENERIC_FILES) {
      const code = codeOf(file);
      assert.ok(!code.includes("get_my_portal_context"));
      assert.ok(!code.includes("portal_kind"));
      assert.ok(!code.includes("context_version"));
    }
  });

  test("9.2 no migration was added by this milestone", () => {
    const migrations = readdirSync(join(ROOT, "supabase", "migrations")).filter(
      (f) => f.endsWith(".sql"),
    );
    assert.equal(
      migrations.length,
      59,
      "this is a Web-only milestone; a new migration means the scope grew",
    );
  });

  test("9.3 landing routes were not changed to accommodate this flow", () => {
    const decision = codeOf(join(ROOT, "lib", "auth", "landing-decision.ts"));
    assert.ok(
      !decision.includes("account-setup"),
      "generic setup is a routing outcome of the invitation flow, not a landing",
    );
  });
});

describe("10. no personal identifier is committed", () => {
  test("10.1 no email address of any kind appears in the new files", () => {
    // Deliberately a SHAPE, not a list of names. An earlier draft of this test
    // enumerated the addresses it was guarding against, which put those very
    // identifiers into the repository — the thing the rule exists to prevent. A
    // regex catches any address, including ones nobody thought to enumerate, and
    // itself contains no personal data.
    const emailShaped = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
    const scanned = [...GENERIC_FILES, COMPLETE_PAGE, LOGIN_PAGE];
    for (const file of scanned) {
      const match = read(file).match(emailShaped);
      assert.equal(
        match,
        null,
        `${file} contains an email-shaped literal: ${match?.[0]}`,
      );
    }
  });

  test("10.2 no UUID literal appears in the new files", () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const file of GENERIC_FILES) {
      assert.ok(!uuid.test(read(file)), `${file} contains a UUID literal`);
    }
  });
});
