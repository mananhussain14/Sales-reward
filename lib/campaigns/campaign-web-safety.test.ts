/**
 * SOURCE-LEVEL SAFETY GUARDS for the campaign Web surfaces —
 * app/(admin)/campaigns/**, app/(retailer)/retailer/campaigns/**, and the two navigation
 * lists.
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHY THESE ARE SOURCE ASSERTIONS RATHER THAN RENDERED-DOM TESTS
 * ============================================================================
 * This repository has no DOM test runner: `npm test` is `node --test` over the pure
 * modules, and every UI guarantee in the product is asserted the same way these are —
 * see lib/products/product-source-safety.test.ts and
 * lib/receipts/receipt-source-safety.test.ts. Adding a renderer for one feature would
 * mean this milestone's UI was verified by a mechanism nothing else in the project uses.
 *
 * What that buys, and what it does not: these catch a REGRESSION IN KIND — a write
 * appearing on a read-only page, a Server Action losing its access check, a lifecycle
 * dialog losing its double-submit guard, a disclosure field reaching a Retailer-facing
 * component. They cannot catch a visual defect, and they are not a substitute for the
 * pgTAP suite, which is where authorization and tenant isolation are actually proved.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const VENDOR_DIR = join(ROOT, "app/(admin)/campaigns");
const RETAILER_DIR = join(ROOT, "app/(retailer)/retailer/campaigns");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const VENDOR_FILES = walk(VENDOR_DIR);
const RETAILER_FILES = walk(RETAILER_DIR);

const read = (path: string) => readFileSync(path, "utf8");
/** Strips comments so a rule is never confused with prose describing it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ACTIONS = read(join(VENDOR_DIR, "actions.ts"));
const ACTIONS_CODE = code(ACTIONS);
const WIZARD = read(join(VENDOR_DIR, "campaign-wizard.tsx"));
const WIZARD_CODE = code(WIZARD);
const LIST = read(join(VENDOR_DIR, "campaign-list.tsx"));
const DETAIL = read(join(VENDOR_DIR, "[campaignId]/page.tsx"));
const DIALOG = read(join(VENDOR_DIR, "[campaignId]/campaign-lifecycle-dialog.tsx"));
const DIALOG_CODE = code(DIALOG);
const GROUP_FORMS = read(join(VENDOR_DIR, "groups/group-forms.tsx"));
const RETAILER_PAGE = read(join(RETAILER_DIR, "page.tsx"));
const RETAILER_PAGE_CODE = code(RETAILER_PAGE);

const ADMIN_NAV = read(join(ROOT, "components/admin/nav-items.tsx"));
const RETAILER_NAV = read(join(ROOT, "components/retailer-portal/retailer-nav-items.tsx"));

/**
 * The shared campaign components the UX redesign extracted.
 *
 * Several guarantees below — "the search hides rather than unmounts", "choices are real
 * radios", "the count is announced" — used to be asserted against campaign-wizard.tsx
 * because that file contained the markup. It no longer does: one picker and one choice
 * card are now used by the wizard AND by Retailer-group creation and editing, which is
 * what stops the four surfaces drifting apart.
 *
 * The guarantees are unchanged and are still asserted; they are simply asserted where the
 * markup now lives. `WIZARD_SURFACE` is the concatenation, so a rule that must hold for
 * "the wizard as a user experiences it" can be checked in one place regardless of which
 * file happens to hold that line today.
 */
const CAMPAIGN_COMPONENTS_DIR = join(ROOT, "components/campaigns");
const PICKER = read(join(CAMPAIGN_COMPONENTS_DIR, "entity-picker.tsx"));
const CHOICE_CARDS = read(join(CAMPAIGN_COMPONENTS_DIR, "choice-cards.tsx"));
const STEPPER = read(join(CAMPAIGN_COMPONENTS_DIR, "wizard-stepper.tsx"));
const SUMMARY = read(join(CAMPAIGN_COMPONENTS_DIR, "campaign-summary.tsx"));
const ELIGIBILITY = read(join(CAMPAIGN_COMPONENTS_DIR, "eligibility-panel.tsx"));
const SHARED_FIELD = read(join(ROOT, "components/ui/field.tsx"));

const PICKER_CODE = code(PICKER);
const CHOICE_CARDS_CODE = code(CHOICE_CARDS);
const STEPPER_CODE = code(STEPPER);

const WIZARD_SURFACE = [WIZARD, PICKER, CHOICE_CARDS, STEPPER, SUMMARY, ELIGIBILITY].join(
  "\n",
);
const WIZARD_SURFACE_CODE = code(WIZARD_SURFACE);

/* ===========================================================================
 * 1. Routes and navigation
 * ======================================================================== */

