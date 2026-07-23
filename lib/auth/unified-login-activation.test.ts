/**
 * SOURCE-LEVEL GUARDS for the unified login and password-only staff activation flow.
 *
 * Run with:  npm test
 *
 * These read the milestone's own source files and assert properties no unit test can
 * observe at runtime, but that a careless later edit could quietly break:
 *
 *   1. The login page is ROLE-NEUTRAL — no Vendor-only wording renders.
 *   2. The activation form asks for a PASSWORD ONLY — there is no email field.
 *   3. The invited email is obtained ONLY from the server-side service-role RPC, and
 *      cannot reach a Client Component.
 *   4. No email, raw token, token hash or password is ever logged.
 *   5. An existing account is offered SIGN-IN, not account creation.
 *   6. Signup uses the CANONICAL invitation email, never form input.
 *   7. Acceptance still calls only the acceptance RPC.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Only the text a browser actually renders: JSX text nodes and string literals. */
function renderedText(source: string): string {
  return stripComments(source);
}

const LOGIN_PAGE = "app/login/page.tsx";
const LOGIN_FORM = "app/login/login-form.tsx";
const STAFF_PAGE = "app/invitations/staff/page.tsx";
const STAFF_FORMS = "app/invitations/staff/accept-forms.tsx";
const STAFF_ACTIONS = "app/invitations/staff/actions.ts";
const REGISTRATION_MODULE = "lib/staff/staff-registration.ts";

describe("the login page is universal", () => {
  test("1. it renders the neutral SalesReward wording", () => {
    const page = read(LOGIN_PAGE);
    assert.ok(page.includes("Sign in to SalesReward"), "missing the neutral heading");
    assert.ok(
      page.includes("Enter your email and password to continue"),
      "missing the neutral subheading",
    );
  });

  test("2. no Vendor-only wording is rendered", () => {
    // Comments may discuss why the old wording was removed; markup may not carry it.
    const rendered = renderedText(read(LOGIN_PAGE));
    for (const phrase of [
      "Vendor Admin sign in",
      "Enter your credentials to access the admin",
      "Vendor Admin · v0.1",
      "Vendor Admin",
    ]) {
      assert.ok(!rendered.includes(phrase), `login page still renders "${phrase}"`);
    }
  });

  test("3. neither the page nor the form names any role at all", () => {
    for (const path of [LOGIN_PAGE, LOGIN_FORM]) {
      const rendered = renderedText(read(path));
      for (const role of [
        "Retailer Owner",
        "Retailer Manager",
        "Sales Staff",
        "VENDOR_SUPER_ADMIN",
        "RETAILER_OWNER",
        "SALES_STAFF",
      ]) {
        assert.ok(!rendered.includes(role), `${path} renders the role "${role}"`);
      }
    }
  });

  test("4. the page validates `next` and the action re-validates it on receipt", () => {
    // Two independent filters: the page will not put an unsafe value in the hidden
    // field, and the action will not honour one that arrives anyway.
    assert.ok(read(LOGIN_PAGE).includes("resolveSafeNextPath"));
    assert.ok(read("app/login/actions.ts").includes("resolveSafeNextPath"));
  });

  test("5. the destination comes from the server-side landing resolver", () => {
    const action = stripComments(read("app/login/actions.ts"));
    assert.ok(action.includes("resolveAuthenticatedLanding"));
    // No role string is compared anywhere in the sign-in action.
    for (const role of ["VENDOR_SUPER_ADMIN", "RETAILER_OWNER", "RETAILER_MANAGER", "SALES_STAFF"]) {
      assert.ok(!action.includes(role), `the sign-in action branches on "${role}"`);
    }
  });
});

