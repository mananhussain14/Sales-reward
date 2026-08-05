/**
 * Tests for Phase 1D-B: the Claim Reviewer product-decision Web UI.
 *
 * Run with:  npm test
 *
 * Two kinds, matching the other review suites:
 *
 *   1. REAL UNIT TESTS of the pure modules — the row parsers, the decision
 *      validator, the settlement mapping and the frozen/current labelling. Every
 *      rule is exercised by CALLING the function rather than by reading its
 *      source. The parsers live in `claim-product-context.ts` precisely so this
 *      is possible; the `server-only` adapters keep only the round trip.
 *
 *   2. SOURCE-SCANNING CONTRACT TESTS of the adapters, the Server Action and the
 *      panel. Those are `server-only` modules, a `"use server"` file and a Client
 *      Component: they cannot be invoked here. What they must NOT do is still
 *      checkable, and for this milestone the most valuable properties are
 *      NEGATIVE ones — no product, quantity or identity may reach the database
 *      from a browser, and no unreadable state may present as decidable.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY SOURCE RULE, so no comment can satisfy a
 * security test. These files explain at length the identifiers the rules forbid.
 *
 * Every fixture below is synthetic. Nothing here touches a hosted database.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isProductDecision,
  isProductRejectionReason,
  productReasonRequiresNote,
  validateProductDecisionInput,
  PRODUCT_DECISIONS,
  PRODUCT_NOTE_MAX_LENGTH,
  PRODUCT_REJECTION_REASONS,
  PRODUCT_REJECTION_REASON_LABELS,
} from "./claim-product-decision-input.ts";
import {
  isProductDecisionOutcome,
  settleProductDecisionOutcome,
  shouldRefreshAfterProductDecisionSettlement,
  PENDING_REQUEST_MESSAGE,
  PRODUCT_DECISION_OUTCOMES,
  REFRESHING_MESSAGE,
  REFUSED_MESSAGE,
  SLOW_REQUEST_MESSAGE,
  SLOW_REQUEST_NOTICE_MS,
  UNCERTAIN_RESULT_MESSAGE,
} from "./claim-product-decision-settlement.ts";
import {
  currentAssignmentLabel,
  currentStatusLabel,
  exclusionReasonLabel,
  hasCurrentStateWarning,
  proposalStatusLabel,
  totalProposedQuantity,
} from "./claim-product-display.ts";
import {
  parseClaimProductContext,
  parseVerifiedSaleItems,
  type ProductContextRpcRow,
  type VerifiedSaleItemRpcRow,
} from "./claim-product-context.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DETAIL_DIR = join(ROOT, "app", "(review)", "review", "[receiptSubmissionId]");

const CONTEXT_MOD = join(ROOT, "lib", "review", "claim-product-context.ts");
const CONTEXT_ADAPTER = join(ROOT, "lib", "review", "claim-receipt-product-context.ts");
const ITEMS_ADAPTER = join(ROOT, "lib", "review", "verified-sale-items.ts");
const WRITE_ADAPTER = join(ROOT, "lib", "review", "finalize-claim-receipt-sale-items.ts");
const INPUT_MOD = join(ROOT, "lib", "review", "claim-product-decision-input.ts");
const SETTLEMENT_MOD = join(ROOT, "lib", "review", "claim-product-decision-settlement.ts");
const DISPLAY_MOD = join(ROOT, "lib", "review", "claim-product-display.ts");
const ACTIONS = join(DETAIL_DIR, "product-decision-actions.ts");
const ACTION_STATE = join(DETAIL_DIR, "product-decision-action-state.ts");
const PANEL = join(DETAIL_DIR, "product-panel.tsx");
const DETAIL_PAGE = join(DETAIL_DIR, "page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}
function codeOf(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const PHASE_1D_B_WEB_FILES = [
  CONTEXT_MOD, CONTEXT_ADAPTER, ITEMS_ADAPTER, WRITE_ADAPTER, INPUT_MOD,
  SETTLEMENT_MOD, DISPLAY_MOD, ACTIONS, ACTION_STATE, PANEL,
];

/** Every value a browser must never be able to assert about a product decision. */
const FORBIDDEN_INPUTS = [
  "vendorId", "vendorOrganizationId", "retailerId", "retailerOrganizationId",
  "shopId", "saleId", "verifiedSaleId", "confirmationId", "receiptConfirmationId",
  "proposalLineId", "decisionId", "reviewerId", "actorId", "profileId",
  "membershipId", "productId", "vendorProductId", "campaignId", "rewardAmount",
  "coinAmount", "auditAction", "returnTo",
];

const RECEIPT_ID = "11111111-2222-4333-8444-555555555555";

/** A synthetic context row. Every field is named explicitly, never spread in. */
function contextRow(
  over: Partial<ProductContextRpcRow> = {},
): ProductContextRpcRow {
  return {
    receipt_submission_id: RECEIPT_ID,
    has_product_proposal: true,
    proposal_line_count: 1,
    has_verified_sale_header: true,
    is_qualification_excluded: false,
    exclusion_reason: null,
    product_decision: null,
    rejection_reason: null,
    reviewer_note: null,
    decided_at: null,
    decided_by_display_name: null,
    already_accepted: false,
    already_rejected: false,
    line_number: 1,
    quantity: 2,
    product_code_at_proposal: "SKU-1",
    product_name_at_proposal: "Blue Widget",
    barcode_at_proposal: "5000000000001",
    brand_at_proposal: "Acme",
    product_status_at_proposal: "ACTIVE",
    product_status_current: "ACTIVE",
    product_assigned_currently: true,
    ...over,
  };
}

/** The single-row shape the RPC returns when there is no proposal at all. */
function noProposalRow(
  over: Partial<ProductContextRpcRow> = {},
): ProductContextRpcRow {
  return contextRow({
    has_product_proposal: false,
    proposal_line_count: 0,
    line_number: null,
    quantity: null,
    product_code_at_proposal: null,
    product_name_at_proposal: null,
    barcode_at_proposal: null,
    brand_at_proposal: null,
    product_status_at_proposal: null,
    product_status_current: null,
    product_assigned_currently: null,
    ...over,
  });
}

function itemRow(
  over: Partial<VerifiedSaleItemRpcRow> = {},
): VerifiedSaleItemRpcRow {
  return {
    line_number: 1,
    quantity: 2,
    product_code_at_proposal: "SKU-1",
    product_name_at_proposal: "Blue Widget",
    barcode_at_proposal: "5000000000001",
    brand_at_proposal: "Acme",
    product_status_at_proposal: "ACTIVE",
    decision: "ACCEPTED",
    decided_at: "2026-08-01T10:00:00+00:00",
    decided_by_display_name: "Dana Reviewer",
    ...over,
  };
}

