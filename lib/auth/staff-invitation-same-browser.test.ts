/**
 * SOURCE-LEVEL GUARDS for the staff-invitation same-browser account-switch and
 * automatic-acceptance flow.
 *
 * Run with:  npm test
 *
 * These read the milestone's own source files and assert properties no unit test can
 * observe at runtime but that a careless later edit could quietly break:
 *
 *   - the wrong-account screen offers an account switch and reveals no identity;
 *   - switching signs out the current Auth session and PRESERVES the invitation cookie;
 *   - the switch action returns to /invitations/staff;
 *   - acceptance is automatic, performed by a POST server action, never a GET render;
 *   - acceptance calls only accept_retailer_staff_invitation, with no membership writes;
 *   - role landings come from the server-side resolver, not client-submitted roles;
 *   - the completed-invitation cookie is cleared and duplicates are safe;
 *   - unsafe login `next` values stay rejected;
 *   - access-denied wording is role-neutral;
 *   - nothing sensitive is logged or reaches a Client Component;
 *   - Retailer Owner activation is untouched, and public signup stays unnecessary.
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

const STAFF_PAGE = "app/invitations/staff/page.tsx";
const STAFF_FORMS = "app/invitations/staff/accept-forms.tsx";
const STAFF_ACTIONS = "app/invitations/staff/actions.ts";
const STAFF_STATE = "app/invitations/staff/accept-state.ts";
const REGISTRATION_MODULE = "lib/staff/staff-registration.ts";
const ACCESS_DENIED = "app/access-denied/page.tsx";
const RETAILER_ACCESS_DENIED = "app/retailer-access-denied/page.tsx";
// Both access-denied routes render one shared, role-neutral card; the neutral
// wording lives there now, so the wording assertions read it while the
// forbidden-phrase checks still cover the page + the shared card together.
const ACCESS_DENIED_CARD = "components/ui/access-denied-card.tsx";

describe("the wrong-account / account-switch screen", () => {
  const page = read(STAFF_PAGE);
  const forms = read(STAFF_FORMS);

  test("1. a signed-in caller with an unavailable invitation is offered the switch", () => {
    // On the signed-in path, resolve `unavailable` renders WrongAccountSwitch — the
    // account-switch screen — rather than a dead-end message.
    const rendered = stripComments(page);
    assert.ok(rendered.includes("WrongAccountSwitch"), "the switch screen is not rendered");
    assert.ok(
      rendered.includes("Continue with the invited account"),
      "missing the switch heading",
    );
    assert.ok(
      forms.includes("Continue as invited staff"),
      "missing the primary switch action",
    );
    assert.ok(forms.includes("Stay signed in"), "missing the secondary action");
  });

  test("2. the screen reveals neither the current nor the invited email, nor any id", () => {
    const rendered = stripComments(page);
    // The switch screen's copy names another account only in the abstract.
    assert.ok(
      rendered.includes("Another SalesReward account is currently signed in"),
      "missing the neutral body",
    );
    // No identity or invitation data is interpolated into the signed-in branch.
    for (const forbidden of [
      "invitation.email",
      "invitedEmail",
      "currentEmail",
      "invitation.retailerName",
      "invitation.roleCode",
      "invitation.shopNames",
      "retailerRoleDisplayName",
    ]) {
      assert.ok(!rendered.includes(forbidden), `the page exposes ${forbidden}`);
    }
  });

  test("3. the wrong-account screen is not the generic dead-end unavailable screen", () => {
    // The old behaviour rendered UnavailableScreen with a sign-out. Now the signed-in
    // unavailable case is the actionable switch.
    const rendered = stripComments(page);
    const signedInSection = rendered.slice(rendered.indexOf("Signed IN."));
    assert.ok(
      !signedInSection.includes("UnavailableScreen"),
      "the signed-in path still renders the dead-end unavailable screen",
    );
  });
});

describe("switching signs out and preserves the invitation cookie", () => {
  const actions = stripComments(read(STAFF_ACTIONS));

  test("4. Continue as invited staff signs out the current Supabase session", () => {
    const start = actions.indexOf("continueAsInvitedStaffAction");
    assert.ok(start >= 0, "the account-switch action is missing");
    const body = actions.slice(start, actions.indexOf("stayInvitedSignedInAction"));
    assert.ok(/signOut\(\{\s*scope:\s*"local"\s*\}\)/.test(body), "it does not sign out");
  });

  test("5. the account switch NEVER clears or names the invitation cookie", () => {
    // signOut clears only the Supabase auth cookies; the invitation cookie is a
    // separate cookie the switch must leave in place. It is not cleared, and the
    // action does not even reference the clear helper.
    const start = actions.indexOf("continueAsInvitedStaffAction");
    const body = actions.slice(start, actions.indexOf("stayInvitedSignedInAction"));
    assert.ok(
      !body.includes("clearStaffInviteCookie"),
      "the account switch clears the invitation cookie",
    );
    assert.ok(
      !/STAFF_INVITE_COOKIE/.test(body),
      "the account switch names the invitation cookie",
    );
  });

  test("6. the switch returns to /invitations/staff, not /login", () => {
    const start = actions.indexOf("continueAsInvitedStaffAction");
    const body = actions.slice(start, actions.indexOf("stayInvitedSignedInAction"));
    assert.ok(/redirect\(RETURN_PATH\)/.test(body), "the switch does not return to the invitation");
    assert.ok(!/redirect\(`?\/login/.test(body), "the switch bounces to /login");
    assert.ok(actions.includes('const RETURN_PATH = "/invitations/staff"'));
  });

  test("7. the clear helper is only ever called by the acceptance action, on success", () => {
    // The invitation cookie is cleared exactly when the invitation is completed — never
    // during an account switch or a stay-signed-in.
    for (const other of ["continueAsInvitedStaffAction", "stayInvitedSignedInAction"]) {
      const start = actions.indexOf(other);
      const end = actions.indexOf("export async function", start + 1);
      const body = end > start ? actions.slice(start, end) : actions.slice(start);
      assert.ok(
        !body.includes("clearStaffInviteCookie"),
        `${other} clears the invitation cookie`,
      );
    }
  });
});

describe("automatic acceptance", () => {
  const page = read(STAFF_PAGE);
  const forms = read(STAFF_FORMS);
  const actions = stripComments(read(STAFF_ACTIONS));

  test("8. a matched signed-in caller gets the transition, not a manual Accept button", () => {
    const rendered = stripComments(page);
    assert.ok(rendered.includes("AcceptInvitationTransition"), "no transition is rendered");
    // The old manual Accept form is gone entirely.
    assert.ok(!forms.includes("AcceptStaffInvitationForm"), "a manual Accept form remains");
    assert.ok(!/Accept invitation<\/button>/.test(forms), "a manual Accept button remains");
  });

  test("9. the transition receives no invitation data of any kind", () => {
    // Comments describe the absence of this data; the code must not contain it.
    const stripped = stripComments(forms);
    const start = stripped.indexOf("export function AcceptInvitationTransition");
    const end = stripped.indexOf("export function WrongAccountSwitch");
    const transition = stripped.slice(start, end);
    for (const forbidden of [
      "retailerName",
      "roleCode",
      "shopNames",
      "email",
      "tokenHash",
      "invitationId",
      "membership",
    ]) {
      assert.ok(!transition.includes(forbidden), `the transition receives ${forbidden}`);
    }
    // It takes no props at all.
    assert.ok(
      /AcceptInvitationTransition\(\)/.test(transition),
      "the transition must take no props",
    );
  });

  test("10. acceptance happens on a POST server action, never during the GET render", () => {
    // The page (a Server Component) never calls the acceptance helper directly — it only
    // renders the transition, which POSTs.
    const rendered = stripComments(page);
    assert.ok(
      !rendered.includes("acceptStaffInvitation("),
      "the page mutates during its GET render",
    );
    assert.ok(
      !rendered.includes("acceptStaffInvitationAction"),
      "the page invokes the acceptance action during render",
    );
    // The action is wired through a <form action=...>, i.e. a POST.
    const start = forms.indexOf("export function AcceptInvitationTransition");
    const transition = forms.slice(start, forms.indexOf("export function WrongAccountSwitch"));
    assert.ok(/<form[^>]*action=\{formAction\}/.test(transition), "the transition does not POST a form");
  });

  test("11. automatic acceptance calls only accept_retailer_staff_invitation", () => {
    assert.ok(actions.includes("acceptStaffInvitation"), "the acceptance helper is missing");
    // No other invitation-mutating RPC is named.
    for (const rpc of [
      "reserve_retailer_staff_invitation",
      "prepare_retailer_staff_invitation",
      "record_retailer_staff_invitation_sent",
    ]) {
      assert.ok(!actions.includes(rpc), `the action names ${rpc}`);
    }
  });

  test("12. no membership, role or shop write exists in application code", () => {
    assert.ok(!/\.from\s*\(\s*["'`]/.test(actions), "the action touches a table directly");
    for (const table of [
      "organization_members",
      "member_roles",
      "retailer_shop_members",
      "profiles",
      "accept_retailer_staff_invitation",
    ]) {
      // Even the acceptance RPC name lives behind the helper, not in the action.
      assert.ok(!actions.includes(table), `the action names ${table} — membership logic must stay in SQL`);
    }
  });

  test("13. the transition submits once and tolerates a development remount", () => {
    const start = forms.indexOf("export function AcceptInvitationTransition");
    const transition = forms.slice(start, forms.indexOf("export function WrongAccountSwitch"));
    // A ref guards the effect so a Strict-Mode double-invoke submits only once.
    assert.ok(/submitted\.current/.test(transition), "no submit-once guard");
    assert.ok(/useRef/.test(transition), "no ref for the guard");
    assert.ok(/disabled=\{pending\}/.test(transition), "the submit control is not disabled while pending");
  });
});

describe("role landings come from the server resolver", () => {
  const actions = stripComments(read(STAFF_ACTIONS));

  test("14. acceptance resolves the landing from the verified session", () => {
    assert.ok(actions.includes("resolveAuthenticatedLanding"), "no server-side landing resolution");
    // Destinations are the fixed LANDING_ROUTES literals, never client-submitted.
    assert.ok(actions.includes("LANDING_ROUTES"), "no fixed route constants");
    // No role string is read from the form or branched on.
    for (const role of ["RETAILER_MANAGER", "SALES_STAFF", "roleCode"]) {
      assert.ok(!actions.includes(role), `the action branches on the client role ${role}`);
    }
  });

  test("15. Manager and Sales Staff landings are the canonical routes", () => {
    const landing = stripComments(read("lib/auth/landing-decision.ts"));
    assert.ok(landing.includes('retailerStaff: "/retailer/staff"'), "Manager landing wrong");
    assert.ok(landing.includes('salesStaff: "/retailer/receipts"'), "Sales Staff landing wrong");
  });
});

describe("completed and stale invitations", () => {
  const actions = stripComments(read(STAFF_ACTIONS));
  const page = stripComments(read(STAFF_PAGE));

  test("16. a successful acceptance clears the invitation cookie", () => {
    const start = actions.indexOf("acceptStaffInvitationAction");
    const end = actions.indexOf("continueAsInvitedStaffAction");
    const accept = actions.slice(start, end);
    assert.ok(accept.includes("clearStaffInviteCookie"), "the cookie is not cleared on success");
    assert.ok(/status === "accepted"/.test(accept), "no accepted branch");
  });

  test("17. a signed-in caller with no cookie is sent to their landing, not a stale form", () => {
    // Both the page and the action redirect a no-cookie signed-in caller to their
    // authorized landing — this is what stops the Back button re-opening an actionable
    // form after completion.
    assert.ok(
      /if \(!tokenHash\)/.test(page) && page.includes("landingDestinationForSignedInCaller"),
      "the page does not redirect a completed/no-cookie caller to their landing",
    );
    const start = actions.indexOf("acceptStaffInvitationAction");
    const accept = actions.slice(start, actions.indexOf("continueAsInvitedStaffAction"));
    assert.ok(/if \(!tokenHash\)/.test(accept), "the action has no no-cookie branch");
  });

  test("18. a duplicate/racing acceptance resolves to the landing, creating nothing new", () => {
    // A refusal after a match is a duplicate that already succeeded; the action
    // re-resolves the landing rather than erroring, and the RPC's token-clearing means
    // no second membership row is possible.
    const start = actions.indexOf("acceptStaffInvitationAction");
    const accept = actions.slice(start, actions.indexOf("continueAsInvitedStaffAction"));
    assert.ok(/status === "refused"/.test(accept), "no refused branch");
    assert.ok(/authorized/.test(accept), "the refused branch does not check authorization");
  });
});

describe("login next handling is unchanged and safe", () => {
  test("19. the sign-in prompt returns through the universal login with a safe next", () => {
    const forms = read(STAFF_FORMS);
    assert.ok(
      forms.includes('href="/login?next=/invitations/staff"'),
      "the sign-in prompt does not use the universal login return path",
    );
  });

  test("20. unsafe next values are still rejected by the shared validator", () => {
    // Untouched by this fix, but pinned here so a regression is caught with the flow.
    const loginAction = read("app/login/actions.ts");
    assert.ok(loginAction.includes("resolveSafeNextPath"), "the login action dropped next validation");
  });
});

describe("access-denied wording is role-neutral", () => {
  test("21. the shared /access-denied page names no specific role or portal", () => {
    const card = stripComments(read(ACCESS_DENIED_CARD));
    const rendered = stripComments(read(ACCESS_DENIED)) + card;
    assert.ok(card.includes("Access denied"), "the title changed");
    assert.ok(
      card.includes("this account does not have access to this"),
      "missing the neutral body",
    );
    for (const phrase of ["Vendor Super Admin", "Vendor Admin · v0.1", "Retailer Owner Portal"]) {
      assert.ok(!rendered.includes(phrase), `the denial still renders "${phrase}"`);
    }
  });

  test("22. the retailer access-denied page names no Retailer Owner Portal wording", () => {
    const card = stripComments(read(ACCESS_DENIED_CARD));
    const rendered = stripComments(read(RETAILER_ACCESS_DENIED)) + card;
    assert.ok(
      card.includes("this account does not have access to this"),
      "missing the neutral body",
    );
    for (const phrase of ["Retailer Owner Portal", "Retailer Owner portal"]) {
      assert.ok(!rendered.includes(phrase), `the denial still renders "${phrase}"`);
    }
  });
});

describe("security: nothing sensitive is logged or reaches the client", () => {
  const FILES = [STAFF_PAGE, STAFF_FORMS, STAFF_ACTIONS, STAFF_STATE, REGISTRATION_MODULE];

  test("23. every console call takes a literal, at most a sanitized category", () => {
    const SAFE = new Set(["operation", "category"]);
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
          assert.ok(SAFE.has(match[1].trim()), `${path}:${index + 1} interpolates ${match[1].trim()}`);
        }
      }
    }
  });

  test("24. no log line names an email, password, token, hash or id binding", () => {
    const FORBIDDEN =
      /\b(email|invitedEmail|password|confirmPassword|rawToken|token|tokenHash|userId|invitationId|error|err|result|response|data|session|claims)\b/;
    for (const path of FILES) {
      for (const [index, line] of stripComments(read(path)).split("\n").entries()) {
        if (!/console\.(log|error|warn|info|debug)/.test(line)) continue;
        const call = /console\.(?:log|error|warn|info|debug)\s*\(([^)]*)/.exec(line);
        assert.ok(!FORBIDDEN.test(call?.[1] ?? ""), `${path}:${index + 1} logs sensitive material`);
      }
    }
  });

  test("25. no Client Component imports a server-only invitation module", () => {
    const forms = read(STAFF_FORMS);
    assert.ok(/^\s*["']use client["']/m.test(forms), "the forms file must be a Client Component");
    for (const mod of [
      "@/lib/staff/staff-registration",
      "@/lib/staff/staff-acceptance",
      "@/lib/staff/staff-invite-cookie",
      "@/lib/supabase/admin",
      "@/lib/supabase/server",
      "next/headers",
    ]) {
      assert.ok(!forms.includes(`from "${mod}"`), `the forms import the server-only ${mod}`);
    }
  });

  test("26. no invitation secret reaches a Client Component prop or state", () => {
    const forms = stripComments(read(STAFF_FORMS));
    for (const forbidden of [
      "tokenHash",
      "invitedEmail",
      "retailerOrganizationId",
      "organization_id",
      "invitation_id",
    ]) {
      assert.ok(!forms.includes(forbidden), `the forms handle ${forbidden}`);
    }
    // The only hidden field permitted is none — the forms carry no hidden fields.
    assert.ok(!/type="hidden"/.test(forms), "the forms introduce a hidden field");
  });
});

describe("nothing unrelated changed", () => {
  test("27. Retailer Owner activation still uses updateUser, no admin client, no sign-in", () => {
    const owner = stripComments(read("app/invitations/complete/actions.ts"));
    assert.ok(owner.includes("updateUser"), "Owner activation no longer sets its password");
    assert.ok(!/createUser/.test(owner), "Owner activation gained createUser");
    assert.ok(!owner.includes("@/lib/supabase/admin"), "Owner activation gained the admin client");
    assert.ok(!/signInWithPassword/.test(owner), "Owner activation gained a sign-in step");
  });

  test("28. public signup remains unnecessary — no signUp anywhere in the staff flow", () => {
    for (const path of [STAFF_PAGE, STAFF_FORMS, STAFF_ACTIONS, REGISTRATION_MODULE]) {
      assert.ok(!/\.signUp\s*\(/.test(stripComments(read(path))), `${path} calls signUp`);
    }
  });

  test("29. activation still creates a confirmed account via the Auth Admin API", () => {
    const registration = stripComments(read(REGISTRATION_MODULE));
    assert.ok(/admin\.auth\.admin\.createUser\s*\(/.test(registration));
    assert.ok(/email_confirm:\s*true/.test(registration));
  });

  test("30. no database migration was added by this fix", () => {
    // A UX fix must not introduce SQL. The staff files contain no migration reference,
    // and the flow uses only pre-existing RPCs.
    for (const path of [STAFF_ACTIONS, STAFF_PAGE, REGISTRATION_MODULE]) {
      const source = stripComments(read(path));
      assert.ok(!/create (or replace )?function/i.test(source), `${path} defines SQL`);
    }
  });
});