describe("the activation form is password-only", () => {
  const forms = read(STAFF_FORMS);

  test("6. it renders a password and a confirm-password field", () => {
    const activation = forms.slice(forms.indexOf("ActivateStaffAccountForm"));
    assert.ok(activation.includes('name="password"'), "no password field");
    assert.ok(activation.includes('name="confirmPassword"'), "no confirmation field");
  });

  test("7. it renders NO email field anywhere in the staff invitation forms", () => {
    const rendered = renderedText(forms);
    assert.ok(!/name="email"/.test(rendered), "an email input is still rendered");
    assert.ok(!/type="email"/.test(rendered), "an email input type is still rendered");
    assert.ok(!/autoComplete="email"/.test(rendered), "an email autocomplete remains");
  });

  test("8. no hidden field carries a token, hash or email", () => {
    const rendered = renderedText(forms);
    assert.ok(!/type="hidden"/.test(rendered), "the staff forms introduce a hidden field");
  });

  test("9. the password-entry branch offers no Sign in control", () => {
    // Someone with no account cannot sign in, and offering it alongside the password
    // fields would hint that their address might already be registered. The sign-in
    // prompt appears ONLY on the already-registered branch, which is a different
    // screen — so the assertion is scoped to the <form> the password fields live in.
    const start = forms.indexOf("export function ActivateStaffAccountForm");
    const end = forms.indexOf("export function StaffInvitationSignInPrompt");
    assert.ok(start >= 0 && end > start, "the two components must both exist");

    const activation = forms.slice(start, end);
    const formStart = activation.indexOf("<form");
    assert.ok(formStart >= 0, "the activation form must render a <form>");

    const passwordBranch = activation.slice(formStart);
    assert.ok(
      !/Sign in/.test(passwordBranch),
      "the password-entry branch offers a Sign in control",
    );
    assert.ok(
      !/StaffInvitationSignInPrompt/.test(passwordBranch),
      "the password-entry branch renders the sign-in prompt",
    );
  });

  test("10. minLength comes from the shared policy, not a literal", () => {
    assert.ok(forms.includes("minLength={MIN_PASSWORD_LENGTH}"));
    assert.ok(!/minLength=\{\d+\}/.test(forms), "a hard-coded minLength remains");
  });
});

