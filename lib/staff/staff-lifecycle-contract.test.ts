/**
 * STATIC CONTRACT GUARDS for the Retailer staff ACTIVATION / DEACTIVATION web milestone.
 *
 *   lib/staff/retailer-staff-membership-status.ts        the write wrapper
 *   lib/staff/my-lifecycle-access-state.ts               the self-only diagnostic wrapper
 *   app/(retailer)/retailer/staff/actions.ts             the Server Action
 *   app/(retailer)/retailer/staff/staff-lifecycle-dialog.tsx   the confirmation dialog
 *   app/(retailer)/retailer/staff/page.tsx               the roster
 *   app/retailer-access-denied/page.tsx                  the inactive-access experience
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions, in the same idiom as
 * ./staff-shop-assignment-contract.test.ts. They read the TypeScript and assert structural
 * properties that a careless later edit could silently destroy — that the wrapper still
 * calls one RPC with two argument keys, that no service-role client appeared, that no raw
 * backend message can reach a screen, that the diagnostic never becomes an authorization
 * gate, and that the access-denied page never trusts the URL.
 *
 * They do NOT execute the modules. The server modules import `next/headers` through the
 * Supabase server client and cannot be imported by `node --test` at all, and the components
 * need a DOM this repository has no harness for. The DECISIONS those modules delegate are
 * unit-tested directly in ./staff-lifecycle-input.test.ts and ./lifecycle-access-state.test.ts,
 * and the database contract underneath is proved by 252 pgTAP assertions in
 * supabase/tests/database/retailer_staff_membership_lifecycle_test.sql.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();

const WRITE_WRAPPER_PATH = "lib/staff/retailer-staff-membership-status.ts";
const DIAGNOSTIC_WRAPPER_PATH = "lib/staff/my-lifecycle-access-state.ts";
const ACTIONS_PATH = "app/(retailer)/retailer/staff/actions.ts";
const DIALOG_PATH = "app/(retailer)/retailer/staff/staff-lifecycle-dialog.tsx";
const ROSTER_PATH = "app/(retailer)/retailer/staff/page.tsx";
const DENIED_PATH = "app/retailer-access-denied/page.tsx";
const VISIBILITY_PATH = "lib/staff/portal-access-decision.ts";
const NOTICE_CARD_PATH = "components/ui/lifecycle-notice-card.tsx";
const INPUT_PATH = "lib/staff/staff-lifecycle-input.ts";

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/**
 * Source with comments stripped.
 *
 * Load-bearing, not tidiness: every module in this milestone documents at length WHY it does
 * not use a service-role client, WHY it never renders a raw status, and WHY the diagnostic is
 * not an authorization gate. Asserting against raw text would fail on the very sentences that
 * state the guarantees.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const WRITE_WRAPPER = read(WRITE_WRAPPER_PATH);
const DIAGNOSTIC_WRAPPER = read(DIAGNOSTIC_WRAPPER_PATH);
const ACTIONS = read(ACTIONS_PATH);
const DIALOG = read(DIALOG_PATH);
const ROSTER = read(ROSTER_PATH);
const DENIED = read(DENIED_PATH);
const VISIBILITY = read(VISIBILITY_PATH);
const NOTICE_CARD = read(NOTICE_CARD_PATH);
// INPUT_PATH is not read into a constant here: the pure decision module is exercised
// directly by ./staff-lifecycle-input.test.ts, and it participates in this file only
// through MILESTONE_FILES, where the whole-milestone safety sweeps re-read it.

const WRITE_CODE = stripComments(WRITE_WRAPPER);
const DIAGNOSTIC_CODE = stripComments(DIAGNOSTIC_WRAPPER);
const ACTIONS_CODE = stripComments(ACTIONS);
const DIALOG_CODE = stripComments(DIALOG);
const ROSTER_CODE = stripComments(ROSTER);
const DENIED_CODE = stripComments(DENIED);
const NOTICE_CARD_CODE = stripComments(NOTICE_CARD);

const WRITE_RPC = "set_retailer_staff_membership_status";
const DIAGNOSTIC_RPC = "get_my_lifecycle_access_state";

/** Every file this milestone created or edited. */
const MILESTONE_FILES = [
  WRITE_WRAPPER_PATH,
  DIAGNOSTIC_WRAPPER_PATH,
  ACTIONS_PATH,
  DIALOG_PATH,
  ROSTER_PATH,
  DENIED_PATH,
  VISIBILITY_PATH,
  NOTICE_CARD_PATH,
  INPUT_PATH,
  "app/(retailer)/retailer/staff/staff-lifecycle-state.ts",
];

/** The action body, sliced out so assertions about it cannot be satisfied by a sibling. */
function lifecycleActionBody(): string {
  const start = ACTIONS_CODE.indexOf("export async function setStaffMembershipStatusAction");
  assert.notEqual(start, -1, "the Server Action must exist");
  return ACTIONS_CODE.slice(start);
}

const ACTION_BODY = lifecycleActionBody();

