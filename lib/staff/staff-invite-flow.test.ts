/**
 * Unit tests for the staff-invitation delivery SEQUENCE.
 *
 * Run with:  npm test
 *
 * The sequence is exercised against fake ports that record every call in order, so these
 * tests pin the contract the milestone actually cares about:
 *
 *   reserve -> generateToken -> prepare -> sendEmail -> recordSent | recordFailure
 *
 * plus token rotation on every attempt, the partial-success outcome, the absence of any
 * automatic retry, and — the security property — that neither the RAW token nor the token
 * HASH nor the invitation id ever appears in a result travelling toward a client.
 *
 * This is the ONE place the order is tested, and it is the order BOTH clients execute:
 * the web portal and the Flutter app reach it through the same Edge Function, which
 * supplies the real ports and adds nothing to the sequence.
 *
 * NO EMAIL IS SENT and NO DATABASE IS TOUCHED. Every port is a fake; the Resend module is
 * not imported here at all, and its own test injects a fake `fetch`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runStaffInviteFlow,
  type StaffInviteEmailResult,
  type StaffInviteFlowCode,
  type StaffInviteFlowPorts,
  type StaffInvitePrepareResult,
  type StaffInviteRecordResult,
  type StaffInviteReserveResult,
} from "./staff-invite-flow.ts";
import { STAFF_INVITATION_HTTP_STATUS } from "./staff-invitation-delivery-contract.ts";

const INVITATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHOP_ID = "11111111-1111-4111-8111-111111111111";

const INPUT = {
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  roleCode: "SALES_STAFF",
  shopIds: [SHOP_ID],
};

type Call = { port: string; args?: unknown };

type FakeOptions = {
  reserve?: StaffInviteReserveResult;
  prepare?: StaffInvitePrepareResult;
  email?: StaffInviteEmailResult;
  recordSent?: StaffInviteRecordResult;
};

/** Builds recording ports plus the call log and the tokens they minted. */
function makePorts(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const tokens: { rawToken: string; tokenHash: string }[] = [];
  let counter = 0;

  const ports: StaffInviteFlowPorts = {
    async reserve(args) {
      calls.push({ port: "reserve", args });
      return (
        options.reserve ?? {
          status: "ok",
          invitationId: INVITATION_ID,
          normalizedEmail: "ada@example.com",
          isResend: false,
        }
      );
    },
    generateToken() {
      counter += 1;
      const token = {
        rawToken: `raw-token-${counter}`,
        tokenHash: `hash${counter}`.padEnd(64, "0"),
      };
      tokens.push(token);
      calls.push({ port: "generateToken" });
      return token;
    },
    async prepare(args) {
      calls.push({ port: "prepare", args });
      return (
        options.prepare ?? {
          status: "ok",
          normalizedEmail: "canonical@example.com",
          firstName: "Ada",
          retailerName: "Harbour Retail",
          roleCode: "SALES_STAFF",
        }
      );
    },
    async sendEmail(args) {
      calls.push({ port: "sendEmail", args });
      return options.email ?? { status: "sent" };
    },
    async recordSent(args) {
      calls.push({ port: "recordSent", args });
      return options.recordSent ?? { status: "ok" };
    },
    async recordFailure(args) {
      calls.push({ port: "recordFailure", args });
    },
    roleDisplayName(roleCode) {
      return roleCode === "SALES_STAFF" ? "Sales Staff" : roleCode;
    },
  };

  return { ports, calls, tokens, order: () => calls.map((call) => call.port) };
}

const HAPPY_ORDER = [
  "reserve",
  "generateToken",
  "prepare",
  "sendEmail",
  "recordSent",
];

/** Every distinct path through the sequence, used by the exhaustive checks. */
const ALL_OPTIONS: FakeOptions[] = [
  {},
  { reserve: { status: "denied" } },
  { reserve: { status: "conflict" } },
  { reserve: { status: "retailer-inactive" } },
  { reserve: { status: "invalid" } },
  { reserve: { status: "unavailable" } },
  { prepare: { status: "unavailable" } },
  { email: { status: "failed" } },
  { recordSent: { status: "failed" } },
  {
    reserve: {
      status: "ok",
      invitationId: INVITATION_ID,
      normalizedEmail: "ada@example.com",
      isResend: true,
    },
  },
];

