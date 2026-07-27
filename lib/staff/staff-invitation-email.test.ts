/**
 * Unit tests for the staff invitation email.
 *
 * Run with:  npm test
 *
 * RESEND IS MOCKED. `fetch` is injected, so no network call is made and NO LIVE EMAIL IS
 * EVER SENT by this suite. No real key can be read into an assertion either: since the
 * shared-delivery milestone this module reads NO environment at all — the configuration
 * is passed in, and these tests pass a placeholder.
 *
 * These pin: the template's required content, the accept URL's shape, that the raw token
 * appears ONLY inside that URL, that the token hash never appears at all, that a bad
 * configuration is refused BEFORE any request, and that no provider status, body, or
 * error escapes into the returned result.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildStaffAcceptUrl,
  sendStaffInvitationEmail,
  staffInvitationHtmlBody,
  staffInvitationTextBody,
  STAFF_INVITE_ENTER_PATH,
  validateStaffInvitationEmailConfig,
  type StaffInvitationEmailConfig,
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

/** A placeholder configuration. Not a secret, and not read from anywhere. */
const CONFIG: StaffInvitationEmailConfig = {
  apiKey: "test-key-not-a-real-secret",
  from: "SalesReward <no-reply@example.test>",
  appOrigin: "https://app.example.test",
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

  test("4. the acceptance path is UNCHANGED by this milestone", () => {
    // The intake route (app/invitations/staff/enter/route.ts) hashes the token
    // server-side, stores the hash in an HttpOnly cookie and redirects to a clean URL.
    // Changing this constant without changing that route silently breaks acceptance.
    assert.equal(STAFF_INVITE_ENTER_PATH, "/invitations/staff/enter");
  });
});

describe("the message body", () => {
  const acceptUrl = buildStaffAcceptUrl("https://app.example.test", RAW_TOKEN);

  test("5. text body carries the required content", () => {
    const body = staffInvitationTextBody(INPUT, acceptUrl);
    assert.match(body, /Ada/);
    assert.match(body, /Harbour Retail/);
    assert.match(body, /Sales Staff/);
    assert.match(body, /ada@example\.com/);
    assert.ok(body.includes(acceptUrl), "must contain the accept link");
    assert.match(body, /expires/i, "must mention expiry");
  });

  test("6. html body carries branding, the button, and the sign-in guidance", () => {
    const body = staffInvitationHtmlBody(INPUT, acceptUrl);
    assert.match(body, /SalesReward/);
    assert.match(body, /Accept invitation/);
    assert.ok(body.includes(`href="${acceptUrl}"`));
    assert.match(body, /create your SalesReward account/i);
    assert.match(body, /expires/i);
  });

  test("7. html-escapes the dynamic display values", () => {
    const body = staffInvitationHtmlBody(
      { ...INPUT, retailerName: `<script>alert("x")</script>` },
      acceptUrl,
    );
    assert.ok(!body.includes("<script>"), "retailer name must be escaped");
    assert.match(body, /&lt;script&gt;/);
  });

  test("8. the RAW token appears ONLY inside the accept URL", () => {
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

  test("9. no id, hash, or internal identifier appears anywhere in the message", () => {
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

describe("validateStaffInvitationEmailConfig", () => {
  const VALID = {
    apiKey: "k",
    from: "SalesReward <no-reply@example.test>",
    appOrigin: "https://app.example.test",
  };

  test("10. accepts a complete configuration and canonicalizes the origin", () => {
    const result = validateStaffInvitationEmailConfig({
      ...VALID,
      appOrigin: "  https://app.example.test/some/path?x=1  ",
    });
    assert.ok(result.ok);
    // Only the ORIGIN survives — a stray path in the variable cannot bend the accept
    // URL into something else.
    assert.equal(result.config.appOrigin, "https://app.example.test");
  });

  test("11. refuses each missing or blank value", () => {
    for (const key of ["apiKey", "from", "appOrigin"] as const) {
      assert.equal(
        validateStaffInvitationEmailConfig({ ...VALID, [key]: undefined }).ok,
        false,
        `${key} absent`,
      );
      assert.equal(
        validateStaffInvitationEmailConfig({ ...VALID, [key]: "   " }).ok,
        false,
        `${key} blank`,
      );
      assert.equal(
        validateStaffInvitationEmailConfig({ ...VALID, [key]: 42 }).ok,
        false,
        `${key} not a string`,
      );
    }
  });

  test("12. refuses a non-https origin, excepting loopback development hosts", () => {
    assert.equal(
      validateStaffInvitationEmailConfig({
        ...VALID,
        appOrigin: "http://evil.example.test",
      }).ok,
      false,
    );
    assert.equal(
      validateStaffInvitationEmailConfig({ ...VALID, appOrigin: "not a url" }).ok,
      false,
    );
    for (const loopback of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://app.example.test",
    ]) {
      assert.equal(
        validateStaffInvitationEmailConfig({ ...VALID, appOrigin: loopback }).ok,
        true,
        loopback,
      );
    }
  });

  test("13. the failure result names nothing — not even which value was missing", () => {
    // It crosses a runtime boundary and becomes a client-visible NOT_CONFIGURED.
    const result = validateStaffInvitationEmailConfig({});
    assert.deepEqual(result, { ok: false });
  });
});

describe("sendStaffInvitationEmail — success", () => {
  test("14. posts to Resend and reports sent", async () => {
    const fake = fakeFetch({ ok: true });
    const result = await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);

    assert.deepEqual(result, { status: "sent" });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, "https://api.resend.com/emails");
    assert.equal(fake.calls[0].init?.method, "POST");
  });

  test("15. the recipient is the canonical address it was given, in a to[] array", async () => {
    const fake = fakeFetch({ ok: true });
    await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);
    const body = sentBody(fake.calls);
    assert.deepEqual(body.to, ["ada@example.com"]);
  });

  test("16. the subject names the Retailer and the role, and no id", async () => {
    const fake = fakeFetch({ ok: true });
    await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);
    const body = sentBody(fake.calls);
    assert.match(body.subject, /Harbour Retail/);
    assert.match(body.subject, /Sales Staff/);
    assert.ok(!/[0-9a-f]{64}/.test(body.subject));
  });

  test("17. the token hash is nowhere in the outgoing request", async () => {
    const fake = fakeFetch({ ok: true });
    await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);
    const serialized = String(fake.calls[0].init?.body ?? "");
    assert.ok(!/[0-9a-f]{64}/.test(serialized), "no SHA-256 digest may be sent");
  });

  test("18. exactly ONE request is made — the sender never retries", async () => {
    for (const response of [{ ok: true }, { ok: false, status: 429 }]) {
      const fake = fakeFetch(response);
      await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);
      assert.equal(fake.calls.length, 1, JSON.stringify(response));
    }
  });
});