// ============================================================================
describe("1. parsing the product context (real unit tests)", () => {
  test("1.1 a ready context parses with a full, ordered line list", () => {
    const parsed = parseClaimProductContext(
      [
        contextRow({ proposal_line_count: 2, line_number: 1, quantity: 2 }),
        contextRow({
          proposal_line_count: 2,
          line_number: 2,
          quantity: 5,
          product_code_at_proposal: "SKU-2",
          product_name_at_proposal: "Red Widget",
        }),
      ],
      RECEIPT_ID,
    );

    assert.ok(parsed);
    assert.equal(parsed.hasProductProposal, true);
    assert.equal(parsed.proposalLineCount, 2);
    assert.equal(parsed.hasVerifiedSaleHeader, true);
    assert.equal(parsed.isQualificationExcluded, false);
    assert.equal(parsed.decision, null);
    assert.equal(parsed.alreadyAccepted, false);
    assert.equal(parsed.alreadyRejected, false);
    assert.deepEqual(
      parsed.lines.map((l) => [l.lineNumber, l.quantity]),
      [[1, 2], [2, 5]],
    );
    assert.equal(parsed.lines[1].productName, "Red Widget");
  });

  test("1.2 no proposal is a real state, not an absence", () => {
    const parsed = parseClaimProductContext([noProposalRow()], RECEIPT_ID);
    assert.ok(parsed);
    assert.equal(parsed.hasProductProposal, false);
    assert.equal(parsed.proposalLineCount, 0);
    assert.deepEqual(parsed.lines, []);
    // Still readable, so the panel says "no product list", never "unavailable".
    assert.equal(parsed.decision, null);
  });

  test("1.3 a missing sale header is carried through, not inferred", () => {
    const parsed = parseClaimProductContext(
      [contextRow({ has_verified_sale_header: false })],
      RECEIPT_ID,
    );
    assert.ok(parsed);
    assert.equal(parsed.hasVerifiedSaleHeader, false);
    assert.equal(parsed.hasProductProposal, true);
  });

  test("1.4 an excluded context keeps its reason, and only when excluded", () => {
    const excluded = parseClaimProductContext(
      [
        contextRow({
          is_qualification_excluded: true,
          exclusion_reason: "TEST_DATA",
        }),
      ],
      RECEIPT_ID,
    );
    assert.ok(excluded);
    assert.equal(excluded.isQualificationExcluded, true);
    assert.equal(excluded.exclusionReason, "TEST_DATA");

    // A reason arriving on a NOT-excluded row is dropped rather than rendered
    // beside a "not excluded" heading.
    const notExcluded = parseClaimProductContext(
      [
        contextRow({
          is_qualification_excluded: false,
          exclusion_reason: "TEST_DATA",
        }),
      ],
      RECEIPT_ID,
    );
    assert.ok(notExcluded);
    assert.equal(notExcluded.exclusionReason, null);
  });

  test("1.5 an accepted context parses as accepted and nothing else", () => {
    const parsed = parseClaimProductContext(
      [
        contextRow({
          product_decision: "ACCEPTED",
          already_accepted: true,
          decided_at: "2026-08-01T10:00:00+00:00",
          decided_by_display_name: "Dana Reviewer",
        }),
      ],
      RECEIPT_ID,
    );
    assert.ok(parsed);
    assert.equal(parsed.decision, "ACCEPTED");
    assert.equal(parsed.alreadyAccepted, true);
    assert.equal(parsed.alreadyRejected, false);
    assert.equal(parsed.rejectionReason, null);
    assert.equal(parsed.decidedByDisplayName, "Dana Reviewer");
  });

  test("1.6 a rejected context keeps its reason and note", () => {
    const parsed = parseClaimProductContext(
      [
        contextRow({
          product_decision: "REJECTED",
          rejection_reason: "QUANTITY_MISMATCH",
          reviewer_note: "  Two on the receipt, three proposed.  ",
          already_rejected: true,
          decided_at: "2026-08-01T10:00:00+00:00",
          decided_by_display_name: "Dana Reviewer",
        }),
      ],
      RECEIPT_ID,
    );
    assert.ok(parsed);
    assert.equal(parsed.decision, "REJECTED");
    assert.equal(parsed.rejectionReason, "QUANTITY_MISMATCH");
    assert.equal(parsed.reviewerNote, "Two on the receipt, three proposed.");
    assert.equal(parsed.alreadyRejected, true);
    assert.equal(parsed.alreadyAccepted, false);
  });

  test("1.7 an unknown decision FAILS CLOSED, never 'no decision yet'", () => {
    // The dangerous failure: an unrecognised word falling through to null would
    // render the accept and reject controls on an already-decided receipt.
    for (const word of ["APPROVED", "accepted", "PENDING", "REOPENED", " "]) {
      assert.equal(
        parseClaimProductContext(
          [contextRow({ product_decision: word, already_accepted: true })],
          RECEIPT_ID,
        ),
        null,
        `${JSON.stringify(word)} must not parse`,
      );

      // ISOLATES THE VOCABULARY GUARD. With both booleans false, the
      // decision/boolean consistency checks below all AGREE with each other, so
      // the only thing that can refuse this row is the vocabulary check itself.
      // Without that isolation the case passes for the wrong reason — and an
      // unknown word reaching the panel with `alreadyAccepted`/`alreadyRejected`
      // false is read as "not yet decided", which is precisely the state that
      // renders the accept and reject controls.
      //
      // Blank is excluded deliberately: a whitespace-only value is ABSENT, not
      // unknown, and "no decision recorded" is a real, correct state.
      if (word.trim().length === 0) continue;
      assert.equal(
        parseClaimProductContext(
          [
            contextRow({
              product_decision: word,
              already_accepted: false,
              already_rejected: false,
            }),
          ],
          RECEIPT_ID,
        ),
        null,
        `${JSON.stringify(word)} must not parse as "not yet decided"`,
      );
    }

    // Same for an unknown rejection reason, and for booleans that contradict the
    // word they are supposed to summarise.
    assert.equal(
      parseClaimProductContext(
        [
          contextRow({
            product_decision: "REJECTED",
            rejection_reason: "NOT_A_REASON",
            already_rejected: true,
          }),
        ],
        RECEIPT_ID,
      ),
      null,
    );
    assert.equal(
      parseClaimProductContext(
        [contextRow({ product_decision: "ACCEPTED", already_accepted: false })],
        RECEIPT_ID,
      ),
      null,
    );
    assert.equal(
      parseClaimProductContext(
        [
          contextRow({
            product_decision: "ACCEPTED",
            already_accepted: true,
            already_rejected: true,
          }),
        ],
        RECEIPT_ID,
      ),
      null,
    );
    // A rejection with no reason, and a reason with no rejection.
    assert.equal(
      parseClaimProductContext(
        [contextRow({ product_decision: "REJECTED", already_rejected: true })],
        RECEIPT_ID,
      ),
      null,
    );
    assert.equal(
      parseClaimProductContext(
        [contextRow({ rejection_reason: "WRONG_PRODUCT" })],
        RECEIPT_ID,
      ),
      null,
    );
    // Zero rows is unreadable, never an empty ready state.
    assert.equal(parseClaimProductContext([], RECEIPT_ID), null);
    // An unreadable line makes the whole list unusable — a partial list must
    // never be presented as the complete one being accepted.
    assert.equal(
      parseClaimProductContext(
        [
          contextRow({ proposal_line_count: 2, line_number: 1 }),
          contextRow({ proposal_line_count: 2, line_number: null }),
        ],
        RECEIPT_ID,
      ),
      null,
    );
    // A count that disagrees with the lines sent.
    assert.equal(
      parseClaimProductContext(
        [contextRow({ proposal_line_count: 3 })],
        RECEIPT_ID,
      ),
      null,
    );
  });

  test("1.8 frozen and current statuses stay separate fields", () => {
    const parsed = parseClaimProductContext(
      [
        contextRow({
          product_status_at_proposal: "ACTIVE",
          product_status_current: "INACTIVE",
          product_assigned_currently: false,
        }),
      ],
      RECEIPT_ID,
    );
    assert.ok(parsed);
    const line = parsed.lines[0];
    assert.equal(line.statusAtProposal, "ACTIVE");
    assert.equal(line.statusCurrent, "INACTIVE");
    assert.equal(line.assignedCurrently, false);
    // Neither is defaulted from the other, and the frozen value is untouched.
    assert.notEqual(line.statusAtProposal, line.statusCurrent);

    // An unreadable current assignment is null, not a silent "No".
    const unknown = parseClaimProductContext(
      [contextRow({ product_assigned_currently: null })],
      RECEIPT_ID,
    );
    assert.equal(unknown?.lines[0].assignedCurrently, null);
  });

  test("1.9 no internal identifier is exposed by the parsed model", () => {
    const parsed = parseClaimProductContext([contextRow()], RECEIPT_ID);
    assert.ok(parsed);

    const keys = Object.keys(parsed).concat(Object.keys(parsed.lines[0]));
    for (const forbidden of [
      "vendorId", "vendorOrganizationId", "retailerId", "retailerOrganizationId",
      "shopId", "saleId", "verifiedSaleId", "confirmationId", "decisionId",
      "proposalLineId", "productId", "vendorProductId", "profileId",
      "membershipId", "storageBucket", "objectPath", "fileSha256", "email", "phone",
    ]) {
      assert.ok(!keys.includes(forbidden), `${forbidden} must not be a field`);
    }

    // The only identifier present is the receipt id the browser already has.
    const uuids = [
      ...JSON.stringify(parsed).matchAll(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      ),
    ].map((m) => m[0]);
    assert.deepEqual(uuids, [RECEIPT_ID]);

    // And the exported type carries no field for one either.
    const t = read(CONTEXT_MOD).match(
      /export type ClaimReceiptProductContext = \{[\s\S]*?\n\};/,
    );
    assert.ok(t);
    for (const forbidden of ["vendorId", "saleId", "decisionId", "productId", "profileId"]) {
      assert.ok(!t[0].includes(forbidden), forbidden);
    }
  });
});

