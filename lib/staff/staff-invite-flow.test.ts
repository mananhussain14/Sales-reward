/**
 * Unit tests for the staff-invitation delivery SEQUENCE.
 *
 * Run with:  npm test
 *
 * The sequence is exercised against fake ports that record every call in order, so
 * these tests pin the contract the milestone actually cares about:
 *
 *   reserve -> prepare -> send -> record sent | record failure
 *
 * plus token rotation on every attempt, sanitized outcomes, and — the security
 * property — that neither the RAW token nor the token HASH ever appears in a result
 * returned toward the browser.
 *
 * NO EMAIL IS SENT. The `sendEmail` port is a fake; the real Resend module is not
 * imported here at all, and its own test injects a fake `fetch`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runStaffInviteFlow,
  type StaffInviteEmailResult,
  type StaffInviteFlowPorts,
  type StaffInvitePrepareResult,
  type StaffInviteReserveResult,
} from "./staff-invite-flow.ts";

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

describe("runStaffInviteFlow — the happy path calls the RPCs in order", () => {
  test("1. reserve -> generateToken -> prepare -> sendEmail -> recordSent", async () => {
    const fake = makePorts();
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "sent" });
    assert.deepEqual(fake.order(), [
      "reserve",
      "generateToken",
      "prepare",
      "sendEmail",
      "recordSent",
    ]);
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

  test("4. the send uses DATABASE values from prepare, not the submitted form values", async () => {
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

  test("6. a reservation that reports is_resend yields 'resent', same call order", async () => {
    const fake = makePorts({
      reserve: {
        status: "ok",
        invitationId: INVITATION_ID,
        normalizedEmail: "ada@example.com",
        isResend: true,
      },
    });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "resent" });
    assert.deepEqual(fake.order(), [
      "reserve",
      "generateToken",
      "prepare",
      "sendEmail",
      "recordSent",
    ]);
  });
});

describe("runStaffInviteFlow — a resend rotates the token", () => {
  test("7. two runs mint two DIFFERENT tokens and prepare with two different hashes", async () => {
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

  test("8. a retry AFTER a delivery failure also mints a new token and re-prepares", async () => {
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
    assert.deepEqual(succeeding.order(), [
      "reserve",
      "generateToken",
      "prepare",
      "sendEmail",
      "recordSent",
    ]);
  });

  test("9. generateToken is called exactly once per attempt — never reused, never skipped", async () => {
    const fake = makePorts();
    await runStaffInviteFlow(INPUT, fake.ports);
    assert.equal(
      fake.order().filter((port) => port === "generateToken").length,
      1,
    );
  });
});

describe("runStaffInviteFlow — delivery failure", () => {
  test("10. a provider refusal records a failure and reports delivery-failed", async () => {
    const fake = makePorts({ email: { status: "failed" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "delivery-failed" });
    assert.ok(fake.order().includes("recordFailure"));
    assert.ok(!fake.order().includes("recordSent"));
  });

  test("11. a configuration gap ALSO records a failure but reports misconfigured", async () => {
    const fake = makePorts({ email: { status: "misconfigured" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "misconfigured" });
    assert.ok(fake.order().includes("recordFailure"));
  });

  test("12. recordFailure is keyed by the expected hash", async () => {
    const fake = makePorts({ email: { status: "failed" } });
    await runStaffInviteFlow(INPUT, fake.ports);

    const recorded = fake.calls.find((call) => call.port === "recordFailure");
    assert.deepEqual(recorded?.args, {
      invitationId: INVITATION_ID,
      tokenHash: fake.tokens[0].tokenHash,
    });
  });
});

describe("runStaffInviteFlow — refusals stop the sequence early", () => {
  test("13. a refused reservation sends nothing and records nothing", async () => {
    const fake = makePorts({ reserve: { status: "rejected" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "rejected" });
    assert.deepEqual(fake.order(), ["reserve"]);
    assert.equal(fake.tokens.length, 0, "no token may be minted for a refusal");
  });

  test("14. a role/shop conflict is reported distinctly and sends nothing", async () => {
    const fake = makePorts({ reserve: { status: "conflict" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "conflict" });
    assert.deepEqual(fake.order(), ["reserve"]);
  });

  test("15. an unavailable reservation stops before the token is generated", async () => {
    const fake = makePorts({ reserve: { status: "unavailable" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "unavailable" });
    assert.deepEqual(fake.order(), ["reserve"]);
  });

  test("16. a failed prepare sends nothing and records nothing", async () => {
    const fake = makePorts({ prepare: { status: "unavailable" } });
    const result = await runStaffInviteFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "unavailable" });
    assert.deepEqual(fake.order(), ["reserve", "generateToken", "prepare"]);
  });
});

describe("runStaffInviteFlow — nothing secret escapes in the result", () => {
  test("17. no outcome carries the raw token, the hash, an id, or an email", async () => {
    const outcomes: FakeOptions[] = [
      {},
      { reserve: { status: "conflict" } },
      { reserve: { status: "rejected" } },
      { reserve: { status: "unavailable" } },
      { prepare: { status: "unavailable" } },
      { email: { status: "failed" } },
      { email: { status: "misconfigured" } },
    ];

    for (const options of outcomes) {
      const fake = makePorts(options);
      const result = await runStaffInviteFlow(INPUT, fake.ports);
      const serialized = JSON.stringify(result);

      assert.deepEqual(
        Object.keys(result),
        ["status"],
        `result must carry only a status, got ${serialized}`,
      );
      assert.ok(!serialized.includes("raw-token"), serialized);
      assert.ok(!serialized.includes("hash"), serialized);
      assert.ok(!serialized.includes(INVITATION_ID), serialized);
      assert.ok(!serialized.includes("@example.com"), serialized);
    }
  });

  test("18. every status is one of the seven declared outcomes", async () => {
    const allowed = new Set([
      "sent",
      "resent",
      "delivery-failed",
      "misconfigured",
      "conflict",
      "rejected",
      "unavailable",
    ]);
    const options: FakeOptions[] = [
      {},
      { reserve: { status: "conflict" } },
      { reserve: { status: "rejected" } },
      { prepare: { status: "unavailable" } },
      { email: { status: "failed" } },
      { email: { status: "misconfigured" } },
    ];
    for (const option of options) {
      const { ports } = makePorts(option);
      const result = await runStaffInviteFlow(INPUT, ports);
      assert.ok(allowed.has(result.status), result.status);
    }
  });
});
