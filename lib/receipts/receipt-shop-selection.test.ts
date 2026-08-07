import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  initialSelectedShopId,
  receiptSelectionGate,
  receiptShopLabel,
  receiptShopMode,
  reconcileSelectedShopId,
} from "./receipt-shop-selection.ts";
import type { AssignedReceiptShop } from "./receipt-normalization.ts";

/**
 * Shop selection: the RULES executed directly, and the FORM asserted at the source level.
 *
 * The rules are a pure module precisely so that "the file picker is unusable until a shop is
 * chosen" is a function call in a test rather than a claim about JSX. What cannot be executed
 * here — the Client Component itself — is pinned by reading its source, the same way
 * ./receipt-extraction-web-polling.test.ts and lib/ui/design-system.test.ts already do.
 *
 * THE SERVER SIDE IS NOT TESTED HERE, AND DELIBERATELY NOT IMITATED HERE. That a crafted
 * submission cannot name an unassigned, withdrawn, closed, suspended, cross-tenant or
 * nonexistent shop is proved against the real functions in
 * supabase/tests/database/sales_staff_receipt_shop_authorization_test.sql. A TypeScript
 * re-implementation of those conditions would be a second definition free to drift from the
 * migrations, which is exactly what this codebase avoids elsewhere.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function code(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** The same file with comments removed, so prose describing a rule cannot satisfy it. */
