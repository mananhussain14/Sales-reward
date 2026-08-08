import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { receiptShopMode } from "./receipt-shop-selection.ts";

/**
 * TWO UX CORRECTIONS, pinned.
 *
 *   1. For a Sales Staff member with SEVERAL shops, the shop field must LOOK required —
 *      and must say, in words, that it comes before the document.
 *   2. The document a person uploads is an itemized sales INVOICE or a POS RECEIPT, so the
 *      copy names both.
 *
 * ============================================================================
 * THE SECOND HALF OF THIS FILE IS THE MORE IMPORTANT HALF
 * ============================================================================
 * A terminology change is exactly the kind of edit that gets applied with a global
 * find-and-replace, and a global find-and-replace across this feature would rename a table,
 * an RPC, an Edge Function, a form field, a route and a migration — a schema and contract
 * change wearing a copy change's clothes. So the sections below assert the INTERNAL
 * vocabulary is still `receipt_*`, by name, one identifier at a time.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function code(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** The same file with comments removed, so prose cannot satisfy a rule about code. */
function executable(relativePath: string): string {
  return code(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const FORM = "app/(retailer)/retailer/receipts/submit-receipt-form.tsx";
const PAGE = "app/(retailer)/retailer/receipts/page.tsx";
const FIELD = "components/ui/field.tsx";
const STEPS = "components/sales-staff/receipt-steps.tsx";
const PANEL = "app/(retailer)/retailer/receipts/receipt-extraction-panel.tsx";
const ITEMS = "app/(retailer)/retailer/receipts/receipt-line-items.tsx";
const SUBMIT_ACTION = "app/(retailer)/retailer/receipts/actions.ts";

const FORM_COPY = "app/(retailer)/retailer/receipts/submit-receipt-state.ts";
const PANEL_COPY = "app/(retailer)/retailer/receipts/extraction-panel-state.ts";

/**
 * Every SENTENCE the two copy modules hold, read out of their source.
 *
 * WHY SOURCE AND NOT AN IMPORT. Both modules import through the `@/` alias, which the
 * TypeScript compiler resolves and `node --test` does not — the same constraint that makes
 * every other UI guard in this repo read source. Reading the file is also the STRONGER
 * choice for the sweep below: it collects whatever sentences the module actually contains,
 * so a copy string added later is swept automatically rather than needing to be listed here.
 *
 * Comments and import lines are removed first, so prose about a rule and a module path can
 * never be mistaken for a sentence a person reads.
 */
function sentencesIn(relativePath: string): string[] {
  const source = executable(relativePath)
    .split("\n")
    .filter((line) => !/^\s*import\b|from "/.test(line))
    .join("\n");

  // Double-quoted literals only. A sentence with an apostrophe is written in double quotes
  // throughout this codebase, and the two template literals here interpolate a number and a
  // shop label rather than naming a document.
  return [...source.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((match) => match[1])
    // A sentence, not a class name, a key or a directive. Every string a person reads on
    // this surface contains a space and ends in punctuation or is a short title.
    .filter((value) => value.length >= 12 && / /.test(value))
    .filter((value) => !/^[a-z-]+(\s[a-z-]+)*$/.test(value) || /\./.test(value));
}

const USER_FACING_COPY: Record<string, string> = Object.fromEntries(
  [...sentencesIn(FORM_COPY), ...sentencesIn(PANEL_COPY)].map((sentence, index) => [
    `${index}: ${sentence.slice(0, 40)}`,
    sentence,
  ]),
);

/* ===========================================================================
 * 1-2. THE SHOP FIELD LOOKS REQUIRED, AND SAYS WHAT COMES FIRST
 * ========================================================================= */

describe("1. the multi-shop shop label carries a required indication", () => {
  const form = executable(FORM);

  test("the label is marked required, noted as Required, and emphasised", () => {
    assert.match(form, /<Label htmlFor="shopId" required requiredNote emphasis>/);
  });

  test("the design system renders a red asterisk for a required label", () => {
    const field = executable(FIELD);
    assert.match(field, /\{required && \(\s*<span className="ml-1 text-red-600"/);
  });

  test("and renders the word Required beside it, only when asked", () => {
    const field = executable(FIELD);
    assert.match(field, /\{required && requiredNote && \(/);
    assert.match(field, /Required\s*<\/span>/);
  });

  test("emphasis SWAPS the weight rather than appending a competing class", () => {
    // `cn` is a plain joiner, so two font-* classes in one attribute are resolved by
    // stylesheet order. A caller-supplied override would be a coin toss; this is not.
    const field = executable(FIELD);
    assert.match(
      field,
      /emphasis \? "font-semibold text-slate-900" : "font-medium text-slate-800"/,
    );
  });

  test("the requirement is never carried by colour alone", () => {
    // The asterisk and the word are both TEXT, so the requirement survives a monochrome
    // screen and a colour-vision difference.
    const field = executable(FIELD);
    assert.ok(field.includes("*"), "the asterisk glyph is gone");
    assert.ok(field.includes("Required"), "the Required word is gone");
  });

  test("the marker is announced ONCE: aria-hidden decoration plus a real aria-required", () => {
    const field = executable(FIELD);
    // Both visual markers are hidden from assistive technology...
    const requiredBlock = /\{required && \(([\s\S]*?)\)\}/.exec(field);
    assert.ok(requiredBlock !== null);
    assert.match(requiredBlock[1], /aria-hidden="true"/);
    // ...and the CONTROL is what states the requirement.
    assert.match(executable(FORM), /aria-required="true"/);
    assert.match(executable(FORM), /name="shopId"[\s\S]{0,120}?required/);
  });
});

describe("2. the multi-shop helper text explains the ORDER, not just the rule", () => {
  test("it names the shop, the sale, and the document that comes after", () => {
    assert.match(
      code(FORM_COPY),
      /RECEIPT_SHOP_CHOICE_HINT =\s*\n?\s*"Select the shop where this sale happened before adding the invoice \/ receipt\.";/,
    );
  });

  test("the form renders it, and ties it to the control with aria-describedby", () => {
    const form = executable(FORM);
    assert.ok(form.includes("RECEIPT_SHOP_CHOICE_HINT"));
    assert.match(form, /aria-describedby=\{[\s\S]*?"shopId-hint"/);
    assert.match(form, /id="shopId-hint"/);
  });

  test("the locked-picker sentence states the same order in the same words", () => {
    assert.match(
      code(FORM_COPY),
      /RECEIPT_SHOP_FIRST_MESSAGE =\s*\n?\s*"Select the shop above first, then add the invoice \/ receipt\.";/,
    );
    assert.ok(executable(FORM).includes("RECEIPT_SHOP_FIRST_MESSAGE"));
  });
});

/* ===========================================================================
 * 3-4. THE GATE AND THE ONE-SHOP CASE ARE UNCHANGED BY THE COPY EDIT
 * ========================================================================= */

describe("3. the picker is still unavailable before a shop is chosen", () => {
  const form = executable(FORM);

  test("the file input is still disabled from the shared gate", () => {
    assert.match(form, /const fileDisabled = !gate\.fileSelectionEnabled;/);
    assert.match(form, /disabled=\{fileDisabled\}/);
  });

  test("the locked panel still replaces the drop target, and offers nothing to click", () => {
    assert.match(form, /const pickerLocked = fileDisabled && !pending;/);
    assert.match(form, /\) : pickerLocked \? \(/);
  });

  test("Submit is still gated on the same single flag", () => {
    assert.match(form, /disabled=\{!gate\.submitEnabled\}/);
  });

  test("a drop still cannot bypass the gate", () => {
    assert.match(form, /if \(input === null \|\| file === null \|\| fileDisabled\) return;/);
  });
});

describe("4. one shop is never presented as a question", () => {
  const form = executable(FORM);

  test("the required selector belongs to the multi-shop branch alone", () => {
    // The `required requiredNote emphasis` label sits inside `gate.showShopSelector`,
    // which is true for `choose` and for nothing else.
    assert.match(
      form,
      /gate\.showShopSelector && \([\s\S]*?<Label htmlFor="shopId" required requiredNote emphasis>/,
    );
    assert.equal(receiptShopMode(1), "fixed");
    assert.equal(receiptShopMode(3), "choose");
  });

  test("the fixed branch shows read-only context and no required marker", () => {
    const fixed = /gate\.showFixedShopNotice && \(([\s\S]*?)\n      \)\}/.exec(form);
    assert.ok(fixed !== null, "the fixed-shop branch could not be read");
    assert.ok(
      !/<Label/.test(fixed[1]),
      "the one-shop branch renders a form label, implying a question",
    );
    assert.ok(!/requiredNote|required /.test(fixed[1]), "the one-shop branch marks a requirement");
    assert.ok(fixed[1].includes("receiptFixedShopNotice"), "the context line is gone");
    assert.match(fixed[1], /<input type="hidden" name="shopId"/);
  });

  test("the read-only notice is unchanged, and asks for nothing", () => {
    // Still `Submitting for: <shop>` — a statement, with no verb asking for an action.
    assert.match(code(FORM_COPY), /return `Submitting for: \$\{shopLabel\}`;/);
  });

  test("the zero-shop block is preserved word for word", () => {
    assert.match(
      code(FORM_COPY),
      /RECEIPT_NO_ACTIVE_SHOP_MESSAGE = "You are not assigned to an active shop\.";/,
    );
    assert.ok(executable(PAGE).includes("RECEIPT_NO_ACTIVE_SHOP_MESSAGE"));
  });
});

/* ===========================================================================
 * 5. THE USER-FACING NAME FOR THE DOCUMENT
 * ========================================================================= */

describe("5. the upload copy names an invoice as well as a receipt", () => {
  test("the page, the form and the strip all say invoice / receipt", () => {
    for (const [file, expected] of [
      [PAGE, "Add an invoice / receipt"],
      [PAGE, "Submit an invoice / receipt"],
      [FORM, "Invoice / receipt image"],
      [FORM, "Add the invoice / receipt"],
      [FORM, "Submit invoice / receipt"],
      [STEPS, "Add the invoice / receipt"],
      [PANEL, "Invoice / receipt no."],
      [SUBMIT_ACTION, "Invoice / receipt submitted from"],
    ] as const) {
      assert.ok(code(file).includes(expected), `${file} is missing: ${expected}`);
    }
  });

  test("the format guidance still states the rule, and says what it is about", () => {
    const form = executable(FORM);
    assert.match(form, /One JPEG, PNG or WebP image of the invoice \/ receipt, up to \{maxMegabytes\} MB/);
    const copy = code(FORM_COPY);
    assert.match(copy, /"unsupported-type": "An invoice \/ receipt must be a JPEG, PNG or WebP image\."/);
    assert.match(copy, /"too-large": `That file is too large\. An invoice \/ receipt must be \$\{MAX_RECEIPT_FILE_MEGABYTES\} MB or smaller\.`/);
  });

  test("the OCR headings name both documents", () => {
    const copy = code(PANEL_COPY);
    assert.match(copy, /EXTRACTION_ITEMS_TITLE = "Items read from this invoice \/ receipt";/);
    assert.match(copy, /EXTRACTION_SUCCEEDED_TITLE = "We read your invoice \/ receipt";/);
    assert.match(copy, /EXTRACTION_FAILED_TITLE = "We couldn't read this invoice \/ receipt";/);
  });

  test("NO user-facing sentence still calls the document a bare 'receipt'", () => {
    // The sweep that gives this milestone its value. "invoice / receipt", "invoice or
    // receipt" and the plural "invoices and receipts" are the accepted forms; a lone
    // "receipt" would be a sentence the terminology change missed.
    for (const [name, sentence] of Object.entries(USER_FACING_COPY)) {
      const remaining = sentence
        .replace(/invoice \/ receipts?/gi, "")
        .replace(/invoice or receipts?/gi, "")
        .replace(/invoices and receipts?/gi, "");
      assert.ok(
        !/receipt/i.test(remaining),
        `${name} still calls the document a bare receipt: ${sentence}`,
      );
    }
  });

  test("every sentence stays a sentence — no placeholder or double space survived", () => {
    for (const [name, sentence] of Object.entries(USER_FACING_COPY)) {
      assert.ok(sentence.trim().length > 0, `${name} is empty`);
      assert.ok(!/ {2}/.test(sentence), `${name} has a double space: ${sentence}`);
      assert.ok(!/\/ {2}|\/$/.test(sentence), `${name} has a dangling slash: ${sentence}`);
    }
  });
});

/* ===========================================================================
 * 6. THE INTERNAL VOCABULARY IS UNTOUCHED
 * ========================================================================= */

describe("6. no internal receipt_* identifier was renamed", () => {
  test("the form field, the route and the state type are unchanged", () => {
    const form = code(FORM);
    assert.ok(form.includes('name="receipt"'), "the file field was renamed");
    assert.ok(form.includes('name="shopId"'), "the shop field was renamed");
    assert.ok(form.includes("SubmitReceiptState"), "the state type was renamed");
    assert.match(code(SUBMIT_ACTION), /const RECEIPTS_PATH = "\/retailer\/receipts";/);
  });

  test("the Server Action and the copy constants keep their RECEIPT_ names", () => {
    for (const name of [
      "RECEIPT_GENERIC_ERROR",
      "RECEIPT_UPLOAD_FAILED_ERROR",
      "RECEIPT_DUPLICATE_ERROR",
      "RECEIPT_TRANSPORT_ERROR",
      "RECEIPT_FILE_MESSAGES",
      "RECEIPT_SHOP_CHOICE_HINT",
      "RECEIPT_SHOP_FIRST_MESSAGE",
      "RECEIPT_NO_ACTIVE_SHOP_MESSAGE",
    ]) {
      assert.ok(
        new RegExp(`export const ${name}\\b`).test(code(FORM_COPY)),
        `${name} was renamed`,
      );
    }
    assert.ok(code(SUBMIT_ACTION).includes("submitReceiptAction"));
  });

  test("every RPC, function and table name the web speaks is still receipt_*", () => {
    const NAMES = [
      ["lib/receipts/receipt-data.ts", '"list_my_assigned_receipt_shops"'],
      ["lib/receipts/receipt-data.ts", '"list_my_receipt_submissions"'],
      ["lib/receipts/receipt-extraction-line-items.ts", '"list_my_receipt_extraction_line_items"'],
      ["lib/receipts/receipt-extraction-poll-request.ts", '"get-receipt-extraction"'],
      ["lib/receipts/receipt-extraction-request.ts", '"request-receipt-extraction"'],
      ["lib/receipts/receipt-submissions.ts", '"reserve_receipt_submission"'],
      ["lib/receipts/receipt-submissions.ts", '"finalize_receipt_submission_upload"'],
    ] as const;
    for (const [file, name] of NAMES) {
      assert.ok(code(file).includes(name), `${file} no longer names ${name}`);
    }
  });

  test("the extraction vocabulary module is untouched by the copy change", () => {
    const vocabulary = code("lib/receipts/receipt-extraction-vocabulary.ts");
    // The internal failure code is still IMAGE_NOT_A_RECEIPT even though its SENTENCE now
    // says "invoice or receipt": the code is a contract with PostgreSQL, the sentence is not.
    assert.ok(vocabulary.includes("IMAGE_NOT_A_RECEIPT"));
    assert.match(code(PANEL_COPY), /IMAGE_NOT_A_RECEIPT:\s*\n?\s*"That image didn't look like an invoice or receipt/);
    assert.match(
      code(PANEL_COPY),
      /satisfies Record<ClientExtractionFailureCode, string>/,
    );
  });

  test("no migration, pgTAP suite or Edge Function was renamed or edited", () => {
    // The names are read off the FILESYSTEM, so a rename fails this test even if every
    // reference to it were updated in step.
    const migrations = readdirSync(join(ROOT, "supabase/migrations"));
    for (const expected of [
      "20260726090000_receipt_submission_storage_foundation.sql",
      "20260726210000_receipt_submission_operations.sql",
      "20260812210000_receipt_extraction_foundation.sql",
      "20260813210000_receipt_extraction_client_operations.sql",
    ]) {
      assert.ok(migrations.includes(expected), `migration ${expected} is missing`);
    }

    const functions = readdirSync(join(ROOT, "supabase/functions"));
    for (const expected of [
      "get-receipt-extraction",
      "request-receipt-extraction",
      "submit-receipt",
    ]) {
      assert.ok(functions.includes(expected), `Edge Function ${expected} is missing`);
    }

    const suites = readdirSync(join(ROOT, "supabase/tests/database"));
    for (const expected of [
      "receipt_extraction_test.sql",
      "sales_staff_receipt_reads_test.sql",
      "sales_staff_receipt_shop_authorization_test.sql",
      "sales_staff_receipt_line_item_reads_test.sql",
    ]) {
      assert.ok(suites.includes(expected), `pgTAP suite ${expected} is missing`);
    }
  });

  test("the user-facing phrase never reached the backend", () => {
    // THE GUARD AGAINST THE FIND-AND-REPLACE THIS MILESTONE MUST NOT BECOME.
    //
    // "invoice / receipt" is a SENTENCE fragment, written for a person. It has no business
    // in a migration, an Edge Function or a pgTAP suite, so its total absence there is a
    // cheap, exact proof that the terminology change stopped at the copy layer.
    //
    // Note what this does NOT assert: that the word "invoice" is absent from the backend. It
    // is not, and never was — `prebuilt-invoice` is the name of an Azure model, and two
    // migrations discuss an invoice number in their comments. Asserting the absence of the
    // word would have been a rule that was false before this change and would have said
    // nothing about it.
    for (const dir of ["supabase/migrations", "supabase/functions", "supabase/tests/database"]) {
      for (const file of walk(join(ROOT, dir))) {
        const source = readFileSync(file, "utf8");
        assert.ok(
          !/invoice\s*\/\s*receipt/i.test(source),
          `${file} carries user-facing copy — the backend must be untouched`,
        );
      }
    }
  });

  test("no invoice-named identifier was introduced anywhere", () => {
    // A column, parameter, table, function or index called `invoice…` would be a schema
    // change. The pre-existing mentions are a quoted Azure model literal and prose, neither
    // of which matches these shapes.
    const IDENTIFIER_SHAPES = [
      /\binvoice_[a-z_]+/i,
      /\bp_invoice/i,
      /create\s+(?:or\s+replace\s+)?(?:table|function|index|view|type)[^;]{0,80}invoice/i,
      /\binvoices\b\s*\(/i,
    ];
    for (const dir of ["supabase/migrations", "supabase/functions", "supabase/tests/database", "lib", "app"]) {
      for (const file of walk(join(ROOT, dir))) {
        if (!/\.(sql|ts|tsx)$/.test(file) || file.endsWith(".test.ts")) continue;
        const source = readFileSync(file, "utf8");
        for (const shape of IDENTIFIER_SHAPES) {
          assert.ok(!shape.test(source), `${file} introduces an invoice-named identifier`);
        }
      }
    }
  });
});

/* ===========================================================================
 * 7. NO BEHAVIOUR CHANGED
 * ========================================================================= */

describe("7. the change is copy and presentation only", () => {
  test("the shop gate module is pure copy-free logic and still decides the same three modes", () => {
    const gate = code("lib/receipts/receipt-shop-selection.ts");
    assert.ok(!/invoice/i.test(gate), "a rule module gained user-facing copy");
    assert.equal(receiptShopMode(0), "unassigned");
    assert.equal(receiptShopMode(1), "fixed");
    assert.equal(receiptShopMode(2), "choose");
  });

  test("no authorization, RPC or extraction logic appears in the changed copy modules", () => {
    for (const file of [
      "app/(retailer)/retailer/receipts/submit-receipt-state.ts",
      "app/(retailer)/retailer/receipts/extraction-panel-state.ts",
      STEPS,
      FIELD,
    ]) {
      const source = executable(file);
      assert.ok(!/\.from\(|\.rpc\(|createClient|createAdminClient/.test(source), `${file} gained I/O`);
    }
  });

  test("the line-item list is still read-only", () => {
    const items = executable(ITEMS);
    for (const control of ["<input", "<select", "<textarea", "<button", "<form"]) {
      assert.ok(!items.includes(control), `the list renders ${control}`);
    }
    assert.ok(!/onChange|onInput|onSubmit|onClick/.test(items));
  });

  test("the file input still accepts exactly the three supported image types", () => {
    assert.match(
      executable(FORM),
      /accept=\{SUPPORTED_RECEIPT_MIME_TYPES\.join\(","\)\}/,
    );
  });
});

/** Every file under a directory, recursively. Used to prove an absence. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
