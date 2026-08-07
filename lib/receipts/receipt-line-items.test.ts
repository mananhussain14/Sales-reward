import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadLineItemsForStatus,
  shouldReadLineItems,
  type LineItemReadResult,
} from "./receipt-line-item-load.ts";
import {
  describeLineItem,
  describeLineItems,
  formatLineItemQuantity,
  lineItemsDetectedLabel,
} from "./receipt-line-item-view.ts";
import { normalizeExtractionLineItems } from "./receipt-extraction-normalization.ts";
import type { LineItemView } from "./receipt-extraction-normalization.ts";
import type { ExtractionStatus } from "./receipt-extraction-vocabulary.ts";

/**
 * The extracted line items: WHEN they are read, WHAT is rendered, and what can never be.
 *
 * The two decisions live in pure modules, so both are executed here rather than described: the
 * read gate is driven by a COUNTING fake that proves QUEUED, PROCESSING and FAILED send nothing
 * at all, and the display reductions are called directly with the values the RPC actually
 * returns. What cannot be executed — the Server Action module and the two client components —
 * is pinned by reading its source, the same constraint and the same answer as
 * ./receipt-extraction-web-polling.test.ts.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function code(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** The same file with comments removed. See ./receipt-extraction-web-polling.test.ts. */
function executable(relativePath: string): string {
  return code(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const LOAD_GATE = "lib/receipts/receipt-line-item-load.ts";
const VIEW = "lib/receipts/receipt-line-item-view.ts";
const READER = "lib/receipts/receipt-extraction-line-items.ts";
const ACTIONS = "app/(retailer)/retailer/receipts/extraction-actions.ts";
const PANEL = "app/(retailer)/retailer/receipts/receipt-extraction-panel.tsx";
const ITEMS = "app/(retailer)/retailer/receipts/receipt-line-items.tsx";
const PANEL_STATE = "app/(retailer)/retailer/receipts/extraction-panel-state.ts";
const CLIENT_OPS_MIGRATION =
  "supabase/migrations/20260813210000_receipt_extraction_client_operations.sql";
const LINE_ITEM_SUITE =
  "supabase/tests/database/sales_staff_receipt_line_item_reads_test.sql";

const LINE_ITEM_FILES = [LOAD_GATE, VIEW, READER, ACTIONS, PANEL, ITEMS, PANEL_STATE];

/** A line item with every field present, as a base for the variations below. */
function line(overrides: Partial<LineItemView> = {}): LineItemView {
  return {
    lineNumber: 1,
    description: "Samsung Galaxy S25",
    descriptionSourceText: "SAMSUNG GALAXY S25",
    quantity: 1,
    quantitySourceText: "1",
    unitPriceMinor: 329900,
    unitPriceSourceText: "3,299.00",
    lineTotalMinor: 329900,
    lineTotalSourceText: "3,299.00",
    confidence: 0.98,
    ...overrides,
  };
}

/** A read port that records how many times it was called. */
function countingRead(result: LineItemReadResult) {
  const calls = { count: 0 };
  return {
    calls,
    ports: {
      read: async (): Promise<LineItemReadResult> => {
        calls.count += 1;
        return result;
      },
    },
  };
}

/* ===========================================================================
 * 1-4. WHEN the line items are read
 * ========================================================================= */

describe("1-4. only a SUCCEEDED reading is asked for its items", () => {
  test("SUCCEEDED fetches them", async () => {
    const { calls, ports } = countingRead({ status: "ok", lineItems: [line()] });
    const outcome = await loadLineItemsForStatus("SUCCEEDED", ports);

    assert.equal(calls.count, 1);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.status === "ok" ? outcome.lineItems.length : -1, 1);
  });

  for (const status of ["QUEUED", "PROCESSING", "FAILED"] as ExtractionStatus[]) {
    test(`${status} sends NO request at all`, async () => {
      // Not "sends one and ignores it": the counting port proves nothing was sent. For QUEUED and
      // PROCESSING that also means the read can never overlap the polling loop.
      const { calls, ports } = countingRead({ status: "ok", lineItems: [line()] });
      const outcome = await loadLineItemsForStatus(status, ports);

      assert.equal(calls.count, 0);
      assert.equal(outcome.status, "skipped");
    });
  }

  test("an unsettled reading sends nothing either", async () => {
    const { calls, ports } = countingRead({ status: "ok", lineItems: [] });
    assert.equal((await loadLineItemsForStatus(null, ports)).status, "skipped");
    assert.equal(calls.count, 0);
  });

  test("the gate itself is true for SUCCEEDED and false for everything else", () => {
    assert.equal(shouldReadLineItems("SUCCEEDED"), true);
    assert.equal(shouldReadLineItems("QUEUED"), false);
    assert.equal(shouldReadLineItems("PROCESSING"), false);
    assert.equal(shouldReadLineItems("FAILED"), false);
    assert.equal(shouldReadLineItems(null), false);
  });

  test("one call issues at most ONE read, and never retries", async () => {
    const { calls, ports } = countingRead({ status: "unavailable" });
    assert.equal((await loadLineItemsForStatus("SUCCEEDED", ports)).status, "unavailable");
    assert.equal(calls.count, 1);
  });

  test("the panel asks only once per settled reading", () => {
    const panel = executable(PANEL);
    // The effect keys on the SETTLED status, which changes once per reading, and a second
    // generation counter discards a superseded run's answer.
    assert.match(panel, /const settledStatus = phase === "settled" \? view\?\.status \?\? null : null;/);
    assert.match(panel, /if \(settledStatus === null\) return;/);
    assert.match(panel, /itemsRunRef\.current !== myRun/);

    const calls = panel.match(/readReceiptLineItemsAction\(/g) ?? [];
    assert.equal(calls.length, 1, "the read action is called from more than one place");
  });

  test("no second polling implementation was introduced", () => {
    for (const file of [LOAD_GATE, VIEW, READER, ITEMS]) {
      const source = executable(file);
      assert.ok(!source.includes("setInterval"), `${file} uses setInterval`);
      assert.ok(!source.includes("setTimeout"), `${file} schedules its own retry`);
    }
    // The panel still drives exactly one loop, through the shared pure module.
    const loops = executable(PANEL).match(/runExtractionPollLoop\(/g) ?? [];
    assert.equal(loops.length, 1);
  });
});

/* ===========================================================================
 * 5-6. EVERY item renders
 * ========================================================================= */

describe("5-6. every returned item is described, and its description is shown", () => {
  test("nine returned lines produce nine descriptions", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      line({ lineNumber: index + 1, description: `Item ${index + 1}` }),
    );
    const described = describeLineItems(many, "AED", 2);

    assert.equal(described.length, 9);
    assert.deepEqual(
      described.map((item) => item.description),
      many.map((item) => item.description),
    );
  });

  test("five returned lines are not truncated", () => {
    // The count the milestone named explicitly, asserted as a count rather than assumed.
    const five = Array.from({ length: 5 }, (_, index) => line({ lineNumber: index + 1 }));
    assert.equal(describeLineItems(five, "AED", 2).length, 5);
  });

  test("the description is carried through unchanged", () => {
    assert.equal(describeLineItem(line(), "AED", 2).description, "Samsung Galaxy S25");
  });

  test("a line with no readable field at all is still a line", () => {
    const blank = describeLineItems(
      [
        line({
          lineNumber: 4,
          description: null,
          quantity: null,
          unitPriceMinor: null,
          lineTotalMinor: null,
        }),
      ],
      "AED",
      2,
    );
    assert.equal(blank.length, 1);
    assert.equal(blank[0].description, null);
    // A POSITION, not an invented product name — line_number is the backend's own value.
    assert.equal(blank[0].fallbackLabel, "Line 4");
  });

  test("the list component maps the whole array, with no slice or filter", () => {
    const items = executable(ITEMS);
    assert.match(items, /items\.map\(\(item\) =>/);
    assert.ok(!/\.slice\(/.test(items), "the list truncates");
    assert.ok(!/\.filter\(/.test(items), "the list drops lines");
    assert.ok(!/\.sort\(/.test(items), "the list re-orders what the RPC ordered");
  });

  test("the count shown is derived from the rendered array itself", () => {
    // So the number and the list cannot disagree.
    assert.match(executable(ITEMS), /lineItemsDetectedLabel\(items\.length\)/);
  });

  test("the detected label counts what was returned, never what the paper contained", () => {
    assert.equal(lineItemsDetectedLabel(4), "4 items detected");
    assert.equal(lineItemsDetectedLabel(1), "1 item detected");
    assert.equal(lineItemsDetectedLabel(0), "0 items detected");
  });
});

/* ===========================================================================
 * 7-12. Presence, absence and zero
 * ========================================================================= */

describe("7-8. quantity", () => {
  test("a present quantity renders", () => {
    assert.equal(describeLineItem(line({ quantity: 3 }), "AED", 2).quantity, "3");
  });

  test("a fractional quantity keeps its fraction and drops trailing zeros", () => {
    assert.equal(formatLineItemQuantity(1.5), "1.5");
    assert.equal(formatLineItemQuantity(2), "2");
    // numeric(9,3) round-trips as 2.000; a person writes 2.
    assert.equal(formatLineItemQuantity(Number("2.000")), "2");
  });

  test("a MISSING quantity is not fabricated as 1", () => {
    // The single most tempting default, and the one that would silently change a receipt.
    assert.equal(formatLineItemQuantity(null), null);
    assert.equal(describeLineItem(line({ quantity: null }), "AED", 2).quantity, null);
  });

  test("a quantity of zero is a VALUE and renders", () => {
    assert.equal(formatLineItemQuantity(0), "0");
  });

  test("a nonsensical quantity renders nothing rather than showing a fault as data", () => {
    assert.equal(formatLineItemQuantity(-1), null);
    assert.equal(formatLineItemQuantity(Number.NaN), null);
    assert.equal(formatLineItemQuantity(Number.POSITIVE_INFINITY), null);
    assert.equal(formatLineItemQuantity(1e21), null);
  });

  test("the row omits the quantity entirely when it is null", () => {
    // No label, no dash, no placeholder: the fact is absent from the DOM.
    assert.match(executable(ITEMS), /item\.quantity !== null &&/);
  });
});

describe("9-12. prices and amounts", () => {
  test("a unit price renders when present", () => {
    assert.equal(describeLineItem(line(), "AED", 2).unitPrice, "AED 3299.00");
  });

  test("a line amount renders when present", () => {
    assert.equal(describeLineItem(line(), "AED", 2).lineTotal, "AED 3299.00");
  });

  test("a zero amount renders as zero", () => {
    // A legitimately zero line — a promotional item — must show its zero rather than vanish.
    const zero = describeLineItem(
      line({ unitPriceMinor: 0, lineTotalMinor: 0 }),
      "AED",
      2,
    );
    assert.equal(zero.unitPrice, "AED 0.00");
    assert.equal(zero.lineTotal, "AED 0.00");
  });

  test("a MISSING price is not fabricated", () => {
    const none = describeLineItem(
      line({ unitPriceMinor: null, lineTotalMinor: null }),
      "AED",
      2,
    );
    assert.equal(none.unitPrice, null);
    assert.equal(none.lineTotal, null);
  });

  test("an item with a price but no description still shows its price", () => {
    const priced = describeLineItem(
      line({ description: null, lineNumber: 2 }),
      "AED",
      2,
    );
    assert.equal(priced.description, null);
    assert.equal(priced.lineTotal, "AED 3299.00");
  });

  test("both amounts are omitted from the row when null", () => {
    const items = executable(ITEMS);
    assert.match(items, /item\.unitPrice !== null &&/);
    assert.match(items, /item\.lineTotal !== null &&/);
  });
});

/* ===========================================================================
 * 13-15. Currency scale comes from the extraction, never from an assumption
 * ========================================================================= */

describe("13-15. the currency minor unit is data", () => {
  test("0-decimal currencies get no decimals", () => {
    // 1234 yen is not 12.34.
    assert.equal(describeLineItem(line({ lineTotalMinor: 1234 }), "JPY", 0).lineTotal, "JPY 1234");
  });

  test("2-decimal currencies render as printed", () => {
    assert.equal(describeLineItem(line({ lineTotalMinor: 123456 }), "AED", 2).lineTotal, "AED 1234.56");
  });

  test("3-decimal currencies keep all three", () => {
    assert.equal(
      describeLineItem(line({ lineTotalMinor: 1234567 }), "KWD", 3).lineTotal,
      "KWD 1234.567",
    );
  });

  test("an unresolved scale renders NOTHING rather than assuming two", () => {
    const unknown = describeLineItem(line(), "AED", null);
    assert.equal(unknown.unitPrice, null);
    assert.equal(unknown.lineTotal, null);
    // The description survives: an unrenderable amount is not an unrenderable line.
    assert.equal(unknown.description, "Samsung Galaxy S25");
  });

  test("a missing currency renders no amount either", () => {
    assert.equal(describeLineItem(line(), null, 2).lineTotal, null);
  });

  test("the panel passes the EXTRACTION's own currency and scale", () => {
    assert.match(
      executable(PANEL),
      /describeLineItems\(\s*lineItems\.items,\s*view\.currencyCode\.value,\s*view\.currencyMinorUnit,?\s*\)/,
    );
  });

  test("no component formats money on its own", () => {
    for (const file of [ITEMS, VIEW]) {
      assert.ok(
        !/Intl\.NumberFormat|toFixed\(/.test(executable(file)),
        `${file} formats money without the shared minor-unit contract`,
      );
    }
  });
});

/* ===========================================================================
 * 16. SKU / reference
 * ========================================================================= */

describe("16. a reference or SKU is rendered only if the contract has one", () => {
  test("the RPC's declared columns contain no reference, product code or SKU", () => {
    const migration = code(CLIENT_OPS_MIGRATION);
    const declaration =
      /create function public\.list_my_receipt_extraction_line_items\([\s\S]*?returns table \(([\s\S]*?)\)\nlanguage plpgsql/.exec(
        migration,
      );
    assert.ok(declaration !== null, "the RPC declaration could not be read");

    const columns = declaration[1];
    for (const absent of ["sku", "reference", "product_code", "barcode", "item_code"]) {
      assert.ok(!columns.includes(absent), `the contract unexpectedly has ${absent}`);
    }
  });

  test("the ten columns it DOES declare are the ten the view type carries", () => {
    // If a migration ever adds a reference column, this is the assertion that fails and forces
    // the decision to be made deliberately rather than discovered in a rendering.
    const normalized = normalizeExtractionLineItems([
      {
        line_number: 1,
        description: "x",
        description_source_text: "X",
        quantity: "1",
        quantity_source_text: "1",
        unit_price_minor: "100",
        unit_price_source_text: "1.00",
        line_total_minor: "100",
        line_total_source_text: "1.00",
        confidence: "0.9",
      },
    ]);
    assert.equal(normalized.status, "ok");
    assert.deepEqual(
      Object.keys(normalized.status === "ok" ? normalized.lineItems[0] : {}).sort(),
      [
        "confidence",
        "description",
        "descriptionSourceText",
        "lineNumber",
        "lineTotalMinor",
        "lineTotalSourceText",
        "quantity",
        "quantitySourceText",
        "unitPriceMinor",
        "unitPriceSourceText",
      ],
    );
  });

  test("nothing invents one", () => {
    for (const file of [VIEW, ITEMS]) {
      const source = executable(file);
      assert.ok(
        !/\bsku\b|\bSku\b|SKU|productCode|product_code|\bRef:/i.test(source),
        `${file} renders a reference the contract does not provide`,
      );
    }
  });
});

/* ===========================================================================
 * 17-21. Nothing internal is rendered, and nothing reaches a table
 * ========================================================================= */

describe("17-20. no internal, provider or storage value can be rendered", () => {
  const FORBIDDEN = [
    "provider_operation_id",
    "providerOperationId",
    "worker_claim_token",
    "workerClaimToken",
    "claim_token",
    "claimToken",
    "provider_model",
    "providerModel",
    "storage_bucket",
    "storageBucket",
    "object_path",
    "storage_object_path",
    "objectPath",
    "file_sha256",
    "fileSha256",
    "expires_at",
    "expiresAt",
    "extraction_id",
    "receipt_extraction_id",
  ];

  test("no file on the line-item path names any of them", () => {
    for (const file of LINE_ITEM_FILES) {
      const source = executable(file);
      for (const field of FORBIDDEN) {
        assert.ok(!source.includes(field), `${file} references ${field}`);
      }
    }
  });

  test("the list component renders no confidence and no source text", () => {
    // Both are in the contract and neither belongs on a submitter's screen: a confidence score
    // invites arguing with the reader, and source text is the same value twice.
    const items = executable(ITEMS);
    assert.ok(!/confidence/i.test(items), "confidence is rendered");
    assert.ok(!/SourceText|source_text/.test(items), "raw source text is rendered");
  });

  test("no internal failure or warning vocabulary appears", () => {
    const items = executable(ITEMS);
    for (const internal of [
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_QUOTA_EXCEEDED",
      "PROVIDER_TIMEOUT",
      "PROVIDER_REJECTED_DOCUMENT",
      "OBJECT_UNREADABLE",
      "NORMALIZATION_FAILED",
      "WORKER_ABANDONED",
      "NEVER_CLAIMED",
    ]) {
      assert.ok(!items.includes(internal), `the list speaks the internal code ${internal}`);
    }
  });

  test("no Azure credential, endpoint or provider name appears on the path", () => {
    for (const file of LINE_ITEM_FILES) {
      assert.ok(
        !/AZURE_|DOCUMENT_INTELLIGENCE|cognitiveservices|prebuilt-receipt|prebuilt-invoice/i.test(
          executable(file),
        ),
        `${file} references Azure configuration`,
      );
    }
  });
});

describe("21. the browser never reaches a protected table", () => {
  test("no file on the path opens a PostgREST table query", () => {
    for (const file of LINE_ITEM_FILES) {
      assert.ok(!/\.from\(/.test(executable(file)), `${file} queries a table directly`);
    }
  });

  test("no file on the path names a protected extraction table", () => {
    // The RPC's own name contains the table's name as a substring, so the check is anchored to a
    // position a table name could occupy — a quoted or dotted identifier — rather than to the
    // bare word inside `list_my_receipt_extraction_line_items`.
    for (const file of LINE_ITEM_FILES) {
      const source = executable(file);
      assert.ok(
        !/["'.](receipt_extractions|receipt_extraction_line_items|receipt_confirmations)\b/.test(
          source,
        ),
        `${file} names a protected table`,
      );
    }
  });

  test("the read goes through the existing authorized RPC, named exactly once", () => {
    const reader = code(READER);
    assert.match(
      reader,
      /const LINE_ITEMS_RPC = "list_my_receipt_extraction_line_items" as const;/,
    );
    // One literal in the whole web application, so a rename has one place to happen.
    const occurrences = LINE_ITEM_FILES.map((file) => {
      const matches = code(file).match(/"list_my_receipt_extraction_line_items"/g);
      return matches === null ? 0 : matches.length;
    }).reduce((a, b) => a + b, 0);
    assert.equal(occurrences, 1);
  });

  test("that RPC authorizes from auth.uid() before it returns a row", () => {
    const migration = code(CLIENT_OPS_MIGRATION);
    const body =
      /create function public\.list_my_receipt_extraction_line_items\([\s\S]*?\$\$;/.exec(
        migration,
      );
    assert.ok(body !== null);
    assert.match(body[0], /if not public\.assert_my_receipt_extraction_access\(p_submission_id\) then/);
    assert.match(body[0], /security definer/);
    // And only a SUCCEEDED attempt has items to return.
    assert.match(body[0], /and x\.status = 'SUCCEEDED'/);
  });

  test("no file on the path constructs a service-role client or reads its key", () => {
    for (const file of LINE_ITEM_FILES) {
      const source = executable(file);
      assert.ok(!/createAdminClient/.test(source), `${file} builds an admin client`);
      assert.ok(
        !/SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE/.test(source),
        `${file} reads the service-role key`,
      );
    }
  });

  test("the reader is server-only and takes no caller identity", () => {
    const reader = executable(READER);
    assert.match(reader, /from "@\/lib\/supabase\/server"/);
    assert.ok(
      !/profileId|organizationId|retailerId|membershipId|userId/.test(reader),
      "the reader accepts a caller identity",
    );
    // The only argument is a submission id.
    assert.match(reader, /getMyReceiptExtractionLineItems\(\s*submissionId: string,?\s*\)/);
  });
});

/* ===========================================================================
 * 22. An unauthorized or failed read is handled safely
 * ========================================================================= */

describe("22. a refused or failed read is handled without leaking anything", () => {
  test("an unauthorized read becomes a plain status", async () => {
    const { ports } = countingRead({ status: "unauthorized" });
    assert.deepEqual(await loadLineItemsForStatus("SUCCEEDED", ports), {
      status: "unauthorized",
    });
  });

  test("an unavailable read becomes a plain status", async () => {
    const { ports } = countingRead({ status: "unavailable" });
    assert.deepEqual(await loadLineItemsForStatus("SUCCEEDED", ports), {
      status: "unavailable",
    });
  });

  test("the Server Action re-resolves portal access before reading", () => {
    const actions = code(ACTIONS);
    const action = /export async function readReceiptLineItemsAction[\s\S]*?\n\}/.exec(actions);
    assert.ok(action !== null);
    assert.match(action[0], /await refuseUnlessSubmitter\(\)/);
    assert.match(action[0], /UUID_PATTERN\.test/);
  });

  test("a database denial and a lapsed session collapse to one client answer", () => {
    const actions = code(ACTIONS);
    const action = /export async function readReceiptLineItemsAction[\s\S]*?\n\}/.exec(actions);
    assert.ok(action !== null);
    assert.match(action[0], /result\.status === "denied"\s*\n?\s*\? \{ status: "unauthorized" \}/);
  });

  test("the read action creates nothing and writes nothing", () => {
    const actions = code(ACTIONS);
    const action = /export async function readReceiptLineItemsAction[\s\S]*?\n\}/.exec(actions);
    assert.ok(action !== null);
    assert.ok(!action[0].includes("requestReceiptExtraction"), "the read can create an attempt");
    assert.ok(!/revalidatePath|confirm|insert|update/i.test(action[0]), "the read mutates");
  });

  test("the reader logs a category and never an error, an id or a row", () => {
    const reader = code(READER);
    assert.match(reader, /console\.error\(`\[receipts-line-items\] \$\{category\}`\)/);
    const logs = reader.match(/console\.(error|log|warn|info)\(/g) ?? [];
    assert.equal(logs.length, 1, "an unaudited log line appeared");
    assert.ok(
      !/logLineItemsFailure\([^)]*submissionId/.test(reader),
      "a receipt id is logged",
    );
  });

  test("a malformed row is refused rather than half-rendered", () => {
    assert.equal(normalizeExtractionLineItems([{ description: "x" }]).status, "malformed");
    assert.match(code(READER), /if \(normalized\.status === "malformed"\)/);
  });

  test("the panel's failure copy blames neither the receipt nor the person", () => {
    const state = code(PANEL_STATE);
    assert.match(state, /EXTRACTION_ITEMS_UNAVAILABLE_MESSAGE =/);
    // The receipt WAS read and saved; the sentence must not suggest otherwise.
    assert.match(state, /Your receipt was read and saved\./);
  });
});

/* ===========================================================================
 * The contract itself is proved against the database
 * ========================================================================= */

describe("the read contract is pinned in pgTAP, not only asserted here", () => {
  const suite = code(LINE_ITEM_SUITE);

  test("every recorded line comes back, proved against a nine-line fixture", () => {
    assert.match(
      suite,
      /all nine recorded lines are returned — nothing is capped, sampled or paged/,
    );
  });

  test("absence is proved to be returned as absence", () => {
    assert.match(suite, /a missing quantity returns NULL — the contract never says 1/);
    assert.match(suite, /a missing price returns NULL — the contract never says 0/);
    assert.match(suite, /a zero-priced promotional line returns zero, not null/);
  });

  test("the currency scale is proved to travel with the extraction", () => {
    assert.match(suite, /a 0-decimal currency reports minor unit 0/);
    assert.match(suite, /rendering it as 30\.00 would be the bug/);
  });

  test("the absence of a reference column is proved from the catalogue", () => {
    assert.match(
      suite,
      /there is no reference, SKU or product code/,
    );
  });

  test("a colleague at the same Retailer and shop is proved to see nothing", () => {
    assert.match(suite, /a colleague in the SAME Retailer and the SAME shop sees none/);
  });

  test("it never enables the hosted runtime", () => {
    // FAKE is the only non-disabled mode it sets, and it restores DISABLED before finishing.
    assert.ok(!/set_mode\('AZURE'\)/.test(suite), "the suite sets the AZURE runtime");
    assert.match(suite, /select pg_temp\.set_mode\('DISABLED'\);/);
    assert.match(suite, /the extraction runtime is DISABLED again before this suite ends/);
  });
});

/* ===========================================================================
 * READ-ONLY: the milestone's business rule, made structural
 * ========================================================================= */

describe("the items are evidence, and evidence is not editable here", () => {
  const items = executable(ITEMS);

  test("the list component contains no form control of any kind", () => {
    for (const control of ["<input", "<select", "<textarea", "<button", "<form"]) {
      assert.ok(!items.includes(control), `the list renders ${control}`);
    }
    assert.ok(!/contentEditable/i.test(items), "the list is editable");
    assert.ok(!/onChange|onInput|onSubmit|onClick/.test(items), "the list has a change handler");
  });

  test("nothing on the path offers to remove, exclude, match or approve an item", () => {
    for (const file of [VIEW, ITEMS, LOAD_GATE, READER]) {
      const source = executable(file);
      assert.ok(
        !/\bexclude|\bremoveItem|\bapprove|\bmatchProduct|\bcoins?\b/i.test(source),
        `${file} reaches into a later milestone`,
      );
    }
  });

  test("no confirmation, correction or write RPC is called from the web", () => {
    for (const file of LINE_ITEM_FILES) {
      const source = executable(file);
      assert.ok(
        !/confirm_receipt_extraction|record_receipt_extraction|update_receipt/.test(source),
        `${file} calls a write RPC`,
      );
    }
  });

  test("the read-only note is shown beside the items", () => {
    assert.ok(items.includes("EXTRACTION_ITEMS_READ_ONLY_NOTE"));
    assert.match(
      code(PANEL_STATE),
      /EXTRACTION_ITEMS_READ_ONLY_NOTE =\s*\n?\s*"These are the reader's own values, kept exactly as read\./,
    );
  });
});
