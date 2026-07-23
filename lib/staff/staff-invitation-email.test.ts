/**
 * Unit tests for the staff invitation email.
 *
 * Run with:  npm test
 *
 * RESEND IS MOCKED. `fetch` is injected, so no network call is made and NO LIVE EMAIL
 * IS EVER SENT by this suite. The real API key is never read into an assertion either —
 * the tests set placeholder environment variables for the duration of each case.
 *
 * These pin: the template's required content, the accept URL's shape, that the raw
 * token appears ONLY inside that URL, that the token hash never appears at all, and
 * that no provider status, body, or error escapes into the returned result.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildStaffAcceptUrl,
  sendStaffInvitationEmail,
  staffInvitationHtmlBody,
  staffInvitationTextBody,
  STAFF_INVITE_ENTER_PATH,
  type StaffInvitationEmailInput,
} from "./staff-invitation-email.ts";

const RAW_TOKEN = "Zm9vYmFyLXJhdy10b2tlbi12YWx1ZS1mb3ItdGVzdGluZy1vbmx5";

const INPUT: StaffInvitationEmailInput = {
  toEmail: "ada@example.com",
  firstName: "Ada",
  retailerName: "Harbour Retail",
  roleDisplayName: "Sales Staff",
  rawToken: RAW_TOKEN,
};

/** Captures what would have been POSTed, and returns a chosen response. */
function fakeFetch(response: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Reads the JSON body the sender would have posted. */
function sentBody(calls: { init: RequestInit | undefined }[]): Record<string, string> {
  return JSON.parse(String(calls[0]?.init?.body ?? "{}"));
}

const ORIGINAL_ENV = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM: process.env.RESEND_FROM,
  APP_ORIGIN: process.env.APP_ORIGIN,
};

beforeEach(() => {
  process.env.RESEND_API_KEY = "test-key-not-a-real-secret";
  process.env.RESEND_FROM = "SalesReward <no-reply@example.test>";
  process.env.APP_ORIGIN = "https://app.example.test";
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("buildStaffAcceptUrl", () => {
  test("1. points at the intake route and carries the raw token as a query value", () => {
    const url = buildStaffAcceptUrl("https://app.example.test", RAW_TOKEN);
    assert.equal(
      url,
      `https://app.example.test${STAFF_INVITE_ENTER_PATH}?token=${RAW_TOKEN}`,
    );
  });

  test("2. percent-encodes anything unexpected rather than letting it alter the URL", () => {
    const url = buildStaffAcceptUrl("https://app.example.test", "a&b=c#d");
    assert.ok(url.endsWith("?token=a%26b%3Dc%23d"));
  });

  test("3. hard-codes no production domain — the origin is entirely the caller's", () => {
    assert.ok(
      buildStaffAcceptUrl("http://localhost:3000", RAW_TOKEN).startsWith(
        "http://localhost:3000/",
      ),
    );
  });
});

describe("the message body", () => {
  const acceptUrl = buildStaffAcceptUrl("https://app.example.test", RAW_TOKEN);

  test("4. text body carries the required content", () => {
    const body = staffInvitationTextBody(INPUT, acceptUrl);
    assert.match(body, /Ada/);
    assert.match(body, /Harbour Retail/);
    assert.match(body, /Sales Staff/);
    assert.match(body, /ada@example\.com/);
    assert.ok(body.includes(acceptUrl), "must contain the accept link");
    assert.match(body, /expires/i, "must mention expiry");
  });

  test("5. html body carries branding, the button, and the sign-in guidance", () => {
    const body = staffInvitationHtmlBody(INPUT, acceptUrl);
    assert.match(body, /SalesReward/);
    assert.match(body, /Accept invitation/);
    assert.ok(body.includes(`href="${acceptUrl}"`));
    assert.match(body, /create your SalesReward account/i);
    assert.match(body, /expires/i);
  });

  test("6. html-escapes the dynamic display values", () => {
    const body = staffInvitationHtmlBody(
      { ...INPUT, retailerName: `<script>alert("x")</script>` },
      acceptUrl,
    );
    assert.ok(!body.includes("<script>"), "retailer name must be escaped");
    assert.match(body, /&lt;script&gt;/);
  });

  test("7. the RAW token appears ONLY inside the accept URL", () => {
    for (const body of [
      staffInvitationTextBody(INPUT, acceptUrl),
      staffInvitationHtmlBody(INPUT, acceptUrl),
    ]) {
      const occurrences = body.split(RAW_TOKEN).length - 1;
      const urlOccurrences = body.split(acceptUrl).length - 1;
      assert.ok(occurrences > 0);
      assert.equal(
        occurrences,
        urlOccurrences,
        "the raw token must not appear outside the accept URL",
      );
    }
  });

  test("8. no id, hash, or internal identifier appears anywhere in the message", () => {
    for (const body of [
      staffInvitationTextBody(INPUT, acceptUrl),
      staffInvitationHtmlBody(INPUT, acceptUrl),
    ]) {
      // A SHA-256 hex digest, an invitation UUID, or a shop UUID would each match one
      // of these. None may be present.
      assert.ok(!/[0-9a-f]{64}/.test(body), "no token hash");
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(body),
        "no UUID of any kind",
      );
    }
  });
});

describe("sendStaffInvitationEmail — success", () => {
  test("9. posts to Resend and reports sent", async () => {
    const fake = fakeFetch({ ok: true });
    const result = await sendStaffInvitationEmail(INPUT, fake.impl);

    assert.deepEqual(result, { status: "sent" });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, "https://api.resend.com/emails");
    assert.equal(fake.calls[0].init?.method, "POST");
  });

  test("10. the recipient is the canonical address it was given, in a to[] array", async () => {
    const fake = fakeFetch({ ok: true });
    await sendStaffInvitationEmail(INPUT, fake.impl);
    const body = sentBody(fake.calls);
    assert.deepEqual(body.to, ["ada@example.com"]);
  });

  test("11. the subject names the Retailer and the role, and no id", async () => {
    const fake = fakeFetch({ ok: true });
    await sendStaffInvitationEmail(INPUT, fake.impl);
    const body = sentBody(fake.calls);
    assert.match(body.subject, /Harbour Retail/);
    assert.match(body.subject, /Sales Staff/);
    assert.ok(!/[0-9a-f]{64}/.test(body.subject));
  });

  test("12. the token hash is nowhere in the outgoing request", async () => {
    const fake = fakeFetch({ ok: true });
    await sendStaffInvitationEmail(INPUT, fake.impl);
    const serialized = String(fake.calls[0].init?.body ?? "");
    assert.ok(!/[0-9a-f]{64}/.test(serialized), "no SHA-256 digest may be sent");
  });
});