describe("the invited email is server-only", () => {
  test("11. the registration registration is the only place the context RPC is named", () => {
    assert.ok(
      read(REGISTRATION_MODULE).includes('"get_retailer_staff_registration_context"'),
    );
    for (const path of [STAFF_PAGE, STAFF_FORMS, STAFF_ACTIONS]) {
      assert.ok(
        !stripComments(read(path)).includes('"get_retailer_staff_registration_context"'),
        `${path} calls the registration-context RPC directly`,
      );
    }
  });

  test("12. the PAGE can only obtain a discriminant, never the email", () => {
    const page = stripComments(read(STAFF_PAGE));
    // The page calls the view function, which returns "register" | "sign-in" |
    // "unavailable" and carries no email by construction.
    assert.ok(page.includes("getStaffRegistrationView"), "the page must use the view API");
    assert.ok(
      !page.includes("getStaffRegistrationCredentials"),
      "the page must never reach the credentials API",
    );
    assert.ok(!/invitedEmail/.test(page), "the page references an invited email");
  });

  test("13. the ACTION never sees an email at all", () => {
    // Stronger than the previous arrangement: the address is resolved, used for both
    // Auth calls, and discarded entirely inside the registration registration. The action
    // passes a token hash and a password and receives one status word back.
    const actions = stripComments(read(STAFF_ACTIONS));
    assert.ok(actions.includes("activateInvitedStaffAccount"));
    assert.ok(!actions.includes("getStaffRegistrationView"));
    assert.ok(!/invitedEmail/.test(actions), "the action references an invited email");
    assert.ok(
      !/formData\.get\(\s*.email.\s*\)/.test(actions),
      "the action reads an email from the form",
    );
  });

  test("14. both Auth calls use the CANONICAL invitation email, never form input", () => {
    const registration = stripComments(read(REGISTRATION_MODULE));
    assert.ok(
      /email:\s*context\.invitedEmail/.test(registration),
      "createUser must use the server-derived canonical address",
    );
    assert.ok(
      /signInWithPassword\(\{\s*email:\s*context\.invitedEmail/.test(registration),
      "sign-in must use the same server-derived address",
    );
    assert.ok(!/formData/.test(registration), "the registration registration must never read form data");
  });

  test("15. no Client Component imports the registration registration", () => {
    for (const path of [STAFF_FORMS]) {
      assert.ok(
        !read(path).includes("@/lib/staff/staff-registration"),
        `${path} imports the server-only registration registration`,
      );
    }
  });
});

describe("an existing account is offered sign-in, not account creation", () => {
  test("16. the page branches on the server-side view and renders the prompt", () => {
    const page = stripComments(read(STAFF_PAGE));
    assert.ok(page.includes('view === "sign-in"'), "no sign-in branch");
    assert.ok(page.includes("StaffInvitationSignInPrompt"), "no sign-in prompt rendered");
    assert.ok(page.includes("ActivateStaffAccountForm"), "no activation form rendered");
  });

  test("17. the sign-in prompt targets the universal login with a safe internal next", () => {
    const forms = read(STAFF_FORMS);
    assert.ok(
      forms.includes('href="/login?next=/invitations/staff"'),
      "the prompt must return to this invitation through /login",
    );
    // A literal internal path — never an absolute URL, never a caller-supplied value.
    assert.ok(!/href="https?:/.test(forms), "an absolute URL is used as a return path");
  });

  test("18. the existing-account screen shows no password fields", () => {
    const forms = read(STAFF_FORMS);
    const start = forms.indexOf("export function StaffInvitationSignInPrompt");
    const prompt = forms.slice(start);
    assert.ok(!/name="password"/.test(prompt), "the sign-in prompt renders a password field");
  });
});

describe("confirmation returns to the invitation", () => {
  test("19. activation returns to the invitation directly — no confirmation round trip", () => {
    const actions = stripComments(read(STAFF_ACTIONS));
    const registration = stripComments(read(REGISTRATION_MODULE));

    // The account is created already-confirmed, so there is no confirmation email and
    // therefore no redirect target for one.
    assert.ok(!actions.includes("emailRedirectTo"), "a confirmation redirect remains");
    assert.ok(!registration.includes("emailRedirectTo"), "a confirmation redirect remains");

    // The person is sent straight back to the invitation instead.
    assert.ok(
      actions.includes('const RETURN_PATH = "/invitations/staff"'),
      "the return path must be the invitation page",
    );
    assert.ok(/redirect\(RETURN_PATH\)/.test(actions), "activation must return to the invitation");
  });

  test("20. acceptance calls only the acceptance RPC and writes no table", () => {
    const actions = stripComments(read(STAFF_ACTIONS));
    assert.ok(actions.includes("acceptStaffInvitation"), "acceptance helper missing");
    assert.ok(!/\.from\s*\(\s*["'`]/.test(actions), "the action touches a table directly");
    for (const rpc of [
      "accept_retailer_staff_invitation",
      "reserve_receipt_submission",
      "organization_members",
      "member_roles",
      "retailer_shop_members",
    ]) {
      assert.ok(
        !actions.includes(rpc),
        `the action names ${rpc} — membership logic must stay in SQL`,
      );
    }
  });
});

describe("nothing sensitive is ever logged", () => {
  const FILES = [
    LOGIN_PAGE,
    LOGIN_FORM,
    "app/login/actions.ts",
    STAFF_PAGE,
    STAFF_FORMS,
    STAFF_ACTIONS,
    REGISTRATION_MODULE,
    "lib/auth/password-policy.ts",
    "lib/auth/landing-decision.ts",
    "lib/auth/authenticated-landing.ts",
  ];

  test("21. every console call takes a literal, interpolating only a sanitized category", () => {
    // The established chokepoint in this codebase is a `log…Failure(category)` helper
    // whose template interpolates one fixed-literal category string and nothing else.
    // That is permitted; any other interpolation is not.
    const SAFE_INTERPOLATIONS = new Set(["operation", "category"]);

    for (const path of FILES) {
      for (const [index, line] of stripComments(read(path)).split("\n").entries()) {
        if (!/console\.(log|error|warn|info|debug)/.test(line)) continue;

        const call = /console\.(?:log|error|warn|info|debug)\s*\(\s*([^)]*)/.exec(line);
        const firstArg = (call?.[1] ?? "").trim();
        assert.ok(
          firstArg.startsWith('"') || firstArg.startsWith("'") || firstArg.startsWith("`"),
          `${path}:${index + 1} logs a non-literal: ${line.trim()}`,
        );

        for (const match of line.matchAll(/\$\{([^}]*)\}/g)) {
          const expression = match[1].trim();
          assert.ok(
            SAFE_INTERPOLATIONS.has(expression),
            `${path}:${index + 1} interpolates "${expression}": ${line.trim()}`,
          );
        }
      }
    }
  });

  test("22. no log line names an email, token, hash or password binding", () => {
    const FORBIDDEN =
      /\b(invitedEmail|invited_email|email|rawToken|token|tokenHash|token_hash|password|confirmPassword|credentials)\b/;
    for (const path of FILES) {
      for (const [index, line] of stripComments(read(path)).split("\n").entries()) {
        if (!/console\.(log|error|warn|info|debug)/.test(line)) continue;
        const call = /console\.(?:log|error|warn|info|debug)\s*\(([^)]*)/.exec(line);
        assert.ok(
          !FORBIDDEN.test(call?.[1] ?? ""),
          `${path}:${index + 1} logs sensitive material: ${line.trim()}`,
        );
      }
    }
  });

  test("23. the password never leaves the action except to Supabase Auth", () => {
    const actions = stripComments(read(STAFF_ACTIONS));
    // It appears in the signUp call and in the validator call, and nowhere else that
    // could persist or transmit it.
    assert.ok(!/redirect\([^)]*password/.test(actions), "a password reaches a redirect");
    assert.ok(!/notice:.*password/.test(actions), "a password reaches the returned state");
  });
});

describe("the password minimum is 6 everywhere", () => {
  test("24. both activation flows and both forms use the shared constant", () => {
    for (const path of [
      STAFF_ACTIONS,
      "app/invitations/complete/actions.ts",
    ]) {
      assert.ok(
        read(path).includes("@/lib/auth/password-policy"),
        `${path} does not use the shared policy`,
      );
      assert.ok(
        !/const MIN_PASSWORD_LENGTH\s*=/.test(read(path)),
        `${path} still declares its own minimum`,
      );
    }
    for (const path of [STAFF_FORMS, "app/invitations/complete/complete-form.tsx"]) {
      assert.ok(
        read(path).includes("MIN_PASSWORD_LENGTH"),
        `${path} does not use the shared constant`,
      );
    }
  });
});

describe("activation creates a confirmed account — it does not sign up", () => {
  const registration = stripComments(read(REGISTRATION_MODULE));
  const actions = stripComments(read(STAFF_ACTIONS));
  const forms = stripComments(read(STAFF_FORMS));
  const page = stripComments(read(STAFF_PAGE));

  test("A1. no supabase.auth.signUp call remains anywhere in the staff activation path", () => {
    // Public signup is disabled on the hosted project and stays that way. A signUp
    // call here would silently create nothing and strand the person behind a
    // confirmation email that is never sent.
    for (const [label, source] of [
      ["registration module", registration],
      ["staff actions", actions],
      ["staff forms", forms],
      ["staff page", page],
    ] as const) {
      assert.ok(!/\.signUp\s*\(/.test(source), `${label} still calls signUp`);
    }
  });

  test("A2. the account is created through the Auth Admin API", () => {
    assert.ok(
      /admin\.auth\.admin\.createUser\s*\(/.test(registration),
      "activation must use auth.admin.createUser",
    );
  });

  test("A3. createUser sets email_confirm: true", () => {
    // The invitation link was delivered to the invited inbox and the person opened it.
    // That is the same proof a confirmation email would gather, so the account is
    // confirmed at creation and no second round trip is required.
    assert.ok(
      /email_confirm:\s*true/.test(registration),
      "the created account must be confirmed at creation",
    );
  });

  test("A4. createUser is reachable only from the server-only registration registration", () => {
    // The Auth Admin API needs the service-role key. Anywhere else — and especially in
    // a Client Component — it would be a credential leak.
    const OTHERS = [STAFF_ACTIONS, STAFF_FORMS, STAFF_PAGE, LOGIN_PAGE, LOGIN_FORM];
    for (const path of OTHERS) {
      const source = stripComments(read(path));
      assert.ok(!/createUser/.test(source), `${path} references createUser`);
      assert.ok(
        !source.includes("@/lib/supabase/admin"),
        `${path} imports the service-role client`,
      );
    }
    assert.ok(registration.includes("createAdminClient"), "the registration module must build the admin client");
  });

  test("A5. no client component imports the registration registration", () => {
    assert.ok(
      /^\s*["']use client["']/m.test(read(STAFF_FORMS)),
      "the forms file must be a Client Component for this check to mean anything",
    );
    assert.ok(
      !read(STAFF_FORMS).includes("@/lib/staff/staff-registration"),
      "a Client Component imports the server-only registration module",
    );
  });

  test("A6. nothing in the flow depends on public signup being enabled", () => {
    // Neither the code nor its comments require the project setting to change: the
    // Admin API works regardless, which is the whole point of this fix.
    for (const source of [registration, actions, forms, page]) {
      assert.ok(!/signUp/.test(source), "a signUp reference remains in code");
    }
  });
});

describe("activation signs the person in and returns to the invitation", () => {
  const registration = stripComments(read(REGISTRATION_MODULE));
  const actions = stripComments(read(STAFF_ACTIONS));

  test("A7. a successful creation is followed by a cookie-aware sign-in", () => {
    assert.ok(
      /signInWithPassword\s*\(/.test(registration),
      "activation must establish a session",
    );
    // The session must be written to THIS request's cookies, so the ordinary server
    // client is required — the admin client has sessions disabled entirely.
    assert.ok(
      registration.includes('from "@/lib/supabase/server"'),
      "sign-in must use the cookie-aware server client",
    );
    // Order matters: create, then sign in.
    assert.ok(
      registration.indexOf("createUser") < registration.indexOf("signInWithPassword"),
      "sign-in must follow account creation",
    );
  });

  test("A8. there is no 'check your email' success state left", () => {
    for (const path of [STAFF_ACTIONS, STAFF_FORMS, STAFF_PAGE, "app/invitations/staff/accept-state.ts"]) {
      const source = stripComments(read(path));
      assert.ok(
        !/check your email/i.test(source),
        `${path} still renders a confirmation-email notice`,
      );
    }
    // The state type carries no success channel at all.
    assert.ok(
      !/\bnotice\b/.test(stripComments(read("app/invitations/staff/accept-state.ts"))),
      "the state still carries a success notice field",
    );
  });

  test("A9. activation ends by redirecting back to the invitation", () => {
    assert.ok(/redirect\(RETURN_PATH\)/.test(actions));
    assert.ok(actions.includes('const RETURN_PATH = "/invitations/staff"'));
  });

  test("A10. an existing account is sent to the universal login, creating nothing", () => {
    // Both the page's up-front branch and the action's concurrency branch land on the
    // same prompt, which targets /login with a validated internal return path.
    assert.ok(stripComments(read(STAFF_PAGE)).includes('view === "sign-in"'));
    assert.ok(/mode:\s*"sign-in"/.test(actions), "no already-registered screen switch");
    assert.ok(
      read(STAFF_FORMS).includes('href="/login?next=/invitations/staff"'),
      "the prompt must return through the universal login",
    );
    // The already-registered branch returns before any Auth write.
    assert.ok(
      registration.indexOf('if (context.hasAuthAccount) return { status: "already-registered" }') <
        registration.indexOf("createUser"),
      "the existing-account check must precede account creation",
    );
  });

  test("A11. a concurrent creation conflict becomes the sign-in screen, not an error", () => {
    // GoTrue refuses a duplicate address; matched on code with a narrow status
    // fallback, never on message text.
    assert.ok(registration.includes('code === "email_exists"'));
    assert.ok(registration.includes('code === "user_already_exists"'));
    assert.ok(registration.includes("status === 422"));
    assert.ok(
      /return \{ status: "already-registered" \}/.test(registration),
      "a conflict must map to the already-registered outcome",
    );
  });
});

describe("activation returns and logs nothing sensitive", () => {
  const registration = stripComments(read(REGISTRATION_MODULE));
  const actions = stripComments(read(STAFF_ACTIONS));

  test("A12. the activation result carries a status and nothing else", () => {
    // No email, no user id, no Auth error, no token.
    for (const forbidden of ["invitedEmail:", "userId", "user.id", "error:"]) {
      assert.ok(
        !new RegExp(`status: "(activated|already-registered|unavailable)"[^}]*${forbidden.replace(".", "\\\\.")}`).test(
          registration,
        ),
        `the activation result leaks ${forbidden}`,
      );
    }
  });

  test("A13. no Auth error object is ever bound, returned or logged", () => {
    // Only the discriminating CODE and STATUS are read, and only to classify.
    assert.ok(
      !/console\.\w+\([^)]*\b(created|signedIn)\b/.test(registration),
      "an Auth result reaches a log line",
    );
    assert.ok(!/return[^;]*created\.error/.test(registration), "an Auth error is returned");
  });

  test("A14. the password never leaves the registration except to Supabase Auth", () => {
    assert.ok(!/console\.\w+\([^)]*password/.test(registration), "a password reaches a log line");
    assert.ok(!/console\.\w+\([^)]*password/.test(actions), "a password reaches a log line");
    assert.ok(!/return[^;]*password/.test(registration), "a password is returned");
    // It is passed to createUser and signInWithPassword, and to the shared validator.
    assert.ok(/password,/.test(registration) || /password:/.test(registration));
  });

  test("A15. the token hash is never logged", () => {
    for (const source of [registration, actions]) {
      assert.ok(!/console\.\w+\([^)]*tokenHash/.test(source), "a token hash reaches a log line");
    }
  });
});

describe("acceptance is unchanged", () => {
  test("A16. acceptance still calls only the acceptance RPC", () => {
    const actions = stripComments(read(STAFF_ACTIONS));
    assert.ok(actions.includes("acceptStaffInvitation"));
    assert.ok(!/\.from\s*\(\s*["'`]/.test(actions), "the action touches a table directly");
    for (const forbidden of [
      "accept_retailer_staff_invitation",
      "organization_members",
      "member_roles",
      "retailer_shop_members",
      "profiles",
    ]) {
      assert.ok(
        !actions.includes(forbidden),
        `the action names ${forbidden} — membership logic must stay in SQL`,
      );
    }
  });

  test("A17. Retailer Owner activation is untouched by this flow", () => {
    // A different route, a different action, and it must not have acquired the Admin
    // API or a sign-in step.
    const owner = stripComments(read("app/invitations/complete/actions.ts"));
    assert.ok(!/createUser/.test(owner), "Owner activation now calls createUser");
    assert.ok(!owner.includes("@/lib/supabase/admin"), "Owner activation gained the admin client");
    assert.ok(!/signInWithPassword/.test(owner), "Owner activation now signs in");
    assert.ok(owner.includes("updateUser"), "Owner activation must still set its password");
  });
});
