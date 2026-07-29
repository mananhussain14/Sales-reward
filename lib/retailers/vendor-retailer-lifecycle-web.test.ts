/**
 * STATIC CONTRACT AND SOURCE-SAFETY GUARDS for the Vendor Retailer lifecycle WEB milestone.
 *
 *   lib/retailers/vendor-retailer-lifecycle.ts                          (RPC wrapper)
 *   lib/retailers/vendor-retailer-manage-capability.ts                  (capability probe)
 *   app/(admin)/retailers/[relationshipId]/actions.ts                   (Server Action)
 *   app/(admin)/retailers/[relationshipId]/retailer-lifecycle-dialog.tsx (control)
 *   app/(admin)/retailers/[relationshipId]/page.tsx                     (detail page)
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * These are SOURCE-LEVEL assertions, in the same idiom as ../staff/staff-source-safety.test.ts.
 * The three modules they cover cannot be unit-tested behaviourally in this repository: the
 * wrapper and the action transitively import `next/headers`, and the dialog needs a DOM there
 * is no harness for. The pure DECISIONS are exercised properly in
 * ./vendor-retailer-lifecycle-input.test.ts; what is asserted here is the set of properties
 * that are cheap to check on every `npm test` and expensive to notice once broken — that the
 * RPC surface did not grow, that no service-role client or table write appeared, that error
 * handling still reads SQLSTATE and never a message, that no retry was introduced after a
 * committed write, and that the milestone did not spread beyond the detail page.
 *
 * The BEHAVIOURAL authority for the database side is
 * supabase/tests/database/vendor_retailer_lifecycle_test.sql (292 assertions), and nothing
 * here is a substitute for it.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();

const WRAPPER_PATH = "lib/retailers/vendor-retailer-lifecycle.ts";
const CAPABILITY_PATH = "lib/retailers/vendor-retailer-manage-capability.ts";
const INPUT_PATH = "lib/retailers/vendor-retailer-lifecycle-input.ts";
const ACTIONS_PATH = "app/(admin)/retailers/[relationshipId]/actions.ts";
const DIALOG_PATH = "app/(admin)/retailers/[relationshipId]/retailer-lifecycle-dialog.tsx";
const DETAIL_PAGE_PATH = "app/(admin)/retailers/[relationshipId]/page.tsx";
const LIST_PAGE_PATH = "app/(admin)/retailers/page.tsx";
const BADGE_PATH = "components/ui/badge.tsx";
const STATE_PATH = "app/(admin)/retailers/[relationshipId]/lifecycle-state.ts";

/** Every file this milestone created or changed, for the sweep-style guards. */
const MILESTONE_FILES = [
  WRAPPER_PATH,
  CAPABILITY_PATH,
  INPUT_PATH,
  ACTIONS_PATH,
  DIALOG_PATH,
  STATE_PATH,
  DETAIL_PAGE_PATH,
];

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/**
 * The source with every comment removed.
 *
 * Load-bearing, not tidiness: these files' headers discuss `service_role`, `.from(`, retries,
 * `auth.users` and the multi-Vendor guard at length precisely to explain why none of them is
 * used, so an assertion against the raw text would fail on the very sentence that states the
 * guarantee. Same idiom as ../staff/staff-source-safety.test.ts.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const WRAPPER = read(WRAPPER_PATH);
const WRAPPER_CODE = stripComments(WRAPPER);
const CAPABILITY_CODE = stripComments(read(CAPABILITY_PATH));
const ACTIONS = read(ACTIONS_PATH);
const ACTIONS_CODE = stripComments(ACTIONS);
const DIALOG = read(DIALOG_PATH);
const DIALOG_CODE = stripComments(DIALOG);
const DETAIL_PAGE = read(DETAIL_PAGE_PATH);
const DETAIL_PAGE_CODE = stripComments(DETAIL_PAGE);
const LIST_PAGE_CODE = stripComments(read(LIST_PAGE_PATH));
const BADGE = read(BADGE_PATH);

/** The one RPC this milestone may call for the write. */
const WRITE_RPC = "set_vendor_retailer_status";
/** The permission the capability probe asks about. */
const PERMISSION = "RETAILERS_MANAGE";

/** Every tracked source file under the app/lib/components trees. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const APP_SOURCES = [
  ...walk(join(ROOT, "app")),
  ...walk(join(ROOT, "lib")),
  ...walk(join(ROOT, "components")),
];

/** Application sources, excluding the test files that must NAME these things to guard them. */
const APP_ONLY = APP_SOURCES.filter((file) => !file.endsWith(".test.ts"));