// ============================================================================
// The write wrapper
// ============================================================================
describe("staff lifecycle — the server write contract", () => {
  test("1. calls exactly the deployed RPC name, declared as a constant", () => {
    assert.match(
      WRITE_CODE,
      new RegExp(`const\\s+\\w+\\s*=\\s*"${WRITE_RPC}"\\s*as const`),
      "the RPC name must be a single greppable constant",
    );
    assert.ok(
      WRITE_CODE.includes(`"${WRITE_RPC}"`),
      "the exact deployed function name must appear",
    );
  });

  test("2. sends exactly the two declared argument keys", () => {
    const call = WRITE_CODE.slice(
      WRITE_CODE.indexOf(".rpc("),
      WRITE_CODE.indexOf(").catch"),
    );
    assert.ok(call.length > 0, "the RPC call must be locatable");

    const keys = [...call.matchAll(/^\s*(p_\w+):/gm)].map((match) => match[1]);
    assert.deepEqual(
      keys,
      ["p_membership_id", "p_status"],
      "exactly p_membership_id and p_status, in that order",
    );
  });

  test("3. sends no extra RPC field — no tenant, actor, role, permission or audit key", () => {
    const call = WRITE_CODE.slice(
      WRITE_CODE.indexOf(".rpc("),
      WRITE_CODE.indexOf(").catch"),
    );
    assert.ok(
      !/p_(organization|retailer|tenant|actor|user|profile|auth|role|permission|audit|current|timestamp|reason)/.test(
        call,
      ),
      "no organization, actor, role, permission, audit or current-status argument",
    );
  });

  test("3b. exactly ONE rpc call exists in the wrapper", () => {
    assert.equal(
      [...WRITE_CODE.matchAll(/\.rpc\s*\(/g)].length,
      1,
      "one write, one call — no retry loop and no second entry point",
    );
  });

  test("4. performs zero direct table access", () => {
    assert.ok(
      !/\.from\s*\(/.test(WRITE_CODE),
      "organization_members is SELECT-only for the browser; this RPC is the only way in",
    );
    assert.ok(
      !/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(WRITE_CODE),
      "no SQL of any kind",
    );
  });

  test("5. constructs no service-role client and reads no secret", () => {
    for (const source of [WRITE_CODE, DIAGNOSTIC_CODE, ACTIONS_CODE]) {
      assert.ok(!/createAdminClient/.test(source), "no service-role client");
      assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/.test(source), "no service-role key");
      assert.ok(!/service_role/.test(source), "no service_role reference");
    }
    // It uses the ORDINARY signed-in server client, which is what makes auth.uid() — and
    // therefore the whole authorization chain — apply.
    assert.match(
      WRITE_CODE,
      /from "@\/lib\/supabase\/server"/,
      "must use the ordinary session client",
    );
  });

  test("6. parses the response strictly, and validates the status vocabulary", () => {
    assert.match(WRITE_CODE, /function readStatusRow/, "a real parser must exist");
    // Not a type assertion — a runtime check against the closed vocabulary.
    assert.match(
      WRITE_CODE,
      /isStaffLifecycleStatus\(\s*record\.membership_status\s*\)/,
      "the returned status must be re-validated against the closed set",
    );
    assert.match(
      WRITE_CODE,
      /typeof record\.status_changed !== "boolean"/,
      "status_changed must be type-checked",
    );
    assert.ok(
      !/as SetStaffMembershipStatusResult|as unknown as/.test(WRITE_CODE),
      "no assertion may stand in for a check",
    );
  });

  test("6b. role_code is deliberately NOT read out of the response", () => {
    // Nothing rendered needs it, and a role code has no business travelling further than
    // it must. The roster already carries the row's display role.
    assert.ok(
      !/record\.role_code/.test(WRITE_CODE),
      "the wrapper must not read role_code out of the RPC response",
    );
  });

  test("7. classifies failures by SQLSTATE only — never by message text", () => {
    for (const code of ["42501", "23514", "55000", "22P02"]) {
      assert.ok(
        WRITE_CODE.includes(`"${code}"`),
        `${code} must be handled as a declared constant`,
      );
    }
    assert.match(
      WRITE_CODE,
      /const code = \(result\.error as \{ code\?: string \}\)\.code/,
      "only the code field may be read off the error",
    );
    assert.ok(
      !/\.message/.test(WRITE_CODE),
      "the PostgreSQL message must never be bound — it can name tables, columns and policies",
    );
    assert.ok(
      !/includes\(["'].*(denied|permission|violat)/i.test(WRITE_CODE),
      "no message-substring matching",
    );
  });

  test("8. no raw backend value is returned or logged", () => {
    // The result union carries plain statuses plus a validated membership status. No
    // SQLSTATE, no PostgREST detail, no error object.
    assert.ok(
      !/return\s*\{[^}]*\berror\b\s*[:,]/.test(WRITE_CODE),
      "the result union must not carry an error object",
    );
    // Logging is a fixed category string, never an interpolated value. The `(?<!function )`
    // guard excludes the helper's own DECLARATION, whose parameter list is not a call site.
    const logs = [...WRITE_CODE.matchAll(/(?<!function )logStatusFailure\(([^)]*)\)/g)].map(
      (m) => m[1],
    );
    assert.ok(logs.length > 0, "the wrapper does log, so this rule is not vacuous");
    for (const argument of logs) {
      assert.match(
        argument.trim(),
        /^"[a-z-]+"$/,
        `every logged value must be a fixed literal: ${argument}`,
      );
    }
  });

  test("9. a committed write with an undescribable response never retries", () => {
    // The distinction that matters: `saved-unconfirmed` means COMMITTED. Reporting it as
    // `unavailable` would invite a retry of something that has already happened.
    assert.match(
      WRITE_CODE,
      /if \(row === null\)[\s\S]{0,300}?return \{ status: "saved-unconfirmed" \}/,
      "an unparseable response after a successful call must be saved-unconfirmed",
    );
    assert.ok(
      !/for\s*\(|while\s*\(|retry|attempt\s*\+\+/i.test(WRITE_CODE),
      "there must be no retry loop anywhere in the wrapper",
    );
  });
});

// ============================================================================
// The diagnostic wrapper
// ============================================================================
describe("staff lifecycle — the diagnostic contract", () => {
  test("10. calls the zero-argument RPC with no arguments at all", () => {
    assert.match(
      DIAGNOSTIC_CODE,
      new RegExp(`const\\s+\\w+\\s*=\\s*"${DIAGNOSTIC_RPC}"\\s*as const`),
    );
    // No second argument object: there is no tenant selector, identifier or filter to send.
    assert.match(
      DIAGNOSTIC_CODE,
      /supabase\.rpc\(\s*LIFECYCLE_ACCESS_STATE_RPC,?\s*\)/,
      "the diagnostic must be called with no argument object",
    );
    assert.ok(
      !/p_\w+\s*:/.test(DIAGNOSTIC_CODE),
      "no p_* argument may be constructed anywhere in the diagnostic wrapper",
    );
  });

  test("11. parses against the exact closed vocabulary", () => {
    assert.match(
      DIAGNOSTIC_CODE,
      /isLifecycleAccessState\(value\)/,
      "the returned word must be checked against the closed set",
    );
    // The vocabulary itself lives in the pure module and is asserted there; here we only
    // require that this wrapper does not carry a second, drifting copy of it.
    for (const word of [
      "PROFILE_INACTIVE",
      "MEMBERSHIP_INACTIVE",
      "ORGANIZATION_INACTIVE",
      "NO_SUPPORTED_ACCESS",
      "AMBIGUOUS",
    ]) {
      assert.ok(
        !DIAGNOSTIC_CODE.includes(word),
        `${word} must not be duplicated in the wrapper — the pure module owns the vocabulary`,
      );
    }
  });

  test("12. returns no identifier or personal data, and reads no table", () => {
    assert.ok(!/\.from\s*\(/.test(DIAGNOSTIC_CODE), "no direct table read");
    assert.ok(
      !/(membership_id|profile_id|organization_id|organization_name|email|role_code|user_id)/.test(
        DIAGNOSTIC_CODE,
      ),
      "no identifier or personal field may be read or returned",
    );
    // The result union carries a state or nothing.
    assert.match(
      DIAGNOSTIC_CODE,
      /\{ status: "ok"; accessState: LifecycleAccessState \}\s*\|\s*\{ status: "unavailable" \}/,
      "the result union is a state or an unavailable marker, and nothing else",
    );
  });

  test("12b. every failure collapses to one unavailable outcome", () => {
    // No SQLSTATE branching: a page that already refused access gains nothing from telling
    // a denial apart from a transport failure, and branching would invite someone to use
    // the difference.
    assert.ok(
      !/42501|23514|55000|22P02/.test(DIAGNOSTIC_CODE),
      "the diagnostic must not branch on SQLSTATE",
    );
    assert.ok(!/\.message/.test(DIAGNOSTIC_CODE), "no backend message may be bound");
    // Counting RETURN statements specifically — the result-union type declaration also
    // contains the literal, and counting it would make the number meaningless.
    assert.equal(
      [...DIAGNOSTIC_CODE.matchAll(/return \{ status: "unavailable" \}/g)].length,
      3,
      "transport, rpc-error and malformed-response all resolve to unavailable",
    );
  });

  test("13. the access-denied page trusts NO query-string reason", () => {
    // A `?reason=` parameter would be attacker-controlled text deciding what a page says
    // about an account — a disclosure primitive and a phishing surface.
    assert.ok(
      !/searchParams|useSearchParams|URLSearchParams|\?reason=|req\.url/.test(DENIED_CODE),
      "the page must read nothing about its state from the URL",
    );
    assert.ok(
      !/searchParams/.test(NOTICE_CARD_CODE),
      "and neither may the card it renders",
    );
    // The state comes from the signed-in session, via the RPC.
    assert.match(
      DENIED_CODE,
      /await getMyLifecycleAccessState\(\)/,
      "the diagnostic must be read from the backend using the session",
    );
  });

  test("14. the diagnostic is NEVER used as an authorization gate", () => {
    // It is read only AFTER the ordinary access check has already refused, and its result
    // chooses a sentence. No branch may redirect, grant, or admit on it.
    // Located by CALL SITE, not by name: both functions are also named on their import
    // lines at the top of the file, which would make any ordering comparison meaningless.
    const accessCheckAt = DENIED_CODE.indexOf("await getRetailerOwnerPortalAccess()");
    const diagnosticAt = DENIED_CODE.indexOf("await getMyLifecycleAccessState()");
    assert.ok(accessCheckAt !== -1, "the access check must be called");
    assert.ok(diagnosticAt !== -1, "the diagnostic must be called");
    assert.ok(
      accessCheckAt < diagnosticAt,
      "the authorization check must run BEFORE the diagnostic is consulted",
    );

    // Every redirect on the page is decided by the access check, never by the diagnostic.
    const afterDiagnostic = DENIED_CODE.slice(diagnosticAt);
    assert.ok(
      !/redirect\s*\(/.test(afterDiagnostic),
      "nothing after the diagnostic may redirect — it decides copy, not routing",
    );

    // No other module consumes it, so it cannot have become a gate somewhere else.
    for (const [path, source] of [
      [ACTIONS_PATH, ACTIONS_CODE],
      [ROSTER_PATH, ROSTER_CODE],
      [DIALOG_PATH, DIALOG_CODE],
      [WRITE_WRAPPER_PATH, WRITE_CODE],
    ] as const) {
      assert.ok(
        !source.includes("getMyLifecycleAccessState"),
        `${path} must not consult the diagnostic`,
      );
    }
  });

  test("14b. the diagnostic result is never cached beyond the request", () => {
    for (const source of [DIAGNOSTIC_CODE, DENIED_CODE]) {
      assert.ok(
        !/unstable_cache|["']use cache["']|revalidate\s*[:=]|cache\(/.test(source),
        "no persistent caching of a lifecycle state a Retailer Owner can change at any moment",
      );
    }
  });
});

// ============================================================================
// The Server Action
// ============================================================================
describe("staff lifecycle — the Server Action", () => {
  test("25/26. UUID and status are validated BEFORE the write wrapper is called", () => {
    const validateAt = ACTION_BODY.indexOf("validateStaffLifecycleInput");
    const writeAt = ACTION_BODY.indexOf("setRetailerStaffMembershipStatus(");
    assert.ok(validateAt !== -1, "the action must validate");
    assert.ok(writeAt !== -1, "the action must call the wrapper");
    assert.ok(validateAt < writeAt, "validation must precede the write");

    // And a failed validation returns without reaching the write.
    assert.match(
      ACTION_BODY,
      /if \(!validation\.ok\)[\s\S]{0,600}?return \{/,
      "a rejected submission must return before the write",
    );
  });

  test("27. the write is called exactly once, with no retry", () => {
    assert.equal(
      [...ACTION_BODY.matchAll(/setRetailerStaffMembershipStatus\(/g)].length,
      1,
      "exactly one write call in the action",
    );
    assert.ok(
      !/while\s*\(|for\s*\(|retry/i.test(ACTION_BODY),
      "no retry loop in the action",
    );
  });

  test("28. the submitted membership is verified against a FRESH canonical roster", () => {
    assert.match(
      ACTION_BODY,
      /getRetailerStaffMembers\(\)/,
      "the roster must be re-read inside the action",
    );
    const rosterAt = ACTION_BODY.indexOf("getRetailerStaffMembers()");
    const validateAt = ACTION_BODY.indexOf("validateStaffLifecycleInput");
    assert.ok(rosterAt < validateAt, "the roster is read before validation consumes it");
    // The roster — not the browser — supplies the entries validation checks against.
    assert.match(
      ACTION_BODY,
      /roster\.members\.map\(/,
      "validation entries must be derived from the canonical roster",
    );
  });

  test("28b. the MANAGE capability is proved separately from the roster read", () => {
    // list_retailer_staff_members() requires only RETAILER_STAFF_READ, which a Manager
    // holds. The invitations read requires RETAILER_STAFF_MANAGE — the exact permission
    // this write RPC gates on — so it is the probe that stops a Manager.
    assert.match(
      ACTION_BODY,
      /getRetailerStaffInvitations\(\)/,
      "the action must probe the management capability",
    );
    assert.match(
      ACTION_BODY,
      /manageCapability\.status === "denied"/,
      "a denied capability probe must refuse the write",
    );
  });

  test("29. a committed outcome revalidates AND re-reads the canonical roster", () => {
    assert.match(ACTION_BODY, /revalidatePath\(STAFF_PATH\)/);
    // The re-read happens after the write, as a confirmation.
    const writeAt = ACTION_BODY.indexOf("setRetailerStaffMembershipStatus(");
    const rereadAt = ACTION_BODY.lastIndexOf("getRetailerStaffMembers()");
    assert.ok(rereadAt > writeAt, "the roster must be re-read after a committed write");
  });

  test("30. a failed re-read never retries the write and never reports failure", () => {
    assert.match(
      ACTION_BODY,
      /if \(refreshed\.status !== "ok"\)[\s\S]{0,300}?outcome: "saved-unconfirmed"/,
      "a failed re-read must be reported as a committed-but-unconfirmed success",
    );
    // The saved-unconfirmed branch must not be an error outcome.
    assert.ok(
      !/if \(refreshed\.status !== "ok"\)[\s\S]{0,300}?outcome: "error"/.test(ACTION_BODY),
      "a failed re-read must never be presented as a failed write",
    );
  });

  test("31. every SQLSTATE outcome maps to a safe local message", () => {
    for (const status of [
      "denied",
      "invalid",
      "retailer-unavailable",
      "malformed",
      "unavailable",
      "saved-unconfirmed",
      "changed",
      "unchanged",
    ]) {
      assert.ok(
        ACTION_BODY.includes(`case "${status}":`),
        `the action must handle the ${status} outcome explicitly`,
      );
    }

    // 22P02 (`malformed`) is reported as a denial so a tampered id is indistinguishable
    // from an unauthorized one.
    assert.match(
      ACTION_BODY,
      /case "malformed":[\s\S]{0,300}?LIFECYCLE_DENIED/,
      "a malformed identifier must be reported exactly like a denial",
    );
  });

  test("31b. every operator-facing message is a fixed local literal", () => {
    const constants = [
      "LIFECYCLE_DENIED",
      "LIFECYCLE_INVALID",
      "LIFECYCLE_RETAILER_UNAVAILABLE",
      "LIFECYCLE_UNAVAILABLE",
      "LIFECYCLE_SAVED_UNCONFIRMED",
    ];
    for (const name of constants) {
      const declaration = new RegExp(`const ${name} =\\s*\\n?\\s*"[^"]+";`);
      assert.match(
        ACTIONS_CODE,
        declaration,
        `${name} must be a fixed string literal with no interpolation`,
      );
    }

    // No template literal in the action may interpolate a backend value. The ONE
    // interpolation permitted is the member's display NAME, taken from the canonical
    // roster the server just read.
    const templates = [...ACTION_BODY.matchAll(/`[^`]*\$\{[^}]*\}[^`]*`/g)].map((m) => m[0]);
    for (const template of templates) {
      assert.ok(
        /firstName|lastName/.test(template),
        `only the roster-sourced display name may be interpolated: ${template}`,
      );
    }
  });

  test("31c. the disclosure-sensitive refusals share ONE message", () => {
    // An unknown, cross-tenant, Owner, self, INVITED or SUSPENDED target must be
    // indistinguishable — the RPC raises one byte-identical 42501 for all of them
    // precisely so a caller cannot sweep membership ids.
    assert.match(
      ACTION_BODY,
      /validation\.reason === "invalid-status"\s*\?\s*LIFECYCLE_INVALID\s*:\s*LIFECYCLE_DENIED/,
      "every validation refusal except a malformed status maps to the same message",
    );
  });

  test("32. session loss and lost authorization are handled before anything else", () => {
    const accessAt = ACTION_BODY.indexOf("getRetailerPortalAccess()");
    const writeAt = ACTION_BODY.indexOf("setRetailerStaffMembershipStatus(");
    assert.ok(accessAt !== -1 && accessAt < writeAt);
    assert.match(ACTION_BODY, /redirect\("\/login"\)/, "a lost session redirects to sign-in");
    assert.match(
      ACTION_BODY,
      /redirect\("\/retailer-access-denied"\)/,
      "a lost authorization redirects to the access-denied route",
    );
  });

  test("32b. the action reads exactly two form fields and nothing else", () => {
    const fields = [...ACTION_BODY.matchAll(/formData\.get(?:All)?\(\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      fields.sort(),
      ["membershipId", "requestedStatus"],
      "no organization id, actor, role, permission, current status or audit field is read",
    );
  });

  test("32c. the action performs no direct table access and builds no client", () => {
    assert.ok(!/\.from\s*\(/.test(ACTIONS_CODE), "no direct table access in the actions module");
    assert.ok(
      !/createClient\(/.test(ACTION_BODY),
      "the action delegates the client to the wrapper",
    );
  });
});

// ============================================================================
// The roster UI
// ============================================================================
describe("staff lifecycle — the roster control", () => {
  test("24/36. the control is gated on the MANAGE capability, not on a role name", () => {
    assert.match(
      ROSTER_CODE,
      /showsStaffLifecycleControl\(invitations\.status\)/,
      "visibility is keyed on the read that requires RETAILER_STAFF_MANAGE",
    );
    // No role code decides visibility.
    assert.ok(
      !/RETAILER_MANAGER|RETAILER_OWNER|SALES_STAFF/.test(
        stripComments(VISIBILITY),
      ),
      "the visibility module must name no role code",
    );
  });

  test("1-5. the capability predicate FAILS CLOSED on anything but a confirmed ok", () => {
    // The rule is a POSITIVE test, not a list of things to exclude — so a value this build
    // does not recognize hides the control by construction rather than by omission.
    assert.match(
      stripComments(VISIBILITY),
      /export function showsStaffLifecycleControl\(status: SectionReadStatus\): boolean \{\s*return status === "ok";/,
      "only an explicit ok may show the lifecycle control",
    );
    assert.ok(
      !/showsStaffLifecycleControl[\s\S]{0,200}?!==\s*"denied"/.test(
        stripComments(VISIBILITY),
      ),
      "the lifecycle predicate must not be the permissive !== denied form",
    );

    // Exercised as behaviour, not merely as text: every non-ok status hides the control,
    // including values outside the declared union that a malformed read could produce.
    const predicate = /return status === "ok";/;
    assert.ok(predicate.test(stripComments(VISIBILITY)));
    const showsControl = (status: string): boolean => status === "ok";
    assert.equal(showsControl("ok"), true, "confirmed authority may show controls");
    for (const status of ["denied", "unavailable", "loading", "unknown", "", "OK"]) {
      assert.equal(
        showsControl(status),
        false,
        `${status || "(empty)"} must hide the lifecycle control`,
      );
    }
  });

  test("5b. Manage Shops keeps its own, deliberately different rule", () => {
    // The correction must not have weakened the neighbouring control, whose failure mode is
    // a wasted click rather than an offer to remove a colleague's access.
    assert.match(
      stripComments(VISIBILITY),
      /export function showsManageShops\(status: SectionReadStatus\): boolean \{\s*return status !== "denied";/,
      "showsManageShops must be unchanged",
    );
  });

  test("33/34/35. MEMBERSHIP-level eligibility decides whether a control renders", () => {
    assert.match(
      ROSTER_CODE,
      /canManageLifecycle &&\s*\n?\s*isLifecycleControlOffered\(member\.membershipId, lifecycleEligible\)/,
      "both the capability and the membership's eligibility must hold",
    );
    // The projection is built ONCE over the whole roster, not per row — that is what makes
    // a multi-role member detectable at all.
    assert.match(
      ROSTER_CODE,
      /const lifecycleEligible = buildLifecycleEligibleMemberships\(/,
      "the projection must be built from the whole roster",
    );
    // The row-only predicate must no longer decide the control anywhere on the page.
    assert.ok(
      !/isEligibleLifecycleTarget\(member\)/.test(ROSTER_CODE),
      "the page must not judge a lifecycle row in isolation",
    );

    assert.equal(
      [...ROSTER_CODE.matchAll(/isLifecycleControlOffered\(/g)].length,
      3,
      "the desktop table and the mobile card list (footer + control) must both apply the rule",
    );
    assert.equal(
      [...ROSTER_CODE.matchAll(/<StaffLifecycleDialog/g)].length,
      2,
      "and both must render the same component",
    );
  });

  test("12. roster React keys stay unique when a membership appears twice", () => {
    // list_retailer_staff_members() emits one row per ACTIVE role, so a bare membership id
    // would be a duplicate key — which silently corrupts React reconciliation. The
    // composite key stays unique even for two byte-identical rows.
    const keys = [...ROSTER_CODE.matchAll(/key=\{`([^`]*)`\}/g)].map((m) => m[1]);
    const rowKeys = keys.filter((key) => key.startsWith("${member.membershipId}"));
    assert.equal(rowKeys.length, 2, "the table row and the mobile card must both be keyed");
    for (const key of rowKeys) {
      assert.equal(
        key,
        "${member.membershipId}-${member.roleCode}-${index}",
        "the key must combine membership id, role code and the row index",
      );
    }
    // Which requires the index to be in scope in both layouts.
    assert.equal(
      [...ROSTER_CODE.matchAll(/members\.members\.map\(\(member, index\) =>/g)].length,
      2,
      "both layouts must map with an index",
    );
  });

  test("12b. the composite key is never rendered to a user", () => {
    // It is a reconciliation detail. It must appear only in `key=`, never in text, a title,
    // an aria-label or a data attribute.
    assert.ok(
      !/(aria-label|title|data-[a-z-]+)=\{`[^`]*member\.roleCode[^`]*\$\{index\}/.test(
        ROSTER_CODE,
      ),
      "the composite key must not leak into an accessible name or attribute",
    );
    assert.ok(
      !/>\{`\$\{member\.membershipId\}/.test(ROSTER_CODE),
      "the membership id must never be rendered as text",
    );
  });

  test("33b. the direction comes from the row's CURRENT status", () => {
    // Deactivate for ACTIVE, Reactivate for DEACTIVATED — derived, never guessed.
    assert.match(DIALOG_CODE, /nextLifecycleStatus\(membershipStatus\)/);
    assert.match(DIALOG_CODE, /DIRECTION_COPY\[targetStatus\]/);
    assert.match(DIALOG, /DEACTIVATED:\s*\{\s*\n\s*opener: "Deactivate"/);
    assert.match(DIALOG, /ACTIVE:\s*\{\s*\n\s*opener: "Reactivate"/);
  });

  test("35b. a row with no direction renders nothing at all", () => {
    assert.match(
      DIALOG_CODE,
      /if \(targetStatus === null\) return null;/,
      "defence in depth against a caller that forgets the eligibility check",
    );
  });

  test("37. a submission in flight cannot be duplicated", () => {
    assert.match(DIALOG_CODE, /canSubmitLifecycleChange\(/);
    assert.match(DIALOG_CODE, /submitting: pending/);
    assert.match(DIALOG_CODE, /loading=\{pending\}/, "the confirm button shows progress");
    assert.match(DIALOG_CODE, /disabled=\{!submitEnabled\}/);
    // Cancel and Close are disabled while pending, so a stray click cannot leave the
    // operator unsure whether the change was submitted.
    assert.equal(
      [...DIALOG_CODE.matchAll(/disabled=\{pending\}/g)].length,
      2,
      "Close and Cancel must both be disabled during a write",
    );
    assert.match(
      DIALOG_CODE,
      /function closeDialog\(\) \{\s*if \(pending\) return;/,
      "the dialog cannot be dismissed mid-write",
    );
  });

  test("37b. after a committed write the confirm button is not rendered at all", () => {
    assert.match(
      DIALOG_CODE,
      /\{!committed && \(\s*<Button\s*\n?\s*type="submit"/,
      "no ordinary retry may resubmit a committed change",
    );
    assert.match(DIALOG_CODE, /alreadyCommitted: committed/);
  });

  test("38. the confirmation copy states the preservation semantics", () => {
    // The fact that makes a destructive-sounding action safe to take.
    assert.match(DIALOG, /preservation:/);
    assert.match(DIALOG, /Their profile, sign-in, role and shop assignments are kept/);
    assert.match(DIALOG, /receipts and history/);
    assert.match(DIALOG, /reactivate them at any time/i);
    assert.match(DIALOG, /never removed, so their access returns exactly as it was/);
    // And the deactivate dialog says what is actually lost.
    assert.match(DIALOG, /lose access to the Retailer workspace/);
  });

  test("39. a committed result closes the dialog and shows feedback on the row", () => {
    assert.match(
      DIALOG_CODE,
      /if \(committed\) setOpen\(false\);/,
      "a committed result closes the dialog",
    );
    assert.match(DIALOG_CODE, /aria-live="polite"/, "the outcome is announced");
    // Canonical refresh is the server's job: revalidatePath in the action re-renders the
    // route. The component never patches the roster from what it submitted.
    assert.ok(
      !/router\.refresh|setMembershipStatus|optimistic/i.test(DIALOG_CODE),
      "no optimistic row mutation — the canonical read is the display authority",
    );
  });

  test("40. a failure keeps the dialog open with a safe recovery path", () => {
    // Errors deliberately do NOT close the dialog, so the message appears in the context of
    // the decision, and Cancel remains available.
    assert.match(DIALOG_CODE, /\{state\.error && \(/);
    assert.match(DIALOG_CODE, /<Alert tone="error">\{state\.error\}<\/Alert>/);
    assert.match(DIALOG_CODE, /Cancel/);
  });

  test("41. no uuid, raw status, SQLSTATE or backend message is rendered", () => {
    // The membership id and the requested status appear ONLY as hidden input values —
    // addresses the server re-validates — never as visible text, title, or aria-label.
    assert.match(
      DIALOG_CODE,
      /<input type="hidden" name="membershipId" value=\{membershipId\} \/>/,
    );
    assert.match(
      DIALOG_CODE,
      /<input type="hidden" name="requestedStatus" value=\{targetStatus\} \/>/,
    );
    assert.ok(
      !/aria-label=\{`?\$\{membershipId\}|>\{membershipId\}</.test(DIALOG_CODE),
      "the membership id must never be rendered as text or an accessible name",
    );
    assert.ok(
      !/>\{membershipStatus\}<|aria-label=\{membershipStatus\}/.test(DIALOG_CODE),
      "the raw membership status must never be rendered",
    );
    for (const forbidden of ["42501", "23514", "55000", "22P02", "sqlstate", "postgres"]) {
      assert.ok(
        !new RegExp(forbidden, "i").test(DIALOG_CODE),
        `${forbidden} must not appear in the dialog`,
      );
    }
  });

  test("13/14/15. the status badge reads Active / Inactive, never Deactivated", () => {
    const badge = read("components/ui/badge.tsx");
    const badgeCode = stripComments(badge);

    assert.match(
      badgeCode,
      /ACTIVE: \{ label: "Active"/,
      "ACTIVE must render as Active",
    );
    assert.match(
      badgeCode,
      /DEACTIVATED: \{ label: "Inactive"/,
      "DEACTIVATED must render as Inactive",
    );
    // The user-facing word "Deactivated" must not survive anywhere as a rendered label.
    assert.ok(
      !/label: "Deactivated"/.test(badgeCode),
      "no status label may read Deactivated",
    );
  });

  test("15b. no rendered source carries a user-facing Deactivated label", () => {
    // Repo-wide over the app and component trees. The BACKEND value DEACTIVATED is
    // untouched — this is only about words a person reads.
    const roots = ["app", "components"];
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      if (!existsSync(join(ROOT, dir))) return;
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const code = stripComments(readFileSync(join(ROOT, rel), "utf8"));
        // Case-sensitive on the capitalized display form. `DEACTIVATED` (the backend
        // constant) is deliberately permitted; `Deactivated` and `deactivated` as prose
        // are not.
        if (/\bDeactivated\b/.test(code)) offenders.push(rel);
      }
    };
    for (const root of roots) walk(root);

    assert.deepEqual(
      offenders,
      [],
      `these files render the word "Deactivated" to a user: ${offenders.join(", ")}`,
    );
  });

  test("16. the backend still receives DEACTIVATED exactly", () => {
    // Terminology changed only at the presentation layer. The wire value, the closed
    // vocabulary and the audit trail are untouched.
    assert.match(
      stripComments(read(INPUT_PATH)),
      /STAFF_LIFECYCLE_STATUSES = \["ACTIVE", "DEACTIVATED"\] as const/,
      "the closed status vocabulary must still be ACTIVE / DEACTIVATED",
    );
    assert.match(
      DIALOG_CODE,
      /<input type="hidden" name="requestedStatus" value=\{targetStatus\} \/>/,
      "the submitted value is the backend status, not a display label",
    );
    assert.match(
      DIALOG_CODE,
      /DEACTIVATED: \{/,
      "the direction copy is keyed on the backend status value",
    );
    // And the dialog's own words are the action verbs, not the status noun.
    assert.match(DIALOG, /opener: "Deactivate"/);
    assert.match(DIALOG, /opener: "Reactivate"/);
    assert.match(DIALOG, /confirm: "Deactivate staff"/);
    assert.match(DIALOG, /confirm: "Reactivate staff"/);
  });

  test("41b. the roster heading no longer promises only active staff", () => {
    // list_retailer_staff_members() already returns non-ACTIVE memberships to a
    // RETAILER_STAFF_MANAGE holder, and this milestone makes them actionable — so a
    // heading of "Active staff" would now be wrong for exactly the operator who can act.
    assert.ok(
      !/>\s*Active staff/.test(ROSTER_CODE),
      "the roster section must not be titled 'Active staff'",
    );
    assert.match(ROSTER_CODE, /Staff members/);
  });
});

// ============================================================================
// The inactive-access experience
// ============================================================================
describe("staff lifecycle — the inactive-access page", () => {
  test("42-45. the four lifecycle causes render the notice card", () => {
    assert.match(DENIED_CODE, /resolveLifecycleNotice\(/);
    assert.match(
      DENIED_CODE,
      /if \(notice !== null\) \{[\s\S]{0,300}?<LifecycleNoticeCard\s+title=\{notice\.title\}\s+message=\{notice\.message\}/,
      "a resolved notice renders the lifecycle card with the mapped copy",
    );
    // The copy itself is asserted value-for-value in ./lifecycle-access-state.test.ts.
  });

  test("46-48. everything else keeps the ordinary access-denied card", () => {
    assert.match(
      DENIED_CODE,
      /return <AccessDeniedCard \/>;/,
      "the neutral card remains the fallback",
    );
    // An unreadable diagnostic passes null, which resolves to null and falls through.
    assert.match(
      DENIED_CODE,
      /lifecycle\.status === "ok" \? lifecycle\.accessState : null/,
      "an unavailable diagnostic must resolve to the ordinary experience",
    );
  });

  test("49. the page reads nothing from the URL", () => {
    assert.ok(
      !/searchParams|useSearchParams|URLSearchParams|params/.test(DENIED_CODE),
      "no query string may influence what this page says about an account",
    );
  });

  test("50. a sign-out action remains available on BOTH cards", () => {
    assert.match(NOTICE_CARD_CODE, /<SignOutButton variant="card" \/>/);
    const accessDeniedCard = stripComments(
      read("components/ui/access-denied-card.tsx"),
    );
    assert.match(
      accessDeniedCard,
      /<SignOutButton variant="card" \/>/,
      "the existing card is unchanged and still offers the way out",
    );
  });

  test("50b. the neutral card was NOT made conditional", () => {
    // Vendor /access-denied renders the same component. Adding a reason prop to it would
    // have put both behaviours in one place and made the specific copy reachable from a
    // path that had not earned it.
    const accessDeniedCard = read("components/ui/access-denied-card.tsx");
    assert.ok(
      !/title\??:|message\??:|props/i.test(
        accessDeniedCard.slice(accessDeniedCard.indexOf("export function AccessDeniedCard")),
      ),
      "AccessDeniedCard must remain a no-prop, fixed, neutral component",
    );
    assert.match(accessDeniedCard, /export function AccessDeniedCard\(\) \{/);
  });

  test("50c. the notice card interpolates only its two fixed props", () => {
    assert.match(NOTICE_CARD_CODE, /\{title\}/);
    assert.match(NOTICE_CARD_CODE, /\{message\}/);
    const interpolations = [...NOTICE_CARD_CODE.matchAll(/\{([a-zA-Z.]+)\}/g)].map(
      (m) => m[1],
    );
    for (const name of interpolations) {
      assert.ok(
        ["title", "message"].includes(name) || name.startsWith("/"),
        `only title and message may be rendered, found ${name}`,
      );
    }
  });
});

// ============================================================================
// Milestone-wide safety
// ============================================================================
describe("staff lifecycle — milestone-wide safety", () => {
  test("no milestone file performs a direct protected-table write", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(!/\.from\s*\(/.test(code), `${path} must not access a table directly`);
      assert.ok(
        !/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(code),
        `${path} must contain no SQL`,
      );
    }
  });

  test("no milestone file imports a service-role client or reads a secret", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(!/createAdminClient/.test(code), `${path} must not build an admin client`);
      assert.ok(
        !/SUPABASE_SERVICE_ROLE_KEY|service_role/.test(code),
        `${path} must not reference the service role`,
      );
      assert.ok(
        !/NEXT_PUBLIC_/.test(code),
        `${path} must not introduce a public environment variable`,
      );
    }
  });

  test("no milestone file interpolates a raw error into anything", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(
        !/\$\{[^}]*\b(error|err|e)\b[^}]*\}/.test(code),
        `${path} must not interpolate an error value`,
      );
      assert.ok(
        !/JSON\.stringify\s*\(\s*(error|err|result)/.test(code),
        `${path} must not serialize an error or a raw result`,
      );
      assert.ok(
        !/console\.(log|warn|info|debug)\s*\(\s*[a-zA-Z_$]/.test(code),
        `${path} must not log a bare identifier`,
      );
    }
  });

  test("the status write exists in no Edge Function", () => {
    // The write's whole authority is auth.uid(); an Edge Function would add a
    // service-role path to an operation that must never have one.
    const functionsDir = join(ROOT, "supabase/functions");
    if (!existsSync(functionsDir)) return;

    const walk = (dir: string): string[] => {
      const found: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) found.push(...walk(full));
        else if (/\.(ts|js)$/.test(entry)) found.push(full);
      }
      return found;
    };

    for (const file of walk(functionsDir)) {
      const code = readFileSync(file, "utf8");
      assert.ok(
        !code.includes(WRITE_RPC),
        `${file} must not call the staff status write`,
      );
      assert.ok(
        !code.includes(DIAGNOSTIC_RPC),
        `${file} must not call the lifecycle diagnostic`,
      );
    }
  });

  test("get_my_portal_context() is untouched by this milestone", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(
        !/get_my_portal_context/.test(code),
        `${path} must not call or alter the portal context`,
      );
    }
  });

  test("no Vendor Retailer lifecycle RPC or permission was introduced", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(
        !/set_vendor_retailer_status|RETAILER_LIFECYCLE|RETAILER_STATUS_MANAGE|VENDOR_RETAILER_STATUS/.test(
          code,
        ),
        `${path} must not begin the Vendor Retailer lifecycle milestone`,
      );
    }
  });

  test("no Flutter file exists in this repository", () => {
    for (const path of ["pubspec.yaml", "lib/main.dart", "android", "ios", "flutter"]) {
      assert.ok(
        !existsSync(join(ROOT, path)),
        `${path} must not exist — Flutter is out of scope`,
      );
    }
  });

  test("exactly two RPC names were added by this milestone, and both are the deployed ones", () => {
    const rpcNames = new Set<string>();
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      for (const match of code.matchAll(/"([a-z_]+)" as const/g)) {
        if (match[1].includes("_")) rpcNames.add(match[1]);
      }
    }
    assert.deepEqual(
      [...rpcNames].sort(),
      [DIAGNOSTIC_RPC, WRITE_RPC].sort(),
      "no third RPC surface may appear",
    );
  });
});