function executable(relativePath: string): string {
  return code(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const FORM = "app/(retailer)/retailer/receipts/submit-receipt-form.tsx";
const PAGE = "app/(retailer)/retailer/receipts/page.tsx";
const FORM_STATE = "app/(retailer)/retailer/receipts/submit-receipt-state.ts";
const SUBMIT_ACTION = "app/(retailer)/retailer/receipts/actions.ts";
const SHOP_AUTH_SUITE =
  "supabase/tests/database/sales_staff_receipt_shop_authorization_test.sql";

const shop = (id: string, name: string, shopCode: string | null = null):
  AssignedReceiptShop => ({ shopId: id, shopName: name, shopCode });

const ONE = [shop("11111111-1111-4111-8111-111111111111", "Shop 2", "S2")];
const MANY = [
  shop("11111111-1111-4111-8111-111111111111", "Shop 1", "S1"),
  shop("22222222-2222-4222-8222-222222222222", "Shop 2", "S2"),
  shop("33333333-3333-4333-8333-333333333333", "Shop 3", null),
];

const gate = (
  shopCount: number,
  selectedShopId: string,
  fileChosen = false,
  pending = false,
  fileRejected = false,
) => receiptSelectionGate({ shopCount, selectedShopId, fileChosen, pending, fileRejected });

/* ===========================================================================
 * 1. ZERO ACTIVE ASSIGNED SHOPS
 * ========================================================================= */

describe("1-2. zero active assigned shops", () => {
  test("the mode is `unassigned`", () => {
    assert.equal(receiptShopMode(0), "unassigned");
  });

  test("file selection is refused", () => {
    assert.equal(gate(0, "").fileSelectionEnabled, false);
  });

  test("Submit is refused, even with a file somehow already chosen", () => {
    // The `fileChosen: true` case is not reachable through the form, and is asserted anyway:
    // the gate must not depend on the picker having been unreachable.
    assert.equal(gate(0, "", true).submitEnabled, false);
  });

  test("naming a shop id does not unlock either control", () => {
    // A tampered client that sets a shop id it was never given still gets nothing here — and
    // would still be refused in SQL, which is where it actually matters.
    const unlocked = gate(0, "11111111-1111-4111-8111-111111111111", true);
    assert.equal(unlocked.fileSelectionEnabled, false);
    assert.equal(unlocked.submitEnabled, false);
  });

  test("no shop is fabricated to fill the gap", () => {
    assert.equal(initialSelectedShopId([]), "");
  });

  test("neither the selector nor the fixed-shop notice is shown", () => {
    const g = gate(0, "");
    assert.equal(g.showShopSelector, false);
    assert.equal(g.showFixedShopNotice, false);
  });

  test("the message is the required sentence, written once and shared", () => {
    const state = code(FORM_STATE);
    assert.match(state, /RECEIPT_NO_ACTIVE_SHOP_MESSAGE =\s*\n?\s*"You are not assigned to an active shop\."/);
    // The page and the form both read the constant, so the two surfaces cannot disagree.
    assert.ok(code(PAGE).includes("RECEIPT_NO_ACTIVE_SHOP_MESSAGE"));
    assert.ok(code(FORM).includes("RECEIPT_NO_ACTIVE_SHOP_MESSAGE"));
  });

  test("the page does not render the form at all for an unassigned submitter", () => {
    const page = executable(PAGE);
    // The capability is ABSENT rather than disabled: the zero-shop branch renders the message
    // and the form is on the other side of the conditional.
    assert.match(page, /shops\.length === 0 \?[\s\S]*?<EmptyState[\s\S]*?\) : \([\s\S]*?<SubmitReceiptForm/);
  });
});

/* ===========================================================================
 * 2. EXACTLY ONE ACTIVE ASSIGNED SHOP
 * ========================================================================= */

describe("3-5. exactly one active assigned shop", () => {
  test("the mode is `fixed`", () => {
    assert.equal(receiptShopMode(1), "fixed");
  });

  test("that shop is chosen automatically", () => {
    assert.equal(initialSelectedShopId(ONE), ONE[0].shopId);
  });

  test("no editable dropdown is offered", () => {
    assert.equal(gate(1, ONE[0].shopId).showShopSelector, false);
  });

  test("the shop is shown as informational context instead", () => {
    assert.equal(gate(1, ONE[0].shopId).showFixedShopNotice, true);
  });

  test("the notice reads `Submitting for: Shop 2`", () => {
    // The exact shape the milestone asked for, from the label helper and the copy function.
    const state = code(FORM_STATE);
    assert.match(state, /return `Submitting for: \$\{shopLabel\}`/);
    assert.equal(receiptShopLabel(shop("x", "Shop 2", null)), "Shop 2");
    assert.equal(receiptShopLabel(shop("x", "Shop 2", "S2")), "Shop 2 · S2");
  });

  test("file selection is enabled immediately, with no further action", () => {
    // The whole point of `fixed`: the shop is already settled, so the picker is live on arrival.
    assert.equal(gate(1, ONE[0].shopId).fileSelectionEnabled, true);
  });

  test("Submit waits for the file and nothing else", () => {
    assert.equal(gate(1, ONE[0].shopId, false).submitEnabled, false);
    assert.equal(gate(1, ONE[0].shopId, true).submitEnabled, true);
  });

  test("the form renders the id in a hidden input rather than a control", () => {
    const form = executable(FORM);
    assert.match(form, /<input type="hidden" name="shopId" value=\{selectedShopId\} \/>/);
  });

  test("the hidden id is not treated as authorization anywhere", () => {
    // The Server Action re-reads the caller's own assigned set and requires the submitted id to
    // appear in it, before the RPC proves the same chain again in SQL.
    const action = code(SUBMIT_ACTION);
    assert.match(action, /const assigned = await getMyAssignedReceiptShops\(\);/);
    assert.match(action, /!assigned\.shops\.some\(\(shop\) => shop\.shopId === selectedShopId\)/);
  });
});

/* ===========================================================================
 * 3. MULTIPLE ACTIVE ASSIGNED SHOPS
 * ========================================================================= */

describe("6-8, 10. multiple active assigned shops", () => {
  test("the mode is `choose`", () => {
    assert.equal(receiptShopMode(2), "choose");
    assert.equal(receiptShopMode(3), "choose");
  });

  test("the selector is shown", () => {
    assert.equal(gate(MANY.length, "").showShopSelector, true);
    assert.equal(gate(MANY.length, "").showFixedShopNotice, false);
  });

  test("NOTHING is preselected", () => {
    // Defaulting to whichever shop sorts first would attribute a sale to a shop nobody chose.
    assert.equal(initialSelectedShopId(MANY), "");
  });

  test("the file picker is unusable before a shop is selected", () => {
    assert.equal(gate(MANY.length, "").fileSelectionEnabled, false);
  });

  test("selecting a shop enables the file picker", () => {
    assert.equal(gate(MANY.length, MANY[1].shopId).fileSelectionEnabled, true);
  });

  test("Submit requires BOTH a shop and a file", () => {
    assert.equal(gate(MANY.length, "", true).submitEnabled, false, "file alone is not enough");
    assert.equal(
      gate(MANY.length, MANY[1].shopId, false).submitEnabled,
      false,
      "a shop alone is not enough",
    );
    assert.equal(gate(MANY.length, MANY[1].shopId, true).submitEnabled, true);
  });

  test("a file the pre-flight check already refused does not enable Submit", () => {
    assert.equal(
      gate(MANY.length, MANY[1].shopId, true, false, true).submitEnabled,
      false,
    );
  });

  test("a submission in flight closes both controls", () => {
    const busy = gate(MANY.length, MANY[1].shopId, true, true);
    assert.equal(busy.fileSelectionEnabled, false);
    assert.equal(busy.submitEnabled, false);
  });

  test("the selector appears BEFORE the receipt input in the form's source order", () => {
    // The ordering IS the fix: a question asked after the photograph is what used to discard it.
    // Comments are stripped first — the module header discusses `name="receipt"` at length, and
    // prose about a field is not the field.
    const form = executable(FORM);
    const selector = form.indexOf('name="shopId"');
    const fileField = form.indexOf('name="receipt"');
    assert.ok(selector > 0 && fileField > 0);
    assert.ok(selector < fileField, "the shop field must come first");
  });

  test("the guidance sentence is the required one", () => {
    assert.match(
      code(FORM_STATE),
      /RECEIPT_SHOP_CHOICE_HINT =\s*"Select the shop where this sale happened\."/,
    );
    assert.ok(code(FORM).includes("RECEIPT_SHOP_CHOICE_HINT"));
  });
});

/* ===========================================================================
 * 9. THE BUG: A SELECTED IMAGE IS NOT SILENTLY LOST
 * ========================================================================= */

describe("9. an ordinary shop-state change never discards the chosen file", () => {
  const form = executable(FORM);

  test("the shop selector's change handler only sets the shop", () => {
    // If it touched the file input or `chosen`, changing shops would throw away a photograph.
    const handler = /onChange=\{\(event\) => setHeldShopId\(event\.currentTarget\.value\)\}/;
    assert.match(form, handler);
  });

  test("the file input is never reset outside the two places allowed to do it", () => {
    // Exactly three: the explicit Remove control, and the success reset. (`clearChosen` holds one
    // of them.) A fourth would be a path that can discard a file without being asked to.
    const resets = form.match(/fileInputRef\.current\.value = ""/g) ?? [];
    assert.equal(resets.length, 2, "an unexpected file-input reset appeared");
  });

  test("the form's action wrapper no longer clears anything", () => {
    // THE ROOT CAUSE. It used to run `setChosen(null)` after EVERY attempt, including a refused
    // one, so a shop-validation error discarded the photograph the person had chosen.
    assert.match(form, /action=\{formAction\}/);
    assert.ok(
      !/action=\{async \(payload: FormData\)/.test(form),
      "the clearing action wrapper is back",
    );
  });

  test("the reset happens on a SUCCESSFUL result alone", () => {
    assert.match(form, /if \(state\.successMessage === null\) return;/);
  });

  test("and only once per result, so a re-render cannot discard the next file", () => {
    // `shops` arrives as a fresh array whenever the server component re-renders — which it does
    // right after a success, because the action revalidates the page. Without this guard that
    // re-render would run the reset a second time, over a file already chosen for the next
    // receipt.
    assert.match(form, /if \(handledStateRef\.current === state\) return;/);
    assert.match(form, /handledStateRef\.current = state;/);
  });

  test("a refused submission keeps the shop the person had chosen", () => {
    // The shop lives in client state, which survives an action result untouched. Nothing in the
    // form writes it except the selector's own handler and the success reset.
    const writes = form.match(/setHeldShopId\(/g) ?? [];
    assert.equal(writes.length, 2);
  });

  test("a withdrawn assignment corrects the shop WITHOUT touching the file", () => {
    // The list can change under a form already on screen. The correction is a render-time
    // derivation, so it cannot reach the picker: there is no effect and no state write involved.
    assert.match(form, /const selectedShopId = reconcileSelectedShopId\(shops, heldShopId\);/);
    assert.equal(reconcileSelectedShopId(MANY, MANY[1].shopId), MANY[1].shopId);
    // A selection no longer in the list falls back to the same starting point a fresh form uses.
    assert.equal(reconcileSelectedShopId(MANY, "44444444-4444-4444-8444-444444444444"), "");
    // And a list that has shrunk to one settles on that one, so the form is never left with a
    // shop it cannot correct and no control to correct it with.
    assert.equal(reconcileSelectedShopId(ONE, MANY[2].shopId), ONE[0].shopId);
    assert.equal(reconcileSelectedShopId([], ONE[0].shopId), "");
  });
});

/* ===========================================================================
 * 11-12. THE SERVER SIDE — where the real refusals live
 * ========================================================================= */

describe("11-12. server-side shop authorization is proved against the database", () => {
  const suite = code(SHOP_AUTH_SUITE);

  test("a crafted unassigned-shop submission is covered", () => {
    assert.match(suite, /UNASSIGNED SHOP: a shop of their own Retailer they were never assigned to is refused/);
    assert.match(suite, /REMOVED ASSIGNMENT: an assignment with removed_at set cannot be used/);
  });

  test("an inactive shop assignment is covered, in both non-active states", () => {
    assert.match(suite, /DEACTIVATED SHOP: a LIVE assignment to a closed shop cannot be used either/);
    assert.match(suite, /SUSPENDED SHOP: nor can a live assignment to a suspended one/);
  });

  test("the refusals are asserted to be indistinguishable from one another", () => {
    assert.match(suite, /indistinguishable: unassigned, removed, closed, suspended, cross-tenant and nonexistent are ONE answer/);
  });

  test("it calls the real reservation RPC rather than any application code", () => {
    assert.match(suite, /public\.reserve_receipt_submission\(/);
    assert.match(suite, /public\.list_my_assigned_receipt_shops\(\)/);
  });

  test("it introduces no service role and no privilege escalation", () => {
    assert.ok(!/service_role/i.test(suite), "the suite reaches for service_role");
    assert.ok(!/set role/i.test(suite), "the suite switches roles");
  });
});

/* ===========================================================================
 * The gate is the only decision-maker
 * ========================================================================= */

describe("the form re-derives none of the rules", () => {
  const form = executable(FORM);

  test("every control reads the gate rather than counting shops itself", () => {
    assert.match(form, /const gate = receiptSelectionGate\(\{/);
    assert.match(form, /disabled=\{!gate\.submitEnabled\}/);
    assert.match(form, /const fileDisabled = !gate\.fileSelectionEnabled;/);
  });

  test("the form does no shop arithmetic of its own", () => {
    assert.ok(
      !/shops\.length === 0|shops\.length === 1|shops\.length > 1/.test(form),
      "the form re-derives the shop mode instead of asking the gate",
    );
  });

  test("a drop cannot bypass the gate the input obeys", () => {
    assert.match(form, /if \(input === null \|\| file === null \|\| fileDisabled\) return;/);
  });

  test("nothing on this path accepts a caller identity from the browser", () => {
    assert.ok(
      !/profileId|organizationId|retailerId|membershipId|userId/.test(form),
      "the form names a caller identity",
    );
  });
});