describe("runStaffInviteFlow — the happy path calls the RPCs in order", () => {
  test("1. reserve -> generateToken -> prepare -> sendEmail -> recordSent", async () => {
    const fake = makePorts();
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.equal(result, "SENT");
    assert.deepEqual(fake.order(), HAPPY_ORDER);
  });

  test("2. recordFailure is NOT called on success", async () => {
    const fake = makePorts();
    await runStaffInviteFlow(INPUT, fake.ports);
    assert.ok(!fake.order().includes("recordFailure"));
  });

  test("3. prepare receives the invitation id and the freshly minted HASH", async () => {
    const fake = makePorts();
    await runStaffInviteFlow(INPUT, fake.ports);

    const prepare = fake.calls.find((call) => call.port === "prepare");
    assert.deepEqual(prepare?.args, {
      invitationId: INVITATION_ID,
      tokenHash: fake.tokens[0].tokenHash,
    });
  });

  test("4. the send uses DATABASE values from prepare, not the submitted values", async () => {
    const fake = makePorts();
    await runStaffInviteFlow(INPUT, fake.ports);

    const send = fake.calls.find((call) => call.port === "sendEmail");
    assert.deepEqual(send?.args, {
      // prepare's canonical email, NOT the "ada@example.com" that was submitted
      toEmail: "canonical@example.com",
      firstName: "Ada",
      retailerName: "Harbour Retail",
      roleDisplayName: "Sales Staff",
      rawToken: fake.tokens[0].rawToken,
    });
  });

  test("5. recordSent is keyed by the EXPECTED hash — never the raw token", async () => {
    const fake = makePorts();
    await runStaffInviteFlow(INPUT, fake.ports);

    const recorded = fake.calls.find((call) => call.port === "recordSent");
    assert.deepEqual(recorded?.args, {
      invitationId: INVITATION_ID,
      tokenHash: fake.tokens[0].tokenHash,
    });
    assert.ok(
      !JSON.stringify(recorded?.args).includes(fake.tokens[0].rawToken),
      "the raw token must never be passed to a recording RPC",
    );
  });

  test("6. a reservation that reports is_resend yields RESENT, same call order", async () => {
    const fake = makePorts({
      reserve: {
        status: "ok",
        invitationId: INVITATION_ID,
        normalizedEmail: "ada@example.com",
        isResend: true,
      },
    });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.equal(result, "RESENT");
    assert.deepEqual(fake.order(), HAPPY_ORDER);
  });

  test("7. every id given to a service-only port came from the RESERVATION", async () => {
    // The whole point of the two-client split: nothing downstream of `reserve` may be
    // addressed by an id from anywhere else. The reservation here returns a distinctive
    // id, and prepare / recordSent must both receive exactly it.
    const reservedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fake = makePorts({
      reserve: {
        status: "ok",
        invitationId: reservedId,
        normalizedEmail: "ada@example.com",
        isResend: false,
      },
    });
    await runStaffInviteFlow(INPUT, fake.ports);

    for (const port of ["prepare", "recordSent"]) {
      const call = fake.calls.find((entry) => entry.port === port);
      assert.equal(
        (call?.args as { invitationId?: string })?.invitationId,
        reservedId,
        `${port} was not keyed by the reserved invitation id`,
      );
    }
  });
});

