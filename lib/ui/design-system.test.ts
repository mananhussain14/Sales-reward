/**
 * SOURCE-LEVEL GUARDS for the modern UI redesign's shared design system.
 *
 * Run with:  npm test
 *
 * These pin a handful of cross-cutting UI invariants that the redesign introduced
 * and that a careless later edit could quietly break — WITHOUT asserting Tailwind
 * classes, which are presentation and expected to change. Every check is on a
 * stable identifier: a form field name, an accessible-name mechanism, an aria
 * attribute, or a mapped label. Runtime rendering is out of scope for this
 * node:test suite, so — like the rest of the repo's UI guards — they read source.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("shared status pill", () => {
  const badge = stripComments(read("components/ui/badge.tsx"));

  test("maps known backend statuses to visible human labels", () => {
    // A representative spread across the lifecycle + invitation + receipt states.
    for (const label of [
      "Active",
      "Invited",
      "Accepted",
      "Expired",
      "Revoked",
      "Failed",
      "Processing",
      "Uploaded",
      "Approved",
      "Rejected",
    ]) {
      assert.ok(badge.includes(`"${label}"`), `status label "${label}" is missing`);
    }
  });

  test("never prints a raw enum — an unknown status falls back to visible text", () => {
    assert.ok(badge.includes("Unknown"), "the Unknown fallback was removed");
  });
});

describe("the status badge has one reusable definition", () => {
  test("the admin StatusBadge re-exports the shared ui badge", () => {
    const adminBadge = read("components/admin/status-badge.tsx");
    assert.ok(
      adminBadge.includes('from "@/components/ui/badge"'),
      "the admin status badge no longer delegates to the shared mapping",
    );
  });
});

describe("the Sales Staff receipt page keeps its upload form and shop selector", () => {
  const form = read("app/(retailer)/retailer/receipts/submit-receipt-form.tsx");

  test("the assigned-shop selector remains a named select", () => {
    assert.ok(form.includes('name="shopId"'), "the shop selector field was lost");
    assert.ok(form.includes("<select"), "the shop selector is no longer a native select");
  });

  test("the receipt file input remains a named file input", () => {
    assert.ok(form.includes('name="receipt"'), "the receipt file field was lost");
    assert.ok(form.includes('type="file"'), "the receipt input is no longer a file input");
  });

  test("the page still renders the submission form and its history section", () => {
    const page = read("app/(retailer)/retailer/receipts/page.tsx");
    assert.ok(page.includes("<SubmitReceiptForm"), "the submit form was removed");
    assert.ok(page.includes("Your submissions"), "the history section was removed");
  });
});

describe("icon-only controls carry accessible names", () => {
  test("the receipt remove control has screen-reader text", () => {
    const form = read("app/(retailer)/retailer/receipts/submit-receipt-form.tsx");
    assert.ok(
      form.includes("Remove selected file"),
      "the remove-file control lost its accessible name",
    );
  });

  test("the mobile navigation toggles keep aria-labels", () => {
    for (const shell of [
      "components/admin/admin-header.tsx",
      "components/retailer-portal/retailer-shell.tsx",
    ]) {
      const source = read(shell);
      assert.ok(
        source.includes("Open navigation menu") &&
          source.includes("Close navigation menu"),
        `${shell} lost its menu-button accessible name`,
      );
    }
  });
});

describe("shared button system exposes a visible focus ring", () => {
  test("buttonClasses defines a focus-visible ring", () => {
    const button = read("components/ui/button.tsx");
    assert.ok(
      button.includes("focus-visible:ring-2"),
      "the shared button lost its focus ring",
    );
  });

  test("form controls define a focus-visible ring", () => {
    const field = read("components/ui/field.tsx");
    assert.ok(
      field.includes("focus-visible:ring-2"),
      "the shared form control lost its focus ring",
    );
  });
});
