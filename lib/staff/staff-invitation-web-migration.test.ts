/**
 * WEB REGRESSION GUARDS for the move to the shared invitation-delivery Edge Function.
 *
 * Run with:  npm test
 *
 * WHAT THESE ARE, AND WHAT THEY ARE NOT. They are SOURCE-LEVEL assertions over the
 * Retailer staff page, its Server Actions, and the module that now calls the Edge
 * Function. They prove the WIRING survived the migration — the form still submits the
 * same fields to the same action, the action still validates the same way and still maps
 * every outcome to a message, and nothing privileged crept back into the web process.
 *
 * They are NOT runtime proof that an invitation arrives. Nothing in this repository can
 * render a React form, sign in as a Retailer Owner, or watch an inbox, and claiming
 * otherwise from a grep would be a lie about coverage. That half is the hosted Chrome
 * verification recorded in docs/retailer-staff-invitation-delivery-audit.md § K.
 *
 * The behavioural half that CAN be tested in Node is tested elsewhere and is not
 * restated here: the delivery sequence in ./staff-invite-flow.test.ts, the request and
 * response contract in ./staff-invitation-delivery-contract.test.ts, and the message
 * itself in ./staff-invitation-email.test.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ACTIONS_PATH = "app/(retailer)/retailer/staff/actions.ts";
const FORM_PATH = "app/(retailer)/retailer/staff/invite-staff-form.tsx";
const CONTROLS_PATH = "app/(retailer)/retailer/staff/invitation-controls.tsx";
const SEND_PATH = "lib/staff/retailer-staff-invitations.ts";
const INTAKE_PATH = "app/invitations/staff/enter/route.ts";
const ACCEPT_ACTIONS_PATH = "app/invitations/staff/actions.ts";

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const ACTIONS = read(ACTIONS_PATH);
const ACTIONS_CODE = stripComments(ACTIONS);
const FORM = read(FORM_PATH);
const SEND = read(SEND_PATH);
const SEND_CODE = stripComments(SEND);

describe("the invite form still submits exactly what it always did", () => {
  test("1. the five fields are unchanged and still named the same", () => {
    for (const field of ["firstName", "lastName", "email", "roleCode", "shopIds"]) {
      assert.ok(
        new RegExp(`name="${field}"`).test(FORM),
        `the form no longer submits ${field}`,
      );
    }
  });

  test("2. no NEW hidden field was introduced by the migration", () => {
    // In particular: no organization id, no invitation id, no token, and no
    // Edge-Function-specific routing value. The form posts to a Server Action, which
    // adds the identity itself.
    const hidden = FORM.match(/type="hidden"[\s\S]{0,160}?name="([a-zA-Z]+)"/g) ?? [];
    const names = hidden.map((match) => /name="([a-zA-Z]+)"/.exec(match)?.[1] ?? "");
    assert.deepEqual(names, [], `unexpected hidden fields: ${names.join(", ")}`);
  });

  test("3. a Retailer Manager selection submits NO shops", () => {
    // The shop checkboxes are rendered only for the Sales Staff role, so a Manager
    // invitation carries an empty `shopIds`. The contract, the action's validator and
    // reserve_retailer_staff_invitation() all refuse a Manager that carries any.
    assert.ok(
      /const showShops = roleCode === SALES_ROLE/.test(FORM),
      "the shop selector is no longer conditioned on the Sales Staff role",
    );
    const checkbox = /name="shopIds"/.exec(FORM);
    assert.ok(checkbox, "the shop checkboxes are gone");
    assert.ok(
      FORM.indexOf("showShops") < checkbox.index,
      "the shop checkboxes are rendered outside the role condition",
    );
  });

  test("4. the form is still a Client Component with no server import", () => {
    assert.match(FORM, /^\s*["']use client["']/m);
    for (const forbidden of [
      "@/lib/supabase/admin",
      "@/lib/supabase/server",
      "@/lib/staff/retailer-staff-invitations",
      "@/lib/staff/staff-invitation-email",
      "@/lib/features/retailer-staff-invitations",
      "node:crypto",
    ]) {
      assert.ok(!FORM.includes(`from "${forbidden}"`), `the form imports ${forbidden}`);
    }
  });
});

describe("the Server Action's shape is unchanged", () => {
  test("5. it still reads the same FormData fields, with getAll for the checkboxes", () => {
    for (const field of ["firstName", "lastName", "email", "roleCode"]) {
      assert.ok(
        ACTIONS_CODE.includes(`readField(formData, "${field}")`),
        `the action no longer reads ${field}`,
      );
    }
    assert.ok(
      ACTIONS_CODE.includes(`formData.getAll("shopIds")`),
      "the action no longer reads the shop checkbox group",
    );
  });

  test("6. it still validates against the assignable shop set BEFORE delegating", () => {
    // This is the one client-side rule that is a security property: a submitted shop id
    // is accepted only if it appears in what list_retailer_staff_assignable_shops() just
    // returned for THIS caller. The Edge Function and the reservation RPC re-check
    // ownership independently, but the operator's field-level message comes from here.
    const assignableAt = ACTIONS_CODE.indexOf("getRetailerStaffAssignableShops()");
    const validateAt = ACTIONS_CODE.indexOf("validateStaffInviteInput(");
    const sendAt = ACTIONS_CODE.indexOf("sendRetailerStaffInvitation(");
    assert.ok(assignableAt > -1, "the assignable-shop read is gone");
    assert.ok(validateAt > assignableAt, "validation no longer uses the assignable set");
    assert.ok(sendAt > validateAt, "the send happens before validation");
  });

  test("7. the feature gate still runs before anything touches the database", () => {
    const flagAt = ACTIONS_CODE.indexOf("isRetailerStaffInvitationsEnabled()");
    const accessAt = ACTIONS_CODE.indexOf("getRetailerPortalAccess()");
    assert.ok(flagAt > -1 && flagAt < accessAt, "the feature gate moved or vanished");
  });

  test("8. the resend path still supplies only an invitation id from the browser", () => {
    // The recipient, names, role and shop set are re-read from the database, so a
    // hand-crafted POST cannot redirect a resend to another address or widen its shops.
    const resend =
      /export async function resendStaffInvitationAction[\s\S]*?\n}/.exec(ACTIONS_CODE)?.[0] ??
      "";
    assert.ok(resend.length > 0, "the resend action is gone");
    assert.ok(
      resend.includes(`readField(formData, "invitationId")`),
      "the resend action reads something other than an invitation id",
    );
    for (const field of ["firstName", "lastName", "email", "roleCode", "shopIds"]) {
      assert.ok(
        !new RegExp(`readField\\(formData, "${field}"\\)`).test(resend),
        `the resend action reads ${field} from the browser`,
      );
    }
    assert.ok(
      /invitation\.(email|firstName|lastName|roleCode|shopIds)/.test(resend),
      "the resend action no longer re-reads the invitation from the database",
    );
  });

  test("9. every outcome the send module can return has a user-facing message", () => {
    // A missing case would fall through to the generic error and silently mislabel a
    // successful delivery — which is exactly the risk the partial-success outcome adds.
    const statuses = [
      "sent",
      "resent",
      "sent-unconfirmed",
      "delivery-failed",
      "misconfigured",
      "conflict",
      "paused",
      "rejected",
      "unavailable",
    ];
    const declared = /export type StaffInviteSendResult =([\s\S]*?);/.exec(SEND)?.[1] ?? "";
    for (const status of statuses) {
      assert.ok(declared.includes(`"${status}"`), `${status} is not a declared outcome`);
    }
    for (const status of ["sent", "resent", "sent-unconfirmed", "paused", "delivery-failed", "misconfigured", "conflict"]) {
      assert.ok(
        ACTIONS_CODE.includes(`case "${status}":`),
        `the invite action does not handle "${status}"`,
      );
    }
  });

  test("10. the partial success is presented as a SUCCESS that discourages a resend", () => {
    // Presenting it as an error would push the operator to send again, which rotates the
    // token and kills the link that has already been delivered.
    const message =
      /const DELIVERY_UNCONFIRMED_MESSAGE\s*=\s*\n?\s*"([^"]+)"/.exec(ACTIONS)?.[1] ?? "";
    assert.ok(message.length > 0, "the partial-success message is gone");
    assert.match(message, /accepted for delivery/i);
    assert.match(message, /invitation list/i);
    assert.match(message, /no need to send it again/i);

    const branch =
      /case "sent-unconfirmed":([\s\S]*?)case "paused":/.exec(ACTIONS_CODE)?.[1] ?? "";
    assert.ok(branch.includes("successMessage: DELIVERY_UNCONFIRMED_MESSAGE"));
    assert.ok(branch.includes("formError: null"), "it is rendered as an error");
  });

  test("11. the invitation list is revalidated for every outcome that touched the database", () => {
    assert.ok(
      ACTIONS_CODE.includes("revalidatePath(STAFF_PATH)"),
      "the staff page is no longer revalidated",
    );
    // The three outcomes that must NOT revalidate are the three where the Edge Function
    // refused before reserving anything.
    const guard =
      /if \(\s*result\.status !== "rejected" &&\s*result\.status !== "unavailable" &&\s*result\.status !== "paused"\s*\)/;
    assert.ok(
      guard.test(ACTIONS_CODE.replace(/\s+/g, " ").replace(/ &&/g, " &&\n")) ||
        (ACTIONS_CODE.includes(`result.status !== "paused"`) &&
          ACTIONS_CODE.includes(`result.status !== "rejected"`)),
      "the revalidation guard no longer excludes the no-op outcomes",
    );
  });
});

describe("the web process holds nothing privileged any more", () => {
  test("12. the send module calls the Edge Function with the CALLER'S token", () => {
    assert.ok(SEND_CODE.includes("send-retailer-staff-invitation"));
    assert.ok(
      /Authorization: `Bearer \$\{accessToken\}`/.test(SEND_CODE),
      "the caller's own access token is not forwarded",
    );
    // The publishable key is what the gateway expects; it is a public value.
    assert.ok(/apikey: publishableKey/.test(SEND_CODE));
    assert.ok(
      !/SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey/.test(SEND_CODE),
      "the send module names the service-role key",
    );
  });

  test("13. the send request carries no cookie", () => {
    // Deliberately bearer-token only: the CORS policy allows any origin precisely
    // because this endpoint carries no ambient authority.
    assert.ok(/credentials: "omit"/.test(SEND_CODE), "the send request may carry cookies");
  });

  test("14. the send module puts exactly the five contract fields on the wire", () => {
    const body = /body: JSON\.stringify\(\{([\s\S]*?)\}\)/.exec(SEND_CODE)?.[1] ?? "";
    assert.ok(body.length > 0, "the request body is gone");
    const keys = [...body.matchAll(/^\s*([A-Za-z]+):/gm)].map((match) => match[1]).sort();
    assert.deepEqual(keys, ["email", "firstName", "lastName", "roleCode", "shopIds"]);
    // Built field-by-field rather than by spreading, so an upstream field cannot ride along.
    assert.ok(!/\.\.\.input/.test(body), "the caller's object is spread into the body");
  });

  test("15. an unrecognized reply is an outage, not a guess", () => {
    assert.ok(
      SEND_CODE.includes("STAFF_INVITATION_CONTRACT_VERSION"),
      "the reply's contract version is not checked",
    );
    assert.ok(
      SEND_CODE.includes("isStaffInvitationCode("),
      "the reply's code is not validated against the contract",
    );
  });

  test("16. nothing from the reply is logged or rendered verbatim", () => {
    // A gateway error page can name the project; a provider body can name the recipient;
    // a transport throw carries the request headers, which include the access token.
    const callSites = SEND_CODE.split("\n")
      // The helper's own declaration is not a call site; its parameter is the sanitized
      // category the rule is about.
      .filter((line) => !/function\s+logStaffInviteFailure/.test(line))
      .flatMap((line) => [...line.matchAll(/logStaffInviteFailure\(\s*([^)]*)\)/g)])
      .map((match) => match[1].trim());
    assert.ok(callSites.length >= 5, `only ${callSites.length} sanitized log call sites`);
    for (const argument of callSites) {
      assert.match(argument, /^"[^"$]*"$/, `a log category is not a plain literal: ${argument}`);
    }

    // And the single console call itself interpolates only the sanitized category.
    const consoleLines = SEND_CODE.split("\n").filter((line) => /console\./.test(line));
    assert.equal(consoleLines.length, 1, "logging is no longer funnelled through one helper");
    for (const match of consoleLines[0].matchAll(/\$\{([^}]*)\}/g)) {
      assert.equal(match[1].trim(), "category", `the log line interpolates "${match[1]}"`);
    }
  });
});

describe("revoke and acceptance are untouched by this milestone", () => {
  test("17. revoke still calls its own RPC under the caller's token, and is not gated", () => {
    assert.ok(SEND_CODE.includes(`"revoke_retailer_staff_invitation"`));
    assert.ok(
      /supabase\.rpc\(REVOKE_RPC/.test(SEND_CODE),
      "revoke no longer runs under the caller's own client",
    );
    const revoke =
      /export async function revokeStaffInvitationAction[\s\S]*?\n}/.exec(ACTIONS_CODE)?.[0] ??
      "";
    assert.ok(revoke.length > 0, "the revoke action is gone");
    assert.ok(
      !revoke.includes("isRetailerStaffInvitationsEnabled"),
      "revoke became feature-gated — a kill switch must not be switchable off",
    );
  });

  test("18. the token intake route still hashes, cookies, and redirects clean", () => {
    const intake = stripComments(read(INTAKE_PATH));
    assert.ok(intake.includes("hashInvitationToken("), "the token is no longer hashed here");
    assert.ok(
      intake.includes("STAFF_INVITE_COOKIE") && intake.includes("staffInviteCookieOptions()"),
      "the hash is no longer stored in the scoped cookie",
    );
    assert.ok(
      /url\.search = ""/.test(intake),
      "the redirect no longer strips the token from the URL",
    );
    assert.ok(
      /Referrer-Policy"?,\s*"no-referrer"/.test(intake),
      "the no-referrer header is gone",
    );
    // And the raw token is never logged or rendered.
    assert.ok(!/console\./.test(intake), "the intake route logs");
  });

  test("19. the acceptance path is unchanged and still token-driven", () => {
    const accept = stripComments(read(ACCEPT_ACTIONS_PATH));
    const acceptance = stripComments(read("lib/staff/staff-acceptance.ts"));

    assert.ok(
      accept.includes("acceptStaffInvitation("),
      "the acceptance action no longer delegates to the acceptance module",
    );
    assert.ok(
      acceptance.includes("accept_retailer_staff_invitation"),
      "acceptance no longer uses the existing acceptance RPC",
    );
    // Acceptance is driven by the HASH read from the scoped cookie, not by anything the
    // delivery milestone introduced.
    assert.ok(/tokenHash/.test(accept), "acceptance is no longer keyed by the token hash");
    for (const source of [accept, acceptance]) {
      assert.ok(
        !source.includes("send-retailer-staff-invitation"),
        "acceptance was rewired through the delivery function",
      );
    }
  });

  test("20. the invitation controls still submit only an invitation id", () => {
    const controls = read(CONTROLS_PATH);
    const hidden = controls.match(/type="hidden"[\s\S]{0,160}?name="([a-zA-Z]+)"/g) ?? [];
    const names = [
      ...new Set(hidden.map((match) => /name="([a-zA-Z]+)"/.exec(match)?.[1] ?? "")),
    ];
    assert.deepEqual(names, ["invitationId"]);
  });
});