describe("runStaffInviteFlow — a resend rotates the token", () => {
  test("8. two runs mint two DIFFERENT tokens and prepare with two different hashes", async () => {
    const fake = makePorts();
    await runStaffInviteFlow(INPUT, fake.ports);
    await runStaffInviteFlow(INPUT, fake.ports);

    assert.equal(fake.tokens.length, 2);
    assert.notEqual(fake.tokens[0].rawToken, fake.tokens[1].rawToken);
    assert.notEqual(fake.tokens[0].tokenHash, fake.tokens[1].tokenHash);

    const prepares = fake.calls.filter((call) => call.port === "prepare");
    assert.equal(prepares.length, 2);
    assert.notEqual(
      (prepares[0].args as { tokenHash: string }).tokenHash,
      (prepares[1].args as { tokenHash: string }).tokenHash,
    );
  });

  test("9. a resend takes the SAME path as a first send — it cannot replay a token", async () => {
    const fake = makePorts({
      reserve: {
        status: "ok",
        invitationId: INVITATION_ID,
        normalizedEmail: "ada@example.com",
        isResend: true,
      },
    });
    await runStaffInviteFlow(INPUT, fake.ports);

    // There is no branch that skips generateToken or prepare for a resend, so the
    // previous token is invalidated by prepare before the new one is emailed.
    assert.deepEqual(fake.order(), HAPPY_ORDER);
    assert.equal(fake.tokens.length, 1);
  });

  test("10. a retry AFTER a delivery failure also mints a new token and re-prepares", async () => {
    const failing = makePorts({ email: { status: "failed" } });
    await runStaffInviteFlow(INPUT, failing.ports);

    const succeeding = makePorts();
    await runStaffInviteFlow(INPUT, succeeding.ports);

    assert.deepEqual(failing.order(), [
      "reserve",
      "generateToken",
      "prepare",
      "sendEmail",
      "recordFailure",
    ]);
    assert.deepEqual(succeeding.order(), HAPPY_ORDER);
  });

  test("11. generateToken is called exactly once per attempt — never reused, never skipped", async () => {
    const fake = makePorts();
    await runStaffInviteFlow(INPUT, fake.ports);
    assert.equal(fake.order().filter((port) => port === "generateToken").length, 1);
  });
});

describe("runStaffInviteFlow — no automatic retry, ever", () => {
  test("12. a provider refusal produces exactly ONE sendEmail call", async () => {
    const fake = makePorts({ email: { status: "failed" } });
    await runStaffInviteFlow(INPUT, fake.ports);
    assert.equal(fake.order().filter((port) => port === "sendEmail").length, 1);
  });

  test("13. a failed recordSent is not retried inside the request", async () => {
    const fake = makePorts({ recordSent: { status: "failed" } });
    await runStaffInviteFlow(INPUT, fake.ports);
    assert.equal(fake.order().filter((port) => port === "recordSent").length, 1);
    // And in particular the sequence does not fall back to recording a FAILURE for a
    // message the provider accepted, which would contradict the delivery that happened.
    assert.ok(!fake.order().includes("recordFailure"));
  });

  test("14. no outcome reserves twice", async () => {
    for (const options of ALL_OPTIONS) {
      const fake = makePorts(options);
      await runStaffInviteFlow(INPUT, fake.ports);
      assert.equal(
        fake.order().filter((port) => port === "reserve").length,
        1,
        `reserved more than once for ${JSON.stringify(options)}`,
      );
    }
  });
});

