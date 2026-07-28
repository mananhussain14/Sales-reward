/**
 * STATIC CONTRACT AND SECURITY GUARDS for the web Manage Shops milestone.
 *
 *   app/(retailer)/retailer/staff/actions.ts             updateStaffShopAssignmentsAction
 *   app/(retailer)/retailer/staff/manage-shops-dialog.tsx
 *   app/(retailer)/retailer/staff/page.tsx
 *   lib/staff/retailer-staff-shop-assignments.ts
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * ============================================================================
 * SOURCE-LEVEL assertions over the modules above, in the same idiom as
 * ./staff-source-safety.test.ts and ../products/product-source-safety.test.ts. They read
 * the code and assert structural properties that a careless later edit could silently
 * destroy: that the RPC name and its two arguments have not changed, that no service-role
 * client or direct table write appeared, that no internal identifier is rendered, and
 * that the documentation still describes what the code does.
 *
 * They do NOT execute the action (it imports `next/headers`) and do NOT render the
 * component (this repository has no DOM harness — see
 * ./staff-shop-assignment-input.test.ts for why, and for the 46 executed assertions that
 * cover every branch of the editor's actual logic).
 *
 * The BEHAVIOURAL specification of the RPC itself is
 * supabase/tests/database/retailer_staff_shop_assignment_writes_test.sql (163
 * assertions), run with `npx supabase test db --local`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();

const ACTIONS_PATH = "app/(retailer)/retailer/staff/actions.ts";
const DIALOG_PATH = "app/(retailer)/retailer/staff/manage-shops-dialog.tsx";
const PAGE_PATH = "app/(retailer)/retailer/staff/page.tsx";
const WRAPPER_PATH = "lib/staff/retailer-staff-shop-assignments.ts";
const STATE_PATH = "app/(retailer)/retailer/staff/manage-shops-state.ts";
const INPUT_PATH = "lib/staff/staff-shop-assignment-input.ts";
const DECISION_PATH = "lib/staff/portal-access-decision.ts";
const DOC_PATH = "docs/retailer-manage-staff-shops-web.md";
const MATRIX_PATH = "docs/mobile-feature-matrix.md";

const ACTIONS = readFileSync(join(ROOT, ACTIONS_PATH), "utf8");
const DIALOG = readFileSync(join(ROOT, DIALOG_PATH), "utf8");
const PAGE = readFileSync(join(ROOT, PAGE_PATH), "utf8");
const WRAPPER = readFileSync(join(ROOT, WRAPPER_PATH), "utf8");
const STATE = readFileSync(join(ROOT, STATE_PATH), "utf8");
const INPUT = readFileSync(join(ROOT, INPUT_PATH), "utf8");
const DECISION = readFileSync(join(ROOT, DECISION_PATH), "utf8");
const DOC = readFileSync(join(ROOT, DOC_PATH), "utf8");
const MATRIX = readFileSync(join(ROOT, MATRIX_PATH), "utf8");

const RPC = "set_retailer_staff_shop_assignments";
const PERMISSION = "RETAILER_STAFF_SHOP_ASSIGN";

/**
 * The TypeScript equivalent of stripping comments, so prose describing a rule cannot trip
 * the rule it describes. Every module in this milestone documents at length what it does
 * NOT do — "no service-role client", "never `.from(`" — and asserting against raw text
 * would fail on the sentences that state the guarantees. Same idiom as
 * ../products/product-source-safety.test.ts.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const ACTIONS_CODE = stripComments(ACTIONS);
const DIALOG_CODE = stripComments(DIALOG);
const PAGE_CODE = stripComments(PAGE);
const WRAPPER_CODE = stripComments(WRAPPER);
const INPUT_CODE = stripComments(INPUT);

/** The body of one named function declaration, brace-matched from its signature. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(start, -1, `must declare ${name}`);

  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${name} has an unbalanced body`);
}

const ACTION_BODY = functionBody(ACTIONS_CODE, "updateStaffShopAssignmentsAction");

// ============================================================================
// The RPC contract
// ============================================================================
describe("Manage Shops — the RPC contract", () => {
  test("1. the shop-assignment write names exactly one RPC", () => {
    assert.ok(
      WRAPPER_CODE.includes(`"${RPC}"`),
      `the wrapper must name ${RPC}`,
    );
    assert.match(
      WRAPPER_CODE,
      /const\s+SET_SHOP_ASSIGNMENTS_RPC\s*=\s*"set_retailer_staff_shop_assignments"\s+as\s+const/,
      "the RPC name must be a single greppable constant",
    );
  });

  test("2. it is the ONLY shop-assignment write reachable from the web", () => {
    // No add/remove pair, no bulk variant, no second entry point. A second one would be a
    // second place for the zero-shop and active-projection rules to be stated.
    for (const [label, code] of [
      ["actions", ACTIONS_CODE],
      ["dialog", DIALOG_CODE],
      ["wrapper", WRAPPER_CODE],
      ["page", PAGE_CODE],
    ] as const) {
      assert.ok(
        !/\b(add|remove|assign|unassign)_retailer_staff_shop/i.test(code),
        `${label} must not reference an add/remove shop-assignment RPC`,
      );
    }
  });

  test("3. EXACTLY p_membership_id and p_shop_ids are passed — nothing else", () => {
    const call = WRAPPER_CODE.slice(
      WRAPPER_CODE.indexOf("supabase.rpc("),
      WRAPPER_CODE.indexOf(").catch("),
    );

    assert.ok(call.includes("p_membership_id: membershipId"), "must send p_membership_id");
    assert.ok(call.includes("p_shop_ids: shopIds"), "must send p_shop_ids");

    // Every `key:` in the argument object, so an added property is a failure rather than
    // a silent extra the RPC would reject at runtime.
    const keys = Array.from(call.matchAll(/(\w+)\s*:/g)).map((match) => match[1]);
    assert.deepEqual(
      keys.sort(),
      ["p_membership_id", "p_shop_ids"],
      "the RPC call must carry exactly two arguments",
    );
  });

  test("4. no organization / Retailer / tenant id is sent", () => {
    for (const [label, code] of [
      ["wrapper", WRAPPER_CODE],
      ["action", ACTION_BODY],
    ] as const) {
      assert.ok(
        !/p_(retailer|organization|tenant|org)\w*/i.test(code),
        `${label} must not send a tenant argument`,
      );
      assert.ok(
        !/organizationId|retailerId|retailerOrganizationId/i.test(code),
        `${label} must not carry a tenant id at all`,
      );
    }
  });

  test("5. no actor / caller / user / profile id is sent", () => {
    for (const [label, code] of [
      ["wrapper", WRAPPER_CODE],
      ["action", ACTION_BODY],
    ] as const) {
      assert.ok(
        !/p_(actor|caller|user|profile|auth)\w*/i.test(code),
        `${label} must not send an identity argument`,
      );
      assert.ok(
        !/actorProfileId|callerUserId|authUserId/i.test(code),
        `${label} must not carry an actor id`,
      );
    }
  });

  test("6. no role code, permission code, status, timestamp or audit field is sent", () => {
    const call = WRAPPER_CODE.slice(WRAPPER_CODE.indexOf("supabase.rpc("));
    assert.ok(
      !/p_(role|permission|status|audit|assigned|removed|updated)\w*/i.test(call),
      "the RPC call must carry no role, permission, status, audit or timestamp argument",
    );
    // The permission is named in the DECISION module (it gates presentation) and in the
    // migration — never as something this write sends.
    assert.ok(
      !new RegExp(`p_\\w*\\s*:\\s*["']${PERMISSION}`).test(WRAPPER_CODE),
      "the permission code must never be an RPC argument",
    );
  });

  test("7. no current-assignment list is sent as a trusted fact", () => {
    // Complete replacement means ONE set crosses. A second array argument would be a
    // client claim about the current state, or an add/remove split the backend would have
    // to trust.
    const call = WRAPPER_CODE.slice(WRAPPER_CODE.indexOf("supabase.rpc("));
    assert.ok(
      !/p_(current|existing|previous|before|added|removed)\w*/i.test(call),
      "the RPC call must not carry a current, previous, added or removed set",
    );
  });

  test("8. the target is the canonical membership id and nothing else", () => {
    assert.ok(
      ACTION_BODY.includes('formData.get("membershipId")'),
      "the action must read the membership id from the form",
    );
    for (const forbidden of [
      "authUserId",
      "profileId",
      "userId",
      "email",
      "invitationId",
      "memberRoleId",
      "roleId",
    ]) {
      assert.ok(
        !new RegExp(`formData\\.(get|getAll)\\(["']${forbidden}["']\\)`).test(ACTION_BODY),
        `the action must never read ${forbidden} from the form`,
      );
    }
  });
});

