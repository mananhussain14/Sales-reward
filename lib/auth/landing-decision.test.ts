/**
 * Unit tests for the pure authenticated-landing precedence logic.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added — matching
 * lib/retailer-portal/portal-normalization.test.ts. The `.ts` extension on the
 * import is required by Node's ESM resolver and permitted by
 * allowImportingTsExtensions (tsconfig has noEmit).
 *
 * Only the PURE selectLanding is tested. resolveAuthenticatedLanding cannot be
 * unit-tested here: it imports the two access resolvers, which pull in
 * `next/headers` and throw outside a request. Its ORDERING behaviour is the same
 * behaviour selectLanding encodes and these tests pin.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  selectLanding,
  LANDING_ROUTES,
  type LandingDecision,
} from "./landing-decision.ts";

/** The complete set of routes the decision may ever emit. */
const ALLOWED_DESTINATIONS = new Set<string>([
  LANDING_ROUTES.vendor,
  LANDING_ROUTES.retailer,
  LANDING_ROUTES.accessDenied,
  LANDING_ROUTES.login,
]);

/** Reads a decision's destination if it has one (unavailable has none). */
function destinationOf(decision: LandingDecision): string | undefined {
  return "destination" in decision ? decision.destination : undefined;
}

describe("selectLanding — Vendor-first precedence", () => {
  test("1. Vendor authorized + Retailer authorized -> Vendor landing", () => {
    const d = selectLanding("authorized", "authorized");
    assert.equal(d.kind, "vendor");
    assert.equal(destinationOf(d), "/");
  });

  test("2. Vendor authorized + Retailer unauthorized -> Vendor landing", () => {
    const d = selectLanding("authorized", "unauthorized");
    assert.equal(d.kind, "vendor");
    assert.equal(destinationOf(d), "/");
  });

  test("Vendor authorized wins regardless of any Retailer status", () => {
    for (const r of ["authorized", "unauthenticated", "unauthorized", "unavailable"] as const) {
      const d = selectLanding("authorized", r);
      assert.equal(d.kind, "vendor", `retailer=${r} should not change a Vendor landing`);
    }
  });
});

describe("selectLanding — Retailer Owner only", () => {
  test("3. Vendor unauthorized + Retailer authorized -> /retailer", () => {
    const d = selectLanding("unauthorized", "authorized");
    assert.equal(d.kind, "retailer");
    assert.equal(destinationOf(d), "/retailer");
  });
});

describe("selectLanding — denial and unauthenticated", () => {
  test("4. Both unauthorized (authenticated) -> generic /access-denied", () => {
    const d = selectLanding("unauthorized", "unauthorized");
    assert.equal(d.kind, "unauthorized");
    assert.equal(destinationOf(d), "/access-denied");
    // Explicitly NOT the retailer-specific denial route.
    assert.notEqual(destinationOf(d), "/retailer-access-denied");
  });

  test("5. Vendor unauthenticated -> /login (Retailer not consulted)", () => {
    const d = selectLanding("unauthenticated", "unauthorized");
    assert.equal(d.kind, "unauthenticated");
    assert.equal(destinationOf(d), "/login");
  });

  test("defensive: Vendor unauthorized + Retailer unauthenticated -> /login", () => {
    const d = selectLanding("unauthorized", "unauthenticated");
    assert.equal(d.kind, "unauthenticated");
    assert.equal(destinationOf(d), "/login");
  });
});

describe("selectLanding — operational unavailable, never a denial", () => {
  test("7. Vendor unauthorized + Retailer unavailable -> unavailable (no destination)", () => {
    const d = selectLanding("unauthorized", "unavailable");
    assert.equal(d.kind, "unavailable");
    assert.equal(destinationOf(d), undefined);
  });

  test("6. Vendor has no 'unavailable' status by design — a Vendor operational failure surfaces as 'unauthorized' and falls through", () => {
    // The Vendor resolver collapses DB/RPC/transport failures to "unauthorized"
    // (fail-closed), so there is no vendor-unavailable input to model. The type
    // enforces this: VendorAccessStatus has three members, none "unavailable".
    // A Vendor failure therefore behaves exactly like "not a Vendor" and defers
    // to the Retailer resolver, whose "unavailable" IS surfaced (test 7). This
    // documents the justified "safely continues" behaviour the design allows.
    const asIfVendorFailed = selectLanding("unauthorized", "authorized");
    assert.equal(asIfVendorFailed.kind, "retailer");

    const asIfVendorFailedRetailerAlsoDown = selectLanding("unauthorized", "unavailable");
    assert.equal(asIfVendorFailedRetailerAlsoDown.kind, "unavailable");
  });
});

describe("selectLanding — no open redirect", () => {
  test("8. every possible input pair yields a destination from the fixed allow-set (or none)", () => {
    const vendorStatuses = ["authorized", "unauthenticated", "unauthorized"] as const;
    const retailerStatuses = ["authorized", "unauthenticated", "unauthorized", "unavailable"] as const;

    for (const v of vendorStatuses) {
      for (const r of retailerStatuses) {
        const d = selectLanding(v, r);
        const dest = destinationOf(d);
        if (d.kind === "unavailable") {
          assert.equal(dest, undefined, `unavailable must carry no destination (v=${v}, r=${r})`);
        } else {
          assert.ok(
            dest !== undefined && ALLOWED_DESTINATIONS.has(dest),
            `destination "${dest}" for (v=${v}, r=${r}) is not in the fixed allow-set`,
          );
        }
      }
    }
  });

  test("selectLanding accepts only status discriminants — no destination is an input", () => {
    // The signature takes two strings; there is no parameter through which a
    // caller could inject a target. This is a compile-time guarantee, restated
    // here as an executable reminder that the routes come only from LANDING_ROUTES.
    assert.deepEqual(
      [...ALLOWED_DESTINATIONS].sort(),
      ["/", "/access-denied", "/login", "/retailer"],
    );
  });
});

describe("invitation completion destination", () => {
  test("9. completion redirects to the shared retailer route constant, which is /retailer", () => {
    // app/invitations/complete/actions.ts redirects to LANDING_ROUTES.retailer,
    // the same constant selectLanding uses for an authorized owner. Pinning the
    // constant pins both call sites at once.
    assert.equal(LANDING_ROUTES.retailer, "/retailer");
    assert.equal(selectLanding("unauthorized", "authorized").kind, "retailer");
    assert.equal(
      destinationOf(selectLanding("unauthorized", "authorized")),
      LANDING_ROUTES.retailer,
    );
  });
});