describe("sendStaffInvitationEmail — failures are sanitized", () => {
  test("19. a non-2xx response yields 'failed' and nothing provider-specific", async () => {
    const fake = fakeFetch({
      ok: false,
      status: 422,
      statusText: "Unprocessable",
      text: async () => "rate limited for ada@example.com",
    });
    const result = await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);

    assert.deepEqual(result, { status: "failed" });
    assert.deepEqual(Object.keys(result), ["status"]);
  });

  test("20. a malformed provider response is treated as failed, never trusted", async () => {
    for (const response of [null, undefined, {}, { ok: "yes" }]) {
      const fake = fakeFetch(response);
      const result = await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);
      assert.deepEqual(result, { status: "failed" });
    }
  });

  test("21. a transport throw yields 'failed' and never surfaces the thrown value", async () => {
    const throwing = (async () => {
      // A real transport error can quote the request headers, which carry the key, and
      // the body, which carries the accept URL and therefore the raw token.
      throw new Error(
        `connect ECONNREFUSED with Bearer ${CONFIG.apiKey} token=${RAW_TOKEN}`,
      );
    }) as unknown as typeof fetch;

    const result = await sendStaffInvitationEmail(INPUT, CONFIG, throwing);
    assert.deepEqual(result, { status: "failed" });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("Bearer"));
    assert.ok(!serialized.includes(CONFIG.apiKey));
    assert.ok(!serialized.includes(RAW_TOKEN));
  });

  test("22. every result carries a status and nothing else", async () => {
    const cases: unknown[] = [{ ok: true }, { ok: false }, null];
    for (const response of cases) {
      const fake = fakeFetch(response);
      const result = await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);
      assert.deepEqual(Object.keys(result), ["status"]);
    }
  });

  test("23. neither the key nor the raw token is ever returned", async () => {
    for (const response of [{ ok: true }, { ok: false }, null]) {
      const fake = fakeFetch(response);
      const result = await sendStaffInvitationEmail(INPUT, CONFIG, fake.impl);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(CONFIG.apiKey));
      assert.ok(!serialized.includes(RAW_TOKEN));
      assert.ok(!serialized.includes(CONFIG.appOrigin));
    }
  });
});