// ============================================================================
// No privileged path
// ============================================================================
describe("Manage Shops — no privileged path exists", () => {
  const MODULES = [
    ["actions", ACTIONS_CODE],
    ["dialog", DIALOG_CODE],
    ["wrapper", WRAPPER_CODE],
    ["page", PAGE_CODE],
    ["input", INPUT_CODE],
  ] as const;

  test("9. no service-role client or key anywhere on this path", () => {
    for (const [label, code] of MODULES) {
      assert.ok(
        !/createAdminClient|SERVICE_ROLE|service_role|serviceRole/i.test(code),
        `${label} must not reference a service-role client or key`,
      );
    }
  });

  test("10. no direct table access — retailer_shop_members is unreachable", () => {
    for (const [label, code] of MODULES) {
      assert.ok(
        !/retailer_shop_members/.test(code),
        `${label} must not name retailer_shop_members`,
      );
      assert.ok(
        !/retailer_shops\b/.test(code),
        `${label} must not read public.retailer_shops directly`,
      );
    }
    assert.ok(
      !/\.from\(/.test(WRAPPER_CODE),
      "the wrapper must contain zero .from( calls",
    );
    assert.ok(
      !/\.from\(/.test(ACTION_BODY),
      "the action must contain zero .from( calls",
    );
  });

  test("11. no Edge Function is involved", () => {
    for (const [label, code] of MODULES) {
      assert.ok(
        !/functions\.invoke|\/functions\/v1|supabase\.functions/i.test(code),
        `${label} must not call an Edge Function`,
      );
    }
  });

  test("12. no direct database connection, token or secret", () => {
    for (const [label, code] of MODULES) {
      assert.ok(
        !/postgres:\/\/|DATABASE_URL|RESEND_API_KEY|token_hash|tokenHash/i.test(code),
        `${label} must not reference a connection string, Resend credential or token hash`,
      );
    }
  });

  test("13. the write goes through the ordinary session client", () => {
    assert.match(
      WRAPPER_CODE,
      /import\s*\{\s*createClient\s*\}\s*from\s*"@\/lib\/supabase\/server"/,
      "the wrapper must use the ordinary server client",
    );
    assert.match(
      WRAPPER_CODE,
      /const\s+supabase\s*=\s*await\s+createClient\(\)/,
      "and construct it per call",
    );
  });

  test("14. no client-side organization selector exists", () => {
    // Nothing in the UI may nominate whose staff or shops are edited. The dialog's props
    // are the member's own row and the caller's own assignable shops.
    assert.ok(
      !/organization|retailerId|tenant/i.test(DIALOG_CODE),
      "the dialog must carry no organization or tenant concept",
    );
  });
});

// ============================================================================
// Server-side re-establishment and validation
// ============================================================================
describe("Manage Shops — the Server Action re-establishes its own footing", () => {
  test("15. portal access is re-resolved from the verified session", () => {
    assert.ok(
      ACTION_BODY.includes("await getRetailerPortalAccess()"),
      "the action must re-resolve portal access",
    );
    assert.ok(
      ACTION_BODY.includes('redirect("/login")'),
      "an unauthenticated caller must be redirected to /login",
    );
    assert.ok(
      ACTION_BODY.includes('redirect("/retailer-access-denied")'),
      "an unauthorized caller must be redirected",
    );
  });

  test("16. DEFENCE IN DEPTH: the assignable shop set is re-read server-side", () => {
    const readAt = ACTION_BODY.indexOf("getRetailerStaffAssignableShops()");
    const validateAt = ACTION_BODY.indexOf("validateShopAssignmentInput(");
    const rpcAt = ACTION_BODY.indexOf("setRetailerStaffShopAssignments(");

    assert.notEqual(readAt, -1, "the action must re-read the assignable shops");
    assert.notEqual(validateAt, -1, "the action must validate the submission");
    assert.ok(
      readAt < validateAt && validateAt < rpcAt,
      "the fresh read must precede validation, which must precede the RPC",
    );
  });

  test("17. validation is delegated to the pure module, not re-implemented", () => {
    for (const helper of [
      "normalizeMembershipId",
      "normalizeShopSelection",
      "validateShopAssignmentInput",
      "describeSaveOutcome",
    ]) {
      assert.ok(
        ACTIONS_CODE.includes(helper),
        `the action must use ${helper} rather than a second copy of the rule`,
      );
    }
  });

  test("18. only the two known form fields are read", () => {
    const reads = Array.from(
      ACTION_BODY.matchAll(/formData\.(?:get|getAll)\((["'])(.+?)\1\)/g),
    ).map((match) => match[2]);

    assert.deepEqual(
      reads.sort(),
      ["membershipId", "shopIds"],
      "an unknown submitted field must never be read, and therefore never trusted",
    );
  });

  test("19. every rejection reason is handled — no silent fall-through", () => {
    for (const reason of ["empty", "unavailable-shop", "too-many", "invalid-target"]) {
      assert.ok(
        ACTION_BODY.includes(`"${reason}"`),
        `the action must handle the ${reason} rejection`,
      );
    }
  });
});

// ============================================================================
// Error mapping
// ============================================================================
describe("Manage Shops — errors are mapped by SQLSTATE, never by message", () => {
  test("20. the four expected SQLSTATEs are mapped explicitly", () => {
    const codes = { "42501": "denied", "23514": "invalid", "55000": "retailer-unavailable", "22P02": "malformed" };

    for (const [code, status] of Object.entries(codes)) {
      assert.ok(
        WRAPPER_CODE.includes(`"${code}"`),
        `the wrapper must recognise SQLSTATE ${code}`,
      );
      assert.ok(
        WRAPPER_CODE.includes(`status: "${status}"`),
        `the wrapper must expose the ${status} outcome`,
      );
    }
  });

  test("21. an unexpected SQLSTATE becomes a safe generic failure", () => {
    assert.match(
      WRAPPER_CODE,
      /default:[\s\S]{0,200}status:\s*"unavailable"/,
      "an unrecognised code must fall through to unavailable",
    );
  });

  test("22. ONLY the error code is read — no message substring matching", () => {
    assert.match(
      WRAPPER_CODE,
      /\(result\.error as \{ code\?: string \}\)\.code/,
      "the wrapper must read only the SQLSTATE off the error",
    );
    assert.ok(
      !/error\.message|error\.details|error\.hint|\.message\b/.test(WRAPPER_CODE),
      "no message, detail or hint may be read",
    );
    assert.ok(
      !/includes\(["'].*(denied|violat|constraint|permission).*["']\)/i.test(WRAPPER_CODE),
      "outcomes must never be decided by matching a message substring",
    );
  });

  test("23. no raw database message can reach the UI", () => {
    // Every operator-facing string on this path is a literal declared in the action.
    const messages = Array.from(
      ACTIONS_CODE.matchAll(/const\s+(SHOP_ASSIGNMENT_\w+)\s*=\s*\n?\s*"([^"]+)"/g),
    );
    assert.ok(messages.length >= 6, "the action must declare its own message set");

    for (const [, name, text] of messages) {
      assert.ok(
        !/SQLSTATE|PGRST|postgres|relation |column |function public\.|\bpg_/i.test(text),
        `${name} must not contain database vocabulary`,
      );
      assert.doesNotMatch(
        text,
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        `${name} must not contain an identifier`,
      );
      assert.ok(
        !/supabase\.co|https?:\/\//i.test(text),
        `${name} must not contain a project URL`,
      );
    }
  });

  test("24. failures are NOT all collapsed into one connection message", () => {
    const distinct = new Set(
      Array.from(ACTIONS_CODE.matchAll(/const\s+SHOP_ASSIGNMENT_\w+\s*=\s*\n?\s*"([^"]+)"/g)).map(
        (match) => match[1],
      ),
    );
    assert.ok(
      distinct.size >= 6,
      "validation, access, stale data, retailer-state and service failure must be distinguishable",
    );
    for (const message of distinct) {
      assert.doesNotMatch(
        message,
        /check your (internet )?connection/i,
        "no outcome may be reported as a connection problem",
      );
    }
  });

  test("25. the state type carries no SQLSTATE or backend detail", () => {
    assert.ok(
      !/sqlstate|code|detail|hint/i.test(stripComments(STATE)),
      "the action state must expose no error code or backend detail",
    );
  });
});

// ============================================================================
// Success, re-read, and the counts
// ============================================================================
describe("Manage Shops — canonical re-read and honest counts", () => {
  test("26. a committed write revalidates the route and RE-READS the canonical roster", () => {
    const savedAt = ACTION_BODY.indexOf('revalidatePath(STAFF_PATH)');
    const rereadAt = ACTION_BODY.indexOf("await getRetailerStaffMembers()");

    assert.notEqual(rereadAt, -1, "the action must re-read the roster after success");
    assert.notEqual(savedAt, -1, "the action must revalidate the staff route");
    assert.ok(rereadAt > savedAt, "the re-read must follow the revalidation");
  });

  test("27. the roster is NEVER patched from the submitted ids", () => {
    // The submitted set describes the VISIBLE active shops only. The database alone can
    // see the preserved non-ACTIVE assignments, so it is the only honest source for what
    // the member is now assigned to.
    assert.ok(
      !/setMembers|mutateRow|optimistic|patchRoster/i.test(DIALOG_CODE),
      "the dialog must not locally mutate the roster row",
    );
    assert.ok(
      !/shopNames\s*=/.test(DIALOG_CODE),
      "the dialog must not compute display shop names of its own",
    );
  });

  test("28. a failed re-read is reported as a SUCCESS with a caveat, not a failed write", () => {
    assert.ok(
      ACTION_BODY.includes('outcome: "saved-unconfirmed"'),
      "the action must have a distinct partial-success outcome",
    );

    const message = ACTIONS_CODE.match(
      /SHOP_ASSIGNMENT_SAVED_UNCONFIRMED\s*=\s*\n?\s*"([^"]+)"/,
    )?.[1];
    assert.ok(message, "the partial-success message must exist");
    assert.match(message!, /were updated/i, "it must state that the write succeeded");
    assert.match(message!, /could not be refreshed/i, "and name the refresh as the problem");
    assert.ok(
      !/failed|try again|retry/i.test(message!),
      "it must not invite a retry of a committed change",
    );
  });

  test("29. no automatic write retry exists anywhere on this path", () => {
    for (const [label, code] of [
      ["actions", ACTIONS_CODE],
      ["dialog", DIALOG_CODE],
      ["wrapper", WRAPPER_CODE],
    ] as const) {
      assert.ok(
        !/setTimeout|setInterval|retryCount|maxRetries|while\s*\(/i.test(code),
        `${label} must contain no automatic retry loop`,
      );
    }
    // The only retry offered is a READ: router.refresh() for the shop picker.
    assert.ok(
      DIALOG_CODE.includes("router.refresh()"),
      "the dialog must offer a read-only retry for the shop picker",
    );
  });

  test("30. Save is withdrawn once the write has committed", () => {
    assert.match(
      DIALOG_CODE,
      /const\s+committed\s*=\s*state\.outcome\s*===\s*"saved"\s*\|\|\s*state\.outcome\s*===\s*"saved-unconfirmed"/,
      "the dialog must know when a write has committed",
    );
    assert.match(
      DIALOG_CODE,
      /\{!committed\s*&&\s*\(/,
      "the Save button must be unmounted once committed, so no retry can resubmit it",
    );
    assert.match(
      DIALOG_CODE,
      /alreadySaved:\s*committed/,
      "and the Save gate must be told about it",
    );
  });
});

// ============================================================================
// The UI's own structure
// ============================================================================
describe("Manage Shops — the editor's structure", () => {
  test("31. NO internal identifier is ever rendered as text", () => {
    // Ids may live in a form control's `value` and in a React key — those are addresses
    // the server re-validates. They must appear in no visible text, title, aria-label or
    // data attribute.
    assert.ok(
      !/>\{(membershipId|shop\.shopId)\}/.test(DIALOG),
      "no id may be rendered as element content",
    );
    assert.ok(
      !/(title|aria-label|alt|data-[\w-]+)=\{[^}]*(membershipId|shopId)/.test(DIALOG),
      "no id may be placed in a title, label, alt or data attribute",
    );

    // The only permitted appearances of the ids.
    const permitted = [
      'name="membershipId" value={membershipId}',
      "key={shop.shopId}",
      "value={shop.shopId}",
      "selected.has(shop.shopId)",
      "toggleShop(shop.shopId,",
    ];
    for (const usage of permitted) {
      assert.ok(DIALOG.includes(usage), `expected the id to be used as: ${usage}`);
    }

    // What IS rendered is a name.
    assert.ok(DIALOG.includes("{shop.shopName}"), "the picker must render shop names");
    assert.ok(DIALOG.includes("{memberName}"), "the header must render the person's name");
  });

  test("32. duplicate selection is structurally impossible", () => {
    assert.match(
      DIALOG_CODE,
      /useState<Set<string>>/,
      "the selection must be a Set, which cannot hold a duplicate",
    );
  });

  test("33. the Save gate and the initial selection come from the pure module", () => {
    for (const helper of ["canSaveSelection", "reconcileSelection", "hasSelectionChanged"]) {
      assert.ok(
        DIALOG_CODE.includes(helper),
        `the dialog must use ${helper} rather than a second copy of the rule`,
      );
    }
    assert.match(
      DIALOG_CODE,
      /disabled=\{!saveEnabled\}/,
      "the Save button must be driven by the gate",
    );
    assert.match(
      DIALOG_CODE,
      /submitting:\s*pending/,
      "and the gate must be told when a write is in flight",
    );
  });

  test("34. the initial selection is the INTERSECTION of current and assignable", () => {
    assert.match(
      DIALOG_CODE,
      /reconcileSelection\(currentShopIds,\s*optionIds\)/,
      "the editor must open with current ∩ assignable, never with current alone",
    );
  });

  test("35. a stale shop list replaces the options and re-reconciles the selection", () => {
    assert.match(
      DIALOG_CODE,
      /state\.refreshedShops\s*\?\?\s*shops/,
      "a refreshed shop list must supersede the server-rendered one",
    );
    assert.match(
      DIALOG_CODE,
      /reconcileSelection\(Array\.from\(selected\),\s*optionIds\)/,
      "and the selection must be re-derived from the ids currently on offer",
    );
  });

  test("36. a shop-picker READ failure is isolated and cannot submit", () => {
    assert.ok(
      DIALOG_CODE.includes("optionsReady"),
      "the dialog must know whether the options loaded",
    );
    // Passed as an ES shorthand property, so match either spelling.
    assert.match(
      DIALOG_CODE,
      /canSaveSelection\(\{[\s\S]{0,240}\boptionsReady\b\s*[,:]/,
      "and the Save gate must refuse to submit without them",
    );
    assert.match(
      DIALOG,
      /Shops could not be loaded/,
      "with a picker-specific message rather than a page error",
    );
    assert.match(
      DIALOG,
      /The staff list is\s*\n?\s*unaffected/,
      "that says the roster is unaffected",
    );
  });

  test("37. accessibility: dialog semantics, focus and labelling", () => {
    for (const attribute of [
      'role="dialog"',
      'aria-modal="true"',
      "aria-labelledby={headingId}",
      "aria-describedby={descriptionId}",
      "tabIndex={-1}",
      'aria-haspopup="dialog"',
      "aria-expanded={open}",
    ]) {
      assert.ok(DIALOG.includes(attribute), `the dialog must set ${attribute}`);
    }

    assert.ok(
      DIALOG_CODE.includes("dialogRef.current?.focus()"),
      "focus must move into the dialog on open",
    );
    assert.ok(
      DIALOG_CODE.includes("openerRef.current?.focus()"),
      "and return to the opener on close",
    );
    assert.match(
      DIALOG_CODE,
      /event\.key === "Escape" && !pending/,
      "Escape must close, but never while a write is in flight",
    );
    assert.ok(
      DIALOG.includes('aria-live="polite"'),
      "the selected count must be announced",
    );
    assert.ok(
      DIALOG.includes(`aria-label={\`Manage shops for \${memberName}\`}`),
      "the opener must have a per-person accessible name",
    );
  });

  test("38. narrow layouts do not overflow", () => {
    // A bottom sheet below `sm` and a centred panel above it, with the body scrolling
    // rather than the page, and long names truncating rather than pushing the layout.
    for (const cls of [
      "max-h-[90dvh]",
      "overflow-y-auto",
      "sm:max-w-lg",
      "flex-col-reverse",
      "truncate",
      "min-w-0",
    ]) {
      assert.ok(DIALOG.includes(cls), `the dialog must use ${cls} for narrow layouts`);
    }
  });
});

// ============================================================================
// Presentation authority
// ============================================================================
describe("Manage Shops — who sees the control", () => {
  test("39. presentation is keyed on the backend-derived capability, not a role string", () => {
    assert.ok(
      DECISION.includes("export function showsManageShops"),
      "the decision must live in the pure predicate module",
    );
    assert.ok(
      PAGE_CODE.includes("showsManageShops(assignable.status)"),
      "the page must key the control on the assignable-shop read status",
    );
    assert.ok(
      PAGE_CODE.includes("showsShopPicker(assignable.status)"),
      "and the picker on whether that read actually succeeded",
    );

    // No role name in the decision module's EXECUTABLE code — the role/permission mapping
    // in SQL is the authority, and a TypeScript copy would be free to drift from it. Its
    // prose legitimately explains which roles a mapping currently admits, so the check is
    // against the code rather than the comments.
    assert.ok(
      !/RETAILER_OWNER|RETAILER_MANAGER|SALES_STAFF/.test(stripComments(DECISION)),
      "the decision module's executable code must name no role",
    );
  });

  test("40. the control is offered only for an eligible target", () => {
    assert.ok(
      PAGE_CODE.includes("canManageStaffShops(member)"),
      "the page must gate each row on the eligibility predicate",
    );
    // Both layouts — the table and the mobile cards — must gate identically.
    //
    // THREE references, not two, since the staff lifecycle milestone: the mobile card list
    // now shares its actions footer with the Deactivate/Reactivate control, so the same
    // predicate appears once in that footer's existence condition and once around the
    // editor itself. Without the first, an ineligible row would render an empty bordered
    // strip. The desktop table contributes the third.
    assert.equal(
      (PAGE_CODE.match(/canManageStaffShops\(member\)/g) ?? []).length,
      3,
      "the desktop table and the mobile card list must both gate the control",
    );
  });

  test("41. no invitation row can reach the editor", () => {
    // Invitations are a different list with different identifiers. The control is
    // rendered only inside the members map, never the invitations map.
    const invitationsSection = PAGE_CODE.slice(
      PAGE_CODE.indexOf("invitations.invitations.map"),
    );
    assert.ok(
      !invitationsSection.includes("ManageShopsDialog"),
      "the invitation list must not render the editor",
    );
    assert.ok(
      !DIALOG_CODE.includes("invitationId"),
      "the dialog must have no invitation concept",
    );
  });

  test("42. each editor instance is keyed by membership, isolating session and target", () => {
    // The key is NAMESPACED since the staff lifecycle milestone — `shops-<membershipId>`
    // rather than the bare id — because a row now renders two sibling dialogs and two
    // siblings sharing one key is a React reconciliation hazard. The isolation guarantee is
    // unchanged and is what this asserts: the membership id is still what makes the key
    // unique, so a different account or Retailer produces different keys and React discards
    // every editor's state rather than carrying it into a new session.
    assert.equal(
      (
        PAGE_CODE.match(
          /key=\{`shops-\$\{member\.membershipId\}`\}\s*\n\s*membershipId=/g,
        ) ?? []
      ).length,
      2,
      "both layouts must key the editor by membership id so state cannot outlive a context change",
    );
  });
});

// ============================================================================
// Regression — the rest of the page is untouched
// ============================================================================
describe("Manage Shops — the existing page still works", () => {
  test("43. the invite, resend and revoke actions are unchanged", () => {
    for (const action of [
      "inviteStaffAction",
      "resendStaffInvitationAction",
      "revokeStaffInvitationAction",
    ]) {
      assert.ok(
        ACTIONS_CODE.includes(`export async function ${action}`),
        `${action} must still exist`,
      );
    }
    assert.ok(
      ACTIONS_CODE.includes("sendRetailerStaffInvitation"),
      "invitation delivery must still go through the shared service",
    );
  });

  test("44. the roster, invitation history and invite form still render", () => {
    for (const marker of [
      "showsInvitationSection(invitations.status)",
      "showsInviteSection(assignable.status)",
      "showsInviteForm(assignable.status)",
      "<InviteStaffForm",
      "<ResendInvitationForm",
      "<RevokeInvitationForm",
      "members.members.map",
      "invitations.invitations.map",
    ]) {
      assert.ok(PAGE_CODE.includes(marker), `the page must still render ${marker}`);
    }
  });

  test("45. Manage Shops is NOT coupled to the invitation feature flag", () => {
    // A kill switch for sending email must not also stop an Owner correcting an existing
    // employee's shops — that is neither an invitation nor an account creation.
    assert.ok(
      !ACTION_BODY.includes("isRetailerStaffInvitationsEnabled"),
      "the shop-assignment action must not be gated by the invitation flag",
    );
  });

  test("46. a Manage Shops failure cannot erase unrelated page state", () => {
    // The editor's outcome lives in its own useActionState. Nothing about it can throw
    // into the page or clear the roster, invitation list or invite form.
    assert.ok(
      !/throw\s+new\s+Error/.test(ACTION_BODY),
      "the action must return a state, never throw a page error",
    );
    assert.ok(
      !DIALOG_CODE.includes("notFound()") && !DIALOG_CODE.includes("throw "),
      "the dialog must not throw",
    );
  });

  test("47. no Vendor or Sales Staff route is touched by this milestone", () => {
    // ROUTES, not import paths: the page has always imported a formatter from
    // lib/retailers/, which is a module and not a Vendor screen. What must not appear is a
    // link, redirect or route segment pointing at the Vendor admin area.
    const routeReferences = Array.from(
      PAGE_CODE.matchAll(/(?:href|redirect\()\s*=?\s*["'`]([^"'`]+)/g),
    ).map((match) => match[1]);

    for (const route of routeReferences) {
      assert.ok(
        !/^\/(products|retailers|users|roles|audit)\b/.test(route),
        `the staff page must not link to the Vendor route ${route}`,
      );
    }
    assert.ok(
      !PAGE_CODE.includes("(admin)"),
      "the staff page must not import from the Vendor admin route group",
    );
    assert.ok(
      !/\/receipts|list_my_assigned_receipt_shops|reserve_receipt/.test(
        `${PAGE_CODE}${ACTIONS_CODE}${DIALOG_CODE}`,
      ),
      "nothing here may touch the Sales Staff receipt surface",
    );
  });
});

// ============================================================================
// Documentation
// ============================================================================
describe("Manage Shops — documentation", () => {
  test("48. the web document describes the shipped contract", () => {
    for (const marker of [
      RPC,
      "p_membership_id",
      "p_shop_ids",
      "shops_added",
      PERMISSION,
      "/retailer/staff",
      "membership_id",
      "22P02",
      "42501",
      "23514",
      "55000",
    ]) {
      assert.ok(DOC.includes(marker), `the web doc must state ${marker}`);
    }
    assert.match(DOC, /active/i, "and describe the ACTIVE-shop projection");
  });

  test("49. the doc does NOT claim hidden non-ACTIVE assignments are removed", () => {
    // The one statement that would be false and dangerous.
    assert.ok(
      /preserv/i.test(DOC),
      "the doc must say hidden non-ACTIVE assignments are preserved",
    );
    // Every sentence that mentions removing AND a hidden/non-ACTIVE assignment must be a
    // NEGATION. "never attempts to remove a hidden assignment" is exactly the sentence
    // this rule wants present; a bare "removes hidden assignments" is the one it forbids.
    const sentences = DOC.split(/(?<=[.!?])\s+/).filter(
      (sentence) =>
        /hidden|non-active|inactive|suspended|deactivated/i.test(sentence) &&
        /\b(remove|removes|removed|delete|deletes|retire|retires|retired)\b/i.test(
          sentence,
        ),
    );

    for (const sentence of sentences) {
      assert.match(
        sentence,
        /\b(never|not|no|without|preserv\w*|untouched)\b/i,
        `this sentence claims hidden assignments are removed: ${sentence.trim()}`,
      );
    }
  });

  test("50. the feature matrix states backend shipped, web shipped, Flutter not yet", () => {
    const row = MATRIX.split("\n").find(
      (line) => line.includes(RPC) && line.startsWith("|"),
    );
    assert.ok(row, "the feature matrix must carry a Manage Shops row");
    assert.match(row!, /Shipped/, "web status must read Shipped");
    assert.match(
      row!,
      /Flutter[^|]*not (yet )?implemented|🔴|Not implemented/i,
      "and Flutter must be marked as not yet implemented",
    );
  });
});