// ============================================================================
describe("2. the read-only proposal panel", () => {
  const p = codeOf(PANEL);

  test("2.10 proposal lines render in the order the database returned them", () => {
    // No sort, no reverse, no reorder control anywhere.
    assert.match(p, /lines\.map\(\(line\) => \(/);
    assert.ok(!/\.sort\(|\.reverse\(/.test(p), "the panel reorders lines");
    assert.match(p, /Line \{line\.lineNumber\}/);
  });

  test("2.11 the quantity renders, and only as text", () => {
    assert.match(p, /Quantity/);
    assert.match(p, /\{line\.quantity\}/);
    assert.ok(
      !/name="quantity"|type="number"/.test(p),
      "a quantity must never be an input",
    );
  });

  test("2.12 every frozen value renders", () => {
    assert.match(p, /\{line\.productName \?\? "Product name not recorded"\}/);
    assert.match(p, /\{line\.productCode \?\? "Not recorded"\}/);
    assert.match(p, /line\.barcode \? \(/);
    assert.match(p, /line\.brand \? \(/);
    assert.match(p, /proposalStatusLabel\(line\.statusAtProposal\)/);
  });

  test("2.13 a currently inactive product is warned about in words", () => {
    assert.match(p, /currentStatusLabel\(line\.statusCurrent\)/);
    assert.match(p, /line\.statusCurrent === "INACTIVE" \? "amber" : "slate"/);
    assert.match(currentStatusLabel("INACTIVE"), /Current catalogue status: Inactive/);
  });

  test("2.14 a currently unassigned product is warned about in words", () => {
    assert.match(p, /currentAssignmentLabel\(line\.assignedCurrently\)/);
    assert.match(p, /line\.assignedCurrently === false \? "amber" : "slate"/);
    assert.match(
      currentAssignmentLabel(false),
      /Currently assigned to this retailer: No/,
    );
  });

  test("2.15 a current change never replaces or disables the frozen value", () => {
    // Both labels name WHICH fact they describe, so neither can be misread.
    assert.match(proposalStatusLabel("ACTIVE"), /^Status when submitted:/);
    assert.match(currentStatusLabel("INACTIVE"), /^Current catalogue status:/);
    assert.equal(
      hasCurrentStateWarning({
        statusAtProposal: "ACTIVE",
        statusCurrent: "INACTIVE",
        assignedCurrently: true,
      }),
      true,
    );
    assert.equal(
      hasCurrentStateWarning({
        statusAtProposal: "ACTIVE",
        statusCurrent: "ACTIVE",
        assignedCurrently: false,
      }),
      true,
    );
    assert.equal(
      hasCurrentStateWarning({
        statusAtProposal: "INACTIVE",
        statusCurrent: "ACTIVE",
        assignedCurrently: true,
      }),
      false,
    );

    // And the decision gate does NOT consult either current fact.
    const gate = p.match(/const canDecide =[\s\S]*?;\n/);
    assert.ok(gate);
    assert.ok(
      !/statusCurrent|assignedCurrently|hasCurrentStateWarning/.test(gate[0]),
      "current product state must never withhold the decision controls",
    );
    assert.match(p, /remain\s*\n?\s*authoritative, so this does not stop you/);
  });

  test("2.16 there is no product edit control of any kind", () => {
    const inputs = [...p.matchAll(/<input[^>]*name="([A-Za-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(inputs)].sort(), [
      "decision", "receiptSubmissionId", "rejectionReason",
    ]);
    // One textarea, and it is the reviewer's note — not a product field.
    assert.equal((p.match(/<textarea/g) ?? []).length, 1);
    assert.match(p, /name="reviewerNote"/);
    assert.ok(!/<select/.test(p), "no product picker belongs on this panel");
    assert.ok(
      !/Add (a )?product|Remove line|Edit quantity|Replace product|Move line/i.test(p),
      "an edit affordance exists",
    );
  });

  test("2.17 the whole-list rule and the separate decisions are stated", () => {
    assert.match(p, /accepting or rejecting the complete list/);
    assert.match(p, /cannot\s*\n?\s*be edited, added, removed or reordered/);
    assert.match(p, /Receipt-photo verification is a separate decision/);
    assert.match(p, /creates no reward and no coins/);
    assert.match(p, /Total quantity/);
    assert.match(p, /totalProposedQuantity/);
    assert.equal(totalProposedQuantity([{ quantity: 2 }, { quantity: 5 }]), 7);
    assert.equal(totalProposedQuantity([]), 0);
  });
});

// ============================================================================
describe("3. the state matrix", () => {
  const p = codeOf(PANEL);
  const page = codeOf(DETAIL_PAGE);

  /** Every state's controls hang off this one expression. */
  const gate = p.match(/const canDecide =[\s\S]*?;\n/)![0];

  test("3.18 no proposal offers no controls", () => {
    assert.match(gate, /hasProposal/);
    assert.match(p, /!unavailable && !hasProposal \? \(/);
    assert.match(p, /No product list was submitted for this receipt/);
  });

  test("3.19 a missing sale header offers no controls, and says why", () => {
    assert.match(gate, /hasSaleHeader/);
    assert.match(p, /!decided && !excluded && !hasSaleHeader \? \(/);
    assert.match(p, /Finalize the sale details first/);
    assert.match(p, /read-only until then/);
  });

  test("3.20 an active exclusion fails closed — the TEST_DATA receipt included", () => {
    assert.match(gate, /!excluded/);
    assert.match(p, /!decided && excluded \? \(/);
    assert.match(p, /A product decision is blocked/);
    assert.match(p, /exclusionReasonLabel\(context\.exclusionReason\)/);
    // The reason is rendered in words, never as a raw enum.
    assert.equal(exclusionReasonLabel("TEST_DATA"), "Test data");
    assert.equal(exclusionReasonLabel("NON_QUALIFYING"), "Non-qualifying");
    assert.equal(exclusionReasonLabel("DUPLICATE"), "Duplicate");
    assert.equal(exclusionReasonLabel(null), null);
  });

  test("3.21 only the ready state renders both controls", () => {
    assert.match(
      gate,
      /!unavailable &&\s*\n?\s*!decided &&\s*\n?\s*!excluded &&\s*\n?\s*hasProposal &&\s*\n?\s*hasSaleHeader &&\s*\n?\s*!state\.settled/,
    );
    assert.match(p, /\{canDecide \? \(\s*\n?\s*<form/);
    assert.match(p, /Accept complete product list/);
    assert.match(p, /Reject complete product list/);
    // Both live inside the single gated form.
    assert.equal((p.match(/<form[\s\S]{0,80}?action=\{formAction\}/g) ?? []).length, 1);
  });

  test("3.22 an accepted receipt offers no controls", () => {
    assert.match(gate, /!decided/);
    assert.match(p, /const decided = accepted \|\| rejected/);
    assert.match(p, /accepted \? \(\s*\n?\s*<AcceptedItemsBody/);
    assert.match(p, /no further product decision can be recorded/);
  });

  test("3.23 a rejected receipt offers no controls and shows zero items", () => {
    assert.match(p, /\{rejected \? <RejectedDecisionBody/);
    assert.match(p, /There are no authoritative sale items for this receipt/);
    assert.match(p, /cannot be reopened or replaced/);
  });

  test("3.24 an unreadable context offers no write control at all", () => {
    assert.match(p, /const unavailable = context === null/);
    assert.match(gate, /!unavailable/);
    assert.match(p, /temporarily unavailable/);
    assert.match(p, /no decision\s*\n?\s*is assumed either way/);
    // The page collapses every unreadable answer into that one null.
    assert.match(
      page,
      /productContextResult\?\.status === "authorized"\s*\n?\s*\? productContextResult\.context\s*\n?\s*: null/,
    );
    // And the panel is only mounted for a VERIFIED receipt in the first place.
    assert.match(page, /d\.decision === "VERIFIED" \? \(\s*\n?\s*<ProductPanel/);
  });
});

// ============================================================================
describe("4. the acceptance flow", () => {
  const p = codeOf(PANEL);
  const a = codeOf(ACTIONS);
  const w = codeOf(WRITE_ADAPTER);
  const page = codeOf(DETAIL_PAGE);

  test("4.25 the accept dialog states every consequence", () => {
    assert.match(p, /Accept the complete product list permanently\?/);
    assert.match(p, /will become an authoritative sale\s*\n?\s*item/);
    assert.match(p, /The complete list is accepted together/);
    assert.match(p, /permanent/);
    assert.match(p, /Products and quantities cannot be edited/);
    assert.match(p, /no campaign is being evaluated, and no reward\s*\n?\s*or coins/);
    assert.match(p, /role="dialog"/);
  });

  test("4.26 acceptance normalizes to ACCEPTED with a null reason and note", () => {
    const r = validateProductDecisionInput({ decision: "ACCEPTED" });
    assert.ok(r.ok);
    assert.deepEqual(r.value, {
      decision: "ACCEPTED",
      rejectionReason: null,
      reviewerNote: null,
    });

    // A crafted request that smuggles either is refused, not silently stripped.
    const withReason = validateProductDecisionInput({
      decision: "ACCEPTED",
      rejectionReason: "OTHER",
    });
    assert.equal(withReason.ok, false);
    const withNote = validateProductDecisionInput({
      decision: "ACCEPTED",
      reviewerNote: "hello",
    });
    assert.equal(withNote.ok, false);
  });

  test("4.27 no product, quantity or line ever reaches the RPC", () => {
    const call = w.match(/\.rpc\("finalize_claim_receipt_sale_items",\s*\{([\s\S]*?)\}\s*,?\s*\)/);
    assert.ok(call);
    const args = [...call[1].matchAll(/(p_[a-z_]+):/g)].map((m) => m[1]).sort();
    assert.deepEqual(args, [
      "p_decision", "p_rejection_reason", "p_reviewer_note", "p_submission_id",
    ]);
    assert.ok(
      !/product|quantity|line|sale_id|vendor|retailer|shop|actor|reviewer_id|campaign|reward|coin/i.test(
        call[1].replace(/p_reviewer_note/g, ""),
      ),
      "a forbidden argument reaches the RPC",
    );
  });

  test("4.28 a double submit cannot produce a second Server Action call", () => {
    // Structural: a settled state short-circuits before any RPC.
    assert.match(a, /if \(prevState\.settled\)\s*\{\s*return prevState;/);
    assert.ok(
      a.indexOf("prevState.settled") < a.indexOf("finalizeClaimReceiptSaleItems("),
      "the short-circuit must come first",
    );
    // Visual: the confirm button is disabled the moment the request is in flight.
    assert.match(p, /const confirmDisabled =\s*\n?\s*pending \|\|/);
    assert.match(p, /disabled=\{confirmDisabled\}/);
    assert.equal((p.match(/type="submit"/g) ?? []).length, 1);
    // And exactly one write call site in the action.
    assert.equal((a.match(/finalizeClaimReceiptSaleItems\(/g) ?? []).length, 1);
  });

  test("4.29 pending disables both actions, the reason and the note", () => {
    const form = p.slice(p.indexOf("{canDecide ? ("));
    // Both openers, both dialog buttons, the radios and the textarea.
    assert.ok(
      (form.match(/disabled=\{pending\}/g) ?? []).length >= 4,
      "every control must be disabled while pending",
    );
    assert.match(p, /onClick=\{\(\) => setMode\("ACCEPTED"\)\}[\s\S]{0,120}disabled=\{pending\}/);
    assert.match(p, /onClick=\{\(\) => setMode\("REJECTED"\)\}[\s\S]{0,120}disabled=\{pending\}/);
    // The dialog cannot be dismissed or reopened mid-flight either.
    assert.match(p, /event\.key === "Escape" && !pending/);
    assert.match(p, /event\.currentTarget && !pending/);
    assert.match(p, /if \(!pending\) setMode\(null\)/);
  });

  test("4.30 the slow notice is presentation only and calls nothing", () => {
    const slow = p.match(/slowTimer\.current = setTimeout\([\s\S]{0,120}/);
    assert.ok(slow);
    assert.match(slow[0], /setSlow\(true\)/);
    assert.ok(!/formAction|decideReceiptProductsAction|router\.refresh/.test(slow[0]));
    assert.equal((p.match(/setTimeout\(/g) ?? []).length, 1);
    assert.match(p, /onSubmit=\{armSlowNotice\}/);
    assert.match(SLOW_REQUEST_MESSAGE, /taking longer than expected/i);
    assert.match(SLOW_REQUEST_MESSAGE, /Do not submit again/i);
    assert.ok(!/failed|error|lost/i.test(SLOW_REQUEST_MESSAGE));
    assert.ok(SLOW_REQUEST_NOTICE_MS >= 2000 && SLOW_REQUEST_NOTICE_MS <= 10000);
    assert.match(PENDING_REQUEST_MESSAGE, /Saving the permanent product decision/);
  });

  test("4.31 ACCEPTED settles as an authoritative success", () => {
    const s = settleProductDecisionOutcome("ACCEPTED");
    assert.equal(s.settled, true);
    assert.equal(s.changed, true);
    assert.match(s.message, /complete product list was accepted/);
    assert.match(s.message, /VERIFIED review decision is unchanged/);
    assert.match(s.message, /no reward or coins were created/);
  });

  test("4.32 ALREADY_ACCEPTED settles idempotently and claims no new decision", () => {
    const s = settleProductDecisionOutcome("ALREADY_ACCEPTED");
    assert.equal(s.settled, true);
    assert.equal(s.changed, false);
    assert.match(s.message, /had already accepted/);
    assert.match(s.message, /Nothing was changed by this request/);
    assert.match(s.message, /no second decision/);
    assert.ok(
      !/^The complete product list was accepted/.test(s.message),
      "an idempotent reply must not read as a fresh write",
    );
  });

  test("4.33 the accepted state is read from the authoritative item RPC", () => {
    // The page reads it only when the decision says ACCEPTED.
    assert.match(page, /productContext\?\.alreadyAccepted\s*\n?\s*\? getVerifiedSaleItems/);
    // The panel renders those rows, never the proposal it was accepted from.
    const body = p.slice(p.indexOf("function AcceptedItemsBody"));
    assert.match(body, /sale\.items\.map/);
    assert.ok(!/context\.lines/.test(body), "the accepted state reconstructs items");
    assert.match(body, /item\.productName/);
    assert.match(body, /item\.quantity/);
    assert.match(body, /Line \{item\.lineNumber\}/);
    assert.match(body, /proposalStatusLabel\(item\.statusAtProposal\)/);
    assert.match(body, /Decided by/);

    // And the parser returns exactly those fields, in order.
    const parsed = parseVerifiedSaleItems([
      itemRow({ line_number: 1 }),
      itemRow({ line_number: 2, quantity: 3, product_code_at_proposal: "SKU-2" }),
    ]);
    assert.ok(parsed);
    assert.deepEqual(
      parsed.items.map((i) => [i.lineNumber, i.quantity]),
      [[1, 2], [2, 3]],
    );
    assert.equal(parsed.decidedByDisplayName, "Dana Reviewer");
    // An unreadable line makes the whole authoritative set unusable.
    assert.equal(parseVerifiedSaleItems([itemRow({ quantity: null })]), null);
    assert.equal(parseVerifiedSaleItems([]), null);
  });
});

// ============================================================================
describe("5. the rejection flow", () => {
  const p = codeOf(PANEL);

  test("5.34 a rejection requires a reason", () => {
    const r = validateProductDecisionInput({ decision: "REJECTED" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.fieldErrors.rejectionReason);
    // The dialog cannot be confirmed without one either.
    assert.match(p, /const rejectionReady = reason !== null && !noteMissing && !noteTooLong/);
    assert.match(p, /mode === "REJECTED" && !rejectionReady/);
  });

  test("5.35 each of the five approved reasons maps to its exact label", () => {
    assert.deepEqual([...PRODUCT_REJECTION_REASONS], [
      "PRODUCT_NOT_ON_RECEIPT", "WRONG_PRODUCT", "QUANTITY_MISMATCH",
      "ILLEGIBLE", "OTHER",
    ]);
    assert.deepEqual(PRODUCT_REJECTION_REASON_LABELS, {
      PRODUCT_NOT_ON_RECEIPT: "Product not shown on receipt",
      WRONG_PRODUCT: "Wrong product selected",
      QUANTITY_MISMATCH: "Quantity does not match",
      ILLEGIBLE: "Receipt too unclear to verify products",
      OTHER: "Other",
    });
    for (const code of PRODUCT_REJECTION_REASONS) {
      const r = validateProductDecisionInput({
        decision: "REJECTED",
        rejectionReason: code,
        reviewerNote: code === "OTHER" ? "because" : "",
      });
      assert.ok(r.ok, code);
      assert.equal(r.value.rejectionReason, code);
    }
    // The panel renders the labels from the same map, never a hand-typed copy.
    assert.match(p, /PRODUCT_REJECTION_REASONS\.map\(\(code\) => \(/);
    assert.match(p, /PRODUCT_REJECTION_REASON_LABELS\[code\]/);
  });

  test("5.36 an unrecognised reason is refused locally", () => {
    for (const bad of ["DUPLICATE_RECEIPT", "product_not_on_receipt", "MADE_UP", "  "]) {
      const r = validateProductDecisionInput({
        decision: "REJECTED",
        rejectionReason: bad,
        reviewerNote: "note",
      });
      assert.equal(r.ok, false, bad);
    }
    assert.equal(isProductRejectionReason("OTHER"), true);
    assert.equal(isProductRejectionReason("other"), false);
    assert.equal(isProductRejectionReason(null), false);
  });

  test("5.37 OTHER requires a non-empty trimmed note", () => {
    assert.equal(productReasonRequiresNote("OTHER"), true);
    for (const note of [undefined, "", "   ", "\n\t "]) {
      const r = validateProductDecisionInput({
        decision: "REJECTED",
        rejectionReason: "OTHER",
        reviewerNote: note,
      });
      assert.equal(r.ok, false, JSON.stringify(note));
      assert.ok(!r.ok && r.fieldErrors.reviewerNote);
    }
    const ok = validateProductDecisionInput({
      decision: "REJECTED",
      rejectionReason: "OTHER",
      reviewerNote: " a real explanation ",
    });
    assert.ok(ok.ok);
    assert.equal(ok.value.reviewerNote, "a real explanation");
  });

  test("5.38 the four standard reasons accept an empty note", () => {
    for (const code of PRODUCT_REJECTION_REASONS.filter((c) => c !== "OTHER")) {
      assert.equal(productReasonRequiresNote(code), false, code);
      const r = validateProductDecisionInput({
        decision: "REJECTED",
        rejectionReason: code,
        reviewerNote: "   ",
      });
      assert.ok(r.ok, code);
      assert.equal(r.value.reviewerNote, null);
    }
  });

  test("5.39 the note is trimmed exactly as the database trims it", () => {
    const r = validateProductDecisionInput({
      decision: "REJECTED",
      rejectionReason: "ILLEGIBLE",
      reviewerNote: "   padded note   ",
    });
    assert.ok(r.ok);
    assert.equal(r.value.reviewerNote, "padded note");

    // 500 real characters wrapped in spaces is accepted by both, matching
    // `nullif(btrim(...), '')` followed by `length(...) > 500`.
    const exactly500 = "x".repeat(PRODUCT_NOTE_MAX_LENGTH);
    const padded = validateProductDecisionInput({
      decision: "REJECTED",
      rejectionReason: "ILLEGIBLE",
      reviewerNote: `   ${exactly500}   `,
    });
    assert.ok(padded.ok);
    assert.equal(padded.value.reviewerNote?.length, PRODUCT_NOTE_MAX_LENGTH);
  });

  test("5.40 more than 500 characters is refused", () => {
    const r = validateProductDecisionInput({
      decision: "REJECTED",
      rejectionReason: "ILLEGIBLE",
      reviewerNote: "x".repeat(PRODUCT_NOTE_MAX_LENGTH + 1),
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /at most 500 characters/.test(r.fieldErrors.reviewerNote!));
    // The panel mirrors it and shows a live count.
    assert.match(p, /const noteTooLong = noteTrimmed\.length > PRODUCT_NOTE_MAX_LENGTH/);
    assert.match(p, /\{noteTrimmed\.length\} of \{PRODUCT_NOTE_MAX_LENGTH\}/);
    assert.match(p, /maxLength=\{PRODUCT_NOTE_MAX_LENGTH\}/);
  });

  test("5.41 a rejection carries no product or quantity", () => {
    const r = validateProductDecisionInput({
      decision: "REJECTED",
      rejectionReason: "WRONG_PRODUCT",
      reviewerNote: "second line is a different SKU",
    });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.value).sort(), [
      "decision", "rejectionReason", "reviewerNote",
    ]);
    // And no per-line verdict exists to send.
    assert.ok(
      !/rejectLine|lineDecision|perLine|name="lineNumber"/i.test(p),
      "a line-specific rejection exists",
    );
  });

  test("5.42 REJECTED settles as an authoritative success", () => {
    const s = settleProductDecisionOutcome("REJECTED");
    assert.equal(s.settled, true);
    assert.equal(s.changed, true);
    assert.match(s.message, /complete product list was rejected/);
    assert.match(s.message, /No authoritative sale items exist/);
    assert.match(s.message, /VERIFIED review decision is unchanged/);
  });

  test("5.43 ALREADY_REJECTED settles idempotently and claims no new decision", () => {
    const s = settleProductDecisionOutcome("ALREADY_REJECTED");
    assert.equal(s.settled, true);
    assert.equal(s.changed, false);
    assert.match(s.message, /had already rejected/);
    assert.match(s.message, /Nothing was changed by this request/);
    assert.ok(!/^The complete product list was rejected/.test(s.message));
  });
});

// ============================================================================
describe("6. conflict and uncertainty", () => {
  const p = codeOf(PANEL);
  const a = codeOf(ACTIONS);
  const w = codeOf(WRITE_ADAPTER);

  test("6.44 CONFLICT settles without retrying anything", () => {
    const s = settleProductDecisionOutcome("CONFLICT");
    assert.equal(s.settled, true);
    assert.equal(s.changed, false);
    assert.match(s.message, /Nothing was changed/);
    assert.match(s.message, /Refresh/);
    // A settled state short-circuits any further submission.
    assert.match(a, /if \(prevState\.settled\)\s*\{\s*return prevState;/);
  });

  test("6.45 CONFLICT names nobody and exposes no identifier", () => {
    const m = settleProductDecisionOutcome("CONFLICT").message;
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/i.test(m));
    assert.ok(!/\breviewer [A-Z]|\bby [A-Z]|another reviewer|someone else/i.test(m));
    assert.ok(!/email|@/.test(m));
  });

  test("6.46 an unreadable outcome is never reported as success", () => {
    assert.match(w, /!isProductDecisionOutcome\(row\.outcome\)/);
    assert.match(w, /if \(row === null \|\| !isProductDecisionOutcome[\s\S]{0,140}status: "unavailable"/);
    for (const bad of ["OK", "SUCCESS", "accepted", "FINALIZED", "", null, 7]) {
      assert.equal(isProductDecisionOutcome(bad), false, String(bad));
    }
    assert.deepEqual([...PRODUCT_DECISION_OUTCOMES], [
      "ACCEPTED", "REJECTED", "ALREADY_ACCEPTED", "ALREADY_REJECTED", "CONFLICT",
    ]);
  });

  test("6.47 transport uncertainty claims neither success nor failure", () => {
    const outage = a.match(/result\.status === "unavailable"[\s\S]*?\n  \}/);
    assert.ok(outage);
    assert.ok(!/settled: true/.test(outage[0]));
    assert.match(outage[0], /uncertain: true/);

    assert.match(UNCERTAIN_RESULT_MESSAGE, /could not confirm/i);
    assert.match(UNCERTAIN_RESULT_MESSAGE, /will not create a second decision/);
    assert.ok(!/^Recorded|successfully|has been recorded/i.test(UNCERTAIN_RESULT_MESSAGE));
    assert.ok(
      UNCERTAIN_RESULT_MESSAGE.indexOf("could not confirm") <
        UNCERTAIN_RESULT_MESSAGE.indexOf("recorded"),
      "uncertainty must be stated before the word recorded appears",
    );
    // A refusal, by contrast, is a definite answer and is worded as one.
    assert.match(REFUSED_MESSAGE, /no longer available/);
  });

  test("6.48 a manual status check is offered, and it only re-reads", () => {
    assert.match(p, /Check product decision status/);
    assert.match(p, /state\.uncertain \? \(/);
    const btn = p.match(/onClick=\{checkProductDecisionStatus\}[\s\S]{0,200}/);
    assert.ok(btn);
    assert.ok(!/type="submit"/.test(btn[0]));
    // ONE call site for the refresh, used by both the settlement effect and the
    // manual button, and it calls no RPC of its own.
    assert.equal((p.match(/router\.refresh\(/g) ?? []).length, 1);
    assert.match(p, /refreshRequested = useRef\(false\)/);
    assert.match(p, /if \(refreshRequested\.current\) return;/);
    assert.match(p, /refreshRequested\.current = true;/);
    assert.match(REFRESHING_MESSAGE, /recorded/i);
  });

  test("6.49 nothing polls", () => {
    for (const f of PHASE_1D_B_WEB_FILES) {
      const s = codeOf(f);
      assert.equal((s.match(/setInterval\(/g) ?? []).length, 0, f);
      assert.ok(!/useSWR|swr|refetchInterval|revalidateOnFocus/i.test(s), f);
    }
    assert.equal((codeOf(PANEL).match(/setTimeout\(/g) ?? []).length, 1);
  });

  test("6.50 nothing retries or resubmits automatically", () => {
    for (const f of [PANEL, ACTIONS, WRITE_ADAPTER]) {
      const s = codeOf(f).replace(/attempt/gi, "");
      assert.ok(!/\bretry\b|\bresubmit\b|\bbackoff\b/i.test(s), f);
    }
    // The refresh only ever runs after a FINAL, certain answer.
    assert.equal(
      shouldRefreshAfterProductDecisionSettlement({ settled: true, uncertain: false }),
      true,
    );
    assert.equal(
      shouldRefreshAfterProductDecisionSettlement({ settled: false, uncertain: false }),
      false,
    );
    assert.equal(
      shouldRefreshAfterProductDecisionSettlement({ settled: false, uncertain: true }),
      false,
    );
    assert.equal(
      shouldRefreshAfterProductDecisionSettlement({ settled: true, uncertain: true }),
      false,
    );
  });

  test("6.51 no raw provider diagnostic can reach a reviewer or a log", () => {
    for (const f of [CONTEXT_ADAPTER, ITEMS_ADAPTER, WRITE_ADAPTER]) {
      const s = codeOf(f);
      assert.ok(!/error\.(message|details|hint)/.test(s), `${f} reads an error body`);
      for (const [, , arg] of s.matchAll(/console\.(error|warn|log)\(([^)]*)\)/g)) {
        assert.match(arg.trim(), /^"[^"]*"$/, `${f} logs a non-literal`);
      }
    }
    // Only the SQLSTATE is read, and 42501 is deliberately ambiguous.
    assert.match(codeOf(WRITE_ADAPTER), /function sqlstateOf/);
    assert.match(codeOf(WRITE_ADAPTER), /case "42501":[\s\S]{0,160}status: "refused"/);
    assert.equal((codeOf(ACTIONS).match(/console\./g) ?? []).length, 0);
    // Every sentence the reviewer can see is a fixed string from one module.
    for (const o of PRODUCT_DECISION_OUTCOMES) {
      const m = settleProductDecisionOutcome(o).message;
      assert.ok(!/public\.|pg_|relation |function |column /i.test(m), o);
    }
  });
});

// ============================================================================
describe("7. the security boundary", () => {
  const a = codeOf(ACTIONS);
  const p = codeOf(PANEL);

  test("7.52 the Server Action reads exactly four form fields", () => {
    const reads = [...a.matchAll(/field\(formData, "([A-Za-z]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(reads)].sort(), [
      "decision", "receiptSubmissionId", "rejectionReason", "reviewerNote",
    ]);
    assert.equal((a.match(/formData\.get\(/g) ?? []).length, 1);
    // The id shape is checked before any RPC is reachable.
    assert.match(a, /isReceiptSubmissionId\(receiptSubmissionId\)/);
    assert.ok(
      a.indexOf("isReceiptSubmissionId") < a.indexOf("finalizeClaimReceiptSaleItems("),
    );
    // It revalidates nothing and never redirects — outcome first, refresh second.
    assert.ok(!/revalidatePath|from "next\/cache"|redirect\(/.test(a));
  });

  test("7.53 no Vendor input is accepted anywhere", () => {
    for (const f of PHASE_1D_B_WEB_FILES) {
      const s = codeOf(f);
      assert.ok(
        !/formData\.get\("(vendor|organization|tenant)/i.test(s),
        `${f} reads a Vendor field`,
      );
      assert.ok(!/vendorId|vendorOrganizationId/.test(s), `${f} names a Vendor id`);
    }
  });

  test("7.54 no reviewer or actor input is accepted anywhere", () => {
    for (const f of PHASE_1D_B_WEB_FILES) {
      const s = codeOf(f);
      assert.ok(
        !/formData\.get\("(reviewer|actor|profile|user|member|role)/i.test(s),
        `${f} reads an identity field`,
      );
      assert.ok(!/reviewerId|actorId|profileId|membershipId/.test(s), f);
    }
    // The only person named anywhere is a display name the database chose.
    assert.match(p, /decidedByDisplayName/);
  });

  test("7.55 no sale, confirmation, decision or proposal-line id is accepted", () => {
    for (const f of PHASE_1D_B_WEB_FILES) {
      const s = codeOf(f);
      for (const forbidden of FORBIDDEN_INPUTS) {
        assert.ok(!s.includes(forbidden), `${f} names ${forbidden}`);
      }
      assert.ok(!/[?&](returnTo|redirect|next)=/.test(s), `${f} has a return URL`);
    }
  });

  test("7.56 no product list can be sent from the browser", () => {
    const w = codeOf(WRITE_ADAPTER);
    // The write adapter's only input type has three fields and no array.
    assert.match(w, /NormalizedProductDecision/);
    assert.ok(
      !/JSON\.stringify|p_lines|p_products|p_quantities|jsonb/.test(w),
      "a list reaches the RPC",
    );
    const args = w.match(/\.rpc\("finalize_claim_receipt_sale_items",\s*\{([\s\S]*?)\}\s*,?\s*\)/);
    assert.ok(args);
    assert.ok(!/\[|\bmap\(|\bJSON\b/.test(args[1]), "an array is built for the RPC");
    // And the normalized shape itself cannot carry one.
    const r = validateProductDecisionInput({
      decision: "ACCEPTED",
      // Anything else on the object is ignored: there is no parameter for it.
      ...({ lines: [{ productId: "x", quantity: 9 }] } as object),
    });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.value).sort(), [
      "decision", "rejectionReason", "reviewerNote",
    ]);
    assert.deepEqual([...PRODUCT_DECISIONS], ["ACCEPTED", "REJECTED"]);
    assert.equal(isProductDecision("ACCEPT"), false);
    assert.equal(isProductDecision("accepted"), false);
  });

  test("7.57 the finalize RPC has exactly one production call site", () => {
    const hits: string[] = [];
    walk(ROOT);
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".test.ts")) continue;
        // Comments are stripped first: a file that merely EXPLAINS the RPC in
        // prose is not a call site, and must not be counted as one.
        if (codeOf(full).includes("finalize_claim_receipt_sale_items")) hits.push(full);
      }
    }
    assert.deepEqual(hits, [WRITE_ADAPTER]);

    // Same for the two reads: one adapter each, and no adapter calls two RPCs.
    for (const [file, rpc] of [
      [CONTEXT_ADAPTER, "get_claim_receipt_product_context"],
      [ITEMS_ADAPTER, "get_verified_sale_items"],
      [WRITE_ADAPTER, "finalize_claim_receipt_sale_items"],
    ] as const) {
      const rpcs = [...codeOf(file).matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(rpcs)], [rpc], file);
    }
  });

  test("7.58 no table is read or mutated directly, and no SQL is added", () => {
    for (const f of PHASE_1D_B_WEB_FILES) {
      // The RPC NAMES contain table names as substrings — `get_verified_sale_items`
      // is not a reference to `verified_sale_items`. Remove the permitted RPC
      // names first so the remaining text is checked honestly.
      const s = codeOf(f).replace(/\.rpc\("[a-z_]+"/g, ".rpc(");
      assert.ok(!/\.from\("/.test(s), `${f} queries a table`);
      assert.ok(!/\.(insert|update|upsert|delete)\(/.test(s), `${f} mutates a table`);
      for (const t of [
        "receipt_confirmation_products", "receipt_product_review_decisions",
        "verified_sale_items", "verified_sales", "receipt_submissions",
        "vendor_products", "audit_logs",
      ]) {
        assert.ok(!s.includes(t), `${f} names ${t}`);
      }
      assert.ok(!/create table|alter table|insert into|drop table/i.test(s), `${f} has DDL`);
      assert.ok(!f.endsWith(".sql"));
    }
    // SUPERSEDED BY MIGRATIONS 65-69. The original pinned a running total that every
    // later approved milestone falsifies, and it had been failing since Migration 65
    // because those units ran only the database suite. What THIS file owns is that its
    // OWN milestone still contributes exactly what it did, in its original position,
    // under its original name — so that is pinned, and the total is asserted as a
    // floor rather than as a number this file has no authority over.
    const files = readdirSync(join(ROOT, "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    assert.ok(files.length >= 64, "migrations are never removed");
    assert.equal(
      files.filter((f) => f.includes("receipt_product_proposals_and_sale_items"))
        .length,
      1,
      "Phase 1D-B must contribute exactly one migration",
    );
    assert.equal(
      files[63],
      "20260822090000_receipt_product_proposals_and_sale_items.sql",
    );
  });

  test("7.59 no service-role client and no credential anywhere", () => {
    for (const f of PHASE_1D_B_WEB_FILES) {
      const s = read(f);
      assert.ok(!/createAdminClient|supabase\/admin|SERVICE_ROLE/.test(s), f);
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}|sb_(secret|publishable)_/.test(s), f);
      assert.ok(!/dmyzdcnbeurlqiwozpae/.test(s), f);
      assert.ok(!/@(gmail|yahoo|outlook|hotmail)\./i.test(s), f);
      const uuids = [
        ...s.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi),
      ];
      assert.deepEqual(uuids.map((m) => m[0]), [], `hard-coded UUID in ${f}`);
    }
    // Both reads use the ordinary authenticated client.
    for (const f of [CONTEXT_ADAPTER, ITEMS_ADAPTER, WRITE_ADAPTER]) {
      assert.match(codeOf(f), /^import "server-only";/m);
      assert.match(codeOf(f), /from "@\/lib\/supabase\/server"/);
    }
    // Request-scoped React cache only — never a cross-user one.
    for (const f of [CONTEXT_ADAPTER, ITEMS_ADAPTER]) {
      assert.match(codeOf(f), /import \{ cache \} from "react"/);
      assert.ok(!/unstable_cache|revalidate:|force-cache/.test(codeOf(f)));
    }
  });

  test("7.60 the Phase 1D-A sale-header flow is untouched and still mounted", () => {
    const page = codeOf(DETAIL_PAGE);
    assert.match(page, /d\.decision === "VERIFIED" \? \(\s*<SaleHeaderPanel/);
    assert.match(page, /getClaimReceiptSaleContext\(d\.receiptSubmissionId\)/);
    assert.match(page, /saleContext\?\.alreadyFinalized/);
    assert.match(page, /header=\{saleHeader\}/);
    // The new panel is added AFTER it, never in place of it.
    assert.ok(page.indexOf("<SaleHeaderPanel") < page.indexOf("<ProductPanel"));
    // And this milestone did not touch its modules.
    for (const f of [
      "claim-sale-finalization-input.ts", "claim-sale-finalization-settlement.ts",
      "finalize-claim-receipt-sale-header.ts", "verified-sale-header.ts",
      "claim-receipt-sale-context.ts",
    ]) {
      assert.ok(
        !PHASE_1D_B_WEB_FILES.includes(join(ROOT, "lib", "review", f)),
        f,
      );
    }
  });

  test("7.61 the receipt-review and qualification flows are untouched and still mounted", () => {
    const page = codeOf(DETAIL_PAGE);
    assert.match(page, /<DecisionForm receiptSubmissionId=\{d\.receiptSubmissionId\}/);
    assert.match(page, /<QualificationPanel/);
    assert.ok(page.indexOf("<QualificationPanel") < page.indexOf("<ProductPanel"));
    // The image decision is described as separate in every state of the panel.
    const p2 = codeOf(PANEL);
    assert.equal(
      (p2.match(/VERIFIED review decision/g) ?? []).length >= 3,
      true,
      "each terminal state must repeat that the image decision is separate",
    );
    assert.ok(
      !/decide_claim_receipt|record_receipt_qualification|finalize_claim_receipt_sale_header/.test(
        PHASE_1D_B_WEB_FILES.map(codeOf).join("\n"),
      ),
      "this milestone must not call another flow's RPC",
    );
  });
});

// ============================================================================
describe("8. accessibility and milestone boundaries", () => {
  const p = codeOf(PANEL);

  test("8.1 the panel heading is announced and every status carries a word", () => {
    assert.match(p, /aria-labelledby="product-decision-heading"/);
    assert.match(p, /id="product-decision-heading"/);
    assert.match(p, /Products accepted/);
    assert.match(p, /Products rejected/);
    assert.match(p, /Blocked by exclusion/);
    assert.match(p, /Not yet decided/);
  });

  test("8.2 pending and slow messages are live regions", () => {
    assert.ok((p.match(/role="status"/g) ?? []).length >= 3);
    assert.equal(
      (p.match(/\{slow \? SLOW_REQUEST_MESSAGE : PENDING_REQUEST_MESSAGE\}/g) ?? [])
        .length,
      2,
    );
    assert.match(p, /role="alert"/);
  });

  test("8.3 the dialog is titled, described and focus-managed", () => {
    assert.match(p, /aria-modal="true"/);
    assert.match(p, /aria-labelledby=\{headingId\}/);
    assert.match(p, /aria-describedby=\{descriptionId\}/);
    assert.match(p, /tabIndex=\{-1\}/);
    assert.match(p, /dialogRef\.current\?\.focus\(\)/);
    assert.match(p, /dialogWasOpen\.current/);
    assert.match(p, /aria-haspopup="dialog"/);
    assert.match(p, /permanently\?/);
  });

  test("8.4 the reason group and the note are labelled with a visible count", () => {
    assert.match(p, /<legend className="text-sm font-medium text-slate-800">/);
    assert.match(p, /Why is the product list being rejected\?/);
    assert.match(p, /<Label\s*\n?\s*htmlFor=\{noteId\}/);
    assert.match(p, /id=\{noteId\}/);
    assert.match(p, /aria-describedby=\{cn\(\s*\n?\s*noteCountId/);
    assert.match(p, /characters/);
    assert.match(p, /a note is required for this reason/);
  });

  test("8.5 long values wrap and narrow layouts stay usable", () => {
    assert.ok((p.match(/break-words/g) ?? []).length >= 4);
    assert.ok((p.match(/break-all/g) ?? []).length >= 2, "barcodes must wrap");
    assert.match(p, /min-w-0/);
    assert.match(p, /flex-col gap-2 sm:flex-row/);
    assert.match(p, /flex-wrap/);
    assert.match(p, /max-h-full[\s\S]{0,40}overflow-y-auto/);
  });

  test("8.6 no campaign, reward or coin work exists in this milestone", () => {
    for (const f of PHASE_1D_B_WEB_FILES) {
      const s = codeOf(f);
      assert.ok(
        !/campaignId|rewardAmount|coinAmount|payout|qualifyFor|evaluateCampaign/i.test(s),
        f,
      );
    }
    // The copy denies them explicitly in each terminal state.
    assert.ok((p.match(/no reward or coins/gi) ?? []).length >= 2);
    assert.ok((p.match(/campaign/gi) ?? []).length >= 3);
  });

  test("8.7 no optimistic state, and the settlement is rendered before any refresh", () => {
    assert.ok(!/useOptimistic|setAccepted|setRejected|setDecided/.test(p));
    assert.ok(p.indexOf("state.settled ? (") < p.indexOf("{REFRESHING_MESSAGE}"));
    assert.match(
      p,
      /useEffect\(\(\) => \{\s*if \(!shouldRefreshAfterProductDecisionSettlement\(state\)\) return;/,
    );
  });

  test("8.8 the pure modules stay pure", () => {
    const settlement = codeOf(SETTLEMENT_MOD);
    assert.ok(!/\bimport\b/.test(settlement));
    assert.ok(!/next\/|supabase|fetch\(|process\.env|"use (server|client)"/.test(settlement));
    for (const f of [INPUT_MOD, DISPLAY_MOD]) {
      const s = codeOf(f);
      assert.ok(!/next\/|supabase|fetch\(|process\.env|server-only/.test(s), f);
    }
    // The context module imports only the vocabulary it validates against.
    const ctx = codeOf(CONTEXT_MOD);
    assert.ok(!/server-only|supabase|next\/|fetch\(/.test(ctx));
    assert.match(ctx, /from "\.\/claim-product-decision-input\.ts"/);
    assert.ok(!/\.\.\.row|\.\.\.rows/.test(ctx), "rows must never be spread");
  });
});
