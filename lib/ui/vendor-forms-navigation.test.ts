/**
 * SOURCE-LEVEL guards for the Vendor forms & Retailer-list navigation polish.
 *
 * Run with:  npm test
 *
 * These pin the corrections that had to PRESERVE behaviour — same fields, same
 * Server Actions, no leaked secrets — and the structural fix that makes two-column
 * fields align (hint/error rendered BELOW the input). No Tailwind class is
 * asserted; every check is on a stable identifier, a field name, an action import,
 * or DOM source order.
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

const FIELD = "components/ui/field.tsx";
const RETAILER_FORM = "app/(admin)/retailers/new/retailer-form.tsx";
const SHOP_FORM = "app/(admin)/retailers/[relationshipId]/shops/new/shop-form.tsx";
const INVITE_OWNER_FORM =
  "app/(admin)/retailers/[relationshipId]/owner/invite/invite-owner-form.tsx";
const INVITE_OWNER_PAGE =
  "app/(admin)/retailers/[relationshipId]/owner/invite/page.tsx";
const RETAILERS_PAGE = "app/(admin)/retailers/page.tsx";

describe("shared TextField renders hint/error below the input", () => {
  const field = read(FIELD);
  // Isolate the TextField component body.
  const start = field.indexOf("export function TextField");
  const body = field.slice(start);

  test("1. label precedes the input, and the message follows it", () => {
    const labelIdx = body.indexOf("<Label");
    const inputIdx = body.indexOf("<input");
    const errorIdx = body.indexOf("<FieldError");
    const hintIdx = body.indexOf("<FieldHint");
    assert.ok(labelIdx >= 0 && inputIdx > labelIdx, "input must follow the label");
    assert.ok(errorIdx > inputIdx, "the error must render below the input");
    assert.ok(hintIdx > inputIdx, "the hint must render below the input");
  });

  test("2. the aligned field is adopted by every two-column form", () => {
    for (const path of [RETAILER_FORM, SHOP_FORM, INVITE_OWNER_FORM]) {
      assert.ok(
        read(path).includes('from "@/components/ui/field"') &&
          read(path).includes("TextField"),
        `${path} does not use the shared TextField`,
      );
    }
  });
});

describe("Add Retailer form is unchanged in contract", () => {
  const form = read(RETAILER_FORM);

  test("3. retains every field", () => {
    for (const f of ["retailerName", "countryCode", "defaultCurrency", "shopName", "shopCode", "shopCity"]) {
      assert.ok(form.includes(`field="${f}"`), `Add Retailer lost the "${f}" field`);
    }
  });

  test("4. still submits to the same Server Action", () => {
    assert.ok(form.includes("onboardRetailer"), "onboardRetailer disconnected");
    assert.ok(form.includes("action={formAction}"), "form no longer posts to the action");
  });
});

describe("Add Shop form is unchanged in contract", () => {
  const form = read(SHOP_FORM);

  test("5. retains every field and the hidden routing address only", () => {
    for (const f of ["shopName", "shopCode", "shopCity", "countryCode"]) {
      assert.ok(form.includes(`field="${f}"`), `Add Shop lost the "${f}" field`);
    }
    assert.ok(form.includes('name="relationshipId"'), "the routing field was lost");
  });

  test("6. still submits to the same Server Action with a submit control", () => {
    assert.ok(form.includes("addVendorRetailerShop"), "addVendorRetailerShop disconnected");
    assert.ok(form.includes("Add Shop"), "the submit label was lost");
  });

  test("7. shows the accurate staff-assignment info panel", () => {
    assert.ok(
      form.includes("Staff can later be assigned to this shop"),
      "the info panel text was removed",
    );
  });
});

describe("Retailer list makes opening a Retailer obvious", () => {
  const page = read(RETAILERS_PAGE);

  test("8. renders a visible View details action", () => {
    assert.ok(page.includes("View details"), "the desktop View details action is missing");
    assert.ok(page.includes("ViewDetailsLink"), "the view-details component is missing");
  });

  test("9. the action targets the existing Retailer detail route", () => {
    assert.ok(
      page.includes("href={`/retailers/${relationshipId}`}") ||
        page.includes("href={`/retailers/${retailer.relationshipId}`}"),
      "the view-details link does not point at the detail route",
    );
  });

  test("10. mobile cards carry a visible View Retailer action plus status and shops", () => {
    assert.ok(page.includes("View Retailer"), "the mobile card action is missing");
    assert.ok(page.includes("StatusBadge"), "status badges were removed from the list");
    assert.ok(page.includes("ShopCount"), "the shop count was removed from the list");
  });

  test("11. has a proper empty state that invites adding the first Retailer", () => {
    assert.ok(page.includes("No Retailers yet"), "the empty-state title changed");
    assert.ok(
      page.includes("Add your first Retailer to begin managing"),
      "the empty-state body was not updated",
    );
  });
});

describe("Invite Retailer Owner keeps its fields, action and secrecy", () => {
  const form = read(INVITE_OWNER_FORM);
  const page = read(INVITE_OWNER_PAGE);

  test("12. retains first name, last name and email", () => {
    for (const f of ["firstName", "lastName", "email"]) {
      assert.ok(form.includes(`name="${f}"`), `the "${f}" field was lost`);
    }
  });

  test("13. still submits to the same Server Action", () => {
    assert.ok(
      form.includes("inviteRetailerOwnerAction"),
      "inviteRetailerOwnerAction disconnected",
    );
  });

  test("14. carries no token, hash, or secret into the client — only the routing id", () => {
    for (const bad of ['name="token"', 'name="tokenHash"', 'name="hash"']) {
      assert.ok(!form.includes(bad), `a sensitive field appeared: ${bad}`);
    }
    assert.ok(form.includes('name="relationshipId"'), "the routing field was lost");
  });

  test("15. shows the static Retailer Owner access context and security note", () => {
    assert.ok(page.includes("Retailer Owner access"), "the supporting card title is missing");
    assert.ok(
      page.includes("can only be completed by the invited email address"),
      "the security note is missing",
    );
  });
});