describe("sendStaffInvitationEmail — failures are sanitized", () => {
  test("13. a non-2xx response yields 'failed' and nothing provider-specific", async () => {
    const fake = fakeFetch({
      ok: false,
      status: 422,
      statusText: "Unprocessable",
      text: async () => "rate limited for ada@example.com",
    });
    const result = await sendStaffInvitationEmail(INPUT, fake.impl);

    assert.deepEqual(result, { status: "failed" });
    assert.deepEqual(Object.keys(result), ["status"]);
  });

  test("14. a malformed provider response is treated as failed, never trusted", async () => {
    for (const response of [null, undefined, {}, { ok: "yes" }]) {
      const fake = fakeFetch(response);
      const result = await sendStaffInvitationEmail(INPUT, fake.impl);
      assert.deepEqual(result, { status: "failed" });
    }
  });

  test("15. a transport throw yields 'failed' and never surfaces the thrown value", async () => {
    const throwing = (async () => {
      throw new Error(`connect ECONNREFUSED with Bearer ${process.env.RESEND_API_KEY}`);
    }) as unknown as typeof fetch;

    const result = await sendStaffInvitationEmail(INPUT, throwing);
    assert.deepEqual(result, { status: "failed" });
    assert.ok(!JSON.stringify(result).includes("Bearer"));
  });

  test("16. missing configuration is reported distinctly and makes NO request", async () => {
    for (const missing of ["RESEND_API_KEY", "RESEND_FROM", "APP_ORIGIN"]) {
      const saved = process.env[missing];
      delete process.env[missing];
      const fake = fakeFetch({ ok: true });
      const result = await sendStaffInvitationEmail(INPUT, fake.impl);
      assert.deepEqual(result, { status: "misconfigured" }, `${missing} missing`);
      assert.equal(fake.calls.length, 0, "no provider request may be made");
      process.env[missing] = saved;
    }
  });

  test("17. a non-https APP_ORIGIN is refused (loopback excepted)", async () => {
    process.env.APP_ORIGIN = "http://evil.example.test";
    const fake = fakeFetch({ ok: true });
    assert.deepEqual(await sendStaffInvitationEmail(INPUT, fake.impl), {
      status: "misconfigured",
    });
    assert.equal(fake.calls.length, 0);

    process.env.APP_ORIGIN = "http://localhost:3000";
    const loopback = fakeFetch({ ok: true });
    assert.deepEqual(await sendStaffInvitationEmail(INPUT, loopback.impl), {
      status: "sent",
    });
  });

  test("18. every result carries a status and nothing else", async () => {
    const cases: unknown[] = [{ ok: true }, { ok: false }, null];
    for (const response of cases) {
      const fake = fakeFetch(response);
      const result = await sendStaffInvitationEmail(INPUT, fake.impl);
      assert.deepEqual(Object.keys(result), ["status"]);
    }
  });
});
