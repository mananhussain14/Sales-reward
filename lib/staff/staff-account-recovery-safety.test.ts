/**
 * SOURCE-LEVEL SAFETY GUARDS for staff account recovery.
 *
 * Run with:  npm test
 *
 * WHAT THESE ARE, AND WHAT THEY ARE NOT. They read this milestone's own source files and
 * assert structural properties that no Node unit test can observe at runtime — the
 * modules involved import `next/headers`, the service-role client and `next/navigation`,
 * so none of them can be loaded here at all. They are NOT proof that a recovery email
 * arrives or that a password is accepted; that is the hosted verification recorded in
 * docs/retailer-staff-account-recovery-audit.md § J.
 *
 * The property they exist to hold shut is this: an invitation token may never become an
 * account credential. Concretely —
 *
 *   1. RECOVERY_REQUIRED never reaches first-password activation.
 *   2. The address is always resolved SERVER-SIDE; no form field can nominate one.
 *   3. The recovery landing verifies its token and grants nothing else.
 *   4. Completing recovery does not accept the invitation.
 *   5. No redirect target is caller-controlled.
 *   6. No token, hash, email, auth user id or backend message reaches a log or the UI.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const REGISTRATION = "lib/staff/staff-registration.ts";
const STATE_MODULE = "lib/staff/staff-account-state.ts";
const STAFF_PAGE = "app/invitations/staff/page.tsx";
const STAFF_FORMS = "app/invitations/staff/accept-forms.tsx";
const STAFF_ACTIONS = "app/invitations/staff/actions.ts";
const RECOVER_ROUTE = "app/invitations/staff/recover/route.ts";
const SET_PASSWORD_PAGE = "app/invitations/staff/set-password/page.tsx";
const SET_PASSWORD_ACTIONS = "app/invitations/staff/set-password/actions.ts";
const SET_PASSWORD_FORM = "app/invitations/staff/set-password/set-password-form.tsx";
const PROXY_ROUTING = "lib/supabase/proxy-routing.ts";
const MIGRATION =
  "supabase/migrations/20260808090000_repair_retailer_staff_registration_context.sql";
const RECOVERY_TEMPLATE = "supabase/templates/recovery.html";

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Strips SQL comments, for the migration. */
function stripSqlComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, "");
}

const REGISTRATION_CODE = stripComments(read(REGISTRATION));
const ACTIONS_CODE = stripComments(read(STAFF_ACTIONS));
const RECOVER_CODE = stripComments(read(RECOVER_ROUTE));
const SET_PASSWORD_CODE = stripComments(read(SET_PASSWORD_ACTIONS));
const MIGRATION_SQL = stripSqlComments(read(MIGRATION));

/* ===========================================================================
 * 1. THE STATE GATE
 * ========================================================================= */

describe("first-password activation is gated by the state, in code", () => {
  test("1. activation consults the shared predicate rather than an inline comparison", () => {
    assert.ok(
      REGISTRATION_CODE.includes("allowsFirstPasswordActivation("),
      "activation does not use the shared permission predicate",
    );
    assert.ok(
      REGISTRATION_CODE.includes("allowsPasswordRecovery("),
      "recovery does not use the shared permission predicate",
    );
  });

  test("2. RECOVERY_REQUIRED is refused BEFORE any Auth write", () => {
    const activate =
      /export async function activateInvitedStaffAccount[\s\S]*?\n}/.exec(
        REGISTRATION_CODE,
      )?.[0] ?? "";
    assert.ok(activate.length > 0, "the activation function is gone");

    const recoveryGuardAt = activate.indexOf("allowsPasswordRecovery(");
    const createAt = activate.indexOf("createUser(");
    const updateAt = activate.indexOf("updateUserById(");

    assert.ok(recoveryGuardAt > -1, "activation does not check for the recovery state");
    assert.ok(createAt > -1 && updateAt > -1, "activation performs no Auth write at all");
    assert.ok(recoveryGuardAt < createAt, "the guard runs after account creation");
    assert.ok(recoveryGuardAt < updateAt, "the guard runs after the password update");
  });

  test("3. activation is refused for every state the predicate does not admit", () => {
    const activate =
      /export async function activateInvitedStaffAccount[\s\S]*?\n}/.exec(
        REGISTRATION_CODE,
      )?.[0] ?? "";
    assert.ok(
      /if \(!allowsFirstPasswordActivation\([\s\S]{0,120}?return \{ status: "unavailable" \}/.test(
        activate,
      ),
      "an unadmitted state is not refused outright",
    );
  });

  test("4. the recovery request refuses every state except RECOVERY_REQUIRED", () => {
    const request =
      /export async function requestInvitedStaffPasswordRecovery[\s\S]*?\n}/.exec(
        REGISTRATION_CODE,
      )?.[0] ?? "";
    assert.ok(request.length > 0, "the recovery request function is gone");

    const guardAt = request.indexOf("allowsPasswordRecovery(");
    const sendAt = request.indexOf("resetPasswordForEmail(");
    assert.ok(guardAt > -1 && sendAt > -1);
    assert.ok(guardAt < sendAt, "the recovery email is sent before the state is checked");
  });

  test("5. the Server Action refuses the recovery state rather than activating", () => {
    // A Server Action is a public endpoint: a hand-crafted POST reaches it regardless of
    // which screen was rendered.
    assert.ok(
      ACTIONS_CODE.includes(`result.status === "recovery-required"`),
      "the activation action does not handle the recovery state",
    );
    assert.ok(
      !/requestInvitedStaffPasswordRecovery/.test(
        /export async function activateStaffAccountAction[\s\S]*?\n}/.exec(ACTIONS_CODE)?.[0] ??
          "",
      ),
      "the activation action can itself trigger recovery mail",
    );
  });
});

