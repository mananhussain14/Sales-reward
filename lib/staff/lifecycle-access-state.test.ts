/**
 * Unit tests for the self-only lifecycle DIAGNOSTIC vocabulary and copy.
 *
 *   @/lib/staff/lifecycle-access-state
 *
 * Run with:  npm test
 *
 * The server wrapper that calls the RPC (./my-lifecycle-access-state.ts) cannot be
 * unit-tested here — it imports `next/headers` through the Supabase server client — which is
 * exactly why the vocabulary, the guard and the copy mapping live in a pure module. What the
 * wrapper does with them is asserted at source level in ./staff-lifecycle-contract.test.ts.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isLifecycleAccessState,
  LIFECYCLE_ACCESS_STATES,
  resolveLifecycleNotice,
  type LifecycleAccessState,
} from "./lifecycle-access-state.ts";

describe("lifecycle access state — the vocabulary", () => {
  test("11. exactly the six words the RPC declares, in contract order", () => {
    assert.deepEqual(
      [...LIFECYCLE_ACCESS_STATES],
      [
        "ACTIVE",
        "PROFILE_INACTIVE",
        "MEMBERSHIP_INACTIVE",
        "ORGANIZATION_INACTIVE",
        "NO_SUPPORTED_ACCESS",
        "AMBIGUOUS",
      ],
    );
  });

  test("11b. the guard accepts exactly those six and nothing else", () => {
    for (const state of LIFECYCLE_ACCESS_STATES) {
      assert.equal(isLifecycleAccessState(state), true);
    }
    for (const value of [
      "active",
      "Active",
      "",
      "UNKNOWN",
      // A word a FUTURE migration might add. This build must treat it as unknown rather
      // than render an unrecognized state.
      "RETAILER_SUSPENDED",
      null,
      undefined,
      7,
      {},
      ["ACTIVE"],
    ]) {
      assert.equal(
        isLifecycleAccessState(value),
        false,
        `${String(value)} must not be accepted`,
      );
    }
  });
});

describe("lifecycle access state — the copy mapping", () => {
  test("42. MEMBERSHIP_INACTIVE renders the Account inactive copy", () => {
    const notice = resolveLifecycleNotice("MEMBERSHIP_INACTIVE");
    assert.ok(notice);
    assert.equal(notice!.title, "Account inactive");
    assert.equal(
      notice!.message,
      "Your access to this Retailer is inactive. Contact your Retailer administrator.",
    );
  });

  test("43. ORGANIZATION_INACTIVE renders the Retailer inactive copy", () => {
    const notice = resolveLifecycleNotice("ORGANIZATION_INACTIVE");
    assert.ok(notice);
    assert.equal(notice!.title, "Retailer inactive");
    assert.equal(
      notice!.message,
      "This Retailer is currently inactive. Contact the Vendor or your Retailer administrator.",
    );
  });

  test("44. PROFILE_INACTIVE renders the Account unavailable copy", () => {
    const notice = resolveLifecycleNotice("PROFILE_INACTIVE");
    assert.ok(notice);
    assert.equal(notice!.title, "Account unavailable");
    assert.equal(
      notice!.message,
      "Your SalesReward account is currently inactive. Contact support or your administrator.",
    );
  });

  test("45. AMBIGUOUS renders the setup-attention copy", () => {
    const notice = resolveLifecycleNotice("AMBIGUOUS");
    assert.ok(notice);
    assert.equal(notice!.title, "Account setup needs attention");
    assert.equal(
      notice!.message,
      "More than one Retailer context is available for this account. Contact support.",
    );
  });

  test("46. ACTIVE keeps the ORDINARY access-denied experience", () => {
    // Nothing about this person's lifecycle explains the refusal, so some other condition
    // did. Saying anything specific would be a guess, and a wrong one.
    assert.equal(resolveLifecycleNotice("ACTIVE"), null);
  });

  test("47. NO_SUPPORTED_ACCESS keeps the ORDINARY access-denied experience", () => {
    // Distinct copy here would tell an unauthorized (possibly hostile) account that it
    // holds no Retailer membership at all — a fact the existing page deliberately does not
    // disclose.
    assert.equal(resolveLifecycleNotice("NO_SUPPORTED_ACCESS"), null);
  });

  test("48. an unreadable diagnostic keeps the ORDINARY access-denied experience", () => {
    // `null` is what the page passes when the RPC failed, was refused, or returned a word
    // this build does not recognize. The honest fallback is to show no more than the
    // denial already does.
    assert.equal(resolveLifecycleNotice(null), null);
  });

  test("48b. every one of the six states resolves without throwing", () => {
    for (const state of LIFECYCLE_ACCESS_STATES) {
      const notice = resolveLifecycleNotice(state);
      assert.ok(notice === null || typeof notice.title === "string");
    }
  });

  test("12. no notice leaks an identifier, personal data or backend detail", () => {
    const notices = LIFECYCLE_ACCESS_STATES.map((state) =>
      resolveLifecycleNotice(state as LifecycleAccessState),
    ).filter((notice): notice is NonNullable<typeof notice> => notice !== null);

    assert.equal(notices.length, 4, "exactly four states carry specific copy");

    for (const notice of notices) {
      const text = `${notice.title} ${notice.message}`;
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text),
        `no uuid: ${text}`,
      );
      assert.ok(!/@/.test(text), `no email address: ${text}`);
      assert.ok(
        !/\b(RETAILER_OWNER|RETAILER_MANAGER|SALES_STAFF|VENDOR_SUPER_ADMIN)\b/.test(text),
        `no role code: ${text}`,
      );
      assert.ok(
        !/\b(ACTIVE|DEACTIVATED|INVITED|SUSPENDED|PROFILE_INACTIVE|MEMBERSHIP_INACTIVE|ORGANIZATION_INACTIVE|NO_SUPPORTED_ACCESS|AMBIGUOUS)\b/.test(
          text,
        ),
        `no raw status value: ${text}`,
      );
      assert.ok(
        !/\b(42501|23514|55000|22P02)\b/.test(text),
        `no SQLSTATE: ${text}`,
      );
      assert.ok(
        !/postgres|supabase|rpc|sql|error|exception|stack/i.test(text),
        `no backend or error vocabulary: ${text}`,
      );
      // The copy must be actionable rather than merely descriptive.
      assert.match(notice.message, /contact/i);
    }
  });

  test("12b. the four notices are distinguishable from one another", () => {
    const titles = LIFECYCLE_ACCESS_STATES.map(
      (state) => resolveLifecycleNotice(state as LifecycleAccessState)?.title,
    ).filter((title): title is string => title !== undefined);

    assert.equal(
      new Set(titles).size,
      titles.length,
      "each lifecycle cause must have its own title",
    );
  });
});
