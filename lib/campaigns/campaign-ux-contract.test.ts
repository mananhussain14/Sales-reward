/**
 * SOURCE-LEVEL CONTRACT for the campaign UX redesign.
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHAT THIS FILE IS FOR
 * ============================================================================
 * campaign-web-safety.test.ts pins the SAFETY properties — no write on a read-only page,
 * no disclosure field, no lost double-submit guard. This file pins the properties the
 * redesign was commissioned to fix, so a later change cannot quietly undo them:
 *
 *   * Retailer-group creation is ONE flow, and the two-RPC window is handled truthfully.
 *   * The wizard's progress control cannot wrap, and a live summary exists at every width.
 *   * The product/Retailer conflict states the real consequence and offers a way out.
 *   * ONE lifecycle vocabulary. The words "in force" do not reappear beside a state badge.
 *   * The campaign row has a deliberate hierarchy and a visible click affordance.
 *   * Destructive actions do not sit beside the primary one.
 *   * Status is never carried by colour alone.
 *
 * These are source assertions for the reason given at the top of campaign-web-safety:
 * this repository has no DOM runner, and every UI guarantee in the product is asserted
 * this way. They catch a REGRESSION IN KIND, not a visual defect — the screenshots in
 * manual testing remain the check for how it actually looks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENDOR_DIR = join(ROOT, "app/(admin)/campaigns");
const RETAILER_DIR = join(ROOT, "app/(retailer)/retailer/campaigns");
const COMPONENTS = join(ROOT, "components/campaigns");

const read = (path: string) => readFileSync(path, "utf8");
/** Strips comments so a rule is never confused with prose describing it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
/** Collapses whitespace, so a rule is not testing the formatter's line breaks. */
const flat = (source: string) => source.replace(/\s+/g, " ");

const WIZARD = read(join(VENDOR_DIR, "campaign-wizard.tsx"));
const WIZARD_CODE = code(WIZARD);
const LIST = read(join(VENDOR_DIR, "campaign-list.tsx"));
const LIST_CODE = code(LIST);
const DETAIL = read(join(VENDOR_DIR, "[campaignId]/page.tsx"));
const DETAIL_CODE = code(DETAIL);
const GROUP_FORMS = read(join(VENDOR_DIR, "groups/group-forms.tsx"));
const GROUP_FORMS_CODE = code(GROUP_FORMS);
const GROUPS_PAGE = read(join(VENDOR_DIR, "groups/page.tsx"));
const GROUPS_PAGE_CODE = code(GROUPS_PAGE);
const ACTIONS = read(join(VENDOR_DIR, "actions.ts"));
const ACTIONS_CODE = code(ACTIONS);
const RETAILER_PAGE = read(join(RETAILER_DIR, "page.tsx"));
const RETAILER_PAGE_CODE = code(RETAILER_PAGE);

const STEPPER = read(join(COMPONENTS, "wizard-stepper.tsx"));
const STEPPER_CODE = code(STEPPER);
const SUMMARY = read(join(COMPONENTS, "campaign-summary.tsx"));
const SUMMARY_CODE = code(SUMMARY);
const PICKER = read(join(COMPONENTS, "entity-picker.tsx"));
const PICKER_CODE = code(PICKER);
const CHOICE = read(join(COMPONENTS, "choice-cards.tsx"));
const CHOICE_CODE = code(CHOICE);
const ELIGIBILITY = read(join(COMPONENTS, "eligibility-panel.tsx"));
const ELIGIBILITY_CODE = code(ELIGIBILITY);
const FACTS = read(join(COMPONENTS, "campaign-facts.tsx"));

/* ===========================================================================
 * 1. Retailer-group creation is ONE flow
 * ======================================================================== */