/* ===========================================================================
 * 2. THE ADDRESS IS ALWAYS SERVER-RESOLVED
 * ========================================================================= */

describe("the browser cannot nominate an address", () => {
  test("6. the recovery action reads NO form field at all", () => {
    const action =
      /export async function requestStaffPasswordRecoveryAction[\s\S]*?\n}/.exec(
        ACTIONS_CODE,
      )?.[0] ?? "";
    assert.ok(action.length > 0, "the recovery action is gone");
    assert.ok(!/formData\.get\(/.test(action), "the recovery action reads a form field");
    assert.ok(
      /readStaffInviteHash\(\)/.test(action),
      "the recovery action does not read the invitation cookie",
    );
  });

  test("7. its formData parameter is unused, by name", () => {
    assert.ok(
      /requestStaffPasswordRecoveryAction\(\s*_prevState: StaffRecoveryState,\s*_formData: FormData,/.test(
        ACTIONS_CODE,
      ),
      "the recovery action's form parameter is not marked unused",
    );
  });

  test("8. the address comes only from the service-role recipient RPC", () => {
    assert.ok(
      REGISTRATION_CODE.includes(`"resolve_retailer_staff_invitation_recipient"`),
      "the recipient RPC is not called",
    );
    assert.ok(
      /resetPasswordForEmail\(invitedEmail/.test(REGISTRATION_CODE),
      "recovery is not sent to the server-resolved address",
    );
    // No exported function may take an address.
    for (const match of REGISTRATION_CODE.matchAll(
      /export async function (\w+)\(([^)]*)\)/g,
    )) {
      assert.ok(
        !/email/i.test(match[2]),
        `${match[1]} accepts an address as a parameter: ${match[2]}`,
      );
    }
  });

  test("9. no export returns the invited address", () => {
    // Every declared result type is checked: none carries an email field.
    for (const match of REGISTRATION_CODE.matchAll(/export type (\w+)\s*=([\s\S]*?);/g)) {
      assert.ok(
        !/email/i.test(match[2]),
        `${match[1]} carries an address: ${match[2].trim()}`,
      );
    }
  });

  test("10. no Client Component imports the registration module", () => {
    for (const path of [STAFF_FORMS, SET_PASSWORD_FORM]) {
      const source = read(path);
      assert.ok(/^\s*["']use client["']/m.test(source), `${path} is not a Client Component`);
      assert.ok(
        !source.includes("@/lib/staff/staff-registration"),
        `${path} imports the server-only registration module`,
      );
      assert.ok(
        !source.includes("@/lib/supabase/admin"),
        `${path} imports the service-role client`,
      );
    }
  });

  test("11. no Client Component in this flow names an email field or a state", () => {
    for (const path of [STAFF_FORMS, SET_PASSWORD_FORM]) {
      const code = stripComments(read(path));
      assert.ok(!/name="email"/.test(code), `${path} submits an email field`);
      assert.ok(
        !/RECOVERY_REQUIRED|ACTIVATION_REQUIRED|NO_ACCOUNT|ACCOUNT_BLOCKED/.test(code),
        `${path} renders an internal account state`,
      );
    }
  });
});

/* ===========================================================================
 * 3. THE RECOVERY LANDING GRANTS NOTHING BEYOND A SESSION
 * ========================================================================= */

describe("the recovery landing verifies, and does nothing else", () => {
  test("12. it verifies the token server-side with the recovery type only", () => {
    assert.ok(
      /verifyOtp\(\{\s*type: RECOVERY_TYPE,\s*token_hash: tokenHash,\s*\}\)/.test(
        RECOVER_CODE,
      ),
      "the landing does not verify the token server-side",
    );
    assert.ok(
      /const RECOVERY_TYPE = "recovery"/.test(RECOVER_CODE),
      "the OTP type is not pinned to recovery",
    );
    assert.ok(
      /type !== RECOVERY_TYPE/.test(RECOVER_CODE),
      "a token minted for another flow could be replayed here",
    );
  });

  test("13. it neither accepts the invitation nor sets a password", () => {
    for (const forbidden of [
      "accept_retailer_staff_invitation",
      "acceptStaffInvitation",
      "updateUser",
      "createUser",
      "admin",
      "readStaffInviteHash",
      "clearStaffInviteCookie",
    ]) {
      assert.ok(
        !RECOVER_CODE.includes(forbidden),
        `the recovery landing references ${forbidden}`,
      );
    }
  });

  test("14. it uses the publishable-key server client, never the service role", () => {
    assert.ok(
      RECOVER_CODE.includes(`from "@/lib/supabase/server"`),
      "the landing does not use the ordinary server client",
    );
    assert.ok(
      !/SUPABASE_SERVICE_ROLE_KEY|createAdminClient/.test(RECOVER_CODE),
      "the landing reaches for the service role",
    );
  });

  test("15. the token is stripped from every outgoing URL, with no-referrer", () => {
    assert.ok(/url\.search = ""/.test(RECOVER_CODE), "the token survives the redirect");
    assert.ok(
      /Referrer-Policy"?,\s*"no-referrer"/.test(RECOVER_CODE),
      "the landing does not set no-referrer",
    );
  });

  test("16. the landing is reachable without a session; the next step is not", () => {
    const routing = stripComments(read(PROXY_ROUTING));
    assert.ok(
      routing.includes(`"/invitations/staff/recover"`),
      "the recovery landing is not on the public allowlist, so it would bounce to /login",
    );
    assert.ok(
      !routing.includes(`"/invitations/staff/set-password"`),
      "the set-password page is public; it must require the recovery session",
    );
  });
});

/* ===========================================================================
 * 4. NO OPEN REDIRECT ANYWHERE IN THE FLOW
 * ========================================================================= */

describe("no redirect target is caller-controlled", () => {
  const REDIRECTING = [
    [RECOVER_ROUTE, RECOVER_CODE],
    [SET_PASSWORD_ACTIONS, SET_PASSWORD_CODE],
    [SET_PASSWORD_PAGE, stripComments(read(SET_PASSWORD_PAGE))],
  ] as const;

  test("17. no redirecting module reads a next/redirectTo/returnUrl parameter", () => {
    for (const [path, code] of REDIRECTING) {
      assert.ok(
        !/searchParams|nextUrl\.searchParams\.get\(\s*["'](next|redirectTo|returnUrl|return_to)["']/.test(
          code.replace(/searchParams\.get\("token_hash"\)|searchParams\.get\("type"\)/g, ""),
        ),
        `${path} reads a caller-supplied destination`,
      );
    }
  });

  test("18. every redirect argument is a module constant or a fixed literal", () => {
    for (const [path, code] of REDIRECTING) {
      for (const match of code.matchAll(/redirect\(([^)]*)\)/g)) {
        const argument = match[1].trim();
        // The `[^)]*` capture truncates a nested call, so `redirectTo(request, X)`
        // arrives here without its closing paren. Both spellings are accepted; what
        // matters is that the destination is a module constant either way.
        assert.ok(
          /^[A-Z_]+$/.test(argument) ||
            /^redirectTo\(request, [A-Z_]+\)?$/.test(argument) ||
            /^["'][^"'$]*["']$/.test(argument),
          `${path} redirects to a non-constant: ${argument}`,
        );
      }
    }
  });

  test("19. the recovery redirect the app requests is a fixed internal path", () => {
    assert.ok(
      /const STAFF_RECOVERY_LANDING_PATH = "\/invitations\/staff\/recover"/.test(
        REGISTRATION_CODE,
      ),
      "the recovery landing path is not a fixed constant",
    );
    assert.ok(
      /redirectTo: `\$\{appOrigin\}\$\{STAFF_RECOVERY_LANDING_PATH\}`/.test(
        REGISTRATION_CODE,
      ),
      "the redirect is not built from APP_ORIGIN and the fixed path",
    );
    // APP_ORIGIN itself is validated before use — an absolute https origin, or loopback.
    assert.ok(
      /function readAppOrigin\(\)/.test(REGISTRATION_CODE),
      "APP_ORIGIN is used without validation",
    );
  });

  test("20. the emailed link lands under the invitation cookie's own path", () => {
    // A recovery link landing anywhere else would arrive without the invitation hash and
    // strand the person exactly as the defect being fixed did.
    // HTML comments are stripped first: the template's own header explains why the
    // fragment-based default is not used, and that prose must not trip this rule.
    const template = read(RECOVERY_TEMPLATE).replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(
      template.includes("{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery"),
      "the recovery template does not emit a server-verifiable token link",
    );
    assert.ok(
      !template.includes("{{ .ConfirmationURL }}"),
      "the recovery template uses the fragment-based default link",
    );
    assert.ok(
      REGISTRATION_CODE.includes('"/invitations/staff/recover"'),
      "the landing path is not under /invitations/staff",
    );
  });
});

/* ===========================================================================
 * 5. COMPLETION DOES NOT ACCEPT THE INVITATION
 * ========================================================================= */

describe("setting a password is not accepting an invitation", () => {
  test("21. the completion action updates the password on the session, and nothing else", () => {
    assert.ok(
      /supabase\.auth\.updateUser\(\{\s*password:/.test(SET_PASSWORD_CODE),
      "the completion action does not update the password",
    );
    // No email parameter: the session already identifies exactly one account.
    assert.ok(
      !/updateUser\(\{[^}]*email/.test(SET_PASSWORD_CODE),
      "the completion action passes an address to updateUser",
    );
  });

  test("22. it never calls the acceptance RPC or the acceptance module", () => {
    for (const forbidden of [
      "accept_retailer_staff_invitation",
      "acceptStaffInvitation",
      "staff-acceptance",
      "readStaffInviteHash",
      "clearStaffInviteCookie",
      "createAdminClient",
    ]) {
      assert.ok(
        !SET_PASSWORD_CODE.includes(forbidden),
        `the completion action references ${forbidden}`,
      );
    }
  });

  test("23. it returns to the invitation flow, where the exact-email check still applies", () => {
    assert.ok(
      /const RETURN_PATH = "\/invitations\/staff"/.test(SET_PASSWORD_CODE),
      "the completion action does not return to the invitation",
    );
    // And the acceptance path is unchanged: acceptance still runs through the RPC.
    const acceptance = stripComments(read("lib/staff/staff-acceptance.ts"));
    assert.ok(
      acceptance.includes("accept_retailer_staff_invitation"),
      "acceptance no longer uses the existing acceptance RPC",
    );
  });

  test("24. it requires a verified session, and re-checks it in the action", () => {
    assert.ok(
      /getClaims\(\)/.test(SET_PASSWORD_CODE),
      "the completion action does not verify the session",
    );
    assert.ok(
      !/getSession\(\)/.test(SET_PASSWORD_CODE),
      "the completion action trusts getSession()",
    );
    // An expired or consumed recovery session lands on the generic failure page.
    assert.ok(
      /if \(!signedIn\) \{\s*redirect\(FAILURE_PATH\);/.test(SET_PASSWORD_CODE),
      "a caller with no session is not refused",
    );

    const page = stripComments(read(SET_PASSWORD_PAGE));
    assert.ok(/getClaims\(\)/.test(page), "the page does not verify the session either");
    assert.ok(/redirect\(FAILURE_PATH\)/.test(page), "the page admits a session-less visitor");
  });
});

/* ===========================================================================
 * 6. NOTHING SENSITIVE REACHES A LOG OR THE UI
 * ========================================================================= */

describe("nothing sensitive is logged or rendered", () => {
  const LOGGING_MODULES = [
    [REGISTRATION, REGISTRATION_CODE],
    [STAFF_ACTIONS, ACTIONS_CODE],
    [RECOVER_ROUTE, RECOVER_CODE],
    [SET_PASSWORD_ACTIONS, SET_PASSWORD_CODE],
  ] as const;

  test("25. every log call passes a fixed literal and interpolates nothing sensitive", () => {
    const FORBIDDEN =
      /\b(tokenHash|token_hash|rawToken|invitedEmail|email|password|userId|user_id|accountState|error|err|result|data|session|claims|updated|created|sent)\b/;
    let sites = 0;

    for (const [path, code] of LOGGING_MODULES) {
      for (const line of code.split("\n")) {
        if (!/console\.(log|error|warn|info|debug)/.test(line)) continue;
        sites += 1;
        const firstArg = (
          /console\.(?:log|error|warn|info|debug)\s*\(\s*([^)]*)/.exec(line)?.[1] ?? ""
        ).trim();
        assert.ok(/^[`"']/.test(firstArg), `${path} logs a non-literal: ${line.trim()}`);
        for (const match of line.matchAll(/\$\{([^}]*)\}/g)) {
          assert.ok(
            !FORBIDDEN.test(match[1]),
            `${path} interpolates forbidden material: ${match[1]}`,
          );
        }
      }
    }

    assert.ok(sites >= 5, `only ${sites} log sites — the rule is near-vacuous`);

    // The registration module funnels through one helper, so its console count is 1 no
    // matter how many failures it reports. Its CALL sites are what must stay sanitized.
    const helperCalls = [
      ...REGISTRATION_CODE.matchAll(/logRegistrationFailure\(\s*([^)]*)\)/g),
    ]
      .map((match) => match[1].trim())
      .filter((argument) => argument !== "category: string");
    assert.ok(helperCalls.length >= 8, `only ${helperCalls.length} sanitized log calls`);
    for (const argument of helperCalls) {
      assert.match(argument, /^"[^"$]*"$/, `a log category is not a plain literal: ${argument}`);
    }
  });

  test("26. a caught error is bound only for an instanceof check, never used", () => {
    // An Auth error can echo the identifier; a transport throw can carry the password.
    // The one legitimate binding in this flow is the configuration-error type test in
    // the registration module, which reads the error's CLASS and nothing else.
    for (const [path, code] of LOGGING_MODULES) {
      for (const match of code.matchAll(/catch\s*\((\w+)\)\s*\{([\s\S]*?)\n  \}/g)) {
        const bound = match[1];
        const body = match[2];
        const uses = [...body.matchAll(new RegExp(`\\b${bound}\\b`, "g"))].length;
        const typeChecks = [
          ...body.matchAll(new RegExp(`${bound} instanceof `, "g")),
        ].length;
        assert.equal(
          uses,
          typeChecks,
          `${path} uses the caught error for something other than instanceof`,
        );
      }
    }
  });

  test("27. no user-facing string names an internal state or reason", () => {
    // ACCOUNT_BLOCKED in particular must expose nothing: banned, deleted and ambiguous
    // are indistinguishable to the person, by design.
    const page = stripComments(read(STAFF_PAGE));
    for (const forbidden of [
      "ACCOUNT_BLOCKED",
      "RECOVERY_REQUIRED",
      "ACTIVATION_REQUIRED",
      "NO_ACCOUNT",
      "banned",
      "deleted",
      "unconfirmed",
      "encrypted_password",
      "auth.users",
    ]) {
      assert.ok(
        !page.includes(forbidden),
        `the invitation page renders the internal detail "${forbidden}"`,
      );
    }
  });

  test("28. the blocked screen offers no control and no reason", () => {
    const page = read(STAFF_PAGE);
    const blocked =
      /if \(view === "blocked"\) \{([\s\S]*?)\n    \}/.exec(page)?.[1] ?? "";
    assert.ok(blocked.length > 0, "the blocked screen is gone");
    assert.ok(/support/i.test(blocked), "the blocked screen does not point anywhere");
    // No form, no action, no link that could retry something the person cannot fix.
    assert.ok(!/<form|Form|action=/.test(blocked), "the blocked screen offers a control");
  });
});

/* ===========================================================================
 * 7. THE MIGRATION'S OWN DISCLOSURE SURFACE
 * ========================================================================= */

describe("the repaired RPC returns the minimum", () => {
  test("29. the context function returns only a state and an expiry", () => {
    const signature =
      /create function public\.get_retailer_staff_registration_context\([\s\S]*?returns table \(([\s\S]*?)\)/.exec(
        MIGRATION_SQL,
      )?.[1] ?? "";
    assert.ok(signature.length > 0, "the context function is gone");

    const columns = [...signature.matchAll(/^\s*(\w+)\s+\w/gm)].map((match) => match[1]);
    assert.deepEqual(columns, ["account_state", "expires_at"]);
  });

  test("30. it returns no address, id, or password information", () => {
    const body =
      /create function public\.get_retailer_staff_registration_context[\s\S]*?\$\$;/.exec(
        MIGRATION_SQL,
      )?.[0] ?? "";
    const returned = /return query select ([\s\S]*?);/.exec(body)?.[1] ?? "";
    assert.ok(returned.length > 0, "the function returns nothing");
    for (const forbidden of ["email", "id", "password", "token"]) {
      assert.ok(
        !returned.includes(forbidden),
        `the context function returns ${forbidden}: ${returned.trim()}`,
      );
    }
  });

  test("31. it inspects the password's EXISTENCE only, never its value", () => {
    const body =
      /create function public\.get_retailer_staff_registration_context[\s\S]*?\$\$;/.exec(
        MIGRATION_SQL,
      )?.[0] ?? "";
    // The only permitted shape is the emptiness comparison.
    for (const line of body.split("\n")) {
      if (!line.includes("encrypted_password")) continue;
      assert.ok(
        /coalesce\(u\.encrypted_password, ''\) <> ''/.test(line),
        `encrypted_password is used in an unexpected way: ${line.trim()}`,
      );
    }
  });

  test("32. all three functions are service_role-only, with an empty search_path", () => {
    for (const fn of [
      "get_retailer_staff_registration_context",
      "resolve_retailer_staff_invitation_recipient",
    ]) {
      assert.ok(
        new RegExp(`revoke execute on function public\\.${fn}\\(text\\) from anon`).test(
          MIGRATION_SQL,
        ),
        `${fn} is not revoked from anon`,
      );
      assert.ok(
        new RegExp(
          `revoke execute on function public\\.${fn}\\(text\\) from authenticated`,
        ).test(MIGRATION_SQL),
        `${fn} is not revoked from authenticated`,
      );
      assert.ok(
        new RegExp(`grant  execute on function public\\.${fn}\\(text\\) to service_role`).test(
          MIGRATION_SQL,
        ),
        `${fn} is not granted to service_role`,
      );
    }

    // The internal gate is callable by NOBODY directly, including service_role.
    assert.ok(
      /revoke execute on function public\.retailer_staff_invitation_gate\(text\) from service_role/.test(
        MIGRATION_SQL,
      ),
      "the internal gate is directly callable",
    );

    const definers = [...MIGRATION_SQL.matchAll(/create function public\.(\w+)/g)].map(
      (match) => match[1],
    );
    assert.equal(definers.length, 3, `expected three functions, found ${definers.length}`);
    assert.equal(
      (MIGRATION_SQL.match(/set search_path = ''/g) ?? []).length,
      3,
      "not every function pins an empty search_path",
    );
  });

  test("33. it writes nothing and audits nothing", () => {
    for (const forbidden of [
      "insert into",
      "update public.",
      "delete from",
      "audit_logs",
    ]) {
      assert.ok(
        !MIGRATION_SQL.toLowerCase().includes(forbidden),
        `the migration performs a write: ${forbidden}`,
      );
    }
    assert.equal(
      (MIGRATION_SQL.match(/\bstable\b/g) ?? []).length,
      3,
      "not every function is declared STABLE",
    );
  });

  test("34. it drops exactly the one function it repairs, and no other", () => {
    const drops = [...MIGRATION_SQL.matchAll(/drop function ([^\s;]+)/g)].map((m) => m[1]);
    assert.deepEqual(drops, ["public.get_retailer_staff_registration_context(text)"]);
  });

  test("35. the provisioned-identity check covers all three tables", () => {
    // profiles, organization_members and member_roles are what
    // finalize_retailer_owner_invitation creates before a password ever exists. Missing
    // any one of them would classify a half-built identity as a safe empty shell.
    for (const table of [
      "public.profiles",
      "public.organization_members",
      "public.member_roles",
    ]) {
      assert.ok(
        MIGRATION_SQL.includes(table),
        `the provisioned-identity check does not consult ${table}`,
      );
    }
  });

  test("36. the state vocabulary in SQL matches the TypeScript one exactly", () => {
    const stateModule = read(STATE_MODULE);
    const sqlStates = new Set(
      [...MIGRATION_SQL.matchAll(/v_state := '([A-Z_]+)'/g)].map((match) => match[1]),
    );
    assert.equal(sqlStates.size, 5, `SQL emits ${sqlStates.size} states`);
    for (const state of sqlStates) {
      assert.ok(
        stateModule.includes(`"${state}"`),
        `SQL can emit ${state}, which the TypeScript vocabulary does not declare`,
      );
    }
  });
});
