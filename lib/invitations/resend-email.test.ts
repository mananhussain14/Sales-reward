/**
 * Unit tests for the Resend existing-user invitation email sender.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added. `fetch` is mocked
 * via the injectable `fetchImpl` parameter — NO network call is made and no `resend`
 * package is used. The `.ts` import extension is required by Node's ESM resolver, and
 * the module under test uses NO `@/` path alias so this loads under
 * `node --experimental-strip-types`.
 *
 * These pin: misconfiguration (missing key/sender/origin, or an invalid origin) is
 * distinguishable from a transient failure; the module itself builds the accept URL
 * from APP_ORIGIN + the raw token; a non-2xx, a malformed response, and a thrown
 * transport error all collapse to `failed` with nothing provider-specific surfaced;
 * the API key rides ONLY in the Authorization header (never the body); and the
 * recipient + accept URL are the only dynamic values sent.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  sendExistingUserInvitationEmail,
  type ExistingUserInvitationEmailInput,
} from "./resend-email.ts";

const RAW_TOKEN = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA";

const INPUT: ExistingUserInvitationEmailInput = {
  toEmail: "owner@example.com",
  retailerName: "Acme Retail",
  rawToken: RAW_TOKEN,
};

/** The URL the module is expected to construct for a given origin. */
function expectedUrl(origin: string): string {
  return `${origin}/invitations/existing/enter?token=${RAW_TOKEN}`;
}

/** Snapshot and restore the three env vars around each test. */
const ORIGINAL = {
  key: process.env.RESEND_API_KEY,
  from: process.env.RESEND_FROM,
  origin: process.env.APP_ORIGIN,
};

function set(name: "RESEND_API_KEY" | "RESEND_FROM" | "APP_ORIGIN", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Sets all three vars; pass undefined to clear one. */
function setConfig(
  key: string | undefined,
  from: string | undefined,
  origin: string | undefined,
): void {
  set("RESEND_API_KEY", key);
  set("RESEND_FROM", from);
  set("APP_ORIGIN", origin);
}

const GOOD_FROM = "SalesReward <no-reply@example.com>";
const GOOD_ORIGIN = "https://app.example.com";

afterEach(() => {
  setConfig(ORIGINAL.key, ORIGINAL.from, ORIGINAL.origin);
});

/** A fetch stub that records its call and returns a canned Response-like object. */
function stubFetch(response: { ok: boolean } | Error | undefined) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    if (response instanceof Error) throw response;
    return response as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("sendExistingUserInvitationEmail — configuration", () => {
  test("misconfigured when the API key is absent", async () => {
    setConfig(undefined, GOOD_FROM, GOOD_ORIGIN);
    const { impl, calls } = stubFetch({ ok: true });
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "misconfigured" });
    assert.equal(calls.length, 0, "must not attempt a send while misconfigured");
  });

  test("misconfigured when the sender is blank", async () => {
    setConfig("re_key", "   ", GOOD_ORIGIN);
    const { impl, calls } = stubFetch({ ok: true });
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "misconfigured" });
    assert.equal(calls.length, 0);
  });

  test("misconfigured when APP_ORIGIN is absent", async () => {
    setConfig("re_key", GOOD_FROM, undefined);
    const { impl, calls } = stubFetch({ ok: true });
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "misconfigured" });
    assert.equal(calls.length, 0);
  });

  test("misconfigured when APP_ORIGIN is not a valid absolute URL", async () => {
    setConfig("re_key", GOOD_FROM, "not-a-url");
    const { impl, calls } = stubFetch({ ok: true });
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "misconfigured" });
    assert.equal(calls.length, 0);
  });

  test("misconfigured when APP_ORIGIN is http on a non-loopback host", async () => {
    setConfig("re_key", GOOD_FROM, "http://app.example.com");
    const { impl, calls } = stubFetch({ ok: true });
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "misconfigured" });
    assert.equal(calls.length, 0);
  });

  test("allows http on a loopback host (dev)", async () => {
    setConfig("re_key", GOOD_FROM, "http://localhost:3000");
    const { impl, calls } = stubFetch({ ok: true });
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "sent" });
    const body = JSON.parse(calls[0].init.body as string);
    assert.ok(String(body.text).includes(expectedUrl("http://localhost:3000")));
  });
});

describe("sendExistingUserInvitationEmail — sending", () => {
  test("sent on a 2xx, and the module builds a well-formed request + URL", async () => {
    setConfig("re_secret_key", GOOD_FROM, GOOD_ORIGIN);
    const { impl, calls } = stubFetch({ ok: true });

    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "sent" });
    assert.equal(calls.length, 1);

    const { url, init } = calls[0];
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.method, "POST");

    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer re_secret_key");
    assert.equal(headers["Content-Type"], "application/json");

    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.to, ["owner@example.com"]);
    assert.equal(body.from, GOOD_FROM);
    assert.ok(String(body.subject).includes("Acme Retail"));
    // The module constructed the accept URL itself from APP_ORIGIN + the raw token.
    assert.ok(String(body.text).includes(expectedUrl("https://app.example.com")));
    assert.ok(String(body.html).includes(expectedUrl("https://app.example.com")));
  });

  test("the API key never appears in the request BODY", async () => {
    setConfig("re_secret_key", GOOD_FROM, GOOD_ORIGIN);
    const { impl, calls } = stubFetch({ ok: true });
    await sendExistingUserInvitationEmail(INPUT, impl);
    assert.ok(!String(calls[0].init.body).includes("re_secret_key"));
  });

  test("failed on a non-2xx response (nothing provider-specific)", async () => {
    setConfig("re_secret_key", GOOD_FROM, GOOD_ORIGIN);
    const { impl } = stubFetch({ ok: false });
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "failed" });
  });

  test("failed on a malformed/absent response object", async () => {
    setConfig("re_secret_key", GOOD_FROM, GOOD_ORIGIN);
    const { impl } = stubFetch(undefined);
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "failed" });
  });

  test("failed when fetch throws (transport error carrying the key)", async () => {
    setConfig("re_secret_key", GOOD_FROM, GOOD_ORIGIN);
    const { impl } = stubFetch(new Error("network down, header=Bearer re_secret_key"));
    // The thrown error carries the key; the result must NOT expose it.
    assert.deepEqual(await sendExistingUserInvitationEmail(INPUT, impl), { status: "failed" });
  });
});

describe("sendExistingUserInvitationEmail — HTML escaping", () => {
  test("escapes angle brackets in the retailer name in the HTML body", async () => {
    setConfig("re_secret_key", GOOD_FROM, GOOD_ORIGIN);
    const { impl, calls } = stubFetch({ ok: true });
    await sendExistingUserInvitationEmail({ ...INPUT, retailerName: "<script>x</script>" }, impl);
    const body = JSON.parse(calls[0].init.body as string);
    assert.ok(!String(body.html).includes("<script>"));
    assert.ok(String(body.html).includes("&lt;script&gt;"));
  });
});