// ============================================================================
// The RPC wrapper
// ============================================================================
describe("Vendor Retailer lifecycle wrapper — the RPC surface", () => {
  test("1. calls the exact RPC name", () => {
    assert.match(WRAPPER_CODE, /const SET_VENDOR_RETAILER_STATUS_RPC = "set_vendor_retailer_status"/);
    assert.match(WRAPPER_CODE, /supabase\.rpc\(SET_VENDOR_RETAILER_STATUS_RPC,/);
  });

  test("2. sends exactly the two documented argument keys", () => {
    const call = WRAPPER_CODE.slice(
      WRAPPER_CODE.indexOf("supabase.rpc(SET_VENDOR_RETAILER_STATUS_RPC"),
      WRAPPER_CODE.indexOf(").catch(() => null)"),
    );
    const keys = [...call.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
    assert.deepEqual(keys, ["p_relationship_id", "p_status"]);
  });

  test("3. sends no extra field — no tenant, actor, status or audit argument", () => {
    const call = WRAPPER_CODE.slice(
      WRAPPER_CODE.indexOf("supabase.rpc(SET_VENDOR_RETAILER_STATUS_RPC"),
      WRAPPER_CODE.indexOf(").catch(() => null)"),
    );
    for (const forbidden of [
      "organization",
      "vendor_id",
      "retailer_id",
      "actor",
      "profile",
      "role",
      "permission",
      "current",
      "audit",
      "timestamp",
    ]) {
      assert.ok(
        !call.includes(forbidden),
        `the RPC call must not carry ${forbidden}`,
      );
    }
  });

  test("4. issues exactly one RPC call", () => {
    const calls = WRAPPER_CODE.match(/\.rpc\(/g) ?? [];
    assert.equal(calls.length, 1, "one write, one call");
  });

  test("5. performs no direct table access", () => {
    assert.ok(!WRAPPER_CODE.includes(".from("), "no .from( anywhere in the wrapper");
  });

  test("6. uses the ordinary session client, never service-role", () => {
    assert.match(WRAPPER_CODE, /from "@\/lib\/supabase\/server"/);
    assert.ok(!/service[_-]?role/i.test(WRAPPER_CODE));
    assert.ok(!/SERVICE_ROLE|SECRET_KEY|createServiceClient/i.test(WRAPPER_CODE));
  });

  test("7. delegates response parsing to the pure, behaviourally-tested parser", () => {
    assert.match(WRAPPER_CODE, /readVendorRetailerLifecycleRow\(/);
    assert.ok(
      !/as SetVendorRetailerStatusResult|as \{ *retailer_status/.test(WRAPPER_CODE),
      "no type assertion may stand in for a runtime check",
    );
  });

  test("8. passes the SUBMITTED target to the parser, so the returned row is proved", () => {
    // The parser cannot check that the response describes the row this call addressed unless
    // the wrapper hands it the id that was submitted. Every rule the parser then applies —
    // all four columns and the row count — is exercised in ./vendor-retailer-lifecycle-input.test.ts.
    assert.match(
      WRAPPER_CODE,
      /readVendorRetailerLifecycleRow\(\s*result\.data as unknown,\s*relationshipId,\s*\)/,
    );
  });

  test("8b. all four returned columns are validated somewhere", () => {
    const parser = stripComments(read(INPUT_PATH));
    assert.match(parser, /record\.relationship_id/, "the identifier is read");
    assert.match(parser, /UUID_PATTERN\.test\(returnedId\)/, "and shape-checked");
    assert.match(
      parser,
      /returnedId\.toLowerCase\(\) !== expectedRelationshipId/,
      "and compared to the submitted target",
    );
    assert.match(parser, /isVendorRetailerLifecycleStatus\(record\.retailer_status\)/);
    assert.match(parser, /isVendorRetailerLifecycleStatus\(record\.relationship_status\)/);
    assert.match(
      parser,
      /record\.retailer_status !== record\.relationship_status/,
      "the rows move together; a mismatched response is drift, not a variant",
    );
    assert.match(parser, /typeof record\.status_changed !== "boolean"/);
    assert.match(parser, /data\.length !== 1/, "exactly one row");
  });

  test("8c. the parser returns no identifier to its caller", () => {
    const parser = stripComments(read(INPUT_PATH));
    const returnBlock = parser.slice(
      parser.lastIndexOf("return {", parser.indexOf("retailerStatus: record.retailer_status")),
      parser.indexOf("changed: record.status_changed") + 40,
    );
    assert.ok(
      !/relationship_id|returnedId/.test(returnBlock),
      "validated internally, then discarded — validation and exposure are separate concerns",
    );
  });

  test("9. classifies failures by SQLSTATE only", () => {
    for (const code of ["42501", "23514", "55000", "22P02"]) {
      assert.ok(WRAPPER_CODE.includes(code), `${code} must be mapped`);
    }
    assert.match(WRAPPER_CODE, /const code = \(result\.error as \{ code\?: string \}\)\.code/);
  });

  test("10. never reads, returns or logs error.message", () => {
    assert.ok(!/error\.message/.test(WRAPPER_CODE));
    assert.ok(!/\.message/.test(WRAPPER_CODE), "no message property is touched at all");
    assert.ok(!/console\.error\([^)]*error/.test(WRAPPER_CODE));
  });

  test("11. contains no retry of any kind", () => {
    for (const forbidden of [/\bfor\s*\(/, /\bwhile\s*\(/, /retry/i, /attempt/i, /setTimeout/]) {
      assert.ok(!forbidden.test(WRAPPER_CODE), `${forbidden} suggests a retry loop`);
    }
  });

  test("12. carries the saved-unconfirmed outcome, distinct from unavailable", () => {
    assert.match(WRAPPER_CODE, /status: "saved-unconfirmed"/);
    assert.match(WRAPPER_CODE, /status: "unavailable"/);
    for (const outcome of [
      "changed",
      "unchanged",
      "denied",
      "invalid",
      "retailer-unavailable",
      "malformed",
    ]) {
      assert.ok(WRAPPER.includes(`"${outcome}"`), `${outcome} must be part of the vocabulary`);
    }
  });

  test("12b. EVERY parse failure returns saved-unconfirmed — never unavailable, never unchanged", () => {
    const branch = WRAPPER_CODE.slice(
      WRAPPER_CODE.indexOf("if (row === null)"),
      WRAPPER_CODE.indexOf("return {\n    status: row.changed"),
    );
    assert.match(branch, /saved-unconfirmed/);
    assert.ok(
      !branch.includes('"unavailable"'),
      "reporting a committed write as a failure would invite a retry of something already done",
    );
    assert.ok(
      !branch.includes('"unchanged"'),
      "claiming nothing changed could hide an entire Retailer having just been deactivated",
    );
  });

  test("12d. a malformed successful response cannot cause a second RPC call", () => {
    // Structural, and therefore total: the module contains exactly ONE `.rpc(` (test 4) and no
    // loop or timer (test 11), so there is no second call to reach. This pins the remaining
    // way one could appear — the malformed branch falling through instead of returning.
    const branch = WRAPPER_CODE.slice(
      WRAPPER_CODE.indexOf("if (row === null)"),
      WRAPPER_CODE.indexOf("return {\n    status: row.changed"),
    );
    assert.match(branch, /return \{ status: "saved-unconfirmed" \};/);
    assert.ok(!branch.includes(".rpc("), "the recovery path issues no call of its own");
  });

  test("12c. the unparseable response itself is never logged", () => {
    const branch = WRAPPER_CODE.slice(
      WRAPPER_CODE.indexOf("if (row === null)"),
      WRAPPER_CODE.indexOf("return {\n    status: row.changed"),
    );
    // A wrong relationship id is exactly the kind of value that must not reach an operator log.
    assert.match(branch, /logLifecycleFailure\("malformed-response"\)/);
    assert.ok(!/result\.data|JSON\.stringify|row\b.*\)/.test(branch.replace(/row === null/, "")));
  });
});

// ============================================================================
// The capability probe
// ============================================================================
describe("Vendor Retailer lifecycle — the capability probe", () => {
  test("13. asks the database, with a server-derived organization id and no argument", () => {
    assert.match(CAPABILITY_CODE, /has_organization_permission/);
    assert.match(CAPABILITY_CODE, /target_organization_id: access\.organizationId/);
    assert.match(CAPABILITY_CODE, new RegExp(`target_permission_code: ${PERMISSION}`));
    assert.match(
      CAPABILITY_CODE,
      /export async function getVendorRetailerManageCapability\(\): Promise/,
      "zero arguments — nothing for a caller to substitute",
    );
  });

  test("14. resolves the Vendor from the verified session, not from input", () => {
    assert.match(CAPABILITY_CODE, /await getVendorSuperAdminAccess\(\)/);
    assert.match(CAPABILITY_CODE, /access\.status !== "authorized"/);
  });

  test("15. fails closed on a non-boolean answer instead of coercing it", () => {
    assert.match(CAPABILITY_CODE, /typeof granted !== "boolean"/);
    assert.ok(
      !/Boolean\(/.test(CAPABILITY_CODE),
      "coercion would turn 'we could not ask' into a definite denial",
    );
  });

  test("16. keeps denied and unavailable apart, and uses no service-role client", () => {
    assert.match(CAPABILITY_CODE, /status: "denied"/);
    assert.match(CAPABILITY_CODE, /status: "unavailable"/);
    assert.ok(!/service[_-]?role/i.test(CAPABILITY_CODE));
    assert.ok(!CAPABILITY_CODE.includes(".from("));
  });

  test("17. never reads error.message", () => {
    assert.ok(!/error\.message/.test(CAPABILITY_CODE));
    assert.ok(!/\.message/.test(CAPABILITY_CODE));
  });
});

// ============================================================================
// The Server Action
// ============================================================================
describe("Vendor Retailer lifecycle — the Server Action", () => {
  test("18. reads only relationshipId and requestedStatus from the form", () => {
    const gets = [...ACTIONS_CODE.matchAll(/formData\.get\("(\w+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(gets.sort(), ["relationshipId", "requestedStatus"]);
  });

  test("19. validates both fields BEFORE any read or write", () => {
    const validateAt = ACTIONS_CODE.indexOf("validateVendorRetailerLifecycleSubmission");
    const accessAt = ACTIONS_CODE.indexOf("getVendorSuperAdminAccess()");
    const detailAt = ACTIONS_CODE.indexOf("getVendorRetailerDetail(");
    const writeAt = ACTIONS_CODE.indexOf("setVendorRetailerStatus(");

    assert.ok(validateAt > 0 && accessAt > 0 && detailAt > 0 && writeAt > 0);
    assert.ok(validateAt < accessAt, "format is checked before the session is resolved");
    assert.ok(validateAt < detailAt, "and before a canonical read happens");
    assert.ok(validateAt < writeAt, "and certainly before the write");
  });

  test("20. re-resolves Vendor access and redirects on a lost session", () => {
    assert.match(ACTIONS_CODE, /redirect\("\/login"\)/);
    assert.match(ACTIONS_CODE, /redirect\("\/access-denied"\)/);
  });

  test("21. explicitly confirms RETAILERS_MANAGE with positive equality", () => {
    assert.match(ACTIONS_CODE, /getVendorRetailerManageCapability\(\)/);
    assert.match(ACTIONS_CODE, /!isConfirmedManageCapability\(capability\.status\)/);
    assert.ok(
      !/capability\.status !== "denied"/.test(ACTIONS_CODE),
      "an exclusion list would fail open on an unrecognized state",
    );
  });

  test("22. performs a fresh canonical detail read for the caller", () => {
    assert.match(ACTIONS_CODE, /getVendorRetailerDetail\(submission\.relationshipId\)/);
  });

  test("23. a foreign or unknown relationship never reaches the write", () => {
    const notFoundAt = ACTIONS_CODE.indexOf('detail.status === "not-found"');
    const writeAt = ACTIONS_CODE.indexOf("await setVendorRetailerStatus(");
    assert.ok(notFoundAt > 0 && notFoundAt < writeAt);
  });

  test("24. re-validates the lifecycle pair from the canonical read", () => {
    assert.match(
      ACTIONS_CODE,
      /validateVendorRetailerLifecycleTransition\(\s*\{\s*retailerStatus: retailer\.retailerStatus/,
      "the pair comes from the server read, never from the form",
    );
    const transitionAt = ACTIONS_CODE.indexOf("validateVendorRetailerLifecycleTransition");
    const writeAt = ACTIONS_CODE.indexOf("await setVendorRetailerStatus(");
    assert.ok(transitionAt < writeAt);
  });

  test("25. sends the status the SERVER derived, not the one submitted", () => {
    assert.match(
      ACTIONS_CODE,
      /setVendorRetailerStatus\(\s*submission\.relationshipId,\s*transition\.requestedStatus,/,
    );
  });

  test("26. issues exactly one write call", () => {
    const calls = ACTIONS_CODE.match(/await setVendorRetailerStatus\(/g) ?? [];
    assert.equal(calls.length, 1);
  });

  test("27. revalidates and rereads canonical data after a committed change", () => {
    assert.match(ACTIONS_CODE, /revalidatePath\(retailerDetailPath\(submission\.relationshipId\)\)/);
    const rereads = ACTIONS_CODE.match(/getVendorRetailerDetail\(/g) ?? [];
    assert.equal(rereads.length, 2, "one pre-flight read, one confirming reread");
  });

  test("28. a no-op is revalidated and reread on the same path as a change", () => {
    // Both fall through the same switch to the shared step 7; only the final sentence differs.
    assert.match(ACTIONS_CODE, /case "changed":\s*\n\s*case "unchanged":/);
    assert.match(ACTIONS_CODE, /describeVendorRetailerLifecycleNoChange\(/);
  });

  test("29. a failed reread after commit returns saved-unconfirmed, never an error", () => {
    const branch = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf('if (refreshed.status !== "authorized")'),
      ACTIONS_CODE.indexOf('if (result.status === "unchanged")'),
    );
    assert.match(branch, /outcome: "saved-unconfirmed"/);
    assert.ok(!branch.includes('outcome: "error"'));
  });

  test("30. contains no retry after a committed write", () => {
    for (const forbidden of [/\bfor\s*\(/, /\bwhile\s*\(/, /retry/i, /setTimeout/]) {
      assert.ok(!forbidden.test(ACTIONS_CODE), `${forbidden} suggests a retry`);
    }
  });

  test("31. maps every SQLSTATE outcome to safe local copy", () => {
    for (const outcome of [
      "denied",
      "invalid",
      "retailer-unavailable",
      "malformed",
      "unavailable",
      "saved-unconfirmed",
    ]) {
      assert.ok(ACTIONS_CODE.includes(`case "${outcome}"`), `${outcome} must be handled`);
    }
  });

  test("32. the 55000 copy discloses no multi-Vendor state", () => {
    const message = ACTIONS.match(
      /const LIFECYCLE_RETAILER_UNAVAILABLE =\s*\n?\s*"([^"]+)"/,
    )?.[1];
    assert.ok(message, "the generic lifecycle message must exist");
    for (const forbidden of [
      /another vendor/i,
      /other vendor/i,
      /vendors?\b.*manage/i,
      /mismatch/i,
      /deactivated/i,
      /permanently/i,
      /relationship/i,
      /count/i,
    ]) {
      assert.doesNotMatch(message!, forbidden, `55000 copy must not mention ${forbidden}`);
    }
  });

  test("33. no operator copy carries a UUID, SQLSTATE or backend text", () => {
    const messages = [...ACTIONS.matchAll(/const LIFECYCLE_\w+ =\s*\n?\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(messages.length >= 5, "all five copy constants must be found");
    for (const message of messages) {
      assert.doesNotMatch(message, /[0-9a-f]{8}-[0-9a-f]{4}/i);
      assert.doesNotMatch(message, /42501|23514|55000|22P02/);
      assert.doesNotMatch(message, /postgres|supabase|rpc|sql|policy|constraint/i);
      assert.doesNotMatch(message, /suspend/i, "the product never says suspended");
    }
  });

  test("34. the unavailable copy states that nothing was retried", () => {
    const message = ACTIONS.match(/const LIFECYCLE_UNAVAILABLE =\s*\n?\s*"([^"]+)"/)?.[1];
    assert.match(message!, /not retried|nothing was retried/i);
  });

  test("35. the saved-unconfirmed copy asks for a refresh, never a resubmission", () => {
    const message = ACTIONS.match(
      /const LIFECYCLE_SAVED_UNCONFIRMED =\s*\n?\s*"([^"]+)"/,
    )?.[1];
    assert.match(message!, /refresh/i);
    assert.doesNotMatch(message!, /try again|retry|resubmit/i);
  });

  test("36. the Retailer name is display-only and never an authorization input", () => {
    assert.match(ACTIONS_CODE, /const retailerName = retailer\.retailerName/);
    assert.ok(
      !/formData\.get\("retailerName"\)|formData\.get\("name"\)/.test(ACTIONS_CODE),
      "the name must never arrive from the browser",
    );
  });

  test("37. no direct table access and no service-role client", () => {
    assert.ok(!ACTIONS_CODE.includes(".from("));
    assert.ok(!/service[_-]?role/i.test(ACTIONS_CODE));
  });
});

// ============================================================================
// The control
// ============================================================================
describe("Vendor Retailer lifecycle — the dialog", () => {
  test("38. renders nothing for an unsupported pair", () => {
    assert.match(DIALOG_CODE, /if \(action === null\) return null;/);
    assert.match(DIALOG_CODE, /resolveVendorRetailerLifecycle\(\{/);
  });

  test("39. offers Deactivate for the active pair and Reactivate for the inactive one", () => {
    assert.match(DIALOG, /SUSPENDED: \{[\s\S]*?opener: "Deactivate Retailer"/);
    assert.match(DIALOG, /ACTIVE: \{[\s\S]*?opener: "Reactivate Retailer"/);
    assert.match(DIALOG, /heading: "Deactivate Retailer\?"/);
    assert.match(DIALOG, /heading: "Reactivate Retailer\?"/);
  });

  test("40. the deactivation copy describes global Retailer-user blocking", () => {
    const block = DIALOG.slice(DIALOG.indexOf("SUSPENDED: {"), DIALOG.indexOf("ACTIVE: {"));
    assert.match(block, /Retailer Owner/);
    assert.match(block, /Retailer Manager/);
    assert.match(block, /Sales Staff/);
    assert.match(block, /already signed in/i);
    assert.match(block, /refresh|next .*action/i);
    assert.match(block, /Receipt submission stops/i);
    assert.match(block, /Shop creation, product assignment and invitation/i);
  });

  test("41. the deactivation copy states preservation and reversibility", () => {
    const block = DIALOG.slice(DIALOG.indexOf("SUSPENDED: {"), DIALOG.indexOf("ACTIVE: {"));
    assert.match(block, /Nothing is deleted/i);
    assert.match(block, /receipts and pending invitations/i);
    assert.match(block, /reactivat/i);
  });

  test("42. the reactivation copy states restoration and invitation validity", () => {
    const block = DIALOG.slice(DIALOG.indexOf("ACTIVE: {"), DIALOG.indexOf("} as const"));
    assert.match(block, /users, roles, Shops and Shop assignments/i);
    assert.match(block, /available again/i);
    assert.match(block, /invitation that is still valid|not expired/i);
    assert.match(block, /Receipt access resumes/i);
  });

  test("43. Cancel is offered and dismissal is blocked only while pending", () => {
    assert.match(DIALOG, />\s*Cancel\s*</);
    assert.match(DIALOG_CODE, /function closeDialog\(\) \{\s*\n?\s*if \(pending\) return;/);
  });

  test("44. duplicate submission is prevented while a request is in flight", () => {
    assert.match(DIALOG_CODE, /canSubmitVendorRetailerLifecycleChange\(\{/);
    assert.match(DIALOG_CODE, /submitting: pending/);
    assert.match(DIALOG_CODE, /alreadyCommitted: committed/);
    assert.match(DIALOG_CODE, /disabled=\{!submitEnabled\}/);
    assert.match(DIALOG_CODE, /loading=\{pending\}/);
  });

  test("45. the confirm button disappears once committed", () => {
    assert.match(DIALOG_CODE, /\{!committed && \(/);
  });

  test("46. a visible progress label is shown while pending", () => {
    assert.match(DIALOG, /pendingLabel: "Deactivating…"/);
    assert.match(DIALOG, /pendingLabel: "Reactivating…"/);
    assert.match(DIALOG_CODE, /loadingLabel=\{copy\.pendingLabel\}/);
  });

  test("47. is keyboard accessible with focus entry, restoration and Escape", () => {
    assert.match(DIALOG_CODE, /role="dialog"/);
    assert.match(DIALOG_CODE, /aria-modal="true"/);
    assert.match(DIALOG_CODE, /aria-labelledby=\{headingId\}/);
    assert.match(DIALOG_CODE, /aria-describedby=\{descriptionId\}/);
    assert.match(DIALOG_CODE, /dialogRef\.current\?\.focus\(\)/);
    assert.match(DIALOG_CODE, /openerRef\.current\?\.focus\(\)/);
    assert.match(DIALOG_CODE, /event\.key === "Escape" && !pending/);
  });

  test("48. performs no optimistic status mutation", () => {
    for (const forbidden of [/useOptimistic/, /setRetailerStatus/, /setStatus\(/]) {
      assert.ok(!forbidden.test(DIALOG_CODE), `${forbidden} would fabricate a state`);
    }
  });

  test("49. a committed result closes the dialog and an error keeps it open", () => {
    assert.match(DIALOG_CODE, /if \(committed\) setOpen\(false\)/);
  });

  test("50. no capability object is passed to the browser", () => {
    assert.ok(
      !/capability/i.test(DIALOG_CODE),
      "the capability decided whether this renders; it must not travel to the client",
    );
  });

  test("51. renders no identifier, raw status, SQLSTATE or backend error", () => {
    // The id and the statuses appear only as hidden-input values and as decision inputs.
    assert.match(DIALOG_CODE, /<input type="hidden" name="relationshipId"/);
    assert.ok(!/>\{relationshipId\}</.test(DIALOG_CODE), "the id is never rendered as text");
    assert.ok(!/>\{retailerStatus\}</.test(DIALOG_CODE));
    assert.ok(!/>\{relationshipStatus\}</.test(DIALOG_CODE));
    assert.ok(!/42501|23514|55000|22P02/.test(DIALOG_CODE));
  });

  test("52. no service-role client, table access or raw error surfaces here", () => {
    assert.ok(!DIALOG_CODE.includes(".from("));
    assert.ok(!/service[_-]?role/i.test(DIALOG_CODE));
    assert.ok(!/error\.message/.test(DIALOG_CODE));
  });
});

// ============================================================================
// The detail page
// ============================================================================
describe("Vendor Retailer lifecycle — the detail page", () => {
  test("53. gates the control on confirmed capability AND a supported pair", () => {
    assert.match(DETAIL_PAGE_CODE, /isVendorRetailerLifecycleControlOffered\(\{/);
    assert.match(DETAIL_PAGE_CODE, /if \(!offered\) return null;/);
  });

  test("54. reads the capability server-side, in parallel with the detail", () => {
    assert.match(DETAIL_PAGE_CODE, /getVendorRetailerManageCapability\(\)/);
    assert.match(DETAIL_PAGE_CODE, /const \[detail, manageCapability, resolvedSearchParams\]/);
  });

  test("55. keys the control by relationshipId", () => {
    assert.match(DETAIL_PAGE_CODE, /key=\{relationshipId\}/);
  });

  test("56. renders the shared status badge rather than a raw status string", () => {
    assert.match(DETAIL_PAGE_CODE, /<StatusBadge status=\{retailer\.retailerStatus\} \/>/);
  });

  test("57. caches no authorization state", () => {
    for (const forbidden of [/unstable_cache/, /"use cache"/, /revalidate\s*=/, /cache\(/]) {
      assert.ok(!forbidden.test(DETAIL_PAGE_CODE), `${forbidden} must not appear`);
    }
  });

  test("58. performs no direct table access and imports no service-role client", () => {
    assert.ok(!DETAIL_PAGE_CODE.includes(".from("));
    assert.ok(!/service[_-]?role/i.test(DETAIL_PAGE_CODE));
  });
});

// ============================================================================
// Terminology
// ============================================================================
describe("Vendor Retailer lifecycle — terminology", () => {
  test("59. the shared badge renders SUSPENDED as Inactive", () => {
    assert.match(BADGE, /SUSPENDED: \{ label: "Inactive"/);
  });

  test("60. no status label anywhere renders the word Suspended", () => {
    const map = BADGE.slice(BADGE.indexOf("const STATUS_MAP"), BADGE.indexOf("function statusIcon"));
    const labels = [...map.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    assert.ok(labels.length > 0);
    for (const label of labels) {
      assert.doesNotMatch(label, /suspend/i, `the label "${label}" must not say Suspended`);
    }
  });

  test("61. no application source renders 'Suspended' as user-facing text", () => {
    const offenders = APP_ONLY.filter((file) => {
      if (!file.endsWith(".tsx") && !file.endsWith(".ts")) return false;
      return /suspended/i.test(stripComments(readFileSync(file, "utf8")));
    }).map((file) => file.replace(`${ROOT}/`, ""));

    // The stored value SUSPENDED is legitimate in decision code; the capitalized display word
    // is not. Only files that mention it in executable code are listed, and each must be one
    // that uses the STORED vocabulary.
    for (const file of offenders) {
      const code = stripComments(read(file));
      const displayUse = /"[^"]*\bSuspended\b[^"]*"/.test(code);
      assert.ok(
        !displayUse,
        `${file} contains a user-facing "Suspended" string`,
      );
    }
  });

  test("62. the RPC input vocabulary is still SUSPENDED, not INACTIVE", () => {
    const inputCode = stripComments(read(INPUT_PATH));
    assert.match(inputCode, /\["ACTIVE", "SUSPENDED"\] as const/);
    assert.ok(
      !/requestedStatus: "INACTIVE"/.test(inputCode),
      "INACTIVE must never be produced as a requested status",
    );
  });

  test("63. the action copy remains Deactivate / Reactivate", () => {
    assert.match(DIALOG, /"Deactivate Retailer"/);
    assert.match(DIALOG, /"Reactivate Retailer"/);
  });
});

// ============================================================================
// Milestone-wide static safety
// ============================================================================
describe("Vendor Retailer lifecycle — static safety", () => {
  test("64. exactly one application module names the write RPC", () => {
    const namers = APP_ONLY.filter((file) =>
      readFileSync(file, "utf8").includes(`"${WRITE_RPC}"`),
    ).map((file) => file.replace(`${ROOT}/`, ""));
    assert.deepEqual(namers, [WRAPPER_PATH]);
  });

  test("65. no milestone file performs a table write", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(!code.includes(".from("), `${path} must not use .from(`);
      for (const forbidden of [".update(", ".insert(", ".delete(", ".upsert("]) {
        assert.ok(!code.includes(forbidden), `${path} must not call ${forbidden}`);
      }
    }
  });

  test("66. no milestone file imports a service-role client or a secret", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(!/service[_-]?role/i.test(code), `${path} must not reference service_role`);
      assert.ok(!/SERVICE_ROLE_KEY|SECRET_KEY|process\.env/.test(code), `${path} reads no env`);
    }
  });

  test("67. no Web call updates organizations or vendor_retailers directly", () => {
    for (const file of APP_ONLY) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const table of ["organizations", "vendor_retailers"]) {
        assert.ok(
          !new RegExp(`from\\("${table}"\\)[\\s\\S]{0,200}?\\.(update|insert|delete|upsert)\\(`).test(
            code,
          ),
          `${file.replace(`${ROOT}/`, "")} must not write ${table} directly`,
        );
      }
    }
  });

  test("68. the milestone added no migration and no Edge Function", () => {
    const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    assert.equal(
      migrations[migrations.length - 1],
      "20260811090000_vendor_retailer_lifecycle.sql",
      "the deployed backend migration must remain the newest — this milestone adds none",
    );

    const functionsDir = join(ROOT, "supabase/functions");
    if (existsSync(functionsDir)) {
      for (const file of walk(functionsDir)) {
        assert.ok(
          !readFileSync(file, "utf8").includes(WRITE_RPC),
          `${file} must not call the lifecycle write`,
        );
      }
    }
  });

  test("69. no RLS policy was introduced by this milestone", () => {
    for (const path of MILESTONE_FILES) {
      assert.ok(!/create\s+policy/i.test(read(path)), `${path} must not create a policy`);
    }
  });

  test("70. get_my_portal_context and get_my_lifecycle_access_state are untouched", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(!code.includes("get_my_portal_context"), `${path} must not touch portal context`);
      assert.ok(
        !code.includes("get_my_lifecycle_access_state"),
        `${path} must not touch the lifecycle diagnostic`,
      );
    }
  });

  test("71. the staff lifecycle contract is unchanged by this milestone", () => {
    for (const path of MILESTONE_FILES) {
      const code = stripComments(read(path));
      assert.ok(
        !code.includes("set_retailer_staff_membership_status"),
        `${path} must not reference the staff lifecycle write`,
      );
    }
    // And the staff modules still exist, with their own contract intact.
    assert.match(
      read("lib/staff/retailer-staff-membership-status.ts"),
      /"set_retailer_staff_membership_status"/,
    );
  });

  test("72. no Flutter file exists anywhere in the repository", () => {
    for (const dir of ["app", "lib", "components", "supabase", "docs", "scripts", "public"]) {
      for (const file of walk(join(ROOT, dir))) {
        assert.ok(!file.endsWith(".dart"), `${file} is a Flutter file`);
      }
    }
    assert.ok(!existsSync(join(ROOT, "pubspec.yaml")));
  });

  test("73. the Retailer LIST page has no lifecycle control", () => {
    for (const forbidden of [
      "RetailerLifecycleDialog",
      "setVendorRetailerStatusAction",
      "Deactivate Retailer",
      "Reactivate Retailer",
      WRITE_RPC,
    ]) {
      assert.ok(
        !LIST_PAGE_CODE.includes(forbidden),
        `the list page must not carry ${forbidden}`,
      );
    }
  });

  test("74. the detail page is the ONLY lifecycle UI surface", () => {
    const surfaces = APP_ONLY.filter((file) =>
      readFileSync(file, "utf8").includes("RetailerLifecycleDialog"),
    ).map((file) => file.replace(`${ROOT}/`, ""));

    assert.deepEqual(surfaces.sort(), [DIALOG_PATH, DETAIL_PAGE_PATH].sort());
  });

  test("75. the Server Action is reachable from exactly one control", () => {
    const callers = APP_ONLY.filter((file) =>
      readFileSync(file, "utf8").includes("setVendorRetailerStatusAction"),
    ).map((file) => file.replace(`${ROOT}/`, ""));

    assert.deepEqual(callers.sort(), [ACTIONS_PATH, DIALOG_PATH].sort());
  });

  test("76. no dashboard card or navigation surface gained a lifecycle control", () => {
    for (const path of ["app/(admin)/page.tsx", "components/admin"]) {
      const full = join(ROOT, path);
      if (!existsSync(full)) continue;
      const files = statSync(full).isDirectory() ? walk(full) : [full];
      for (const file of files) {
        const code = readFileSync(file, "utf8");
        assert.ok(!code.includes("RetailerLifecycleDialog"));
        assert.ok(!code.includes(WRITE_RPC));
      }
    }
  });
});
