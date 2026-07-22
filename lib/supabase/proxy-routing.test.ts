/**
 * Unit tests for the pure Proxy request-routing decision.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added — matching
 * lib/auth/landing-decision.test.ts and lib/retailer-portal/portal-normalization.test.ts.
 * The `.ts` extension on the import is required by Node's ESM resolver and
 * permitted by allowImportingTsExtensions (tsconfig has noEmit).
 *
 * Only the PURE decideProxyRoute is tested. The updateSession wiring in ./proxy.ts
 * cannot be unit-tested here: it imports @supabase/ssr and next/server and needs a
 * request context. Its routing behaviour is exactly what decideProxyRoute encodes,
 * and updateSession now delegates the entire decision to it, so these tests pin the
 * real policy.
 *
 * These tests are the regression guard for the login Server Action / proxy
 * redirect conflict: a `POST /login` (or any Server Action) must NEVER be turned
 * into a page redirect, because NextResponse.redirect() is a method-preserving 307
 * and would re-issue the login submission against "/".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decideProxyRoute,
  LOGIN_PATH,
  AUTHENTICATED_HOME,
  PUBLIC_PATHS,
  type ProxyRouteInput,
  type ProxyRouteDecision,
} from "./proxy-routing.ts";

/** The only destinations the decision may ever emit for a redirect. */
const ALLOWED_DESTINATIONS = new Set<string>([LOGIN_PATH, AUTHENTICATED_HOME]);

/** Builds an input with sensible defaults, overridable per case. */
function input(overrides: Partial<ProxyRouteInput> = {}): ProxyRouteInput {
  return {
    method: "GET",
    pathname: "/",
    hasVerifiedClaims: false,
    isServerAction: false,
    ...overrides,
  };
}

/** Reads a decision's destination if it has one (continue has none). */
function destinationOf(decision: ProxyRouteDecision): string | undefined {
  return decision.kind === "redirect" ? decision.destination : undefined;
}

describe("decideProxyRoute — authenticated visitor on /login (navigation)", () => {
  test("1. GET /login while authenticated uses the navigation redirect to /", () => {
    const d = decideProxyRoute(
      input({ method: "GET", pathname: LOGIN_PATH, hasVerifiedClaims: true }),
    );
    assert.equal(d.kind, "redirect");
    assert.equal(destinationOf(d), AUTHENTICATED_HOME);
  });

  test("2. HEAD /login while authenticated uses the navigation redirect to /", () => {
    const d = decideProxyRoute(
      input({ method: "HEAD", pathname: LOGIN_PATH, hasVerifiedClaims: true }),
    );
    assert.equal(d.kind, "redirect");
    assert.equal(destinationOf(d), AUTHENTICATED_HOME);
  });
});

describe("decideProxyRoute — Server Action POSTs are never page-redirected", () => {
  test("3. POST /login while authenticated is NOT redirected (continues to the action)", () => {
    // The exact bug: a 307 here would method-preserve POST /login onto POST /.
    const d = decideProxyRoute(
      input({ method: "POST", pathname: LOGIN_PATH, hasVerifiedClaims: true }),
    );
    assert.equal(d.kind, "continue");
    assert.equal(destinationOf(d), undefined);
  });

  test("3b. POST /login while authenticated with the next-action header still continues", () => {
    const d = decideProxyRoute(
      input({
        method: "POST",
        pathname: LOGIN_PATH,
        hasVerifiedClaims: true,
        isServerAction: true,
      }),
    );
    assert.equal(d.kind, "continue");
  });

  test("4. A Server Action POST is never redirected to / — verified across paths", () => {
    // Whatever page the action posts to, and whether or not the header is present,
    // an authenticated Server Action POST must reach its endpoint, never a redirect.
    for (const pathname of ["/", "/login", "/retailer", "/retailers"]) {
      for (const isServerAction of [true, false]) {
        const d = decideProxyRoute(
          input({ method: "POST", pathname, hasVerifiedClaims: true, isServerAction }),
        );
        assert.equal(
          d.kind,
          "continue",
          `POST ${pathname} (isServerAction=${isServerAction}) must continue, never redirect`,
        );
      }
    }
  });

  test("4b. A signed-out Server Action POST to a protected route also continues (action fails closed downstream)", () => {
    // The proxy does not redirect it; the action re-authorizes itself and redirects
    // to /login on its own. Letting it through grants nothing.
    const d = decideProxyRoute(
      input({ method: "POST", pathname: "/retailers", hasVerifiedClaims: false }),
    );
    assert.equal(d.kind, "continue");
  });
});

describe("decideProxyRoute — signed-out navigation to protected routes", () => {
  test("5. signed-out GET /retailer redirects to /login", () => {
    const d = decideProxyRoute(
      input({ method: "GET", pathname: "/retailer", hasVerifiedClaims: false }),
    );
    assert.equal(d.kind, "redirect");
    assert.equal(destinationOf(d), LOGIN_PATH);
  });

  test("5b. signed-out GET /retailer/shops redirects to /login", () => {
    const d = decideProxyRoute(
      input({ method: "GET", pathname: "/retailer/shops", hasVerifiedClaims: false }),
    );
    assert.equal(d.kind, "redirect");
    assert.equal(destinationOf(d), LOGIN_PATH);
  });

  test("5c. signed-out GET a protected Vendor route redirects to /login", () => {
    const d = decideProxyRoute(
      input({ method: "GET", pathname: "/retailers", hasVerifiedClaims: false }),
    );
    assert.equal(d.kind, "redirect");
    assert.equal(destinationOf(d), LOGIN_PATH);
  });

  test("5d. signed-out GET each public path is allowed to render (no redirect)", () => {
    for (const pathname of PUBLIC_PATHS) {
      const d = decideProxyRoute(
        input({ method: "GET", pathname, hasVerifiedClaims: false }),
      );
      assert.equal(d.kind, "continue", `${pathname} must render without a session`);
    }
  });
});