describe("1. Retailer group creation completes the whole task", () => {
  test("1.1 the create form takes the name, the description AND the Retailers", () => {
    const create = GROUP_FORMS_CODE.slice(
      GROUP_FORMS_CODE.indexOf("export function CreateGroupForm"),
      GROUP_FORMS_CODE.indexOf("export function EditGroupForm"),
    );
    assert.match(create, /name="name"/);
    assert.match(create, /name="description"/);
    // The selector the old flow forced onto a second page.
    assert.match(create, /<EntityPicker/);
    assert.match(create, /name="vendorRetailerIds"/);
  });

  test("1.2 the page passes the Retailer directory into the create form", () => {
    assert.match(GROUPS_PAGE_CODE, /getVendorRetailers\(\)/);
    assert.match(GROUPS_PAGE_CODE, /<CreateGroupForm[\s\S]{0,200}retailers=\{/);
    // A directory that failed to READ is never treated as an empty list.
    assert.match(GROUPS_PAGE_CODE, /retailers !== null/);
    assert.match(GROUPS_PAGE_CODE, /optionsReady=\{retailerRows !== null\}/);
  });

  test("1.3 the action attaches the Retailers, then lands on the group", () => {
    const action = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function createRetailerGroupAction"),
      ACTIONS_CODE.indexOf("export async function updateRetailerGroupAction"),
    );
    assert.match(action, /createRetailerGroup\(/);
    assert.match(action, /setRetailerGroupMembers\(/);
    // The requirement: land on the group detail page rather than a list.
    assert.match(action, /redirect\(`\$\{GROUPS_PATH\}\/\$\{groupId\}\?created=1`\)/);
  });

  test("1.4 a membership failure after creation is reported truthfully, not as a failure", () => {
    const action = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function createRetailerGroupAction"),
      ACTIONS_CODE.indexOf("export async function updateRetailerGroupAction"),
    );
    // It keeps the id — which is what lets the UI link straight to the editor AND what
    // stops a retry creating a second group.
    assert.match(action, /createdGroupId: groupId/);
    assert.match(action, /partialWarning:/);
    assert.match(flat(action), /was created, but its Retailers/);
    // NOTHING IS RETRIED AUTOMATICALLY.
    assert.ok(
      !/for \(|while \(|retry|attempt\s*\+\+/i.test(action),
      "the create action contains a retry loop",
    );
  });

  test("1.5 no retry can produce a second group", () => {
    const action = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function createRetailerGroupAction"),
      ACTIONS_CODE.indexOf("export async function updateRetailerGroupAction"),
    );
    // Server-side half: an already-created state short-circuits.
    assert.match(action, /prevState\.createdGroupId !== null/);
    assert.match(action, /return prevState;/);
    // Client-side half: the submit disappears.
    const create = GROUP_FORMS_CODE.slice(
      GROUP_FORMS_CODE.indexOf("export function CreateGroupForm"),
      GROUP_FORMS_CODE.indexOf("export function EditGroupForm"),
    );
    assert.match(create, /const created = state\.createdGroupId !== null/);
    assert.match(create, /\{!created && \(/);
  });

  test("1.6 an empty group is possible but must be chosen deliberately", () => {
    const create = GROUP_FORMS_CODE.slice(
      GROUP_FORMS_CODE.indexOf("export function CreateGroupForm"),
      GROUP_FORMS_CODE.indexOf("export function EditGroupForm"),
    );
    assert.match(create, /allowEmpty/);
    assert.match(create, /blockedOnEmpty/);
    // …and the guard must not deadlock a Vendor who simply has no Retailers yet.
    assert.match(create, /const canChoose = optionsReady && retailers\.length > 0/);
    assert.match(create, /canChoose && noneChosen && !allowEmpty/);
  });

  test("1.7 the primary language is Retailers, not members", () => {
    // "Membership" survives only where it names the replace-the-whole-set contract.
    const visible = [...GROUP_FORMS.matchAll(/>\s*([A-Z][^<>{}]{3,60})\s*</g)].map(
      (m) => m[1],
    );
    for (const label of visible) {
      assert.ok(
        !/\bmembers?\b/i.test(label),
        `a visible label still says "member": ${label.trim()}`,
      );
    }
    assert.match(GROUP_FORMS, /Save Retailers/);
  });
});

/* ===========================================================================
 * 2. The wizard progress control
 * ======================================================================== */

describe("2. the wizard's progress control cannot wrap", () => {
  test("2.1 the step list is not a wrapping row of pills", () => {
    // The exact defect the redesign was commissioned for: `flex flex-wrap` over six
    // labelled buttons, which ran to two or three ragged rows at laptop width.
    assert.ok(
      !/flex flex-wrap[^"]*"\s*\n?\s*aria-label=\{`Step/.test(WIZARD_CODE),
      "the wizard renders a wrapping step bar again",
    );
    assert.ok(
      !/flex-wrap/.test(STEPPER_CODE),
      "the stepper reintroduced flex-wrap, which is what allowed the ragged rows",
    );
  });

  test("2.2 it renders a vertical rail wide and a compact header narrow", () => {
    assert.match(STEPPER_CODE, /lg:hidden/);
    assert.match(STEPPER_CODE, /hidden lg:block/);
    assert.match(STEPPER_CODE, /Step \{activeIndex \+ 1\} of \{total\}/);
  });

  test("2.3 the wizard lays the rail, the step and the summary out as columns", () => {
    assert.match(WIZARD_CODE, /lg:grid-cols-\[13rem_minmax\(0,1fr\)\]/);
    assert.match(WIZARD_CODE, /xl:grid-cols-\[13rem_minmax\(0,1fr\)_17rem\]/);
    // The content column must be allowed to shrink, or a long product name forces the
    // whole page to scroll sideways.
    assert.match(WIZARD_CODE, /min-w-0/);
  });

  test("2.4 a live summary exists, and collapses rather than disappearing", () => {
    assert.match(WIZARD_CODE, /<CampaignSummaryPanel/);
    // `<details>` below xl, a sticky aside at xl. Both, not one or the other.
    assert.match(SUMMARY_CODE, /<details/);
    assert.match(SUMMARY_CODE, /xl:hidden/);
    assert.match(SUMMARY_CODE, /sticky top-6 hidden[^"]*xl:block/);
  });

  test("2.5 the summary covers every decision the requirement lists", () => {
    const rows = WIZARD_CODE.slice(
      WIZARD_CODE.indexOf("const summaryRows"),
      WIZARD_CODE.indexOf("const summaryComplete"),
    );
    for (const key of [
      "name",
      "audience",
      "products",
      "performance",
      "reward",
      "schedule",
      "stacking",
    ]) {
      assert.match(rows, new RegExp(`key: "${key}"`), `the summary omits ${key}`);
    }
  });

  test("2.6 an unset summary row says so instead of rendering a bare dash", () => {
    // A dash reads as "none"; the honest state is "not chosen yet".
    assert.match(SUMMARY_CODE, /Not set/);
    assert.match(SUMMARY_CODE, /<AlertTriangleIcon/);
  });

  test("2.7 the review step offers an Edit link per section", () => {
    const review = WIZARD_CODE.slice(WIZARD_CODE.indexOf('step.key !== "review"'));
    const sections = [...review.matchAll(/<ReviewSection/g)].length;
    assert.ok(sections >= 6, `only ${sections} review sections`);
    const edits = [...review.matchAll(/onEdit=\{\(\) => setStepIndex\((\d)\)\}/g)].map(
      (m) => Number(m[1]),
    );
    // Every step that owns a decision is reachable from the review.
    for (const index of [0, 1, 2, 3, 4]) {
      assert.ok(edits.includes(index), `no review section returns to step ${index + 1}`);
    }
  });

  test("2.8 an incomplete review section is called out rather than dashed", () => {
    const review = WIZARD_CODE.slice(WIZARD_CODE.indexOf('step.key !== "review"'));
    assert.match(review, /incomplete=\{/);
    assert.match(review, /incompleteMessage=/);
    assert.match(SUMMARY_CODE, /incomplete \? "border-amber-300/);
  });

  test("2.9 saving is distinguished from publishing in words", () => {
    const prose = flat(WIZARD);
    assert.match(prose, /Saving does not publish/);
    assert.match(prose, /Save draft/);
    assert.ok(
      !/Review and publish/.test(prose),
      "the wizard again promises a publish it does not perform",
    );
  });
});

/* ===========================================================================
 * 3. Product eligibility and the conflict experience
 * ======================================================================== */

describe("3. the conflict experience says what will actually happen", () => {
  test("3.1 the panel classifies rather than restating one sentence", () => {
    assert.match(ELIGIBILITY_CODE, /classifyPublicationEligibility\(/);
    assert.match(ELIGIBILITY_CODE, /publicationEligibilityCopy\(/);
  });

  test("3.2 it names the affected Retailer and the exact counts", () => {
    assert.match(ELIGIBILITY_CODE, /row\.retailerName/);
    assert.match(ELIGIBILITY_CODE, /row\.eligibleProductCount/);
    assert.match(ELIGIBILITY_CODE, /selectedProductCount/);
    assert.match(flat(ELIGIBILITY), /of \{selectedProductCount\} selected products assigned/);
  });

  test("3.3 a Retailer that matched nothing is called out as earning nothing", () => {
    assert.match(flat(ELIGIBILITY), /nothing to earn on/);
  });

  test("3.4 it offers a correction path, not just a warning", () => {
    assert.match(ELIGIBILITY_CODE, /Review products/);
    assert.match(ELIGIBILITY_CODE, /Change audience/);
    // Wired to the steps that fix each one.
    assert.match(WIZARD_CODE, /onReviewProducts=\{\(\) => setStepIndex\(2\)\}/);
    assert.match(WIZARD_CODE, /onChangeAudience=\{\(\) => setStepIndex\(1\)\}/);
  });

  test("3.5 a blocked publication is announced; a reduced one is not", () => {
    // Blocked is a refusal the operator must act on. Partial is advisory, and announcing
    // it on every keystroke of a wizard step would be noise.
    assert.match(ELIGIBILITY_CODE, /role=\{blocked \? "alert" : undefined\}/);
  });

  test("3.6 the panel never claims which products are missing where", () => {
    // preview_vendor_campaign_publication returns COUNTS, not the per-Retailer product
    // breakdown. Naming products would be a second implementation of the resolution rule.
    assert.ok(
      !/productName|productCode/.test(ELIGIBILITY_CODE),
      "the conflict panel names products it cannot know",
    );
  });

  test("3.7 both product scopes are offered in plain language", () => {
    assert.match(WIZARD_CODE, /productScopePlainLabel\(/);
    assert.match(WIZARD_CODE, /productResolutionExplanation\(/);
  });
});

/* ===========================================================================
 * 4. ONE lifecycle vocabulary
 * ======================================================================== */

describe("4. status language is single and consistent", () => {
  test('4.1 the phrase "in force" is gone from every campaign surface', () => {
    // It described the VERSION POINTER while the badge beside it described the CAMPAIGN'S
    // EFFECTIVE-TIME STATE, so "VERSION 1 · IN FORCE" and "Scheduled" appeared together
    // and read as a contradiction.
    // Asserted on the CODE, with comments stripped. The detail page's header comment
    // quotes the phrase to explain why it was removed, and a test that could not tell an
    // explanation apart from a rendering would fail on its own documentation.
    for (const [name, source] of [
      ["detail", DETAIL_CODE],
      ["list", LIST_CODE],
      ["wizard", WIZARD_CODE],
      ["retailer page", RETAILER_PAGE_CODE],
    ] as const) {
      assert.ok(
        !/in force/i.test(source),
        `"in force" is back on the ${name} surface`,
      );
    }
  });

  test("4.2 the detail page shows exactly one state badge", () => {
    const badges = [...DETAIL_CODE.matchAll(/<CampaignStateBadge/g)].length;
    assert.equal(badges, 1, `the detail page renders ${badges} state badges`);
  });

  test("4.3 version and publication are labelled as secondary metadata", () => {
    assert.match(DETAIL_CODE, /const versionLine =/);
    assert.match(flat(DETAIL), /Version \$\{campaign\.publishedVersionNumber \?\? "—"\} · published/);
    assert.match(flat(DETAIL), /draft, not yet published/);
  });

  test("4.4 every lifecycle word comes from the shared badge map", () => {
    // Six states, one map, so the list, the detail page and the Retailer portal cannot
    // disagree about what a campaign is doing.
    const badge = read(join(ROOT, "components/campaigns/campaign-state-badge.tsx"));
    for (const state of [
      "DRAFT",
      "SCHEDULED",
      "ACTIVE",
      "PAUSED",
      "ENDED",
      "CANCELLED",
    ]) {
      assert.match(badge, new RegExp(`${state}: \\{ label:`));
    }
  });

  test("4.5 state is never carried by colour alone", () => {
    const badge = read(join(ROOT, "components/campaigns/campaign-state-badge.tsx"));
    // Every entry has a text label; two carry an icon as well.
    const labels = [...badge.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    assert.equal(labels.length, 6);
    for (const label of labels) assert.ok(label.trim().length > 0);
  });
});

/* ===========================================================================
 * 5. The campaign list
 * ======================================================================== */

describe("5. the campaign row is scannable and obviously clickable", () => {
  test("5.1 the whole row is one link with a stated affordance", () => {
    assert.match(LIST_CODE, /<Link[\s\S]{0,200}cardClasses\(\s*"interactive"/);
    assert.match(flat(LIST), /View details/);
    assert.match(LIST_CODE, /<ChevronRightIcon/);
  });

  test("5.2 it shows every fact the requirement lists", () => {
    for (const [what, pattern] of [
      ["name", /campaign\.name/],
      ["status", /<CampaignStateBadge/],
      ["performance type", /performancePlainLabel\(/],
      ["audience", /audienceSummary\(/],
      ["product mode", /productSummary\(/],
      ["reward", /rewardSummary\(/],
      ["dates", /formatPeriod\(/],
      ["timezone", /campaign\.timezoneName/],
      ["version", /campaign\.versionNumber/],
    ] as const) {
      assert.match(LIST_CODE, pattern, `the row omits ${what}`);
    }
  });

  test("5.3 the facts are not all equally prominent", () => {
    // The previous row printed six identical definition-list cells. The reward now sits
    // in its own emphasized chip and the coverage facts are explicitly quiet.
    assert.match(LIST_CODE, /function MetaFact/);
    assert.match(LIST_CODE, /text-xs text-slate-600/);
    assert.match(LIST_CODE, /bg-indigo-50[^"]*text-sm font-semibold text-indigo-700/);
  });

  test("5.4 both filter groups are present, with counts", () => {
    for (const label of [
      "All",
      "Draft",
      "Scheduled",
      "Active",
      "Paused",
      "Ended",
      "Cancelled",
    ]) {
      assert.match(LIST_CODE, new RegExp(`label: "${label}"`), `missing filter ${label}`);
    }
    for (const label of ["All types", "Individual", "Retailer team"]) {
      assert.match(LIST_CODE, new RegExp(`label: "${label}"`));
    }
    assert.match(LIST_CODE, /role="radiogroup"/);
    assert.match(LIST_CODE, /aria-live="polite"/);
  });

  test("5.5 a missing reward is stated, never invented", () => {
    assert.match(LIST_CODE, /reward \?\? "No reward set"/);
  });
});

/* ===========================================================================
 * 6. Actions: one primary, destructive separated
 * ======================================================================== */

describe("6. actions do not compete", () => {
  test("6.1 cancel is not in the header action cluster", () => {
    const header = DETAIL_CODE.slice(
      DETAIL_CODE.indexOf("<header"),
      DETAIL_CODE.indexOf("</header>"),
    );
    assert.ok(
      !/kind="CANCEL"/.test(header),
      "the destructive action is back beside the primary one",
    );
    // And the header does still carry the constructive ones.
    assert.match(header, /kind="PUBLISH"/);
    assert.match(header, /Edit draft/);
  });

  test("6.2 cancel lives in its own labelled area", () => {
    assert.match(DETAIL_CODE, /canCancel && \(\s*<section/);
    assert.match(flat(DETAIL), /Cancel this campaign/);
    assert.match(flat(DETAIL), /cannot be undone/);
    assert.match(DETAIL_CODE, /border-red-200/);
  });

  test("6.3 every lifecycle mutation still goes through the confirming dialog", () => {
    const dialog = code(
      read(join(VENDOR_DIR, "[campaignId]/campaign-lifecycle-dialog.tsx")),
    );
    assert.match(dialog, /role="dialog"/);
    assert.match(dialog, /aria-modal="true"/);
    // The safety properties the redesign must not have disturbed.
    assert.match(dialog, /if \(event\.key === "Escape" && !pending\) setOpen\(false\)/);
    assert.match(dialog, /if \(pending\) return;/);
    assert.match(dialog, /\{!state\.committed && \(/);
  });

  test("6.4 the detail page uses collapsible panels rather than tall flat cards", () => {
    assert.match(DETAIL_CODE, /<DetailPanel/);
    const panels = [...DETAIL_CODE.matchAll(/<DetailPanel/g)].length;
    assert.ok(panels >= 5, `only ${panels} detail panels`);
    // A native <details>, so the page needs no JavaScript to be read.
    assert.match(code(FACTS), /<details/);
  });
});

/* ===========================================================================
 * 7. The Retailer Owner surface keeps its guarantees under the new design
 * ======================================================================== */

describe("7. the Retailer Owner surface", () => {
  test("7.1 it remains read-only", () => {
    assert.ok(!/"use client"/.test(RETAILER_PAGE));
    assert.ok(!/<form/.test(RETAILER_PAGE_CODE));
    assert.ok(!/Action\b/.test(RETAILER_PAGE_CODE.replace(/AssignedCampaign/g, "")));
    assert.ok(!/CampaignLifecycleDialog/.test(RETAILER_PAGE_CODE));
  });

  test("7.2 no Vendor-private field can be rendered", () => {
    for (const field of [
      "exclusivityKey",
      "priority",
      "sourceGroupName",
      "eligibleRetailerCount",
      "versionNumber",
      "audienceMode",
    ]) {
      assert.ok(
        !new RegExp(`campaign\\.${field}\\b`).test(RETAILER_PAGE_CODE),
        `the Retailer page renders ${field}`,
      );
    }
  });

  test("7.3 it uses the shared team sentence rather than restating it", () => {
    assert.match(RETAILER_PAGE_CODE, /performanceExplanation\(/);
    assert.ok(!/All eligible Sales Staff sales/.test(RETAILER_PAGE_CODE));
  });

  test("7.4 it never fabricates progress", () => {
    assert.match(RETAILER_PAGE_CODE, /<CalculationEngineNotice/);
    const bindings = [...RETAILER_PAGE_CODE.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
    for (const binding of bindings) {
      assert.ok(
        !/\b(earned|balance|progress|unitsSold|coinsEarned)\b/i.test(binding),
        `a rendered expression claims a result: ${binding.trim()}`,
      );
    }
  });

  test("7.5 the offer is stated as a sentence, with a safe fallback", () => {
    assert.match(RETAILER_PAGE_CODE, /rewardPreviewSentence\(/);
    assert.match(RETAILER_PAGE_CODE, /rewardSentence \?\? reward \?\? "—"/);
  });
});

/* ===========================================================================
 * 8. Loading, feedback and accessibility
 * ======================================================================== */

describe("8. loading, feedback and accessibility", () => {
  test("8.1 every campaign route still has a loading state", () => {
    for (const route of [
      "loading.tsx",
      "new/loading.tsx",
      "groups/loading.tsx",
      "groups/[groupId]/loading.tsx",
      "[campaignId]/loading.tsx",
      "[campaignId]/edit/loading.tsx",
    ]) {
      assert.ok(existsSync(join(VENDOR_DIR, route)), `missing ${route}`);
    }
    assert.ok(existsSync(join(RETAILER_DIR, "loading.tsx")));
  });

  test("8.2 the wizard and group skeletons mirror the real layout", () => {
    // A skeleton with a different shape makes the page visibly jump on hydration.
    const wizardSkeleton = read(join(VENDOR_DIR, "new/loading.tsx"));
    assert.match(wizardSkeleton, /lg:grid-cols-\[13rem_minmax\(0,1fr\)\]/);
    const groupSkeleton = read(join(VENDOR_DIR, "groups/loading.tsx"));
    assert.match(groupSkeleton, /sm:grid-cols-2/);
  });

  test("8.3 pending states are labelled, not just spinners", () => {
    assert.match(WIZARD_CODE, /loadingLabel="Saving…"/);
    assert.match(GROUP_FORMS_CODE, /loadingLabel="Creating…"/);
    assert.match(GROUP_FORMS_CODE, /loadingLabel="Saving…"/);
  });

  test("8.4 a disabled Continue explains itself", () => {
    // A greyed button with no reason is the failure this replaces.
    assert.match(WIZARD_CODE, /Complete this step to continue/);
    assert.match(WIZARD_CODE, /role="status"/);
  });

  test("8.5 interactive surfaces keep a visible focus ring", () => {
    for (const [name, source] of [
      ["stepper", STEPPER_CODE],
      ["picker", PICKER_CODE],
      ["choice cards", CHOICE_CODE],
      ["list", LIST_CODE],
      ["eligibility panel", ELIGIBILITY_CODE],
      ["summary", SUMMARY_CODE],
    ] as const) {
      // Two mechanisms, both valid. A control that is focusable itself takes
      // `focus-visible:ring-2`; a choice card hides its radio visually and lifts the ring
      // onto the label with `has-[:focus-visible]:ring-2`, so the whole card shows focus.
      assert.ok(
        /focus-visible:ring-2/.test(source) ||
          /has-\[:focus-visible\]:ring-2/.test(source),
        `${name} lost its visible focus indicator`,
      );
    }
  });

  test("8.6 every control the redesign added is reachable and named", () => {
    // Search inputs carry a real label even though it is visually hidden.
    assert.match(PICKER_CODE, /<label htmlFor=\{searchId\} className="sr-only">/);
    // The option list is a fieldset with a legend, so the group is announced.
    assert.match(PICKER_CODE, /<legend className="sr-only">\{label\}<\/legend>/);
    // Each stepper segment names its step for a screen reader.
    assert.match(STEPPER_CODE, /className="sr-only"/);
  });

  test("8.7 no page-level horizontal overflow is invited", () => {
    // Wide content scrolls inside its own container rather than the page.
    for (const [name, source] of [
      ["detail", DETAIL_CODE],
    ] as const) {
      const tables = [...source.matchAll(/<table/g)].length;
      const wrappers = [...source.matchAll(/overflow-x-auto/g)].length;
      assert.ok(
        wrappers >= tables,
        `${name} has ${tables} tables but only ${wrappers} scroll containers`,
      );
    }
  });

  test("8.8 the exclusivity key is never silently kept when Stackable is chosen", () => {
    // The database nulls it for a stackable campaign. The form keeps the typed value so
    // toggling back does not lose it — but it must SAY so, and offer to discard it.
    assert.match(flat(WIZARD), /A stackable campaign has no exclusivity key/);
    assert.match(flat(WIZARD), /not saved/);
    assert.match(WIZARD_CODE, /update\("exclusivityKey", ""\)/);
  });
});
