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

  test("9. the account-creation form offers no Sign in button", () => {
    // Someone with no account cannot sign in, and offering it would hint that their
    // address might already be registered.
    const start = forms.indexOf("export function ActivateStaffAccountForm");
    const end = forms.indexOf("export function StaffInvitationSignInPrompt");
    assert.ok(start >= 0 && end > start, "the two components must both exist");
    const activation = forms.slice(start, end);
    assert.ok(!/Sign in/.test(activation), "the activation form offers a Sign in control");
  });

  test("10. minLength comes from the shared policy, not a literal", () => {
    assert.ok(forms.includes("minLength={MIN_PASSWORD_LENGTH}"));
    assert.ok(!/minLength=\{\d+\}/.test(forms), "a hard-coded minLength remains");
  });
});

describe("the invited email is server-only", () => {
  test("11. the registration module is the only place the context RPC is named", () => {
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

  test("13. only the ACTION obtains the credentials", () => {
    const actions = stripComments(read(STAFF_ACTIONS));
    assert.ok(actions.includes("getStaffRegistrationCredentials"));
    assert.ok(!actions.includes("getStaffRegistrationView"));
  });

  test("14. signup uses the CANONICAL invitation email, not form input", () => {
    const actions = stripComments(read(STAFF_ACTIONS));
    assert.ok(
      /email:\s*credentials\.invitedEmail/.test(actions),
      "signUp must use the server-derived canonical address",
    );
    // No email is read from the submitted form anywhere in this module.
    assert.ok(
      !/formData\.get\(\s*["']email["']\s*\)/.test(actions),
      "the action reads an email from the form",
    );
  });

  test("15. no Client Component imports the registration module", () => {
    for (const path of [STAFF_FORMS]) {
      assert.ok(
        !read(path).includes("@/lib/staff/staff-registration"),
        `${path} imports the server-only registration module`,
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
  test("19. emailRedirectTo points back at the acceptance route", () => {
    const actions = stripComments(read(STAFF_ACTIONS));
    assert.ok(actions.includes("emailRedirectTo"), "no confirmation return path");
    assert.ok(actions.includes("RETURN_PATH"), "the return path must be the shared constant");
    assert.ok(
      actions.includes('const RETURN_PATH = "/invitations/staff"'),
      "the return path must be the invitation page",
    );
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