describe("decideProxyRoute — existing-user invitation public routes", () => {
  const ENTER = "/invitations/existing/enter";
  const CLEAN = "/invitations/existing";

  test("E1. both new paths are in the public allow-set", () => {
    assert.ok(PUBLIC_PATHS.has(ENTER), `${ENTER} must be public`);
    assert.ok(PUBLIC_PATHS.has(CLEAN), `${CLEAN} must be public`);
  });

  test("E2. signed-out GET the intake route continues (it sets the cookie, no session)", () => {
    const d = decideProxyRoute(input({ method: "GET", pathname: ENTER, hasVerifiedClaims: false }));
    assert.equal(d.kind, "continue");
    assert.equal(destinationOf(d), undefined);
  });

  test("E3. signed-out GET the clean acceptance page continues (so it can render the sign-in prompt)", () => {
    // The whole point: a signed-out visitor must REACH the page — being 307'd to
    // /login here would drop the page's ability to preserve next=/invitations/existing.
    const d = decideProxyRoute(input({ method: "GET", pathname: CLEAN, hasVerifiedClaims: false }));
    assert.equal(d.kind, "continue");
    assert.equal(destinationOf(d), undefined);
  });

  test("E4. signed-out HEAD both routes continues", () => {
    for (const pathname of [ENTER, CLEAN]) {
      assert.equal(
        decideProxyRoute(input({ method: "HEAD", pathname, hasVerifiedClaims: false })).kind,
        "continue",
      );
    }
  });

  test("E5. authenticated GET both routes continues (the page/route handles account state)", () => {
    for (const pathname of [ENTER, CLEAN]) {
      assert.equal(
        decideProxyRoute(input({ method: "GET", pathname, hasVerifiedClaims: true })).kind,
        "continue",
      );
    }
  });

  test("E6. a signed-out Server Action POST to the acceptance page continues (action fails closed downstream)", () => {
    for (const isServerAction of [true, false]) {
      assert.equal(
        decideProxyRoute(input({ method: "POST", pathname: CLEAN, hasVerifiedClaims: false, isServerAction })).kind,
        "continue",
      );
    }
  });

  test("E7. EXACT match only — an unlisted sibling path is NOT public (still protected)", () => {
    // Guards against ever loosening PUBLIC_PATHS into a prefix rule that would open
    // sibling routes nobody reviewed.
    for (const pathname of ["/invitations/existing/other", "/invitations/existingx", "/invitations"]) {
      const d = decideProxyRoute(input({ method: "GET", pathname, hasVerifiedClaims: false }));
      assert.equal(d.kind, "redirect", `${pathname} must not be public`);
      assert.equal(destinationOf(d), LOGIN_PATH);
    }
  });
});

describe("decideProxyRoute — authenticated navigation to protected routes continues", () => {
  test("6. authenticated GET /retailer continues normally", () => {
    const d = decideProxyRoute(
      input({ method: "GET", pathname: "/retailer", hasVerifiedClaims: true }),
    );
    assert.equal(d.kind, "continue");
  });

  test("6b. authenticated GET / and other protected routes continue normally", () => {
    for (const pathname of ["/", "/retailers", "/retailer/shops", "/access-denied"]) {
      const d = decideProxyRoute(
        input({ method: "GET", pathname, hasVerifiedClaims: true }),
      );
      assert.equal(d.kind, "continue", `authenticated GET ${pathname} must continue`);
    }
  });
});

describe("decideProxyRoute — no arbitrary redirect destination", () => {
  test("7. every redirect destination comes from the fixed two-entry allow-set", () => {
    const methods = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"];
    const paths = [
      "/",
      "/login",
      "/retailer",
      "/retailer/shops",
      "/retailers",
      "/access-denied",
      "/retailer-access-denied",
      "/invitations/accept",
      "/invitations/error",
      "/anything/else",
      "//evil.example.com",
      "https://evil.example.com",
    ];

    for (const method of methods) {
      for (const pathname of paths) {
        for (const hasVerifiedClaims of [true, false]) {
          for (const isServerAction of [true, false]) {
            const d = decideProxyRoute(
              input({ method, pathname, hasVerifiedClaims, isServerAction }),
            );
            if (d.kind === "redirect") {
              assert.ok(
                ALLOWED_DESTINATIONS.has(d.destination),
                `redirect destination "${d.destination}" is not in the fixed allow-set`,
              );
            }
          }
        }
      }
    }
  });

  test("7b. decideProxyRoute accepts no destination input — the routes are fixed literals", () => {
    // There is no field on ProxyRouteInput through which a caller could inject a
    // target; the allow-set is exactly these two internal literals.
    assert.deepEqual([...ALLOWED_DESTINATIONS].sort(), ["/", "/login"]);
    // A pathname that looks like an external URL is treated as an ordinary path:
    // it is not public and not /login, so an unauthenticated GET is sent to /login,
    // never "to" the attacker string.
    const d = decideProxyRoute(
      input({ method: "GET", pathname: "https://evil.example.com", hasVerifiedClaims: false }),
    );
    assert.equal(destinationOf(d), LOGIN_PATH);
  });
});