describe("1. routes and role-based navigation", () => {
  test("1.1 every vendor campaign route has a loading state", () => {
    // A blank screen while a route resolves is the failure the requirement calls out.
    const pages = VENDOR_FILES.filter((file) => file.endsWith("/page.tsx"));
    assert.ok(pages.length >= 5, `only ${pages.length} campaign pages found`);
    for (const page of pages) {
      const loading = page.replace(/page\.tsx$/, "loading.tsx");
      assert.ok(
        VENDOR_FILES.includes(loading),
        `${page.slice(ROOT.length)} has no loading.tsx`,
      );
    }
  });

  test("1.2 the Retailer campaigns route has one too", () => {
    assert.ok(RETAILER_FILES.some((file) => file.endsWith("/loading.tsx")));
  });

  test("1.3 the Vendor nav enables Campaigns and still links /campaigns", () => {
    const entry = ADMIN_NAV.slice(
      ADMIN_NAV.indexOf('label: "Campaigns"'),
      ADMIN_NAV.indexOf('label: "Claims"'),
    );
    assert.match(entry, /href: "\/campaigns"/);
    assert.match(entry, /disabled: false/);
  });

  test("1.4 Claims, Coins, Payouts and Reports stay disabled", () => {
    // This milestone enables Campaigns and nothing else. A neighbouring module switched
    // on by accident would open a 404 and imply a capability that does not exist.
    for (const label of ["Claims", "Coins", "Payouts", "Reports", "Settings"]) {
      const start = ADMIN_NAV.indexOf(`label: "${label}"`);
      assert.notEqual(start, -1, `${label} missing from the nav`);
      assert.match(
        ADMIN_NAV.slice(start, start + 200),
        /disabled: true/,
        `${label} was enabled`,
      );
    }
  });

  test("1.5 the Retailer nav offers Campaigns to the OWNER only", () => {
    const fn = RETAILER_NAV.slice(RETAILER_NAV.indexOf("export function retailerNavItems"));
    // The submitter and reader branches return before the owner list.
    const submitter = fn.slice(fn.indexOf('kind === "submitter"'), fn.indexOf('kind === "reader"'));
    const reader = fn.slice(fn.indexOf('kind === "reader"'), fn.indexOf("return [OVERVIEW_ITEM"));
    assert.ok(!/CAMPAIGNS_ITEM/.test(submitter), "Sales Staff are offered Campaigns");
    assert.ok(!/CAMPAIGNS_ITEM/.test(reader), "a Retailer Manager is offered Campaigns");
    assert.match(fn, /return \[OVERVIEW_ITEM[\s\S]*?CAMPAIGNS_ITEM\]/);
  });
});

/* ===========================================================================
 * 2. The Retailer surface is READ-ONLY
 * ======================================================================== */