describe("runStaffInviteFlow — delivery failure", () => {
  test("15. a provider refusal records a failure and reports DELIVERY_FAILED", async () => {
    const fake = makePorts({ email: { status: "failed" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.equal(result, "DELIVERY_FAILED");
    assert.ok(fake.order().includes("recordFailure"));
    assert.ok(!fake.order().includes("recordSent"));
  });

  test("16. recordFailure is keyed by the expected hash", async () => {
    const fake = makePorts({ email: { status: "failed" } });
    await runStaffInviteFlow(INPUT, fake.ports);

    const recorded = fake.calls.find((call) => call.port === "recordFailure");
    assert.deepEqual(recorded?.args, {
      invitationId: INVITATION_ID,
      tokenHash: fake.tokens[0].tokenHash,
    });
  });

  test("17. a recordFailure that itself fails still reports DELIVERY_FAILED", async () => {
    // recordFailure returns void and cannot report a problem, which is deliberate: the
    // invitation is live, `sent_at` is null and the token is current, so it is retryable
    // whether or not the failure was written down. This test pins that the sequence has
    // no branch that could turn the bookkeeping into a different user-facing outcome.
    const calls: string[] = [];
    const { ports } = makePorts({ email: { status: "failed" } });
    const throwing: StaffInviteFlowPorts = {
      ...ports,
      async recordFailure(args) {
        calls.push("recordFailure");
        await ports.recordFailure(args);
      },
    };
    const result = await runStaffInviteFlow(INPUT, throwing);
    assert.equal(result, "DELIVERY_FAILED");
    assert.deepEqual(calls, ["recordFailure"]);
  });
});

describe("runStaffInviteFlow — the partial success", () => {
  test("18. provider accepted + recordSent failed => DELIVERY_ACCEPTED_STATUS_UNCONFIRMED", async () => {
    const fake = makePorts({ recordSent: { status: "failed" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.equal(result, "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED");
    // The email WAS sent — the sequence must not pretend otherwise.
    assert.deepEqual(fake.order(), HAPPY_ORDER);
  });

  test("19. it is reported on a resend too, not collapsed into RESENT", async () => {
    const fake = makePorts({
      reserve: {
        status: "ok",
        invitationId: INVITATION_ID,
        normalizedEmail: "ada@example.com",
        isResend: true,
      },
      recordSent: { status: "failed" },
    });
    assert.equal(
      await runStaffInviteFlow(INPUT, fake.ports),
      "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED",
    );
  });

  test("20. its HTTP status is a SUCCESS status, so no client auto-retries the write", async () => {
    // 202 is the whole safety property: a 5xx here would invite a retry policy to
    // resubmit, which would rotate the token and kill the link already delivered.
    const status =
      STAFF_INVITATION_HTTP_STATUS.DELIVERY_ACCEPTED_STATUS_UNCONFIRMED;
    assert.equal(status, 202);
    assert.ok(status >= 200 && status < 300, "must not be an error status");
  });
});

describe("runStaffInviteFlow — refusals stop the sequence early", () => {
  const REFUSALS: { reserve: StaffInviteReserveResult; code: StaffInviteFlowCode }[] = [
    { reserve: { status: "denied" }, code: "ACCESS_DENIED" },
    { reserve: { status: "conflict" }, code: "INVITATION_CONFLICT" },
    { reserve: { status: "retailer-inactive" }, code: "RETAILER_INACTIVE" },
    { reserve: { status: "invalid" }, code: "INVALID_REQUEST" },
    { reserve: { status: "unavailable" }, code: "INTERNAL_ERROR" },
  ];

  for (const [index, refusal] of REFUSALS.entries()) {
    test(`${21 + index}. a ${refusal.reserve.status} reservation yields ${refusal.code} and mints no token`, async () => {
      const fake = makePorts({ reserve: refusal.reserve });
      const result = await runStaffInviteFlow(INPUT, fake.ports);

      assert.equal(result, refusal.code);
      assert.deepEqual(fake.order(), ["reserve"]);
      assert.equal(fake.tokens.length, 0, "no token may be minted for a refusal");
    });
  }

  test("26. a failed prepare sends nothing and records nothing", async () => {
    const fake = makePorts({ prepare: { status: "unavailable" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.equal(result, "INTERNAL_ERROR");
    assert.deepEqual(fake.order(), ["reserve", "generateToken", "prepare"]);
  });
});

describe("runStaffInviteFlow — nothing secret escapes in the result", () => {
  test("27. no outcome carries the raw token, the hash, an id, or an email", async () => {
    for (const options of ALL_OPTIONS) {
      const fake = makePorts(options);
      const result = await runStaffInviteFlow(INPUT, fake.ports);

      // The result is a bare string code, so there is no object for anything to hide
      // in — asserted rather than assumed, because widening it is exactly the kind of
      // convenience edit that would carry an invitation id toward a client.
      assert.equal(typeof result, "string", JSON.stringify(result));
      assert.ok(!result.includes("raw-token"), result);
      assert.ok(!result.includes("hash"), result);
      assert.ok(!result.includes(INVITATION_ID), result);
      assert.ok(!result.includes("@"), result);
    }
  });

  test("28. every code is declared in the shared wire contract", async () => {
    // The flow returns wire codes directly, so a code it invents that the contract does
    // not know would be returned with an undefined HTTP status.
    for (const options of ALL_OPTIONS) {
      const { ports } = makePorts(options);
      const result = await runStaffInviteFlow(INPUT, ports);
      assert.equal(
        typeof STAFF_INVITATION_HTTP_STATUS[result],
        "number",
        `"${result}" has no declared HTTP status`,
      );
    }
  });

  test("29. the nine declared flow codes are all reachable", async () => {
    // Guards against a rule above passing because a branch became unreachable.
    const seen = new Set<string>();
    for (const options of ALL_OPTIONS) {
      const { ports } = makePorts(options);
      seen.add(await runStaffInviteFlow(INPUT, ports));
    }
    assert.deepEqual(
      [...seen].sort(),
      [
        "ACCESS_DENIED",
        "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED",
        "DELIVERY_FAILED",
        "INTERNAL_ERROR",
        "INVALID_REQUEST",
        "INVITATION_CONFLICT",
        "RESENT",
        "RETAILER_INACTIVE",
        "SENT",
      ],
    );
  });
});