describe("2. the Retailer Owner page cannot mutate anything", () => {
  test("2.1 it imports no Server Action and no campaign write", () => {
    assert.ok(!/from "@\/app\/\(admin\)/.test(RETAILER_PAGE_CODE), "imports a Vendor module");
    assert.ok(!/actions"/.test(RETAILER_PAGE_CODE), "imports a Server Action module");
    for (const write of [
      "publishCampaign",
      "setCampaignLifecycle",
      "createCampaignDraft",
      "updateCampaignDraft",
      "createCampaignVersion",
      "setRetailerGroupMembers",
    ]) {
      assert.ok(!RETAILER_PAGE_CODE.includes(write), `it calls ${write}`);
    }
  });

  test("2.2 it renders no form, no submit and no mutating control", () => {
    assert.ok(!/<form/i.test(RETAILER_PAGE_CODE));
    assert.ok(!/<button/i.test(RETAILER_PAGE_CODE));
    assert.ok(!/formAction|useActionState/.test(RETAILER_PAGE_CODE));
  });

  test("2.3 it is a Server Component — no client directive", () => {
    assert.ok(!/^"use client"/m.test(RETAILER_PAGE));
  });

  test("2.4 it reads ONLY the assigned-visibility module", () => {
    const imports = [...RETAILER_PAGE_CODE.matchAll(/from "(@\/lib\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const source of imports) {
      assert.ok(
        !/vendor-campaigns|retailer-groups/.test(source),
        `it imports the Vendor module ${source}`,
      );
    }
    assert.ok(imports.includes("@/lib/campaigns/retailer-campaigns"));
  });

  test("2.5 it never renders a Vendor-private disclosure field", () => {
    // These do not arrive — the RPCs withhold them — and the component must not be able
    // to render one even if a future column appeared.
    for (const field of [
      "exclusivityKey",
      "priority",
      "sourceGroupName",
      "vendorRetailerId",
      "eligibleRetailerCount",
      "versionNumber",
      "source",
    ]) {
      assert.ok(
        !new RegExp(`campaign\\.${field}\\b`).test(RETAILER_PAGE_CODE),
        `it renders ${field}`,
      );
    }
  });

  test("2.6 it never claims a progress, balance or earned figure", () => {
    // Asserted on the DATA BINDINGS, not on the prose. The page deliberately SAYS the
    // words "nothing here is a sales total or a coin balance", and a test that could not
    // tell a disclaimer apart from a claim would fail on the very sentence that makes
    // the promise.
    const bindings = [...RETAILER_PAGE_CODE.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
    for (const binding of bindings) {
      assert.ok(
        !/\b(earned|balance|progress|unitsSold|totalCoins|coinsEarned)\b/i.test(binding),
        `a rendered expression claims a result: ${binding.trim()}`,
      );
    }
    // And the honest half of the same claim is present for the reader. The sentence now
    // lives in ONE constant — CALCULATION_ENGINE_NOTICE — rendered through the shared
    // <CalculationEngineNotice />, so that every surface says it identically. Accepting
    // either the component or the literal keeps the guarantee ("the reader is told") while
    // allowing the wording to be centralized, which is what stops two pages drifting.
    const prose = RETAILER_PAGE.replace(/\s+/g, " ");
    assert.ok(
      /calculation engine is connected/.test(prose) ||
        /<CalculationEngineNotice/.test(prose),
      "the page never tells the reader that no result is calculated yet",
    );
  });

  test("2.7 it fails closed on a denial and on a lost session", () => {
    assert.match(RETAILER_PAGE_CODE, /redirect\("\/login"\)/);
    assert.match(RETAILER_PAGE_CODE, /redirect\("\/retailer-access-denied"\)/);
    assert.match(RETAILER_PAGE_CODE, /status === "denied"/);
  });

  test("2.8 it groups every lifecycle state into a section, and covers all six", () => {
    // Asserted on the STATES each section collects, not on its heading. The headings are
    // ordinary product copy and were reworded in the UX redesign ("Running now" rather
    // than "Active campaigns"); the guarantee that matters is that no state falls through
    // and becomes invisible to the Retailer it applies to.
    const sections = RETAILER_PAGE_CODE.slice(
      RETAILER_PAGE_CODE.indexOf("const SECTIONS"),
      RETAILER_PAGE_CODE.indexOf("function formatDate"),
    );

    for (const state of [
      "ACTIVE",
      "SCHEDULED",
      "PAUSED",
      "ENDED",
      "CANCELLED",
    ]) {
      assert.ok(
        new RegExp(`"${state}"`).test(sections),
        `no section collects ${state}, so those campaigns would be invisible`,
      );
    }

    // DRAFT is the one state deliberately absent: the RPC never returns an unpublished
    // campaign to a Retailer, so a section for it would always be empty.
    assert.ok(
      !/"DRAFT"/.test(sections),
      "a Retailer section collects DRAFT, which the RPC never returns",
    );

    // Four sections, each with a heading and a description, so none is an unlabelled list.
    const headings = [...sections.matchAll(/title: "([^"]+)"/g)].map((m) => m[1]);
    assert.equal(headings.length, 4, "expected exactly four Retailer sections");
    for (const heading of headings) {
      assert.ok(heading.trim().length > 0, "a section has an empty heading");
    }
  });

  test("2.8b it distinguishes dynamic from frozen product eligibility", () => {
    // The two behaviours make opposite promises about whether the product list can move,
    // and a Retailer who cannot tell them apart cannot read their own list correctly.
    assert.match(RETAILER_PAGE_CODE, /productResolutionLabel\(/);
    assert.match(RETAILER_PAGE_CODE, /productResolutionExplanation\(/);
    // And it states which instant a historical list reflects.
    const prose = RETAILER_PAGE.replace(/\s+/g, " ");
    assert.match(prose, /what is eligible today while the campaign is running/i);
    assert.match(prose, /what was eligible when it ended/i);
  });

  test("2.9 it uses the shared team wording rather than restating it", () => {
    // One sentence, defined once, so two surfaces cannot describe a team campaign
    // differently.
    assert.match(RETAILER_PAGE_CODE, /performanceExplanation\(/);
    assert.ok(!/All eligible Sales Staff sales/.test(RETAILER_PAGE_CODE));
  });
});

/* ===========================================================================
 * 3. Server Actions
 * ======================================================================== */

describe("3. every Server Action re-checks access and maps errors safely", () => {
  const exported = [...ACTIONS_CODE.matchAll(/export async function (\w+)\(/g)].map(
    (m) => m[1],
  );

  test("3.1 the expected actions exist and nothing else is exported", () => {
    assert.deepEqual(exported.sort(), [
      "createCampaignDraftAction",
      "createCampaignVersionAction",
      "createRetailerGroupAction",
      "publishCampaignAction",
      "setCampaignLifecycleAction",
      "setRetailerGroupMembersAction",
      "updateCampaignDraftAction",
      "updateRetailerGroupAction",
    ]);
  });

  test("3.2 every action re-resolves Vendor Admin access", () => {
    // A Server Action is a public endpoint reachable by a hand-crafted POST from any
    // client, regardless of which page rendered the form.
    const bodies = ACTIONS_CODE.split(/export async function /).slice(1);
    assert.equal(bodies.length, exported.length);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      assert.ok(
        body.includes("await requireVendorAdmin()"),
        `${name} does not re-resolve access`,
      );
    }
  });

  test("3.3 the access check redirects and is never wrapped in a try/catch", () => {
    // redirect() signals by throwing NEXT_REDIRECT; catching it would swallow the
    // navigation and leave an unauthorized caller on the page.
    const guard = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("async function requireVendorAdmin"),
    ).slice(0, 400);
    assert.match(guard, /redirect\("\/login"\)/);
    assert.match(guard, /redirect\("\/access-denied"\)/);
    assert.ok(!/try\s*\{/.test(ACTIONS_CODE), "an action wraps control flow in try/catch");
  });

  test("3.4 no action writes a table or builds a service-role client", () => {
    assert.ok(!/\.from\(/.test(ACTIONS_CODE));
    assert.ok(!/service_role|SERVICE_ROLE/i.test(ACTIONS_CODE));
  });

  test("3.5 no action accepts an authority claim from the form", () => {
    const reads = [...ACTIONS_CODE.matchAll(/readField\(formData, "(\w+)"\)/g)].map(
      (m) => m[1],
    );
    const idReads = [...ACTIONS_CODE.matchAll(/readIds\(formData, "(\w+)"\)/g)].map(
      (m) => m[1],
    );
    for (const field of [...reads, ...idReads]) {
      assert.ok(
        !/actor|vendor|organization|permission|role|audit|status(Before|After)|publishedAt|createdBy/i.test(
          field,
        ) || field === "vendorRetailerIds",
        `the form supplies ${field}`,
      );
    }
  });

  test("3.6 every id read from a form is UUID-screened before it travels", () => {
    const bodies = ACTIONS_CODE.split(/export async function /).slice(1);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      if (!/readField\(formData, "(campaignId|groupId)"\)/.test(body)) continue;
      assert.ok(/isUuid\(/.test(body), `${name} does not screen its id`);
    }
  });

  test("3.7 no raw database message reaches a user-facing string", () => {
    // Every message is a fixed literal in this file. The database's own text is mapped
    // through REFUSAL_COPY by CODE, never echoed.
    assert.ok(!/result\.message|error\.message/.test(ACTIONS_CODE));
    assert.ok(!/\$\{result\./.test(ACTIONS_CODE.replace(/\$\{result\.outcome\.[a-zA-Z]+\}/g, "")));
  });

  test("3.8 every refusal reason has safe, actionable copy", () => {
    const copyBlock = ACTIONS.slice(
      ACTIONS.indexOf("const REFUSAL_COPY"),
      ACTIONS.indexOf("function readField"),
    );
    for (const reason of [
      "cancelled",
      "no-draft",
      "already-drafted",
      "not-published",
      "no-eligible-retailer",
      "no-eligible-product",
      "no-rule",
      "unknown",
    ]) {
      assert.ok(copyBlock.includes(`${reason}:`) || copyBlock.includes(`"${reason}":`),
        `no copy for ${reason}`);
    }
    // No copy names a table, a column, a function or a SQLSTATE.
    assert.ok(!/campaign_versions|campaign_eligible|SQLSTATE|4250|2351|5500/.test(copyBlock));
  });

  test("3.9 every successful mutation revalidates a canonical path", () => {
    const bodies = ACTIONS_CODE.split(/export async function /).slice(1);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      assert.ok(
        /revalidatePath\(/.test(body),
        `${name} does not trigger a canonical reread`,
      );
    }
  });

  test("3.10 revalidated paths are fixed literals, never interpolated from input", () => {
    const paths = [...ACTIONS_CODE.matchAll(/revalidatePath\(([^)]+)\)/g)].map((m) => m[1]);
    for (const path of paths) {
      assert.ok(
        /^(CAMPAIGNS_PATH|GROUPS_PATH)$/.test(path.trim()) ||
          /^`\$\{(CAMPAIGNS_PATH|GROUPS_PATH)\}\/\$\{(campaignId|groupId)\}(\/edit)?`$/.test(
            path.trim(),
          ),
        `unexpected revalidation target: ${path}`,
      );
    }
  });

  test("3.11 no action retries a mutation, ever", () => {
    assert.ok(!/\bretry\b|for \(let attempt|while \(attempt/i.test(ACTIONS_CODE));
  });

  test("3.12 a committed write is never repeated", () => {
    // The server half of the double-submit guard: an already-committed state short
    // circuits before the RPC is called again.
    for (const action of [
      "createCampaignDraftAction",
      "publishCampaignAction",
      "setCampaignLifecycleAction",
      "createCampaignVersionAction",
      "setRetailerGroupMembersAction",
    ]) {
      const start = ACTIONS_CODE.indexOf(`export async function ${action}(`);
      const body = ACTIONS_CODE.slice(start, ACTIONS_CODE.indexOf("\nexport ", start + 1));
      assert.ok(
        /prevState\.(committed|savedCampaignId)/.test(body),
        `${action} has no committed-state guard`,
      );
    }
  });

  test("3.13 a database no-op is reported as a no-op, not as a success", () => {
    assert.match(ACTIONS_CODE, /!result\.outcome\.published/);
    assert.match(ACTIONS_CODE, /!result\.outcome\.statusChanged/);
    assert.match(ACTIONS, /already published\. Nothing was changed/);
    assert.match(ACTIONS, /had already been made\. Nothing was changed/);
  });

  test("3.14 the lifecycle action accepts a closed literal set only", () => {
    assert.match(
      ACTIONS_CODE,
      /raw !== "PAUSE" && raw !== "RESUME" && raw !== "CANCEL"/,
    );
  });
});

/* ===========================================================================
 * 4. The wizard
 * ======================================================================== */

describe("4. the creation wizard", () => {
  test("4.1 it has the six required steps, in order, each with an explanation", () => {
    const input = read(join(ROOT, "lib/campaigns/campaign-input.ts"));
    const block = input.slice(
      input.indexOf("export const WIZARD_STEPS"),
      input.indexOf("export type WizardStepKey"),
    );
    const steps = [...block.matchAll(/key: "(\w+)",\s*\n?\s*title: "([^"]+)"/g)].map(
      (m) => ({ key: m[1], title: m[2] }),
    );

    assert.deepEqual(
      steps.map((step) => step.key),
      ["details", "audience", "products", "reward", "schedule", "review"],
    );
    assert.deepEqual(
      steps.map((step) => step.title),
      [
        "Campaign details",
        "Retailer audience",
        "Product eligibility",
        "Performance and reward",
        "Schedule and stacking",
        // "Review and SAVE". The final step has never published anything — it writes a
        // draft — and a step titled "publish" promised what the button beneath it did not
        // do. The capability is asserted separately by 4.2.
        "Review and save",
      ],
    );

    // Every step carries a one-sentence explanation, which is what the stepper shows
    // beside the title at every width.
    const summaries = [...block.matchAll(/summary: "([^"]+)"/g)].map((m) => m[1]);
    assert.equal(summaries.length, 6, "every step needs a one-sentence explanation");
    for (const summary of summaries) {
      assert.ok(summary.trim().length > 10, `a step explanation is too thin: ${summary}`);
    }
  });

  test("4.2 it NEVER publishes — saving a draft is its only mutation", () => {
    assert.ok(!/publishCampaign/.test(WIZARD_CODE));
    assert.ok(!/setCampaignLifecycle/.test(WIZARD_CODE));
    assert.match(WIZARD, /Save draft/);
  });

  test("4.3 the create page offers no publish CONTROL either", () => {
    // The page's description legitimately uses the word "publish" to tell an operator
    // that nothing is live yet. What must be absent is the capability, not the noun.
    const newPage = code(read(join(VENDOR_DIR, "new/page.tsx")));
    assert.ok(!/publishCampaignAction/.test(newPage), "it imports the publish action");
    assert.ok(!/CampaignLifecycleDialog/.test(newPage), "it renders a lifecycle control");
    assert.ok(!/setCampaignLifecycle/.test(newPage));
    // And the preview it passes down is null: a campaign with no version has nothing to
    // resolve against.
    assert.match(newPage, /preview=\{null\}/);
  });

  test("4.4 saving is explicit and is hidden once committed", () => {
    // No auto-save, and no second submit after a committed create.
    assert.ok(!/useEffect\([^)]*formAction/.test(WIZARD_CODE));
    assert.match(WIZARD_CODE, /const committed = state\.savedCampaignId !== null/);
    // Once the write has committed the submit is replaced by a LINK to the saved
    // campaign, so an ordinary retry cannot create a second one.
    assert.match(WIZARD_CODE, /committed \?[\s\S]{0,600}Open campaign/);
    assert.match(WIZARD_CODE, /href=\{`\/campaigns\/\$\{state\.savedCampaignId\}`\}/);
  });

  test("4.5 every step's fields stay MOUNTED, so no value is lost between steps", () => {
    // Hidden with a class, never unmounted: an unmounted input contributes nothing to
    // the FormData, so switching steps would silently drop the earlier answers.
    const stepDivs = [...WIZARD_CODE.matchAll(/step\.key !== "(\w+)" && "hidden"/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(stepDivs, [
      "details",
      "audience",
      "products",
      "reward",
      "schedule",
      "review",
    ]);
  });

  test("4.6 the multi-select hides non-matching options rather than unmounting them", () => {
    // Same reasoning: a search that unmounted unmatched checkboxes would drop a
    // selection the operator made before typing.
    // The markup now lives in the shared picker, which the wizard AND both group forms
    // use — so this one assertion covers four surfaces instead of one.
    assert.match(PICKER_CODE, /hidden && "hidden"/);
    assert.ok(!/matches\.has\(option\.id\) \?\s*\(/.test(PICKER_CODE));
    assert.ok(
      !/\{matches\.has\([^)]*\) && </.test(PICKER_CODE),
      "an option is conditionally rendered, which would drop it from the FormData",
    );
  });

  test("4.7 selection counts are announced to assistive technology", () => {
    assert.match(PICKER_CODE, /aria-live="polite"[\s\S]{0,400}selected/);
  });

  test("4.8 the step rail exposes step semantics", () => {
    // Both presentations of the rail — the wide vertical one and the narrow
    // "Step X of 6" header — mark the current step and name the position.
    assert.match(STEPPER_CODE, /aria-current=\{active \? "step" : undefined\}/);
    assert.match(STEPPER_CODE, /aria-label=\{`Step \$\{activeIndex \+ 1\} of \$\{total\}/);
    assert.match(STEPPER_CODE, /Step \{activeIndex \+ 1\} of \{total\}/);
    // Completion is stated in words, never by colour alone.
    assert.match(STEPPER_CODE, /"Complete"/);
  });

  test("4.9 every field has a label, and errors are announced", () => {
    // The wizard now uses the shared <Field>, which is where the label/control/error
    // association is defined once for the whole product.
    assert.match(SHARED_FIELD, /<label\s+htmlFor=\{htmlFor\}/);
    assert.match(WIZARD_CODE, /<Field\b/);
    assert.match(WIZARD_SURFACE_CODE, /role="alert"/);
    assert.match(WIZARD_CODE, /aria-invalid=/);
  });

  test("4.10 choices use radio and checkbox semantics, not click handlers on divs", () => {
    assert.match(CHOICE_CARDS_CODE, /type="radio"/);
    assert.match(PICKER_CODE, /type="checkbox"/);
    assert.match(CHOICE_CARDS_CODE, /<fieldset/);
    assert.match(CHOICE_CARDS_CODE, /<legend/);
    assert.match(PICKER_CODE, /<fieldset/);
    assert.match(PICKER_CODE, /<legend/);
    // A card is the radio's own <label>, so the whole surface is the control rather than
    // a div with an onClick.
    assert.match(CHOICE_CARDS_CODE, /<label[\s\S]{0,900}type="radio"/);
  });

  test("4.11 Next is gated on the current step, Save on the WHOLE form", () => {
    assert.match(WIZARD_CODE, /disabled=\{!canAdvance \|\| pending\}/);
    assert.match(WIZARD_CODE, /disabled=\{!validation\.ok \|\| !optionsReady \|\| pending\}/);
  });

  test("4.12 a read failure disables saving rather than becoming a write failure", () => {
    assert.match(WIZARD_CODE, /!optionsReady/);
    assert.match(WIZARD, /Some options could not be loaded/);
  });

  test("4.13 the review step shows the conflicts and states that publishing is separate", () => {
    // Whitespace-normalized: this copy is line-wrapped in JSX, so matching the raw source
    // would test the formatter rather than the wording.
    const prose = WIZARD.replace(/\s+/g, " ");
    // The conflict detail is rendered by the shared eligibility panel, which states the
    // count exactly and — unlike the copy it replaced — distinguishes a publication that
    // is merely reduced from one the database will refuse outright.
    assert.match(WIZARD_CODE, /<EligibilityPanel/);
    const panel = ELIGIBILITY.replace(/\s+/g, " ");
    assert.match(panel, /selected products assigned/);
    assert.match(panel, /nothing to earn on/);

    // Saving is not publishing, and the review step says so.
    assert.match(prose, /Saving does not publish/);
    assert.match(
      prose,
      /Nothing is visible to a Retailer until you publish it from the campaign/,
    );
    assert.ok(
      /calculation engine is connected/.test(prose) ||
        /<CalculationEngineNotice/.test(prose),
      "the review step never says results are not calculated yet",
    );
  });

  test("4.13b the product step states the two eligibility behaviours", () => {
    // Sourced from the shared vocabulary, not restated, so the Vendor and the Retailer
    // cannot be told different things about the same campaign.
    assert.match(WIZARD_CODE, /productResolutionExplanation\(/);
    assert.match(WIZARD_CODE, /"SELECTED_PRODUCTS" \? "SNAPSHOT" : "LIVE_TEMPORAL"/);
    // And the plain-language label for each scope, which is what the choice card shows.
    assert.match(WIZARD_CODE, /productScopePlainLabel\(/);
  });

  test("4.13c coin inputs carry the same bound the database enforces", () => {
    // An input that accepted more than the database does would produce a round trip that
    // fails for a reason the operator could not see coming.
    assert.match(WIZARD_CODE, /max=\{MAX_CAMPAIGN_COINS\}/);
    const bounded = [...WIZARD_CODE.matchAll(/max=\{MAX_CAMPAIGN_COINS\}/g)].length;
    assert.equal(bounded, 3, "coins per unit, bonus coins and the cap must all be bounded");
  });

  test("4.14 no internal identifier is rendered as visible text", () => {
    // Ids live in `value` attributes and React keys only.
    assert.ok(!/>\{[a-zA-Z.]*[Ii]d\}</.test(WIZARD_CODE));
    assert.ok(!/aria-label=\{[^}]*Id\}/.test(WIZARD_CODE));
    assert.ok(!/title=\{[^}]*Id\}/.test(WIZARD_CODE));
  });
});

/* ===========================================================================
 * 5. Lifecycle dialogs
 * ======================================================================== */

describe("5. every lifecycle mutation is behind a confirmation", () => {
  test("5.1 all five lifecycle kinds have confirmation copy", () => {
    for (const kind of ["PUBLISH", "PAUSE", "RESUME", "CANCEL", "NEW_VERSION"]) {
      assert.ok(DIALOG.includes(`${kind}: {`), `no copy for ${kind}`);
    }
  });

  test("5.2 the dialog is a real dialog for assistive technology", () => {
    assert.match(DIALOG_CODE, /role="dialog"/);
    assert.match(DIALOG_CODE, /aria-modal="true"/);
    assert.match(DIALOG_CODE, /aria-labelledby=\{headingId\}/);
    assert.match(DIALOG_CODE, /aria-describedby=\{descriptionId\}/);
    assert.match(DIALOG_CODE, /aria-haspopup="dialog"/);
    assert.match(DIALOG_CODE, /aria-expanded=\{open\}/);
  });

  test("5.3 focus moves in on open and back to the trigger on close", () => {
    assert.match(DIALOG_CODE, /dialogRef\.current\?\.focus\(\)/);
    assert.match(DIALOG_CODE, /openerRef\.current\?\.focus\(\)/);
  });

  test("5.4 Escape closes, but never while a write is in flight", () => {
    assert.match(DIALOG_CODE, /event\.key === "Escape" && !pending/);
  });

  test("5.5 the confirm button DISAPPEARS once the write commits", () => {
    // The client half of the double-submit guard. The RPCs are idempotent regardless,
    // but a control that cannot be pressed twice removes the accident as well.
    assert.match(DIALOG_CODE, /\{!state\.committed && \(\s*<Button\s*\n?\s*type="submit"/);
  });

  test("5.6 the dialog never retries and never auto-submits", () => {
    assert.ok(!/\bretry\b/i.test(DIALOG_CODE));
    assert.ok(!/useEffect\([^)]*formAction/.test(DIALOG_CODE));
  });

  test("5.7 the campaign id is a hidden field, never rendered as text", () => {
    assert.match(DIALOG_CODE, /<input type="hidden" name="campaignId" value=\{campaignId\}/);
    assert.ok(!/>\{campaignId\}</.test(DIALOG_CODE));
  });

  test("5.8 the cancel copy states that it is terminal", () => {
    assert.match(DIALOG, /cannot be undone/);
  });

  test("5.9 the publish copy states that the version becomes frozen", () => {
    assert.match(DIALOG, /freezes this version/);
  });
});

/* ===========================================================================
 * 6. The Vendor pages
 * ======================================================================== */

describe("6. the Vendor pages", () => {
  test("6.1 every page re-resolves access itself rather than trusting the layout", () => {
    for (const file of VENDOR_FILES.filter((f) => f.endsWith("/page.tsx"))) {
      const source = code(read(file));
      assert.ok(
        /getVendorSuperAdminAccess|status === "denied"/.test(source),
        `${file.slice(ROOT.length)} does not re-resolve access`,
      );
      assert.ok(
        /redirect\("\/access-denied"\)/.test(source),
        `${file.slice(ROOT.length)} does not fail closed`,
      );
    }
  });

  test("6.2 detail routes preserve notFound control flow for an unknown id", () => {
    // An unknown id and another Vendor's id are the same answer, so a 404 cannot be used
    // to probe which campaigns exist.
    for (const file of [
      join(VENDOR_DIR, "[campaignId]/page.tsx"),
      join(VENDOR_DIR, "[campaignId]/edit/page.tsx"),
      join(VENDOR_DIR, "groups/[groupId]/page.tsx"),
    ]) {
      const source = code(read(file));
      assert.match(source, /status === "not-found"/);
      assert.match(source, /notFound\(\)/);
    }
  });

  test("6.3 redirect and notFound are never caught", () => {
    for (const file of VENDOR_FILES) {
      const source = code(read(file));
      assert.ok(
        !/catch[\s\S]{0,120}(redirect|notFound)\(/.test(source),
        `${file.slice(ROOT.length)} may swallow a control-flow signal`,
      );
    }
  });

  test("6.4 the list renders no progress or coin total", () => {
    const source = code(LIST);
    assert.ok(!/\b(earned|balance|progress|sold)\b/i.test(source));
  });

  test("6.5 the list exposes the required filters with radio semantics", () => {
    const source = code(LIST);
    assert.match(source, /role="radiogroup"/);
    assert.match(source, /aria-checked=\{selected\}/);
    for (const label of ["Draft", "Scheduled", "Active", "Paused", "Ended", "Cancelled"]) {
      assert.ok(LIST.includes(`label: "${label}"`), `missing filter: ${label}`);
    }
    assert.ok(LIST.includes('label: "Individual"'));
    assert.ok(LIST.includes('label: "Retailer team"'));
  });

  test("6.6 a filter result change is announced", () => {
    assert.match(code(LIST), /aria-live="polite"/);
  });

  test("6.7 the detail page shows the frozen snapshot and says what freezing means", () => {
    assert.match(DETAIL, /Eligibility at publication/);
    assert.match(DETAIL, /frozen at publication/i);
    assert.match(DETAIL, /Included via/);
  });

  test("6.8 the detail page offers a lifecycle control only when it is valid", () => {
    // Whitespace-normalized: these declarations are line-wrapped by the formatter, and
    // matching the raw source would test the formatter rather than the guard.
    const source = code(DETAIL).replace(/\s+/g, " ");
    assert.match(source, /const canPublish = campaign\.draftVersionId !== null/);
    assert.match(source, /const canPause = campaign\.campaignStatus === "PUBLISHED"/);
    assert.match(source, /const canResume = campaign\.campaignStatus === "PAUSED"/);
    assert.match(source, /const canVersion =/);
    // Cancellation is offered only from a live state, and never beside the primary
    // action: it lives in its own area at the foot of the page.
    assert.match(source, /const canCancel =/);
    assert.match(source, /canCancel && \( <section/);
  });

  test("6.9 the detail page never fabricates a reward when the rule is missing", () => {
    // The dash became "Not set", which reads correctly in a labelled tile where a bare
    // "—" is ambiguous. What must hold is that the fallback is a STATEMENT OF ABSENCE and
    // never a fabricated figure.
    const source = code(DETAIL);
    assert.match(source, /reward \?\? "(—|Not set)"/);
    assert.ok(
      !/reward \?\? [`"'][^"'`]*\d/.test(source),
      "the reward fallback contains a number, which would invent an offer",
    );
  });

  test("6.9b the Vendor detail distinguishes frozen from dynamic product eligibility", () => {
    const source = code(DETAIL);
    assert.match(source, /productResolutionLabel\(/);
    assert.match(source, /productResolutionExplanation\(/);
    // The snapshot panel must not describe a LIVE_TEMPORAL campaign's products as frozen.
    const prose = DETAIL.replace(/\s+/g, " ");
    assert.match(prose, /Products are not:/);
    assert.match(prose, /eligible at the time of each verified sale/i);
    // And it must not print a snapshot count of zero as if it meant "no products": a
    // live-temporal row says so in words, and a genuine zero is called out rather than
    // rendered as a bare digit an operator would read as a rounding artefact.
    assert.match(source, /productEligibilityResolution === "LIVE_TEMPORAL" \?/);
    assert.match(prose, /Eligible at time of sale/);
    assert.match(prose, /0 — nothing to earn on/);
  });

  test("6.10 the group screens explain that an edit does not change a published campaign", () => {
    assert.match(GROUP_FORMS, /does <strong>not<\/strong> change any campaign/);
    assert.match(
      read(join(VENDOR_DIR, "groups/[groupId]/page.tsx")),
      /does <strong>not<\/strong> change any campaign/,
    );
  });

  test("6.11 the group membership form refuses to save against a failed read", () => {
    assert.match(code(GROUP_FORMS), /if \(!optionsReady\)/);
    assert.match(GROUP_FORMS, /Retailers could not be loaded/);
  });

  test("6.12 the phrase 'group campaign' appears nowhere in the campaign surfaces", () => {
    // The two concepts the requirement insists on separating: a Retailer GROUP is an
    // audience, a Retailer TEAM is how performance is measured.
    // Comments stripped: one module explicitly documents that this phrase is banned, and
    // a test that could not tell the ban apart from a violation would fail on the rule
    // itself.
    for (const file of [...VENDOR_FILES, ...RETAILER_FILES]) {
      const source = code(read(file));
      assert.ok(
        !/group campaign/i.test(source),
        `${file.slice(ROOT.length)} says "group campaign"`,
      );
    }
  });
});

/* ===========================================================================
 * 7. Responsiveness and focus, across every campaign surface
 * ======================================================================== */

describe("7. responsive and focus-visible by construction", () => {
  const ALL = [...VENDOR_FILES, ...RETAILER_FILES].filter((f) => f.endsWith(".tsx"));

  test("7.1 every interactive surface declares a visible focus ring", () => {
    // Either inline, or through the shared visual system. @/components/ui/button defines
    // `focus-visible:ring-2` once in its BASE, so a file whose only interactive elements
    // come from <Button> or buttonClasses() already has the ring — requiring it to
    // restate the utility would push the design system back into every call site.
    const SHARED = /buttonClasses\(|<Button\b/;
    for (const file of ALL) {
      const source = read(file);
      if (!/<button|<input|<select|<textarea|<Link/.test(source)) continue;
      assert.ok(
        /focus-visible:ring|focus:ring/.test(source) || SHARED.test(source),
        `${file.slice(ROOT.length)} has an interactive element with no focus ring`,
      );
    }
  });

  test("7.2 multi-column layouts declare a small-screen fallback", () => {
    for (const file of ALL) {
      const source = read(file);
      const gridClasses = [...source.matchAll(/grid-cols-\d/g)].map((m) => m[0]);
      if (gridClasses.length === 0) continue;
      assert.ok(
        /grid-cols-1|sm:grid-cols|grid gap/.test(source),
        `${file.slice(ROOT.length)} has a fixed multi-column grid`,
      );
    }
  });

  test("7.3 tables scroll inside their own container rather than the page", () => {
    for (const file of ALL) {
      const source = read(file);
      if (!/<table/.test(source)) continue;
      assert.ok(
        /overflow-x-auto/.test(source),
        `${file.slice(ROOT.length)} has a table with no horizontal scroll container`,
      );
      assert.ok(
        /<caption/.test(source),
        `${file.slice(ROOT.length)} has a table with no caption`,
      );
    }
  });

  test("7.4 no campaign surface hard-codes a pixel width", () => {
    for (const file of ALL) {
      assert.ok(
        !/\bw-\[\d+px\]|\bmin-w-\[\d{3,}px\]/.test(read(file)),
        `${file.slice(ROOT.length)} hard-codes a pixel width`,
      );
    }
  });
});
