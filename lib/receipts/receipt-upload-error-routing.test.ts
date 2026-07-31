/**
 * ACCESS DENIED MEANS DENIED — SOURCE-LEVEL GUARDS.
 *
 * Run with:  npm test
 *
 * The reported defect ended with a Sales Staff member being told "You are signed in, but
 * this account does not have access to this page" because a receipt was 3 MB. Nothing
 * about their authorization had changed. Three separate things had to be true for an
 * upload failure to present itself as a permission problem, and each one is pinned here:
 *
 *   1. Every redirect to an access-denied page is guarded by an AUTHORIZATION status,
 *      and never by a file, size, upload, storage, transport or exception condition.
 *   2. The receipt form reports an operational failure inline, rather than letting it
 *      unwind to the portal-wide error boundary — WITHOUT absorbing a redirect on the
 *      way past.
 *   3. The portal error boundary's escape route is reachable by EVERY kind of portal
 *      member — it no longer points at the Owner-only overview, which redirected a
 *      Sales Staff member straight to Access Denied.
 *
 * WHAT THESE TESTS ARE AND ARE NOT.
 *   Most of them read source. That is a blunt instrument, chosen because the modules
 *   involved import next/headers, next/navigation and the Supabase server client, none
 *   of which can be loaded under `node --experimental-strip-types`. They fail loudly on
 *   the exact shapes that would reconstitute the defect, naming the file and the line.
 *
 *   SECTION 2b IS DIFFERENT AND DELIBERATELY SO. Point 2 above is the one place where
 *   reading source proves nothing useful: a `try/catch` is present either way, and
 *   whether it swallows an authorization redirect depends on runtime behaviour no
 *   grep can see. So 2b runs @/lib/receipts/receipt-submission-attempt for real, driving
 *   it with Next.js's OWN `unstable_rethrow` and with genuine control-flow errors
 *   produced by the installed package's own `redirect()`, `notFound()` and the exact
 *   `getRedirectError` factory `serverActionReducer` uses. Nothing there is a stand-in.
 *
 *   The rest of this milestone's behavioural coverage lives in
 *   ../uploads/upload-request-boundary.test.ts, which runs real framework code against
 *   real encoded payloads, and in ./receipt-upload-preflight.test.ts, which runs the
 *   size decisions for real.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { runGuardedSubmission } from "./receipt-submission-attempt.ts";

const require = createRequire(import.meta.url);

/** The repository root, derived from this file's own location (lib/receipts/). */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(join(dir, entry)));
    else if (/\.tsx?$/.test(entry)) out.push(join(dir, entry));
  }
  return out;
}

const APP_FILES = listSourceFiles("app").map((path) => ({
  path,
  source: stripComments(read(path)),
}));

const FORM = read("app/(retailer)/retailer/receipts/submit-receipt-form.tsx");
const ACTION = read("app/(retailer)/retailer/receipts/actions.ts");
const BOUNDARY = read("app/(retailer)/error.tsx");
const STATE = read("app/(retailer)/retailer/receipts/submit-receipt-state.ts");

// ---------------------------------------------------------------------------
// 1. Every access-denied redirect is guarded by an authorization decision
// ---------------------------------------------------------------------------

/**
 * The SHAPES of condition that may send someone to an access-denied page.
 *
 * Each is a status produced by an authorization resolver or by a database read that was
 * REFUSED — never an operational outcome. Matched by shape rather than by exact text so
 * the rule holds across the whole application, whatever a given module happens to call
 * its result variable (`access`, `history`, `catalog`, `result`, …).
 *
 * `unavailable` is deliberately absent: a read that could not be COMPLETED is not a
 * denial, and this codebase already routes it to a retry-safe state instead. That
 * distinction is the same one this milestone extends to the transport layer, so a future
 * edit that collapsed it would fail here.
 *
 * The `kind !== …` shape is the portal's "authorized, but this page is not for your kind
 * of member" branch — also an authorization decision, decided from a resolver's result.
 */
const AUTHORIZATION_GUARDS = [
  /^[A-Za-z_$][\w$]*\.status === "(unauthorized|denied)"$/,
  /^[A-Za-z_$][\w$]*\.kind !== "[a-z]+"$/,
];

/** Conditions that must NEVER guard an access-denied redirect. */
const OPERATIONAL_SHAPES =
  /\b(413|statusCode|too-?large|tooLarge|size|bytes|upload|storage|mime|signature|timeout|network|fetch|catch|error|unavailable|transport)\b/i;

type Redirect = { path: string; line: number; guard: string };

function collectAccessDeniedRedirects(): Redirect[] {
  const found: Redirect[] = [];

  for (const file of APP_FILES) {
    const lines = file.source.split("\n");
    lines.forEach((text, index) => {
      if (!/redirect\("\/(retailer-)?access-denied"\)/.test(text)) return;

      // The guard is the nearest preceding non-blank line: every one of these redirects
      // is the single statement inside an `if (...) {`.
      let cursor = index - 1;
      while (cursor >= 0 && lines[cursor].trim().length === 0) cursor -= 1;

      const guard = (lines[cursor] ?? "").trim();
      found.push({ path: file.path, line: index + 1, guard });
    });
  }

  return found;
}

const ACCESS_DENIED_REDIRECTS = collectAccessDeniedRedirects();

describe("1. access-denied is reached only by an authorization decision", () => {
  test("1. the redirects were found at all", () => {
    // Otherwise every assertion below would pass vacuously.
    assert.ok(
      ACCESS_DENIED_REDIRECTS.length >= 20,
      `only found ${ACCESS_DENIED_REDIRECTS.length} access-denied redirects`,
    );
  });

  test("2. every one of them sits inside an `if` on an authorization status", () => {
    for (const entry of ACCESS_DENIED_REDIRECTS) {
      const condition = /^if\s*\((.+)\)\s*\{$/.exec(entry.guard)?.[1]?.trim();
      assert.ok(
        condition !== undefined,
        `${entry.path}:${entry.line} is not guarded by a single-condition if: ${entry.guard}`,
      );
      assert.ok(
        AUTHORIZATION_GUARDS.some((pattern) => pattern.test(condition as string)),
        `${entry.path}:${entry.line} redirects to access-denied on a non-authorization condition: ${condition}`,
      );
    }
  });

  test("3. no access-denied redirect is guarded by an operational condition", () => {
    // Stated positively above and negatively here on purpose: the allowlist could be
    // widened by a future edit, and this catches the specific categories the reported
    // defect ran through even if it were.
    for (const entry of ACCESS_DENIED_REDIRECTS) {
      const condition = /^if\s*\((.+)\)\s*\{$/.exec(entry.guard)?.[1] ?? entry.guard;
      assert.ok(
        !OPERATIONAL_SHAPES.test(condition),
        `${entry.path}:${entry.line} routes an operational failure to access-denied: ${condition}`,
      );
    }
  });

  test("4. no catch block anywhere in app/ redirects to access-denied", () => {
    // The most direct way the defect could return: wrapping a failure-prone call and
    // treating any throw as a permission problem.
    for (const file of APP_FILES) {
      for (const match of file.source.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([\s\S]{0,400}?)\}/g)) {
        assert.ok(
          !/access-denied/.test(match[1]),
          `${file.path} redirects to access-denied from a catch block`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The receipt form keeps an operational failure on the receipt page
// ---------------------------------------------------------------------------

describe("2. an upload failure stays on the receipt page", () => {
  test("5. the Server Action call goes through the guarded wrapper", () => {
    const code = stripComments(FORM);
    assert.ok(
      code.includes("runGuardedSubmission"),
      "submitReceiptAction is no longer called through runGuardedSubmission, so a " +
        "rejection would unwind to app/(retailer)/error.tsx and replace the receipt page",
    );
    assert.match(
      code,
      /runGuardedSubmission\(\{[\s\S]{0,400}?submit:\s*\(\)\s*=>\s*submitReceiptAction\(/,
      "runGuardedSubmission is not the thing calling submitReceiptAction",
    );
  });

  test("6. it reports the transport message, and no status code or internals", () => {
    const code = stripComments(FORM);
    const block = /runGuardedSubmission\(\{[\s\S]{0,700}?\n  \}\);/.exec(code)?.[0] ?? "";
    assert.ok(block.length > 0, "the guarded call could not be located");
    assert.ok(
      block.includes("RECEIPT_TRANSPORT_ERROR"),
      "the failure state does not use the shared transport message",
    );
    assert.ok(
      !/access|denied|permission|413|500/i.test(block),
      `the failure state mentions authorization or a status code: ${block}`,
    );
  });

  test("7. the form itself never catches, so it cannot swallow control flow", () => {
    const code = stripComments(FORM);
    // Browser code: a console call here would put framework internals somewhere any
    // extension can read.
    assert.ok(!/console\./.test(code), "the form logs from the browser");
    // The one catch in this flow lives in the wrapper, behind unstable_rethrow. A catch
    // reintroduced here would be one nothing forces to rethrow a redirect.
    assert.ok(
      !/\bcatch\b/.test(code),
      "the form catches directly again; every catch must go through runGuardedSubmission",
    );
  });

  test("8. Next.js's own rethrow helper is the one wired in", () => {
    // The wrapper takes the helper as a parameter so it can stay pure and testable. This
    // is what pins production to the REAL helper rather than something that merely
    // satisfies the parameter's type.
    const code = stripComments(FORM);
    assert.match(
      code,
      /import\s*\{[^}]*\bunstable_rethrow\b[^}]*\}\s*from\s*"next\/navigation"/,
      "the form no longer imports unstable_rethrow from next/navigation",
    );
    assert.match(
      code,
      /rethrowControlFlow:\s*unstable_rethrow\b/,
      "the guarded call is not given Next.js's own unstable_rethrow",
    );
  });

  test("9. no digest, status code or error field is read to classify a failure", () => {
    // Hand-matching Next.js internals is what breaks silently on an upgrade; the
    // supported helper is the framework's promise to keep this working.
    for (const source of [FORM, read("lib/receipts/receipt-submission-attempt.ts")]) {
      const code = stripComments(source);
      assert.ok(
        !/\.digest\b|NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|\.statusCode\b/.test(code),
        "a framework error is being identified by hand instead of by unstable_rethrow",
      );
    }
  });

  test("10. the client never redirects anywhere at all", () => {
    const code = stripComments(FORM);
    assert.ok(
      !/redirect\(|router\.(push|replace)|location\.(href|assign|replace)/.test(code),
      "the receipt form navigates from the browser; routing is the server's decision",
    );
  });

  test("11. an over-sized file is refused before a request is sent", () => {
    const code = stripComments(FORM);
    assert.ok(
      code.includes("receiptSelectionRejection"),
      "the form no longer pre-flights the selection, so an over-sized file would be " +
        "sent and refused by the framework boundary rather than explained",
    );

    // The pre-flight must run BEFORE the action, or it explains nothing. Ordering is
    // checked INSIDE the submission function rather than across the whole file, where
    // the import line alone would satisfy it.
    const body =
      /async function runReceiptSubmission\([\s\S]*?\n\}/.exec(code)?.[0] ?? "";
    assert.ok(body.length > 0, "runReceiptSubmission could not be located");

    const preflight = body.indexOf("receiptSelectionRejection");
    const submission = body.indexOf("submitReceiptAction");
    assert.ok(preflight >= 0, "the submission path does not pre-flight the selection");
    assert.ok(submission >= 0, "the submission path does not call the Server Action");
    assert.ok(preflight < submission, "the pre-flight runs after the submission");
  });
});

// ---------------------------------------------------------------------------
// 2b. The wrapper's REAL behaviour, against the REAL framework errors
// ---------------------------------------------------------------------------

/**
 * Next.js's own navigation module, loaded from the installed package.
 *
 * `createRequire` rather than `import`: next/navigation has no Node-resolvable ESM entry
 * point, which is the same constraint that keeps runGuardedSubmission's helper a
 * parameter instead of an import. ./receipt-upload-preflight.test.ts's sibling suite
 * already reaches into node_modules the same way.
 */
const nextNavigation = require("next/navigation") as {
  redirect: (url: string) => never;
  notFound: () => never;
  unstable_rethrow: (error: unknown) => void;
};

/**
 * The exact error factory `serverActionReducer` uses when an action redirects.
 *
 * The public `redirect()` below resolves its type to "replace" outside a request store,
 * while the reducer builds a "push" error. Both are exercised so neither shape can be
 * the only one that works.
 */
const { getRedirectError } = require("next/dist/client/components/redirect.js") as {
  getRedirectError: (url: string, type: "push" | "replace") => Error & { digest: string };
};

/** Whatever the given framework call throws — a genuine control-flow object. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("the framework call did not throw, so this fixture is not authentic");
}

type TestState = {
  fieldErrors: { receipt?: string };
  formError: string | null;
  successMessage: string | null;
  selectedShopId: string;
};

const PREVIOUS: TestState = {
  fieldErrors: {},
  formError: null,
  successMessage: null,
  selectedShopId: "6f1d5f0a-6a1e-4d2b-9c3f-1a2b3c4d5e6f",
};

const OPERATIONAL: TestState = {
  fieldErrors: {},
  formError:
    "We couldn't send that receipt. Nothing was submitted — please check your connection and try again.",
  successMessage: null,
  selectedShopId: PREVIOUS.selectedShopId,
};

/** Runs the wrapper with the REAL unstable_rethrow, counting how often it submitted. */
async function guard(submit: () => Promise<TestState | undefined>) {
  let calls = 0;
  const result = await runGuardedSubmission<TestState>({
    submit: () => {
      calls += 1;
      return submit();
    },
    rethrowControlFlow: nextNavigation.unstable_rethrow,
    previousState: PREVIOUS,
    operationalFailureState: OPERATIONAL,
  });
  return { result, calls };
}

describe("2b. redirects escape the wrapper; only real failures become a message", () => {
  test("12. a genuine Next.js redirect error is rethrown, not classified", async () => {
    const control = thrownBy(() => nextNavigation.redirect("/login"));

    await assert.rejects(
      () => guard(() => Promise.reject(control)),
      (thrown: unknown) => {
        // The SAME object, untouched — not wrapped, not re-created, not annotated.
        assert.equal(thrown, control);
        return true;
      },
      "a redirect was absorbed by the wrapper instead of reaching the router",
    );
  });

  test("13. a /login redirect never becomes the transport message", async () => {
    // The reducer's exact shape: getRedirectError(href, 'push').
    const control = getRedirectError("/login", "push");
    assert.match(control.digest, /^NEXT_REDIRECT;push;\/login;/);

    let settled: TestState | null = null;
    await assert.rejects(async () => {
      settled = (await guard(() => Promise.reject(control))).result;
    });
    assert.equal(settled, null, "an authorization redirect produced a form state");
  });

  test("14. a /retailer-access-denied redirect never becomes the transport message", async () => {
    const control = getRedirectError("/retailer-access-denied", "push");

    let settled: TestState | null = null;
    await assert.rejects(async () => {
      settled = (await guard(() => Promise.reject(control))).result;
    });
    assert.equal(settled, null, "an access-denied redirect produced a form state");
  });

  test("15. not-found / navigation control flow is rethrown too", async () => {
    // Not used by this action today, but the wrapper must not become the reason a future
    // one silently stops working.
    const control = thrownBy(() => nextNavigation.notFound());

    await assert.rejects(
      () => guard(() => Promise.reject(control)),
      (thrown: unknown) => thrown === control,
    );
  });

  test("16. a control-flow error hidden under `cause` still escapes", async () => {
    const control = thrownBy(() => nextNavigation.redirect("/login"));
    const wrapped = new Error("Failed to fetch", { cause: control });

    await assert.rejects(
      () => guard(() => Promise.reject(wrapped)),
      (thrown: unknown) => thrown === control || thrown === wrapped,
      "unstable_rethrow follows error.cause; the wrapper must not defeat that",
    );
  });

  test("17. an ordinary Error becomes the transport message", async () => {
    const { result, calls } = await guard(() =>
      Promise.reject(new Error("Something failed")),
    );

    assert.equal(result.formError, OPERATIONAL.formError);
    assert.equal(result.successMessage, null);
    assert.deepEqual(result.fieldErrors, {});
    assert.equal(calls, 1);
  });

  test("18. a request-boundary (413) rejection becomes the transport message", async () => {
    // The shape Next.js surfaces when a body exceeds serverActions.bodySizeLimit: the
    // action never ran, and the client sees a failed action response.
    const boundary = new Error("Body exceeded 10747904 limit.");

    const { result } = await guard(() => Promise.reject(boundary));
    assert.equal(result.formError, OPERATIONAL.formError);
  });

  test("19. a dropped connection becomes the transport message", async () => {
    const { result } = await guard(() => Promise.reject(new TypeError("Failed to fetch")));
    assert.equal(result.formError, OPERATIONAL.formError);
  });

  test("20. no raw exception text reaches the returned state", async () => {
    const secret = "SQLSTATE 42501 at https://project.supabase.co/storage/v1/object/x";
    const { result } = await guard(() => Promise.reject(new Error(secret)));

    const rendered = JSON.stringify(result);
    for (const leak of ["SQLSTATE", "42501", "supabase", "storage", "https://", "10747904"]) {
      assert.ok(!rendered.includes(leak), `the returned state leaks "${leak}": ${rendered}`);
    }
    assert.equal(result.formError, OPERATIONAL.formError);
  });

  test("21. the mutation is submitted exactly once on every path", async () => {
    const success: TestState = { ...PREVIOUS, successMessage: "Receipt submitted." };

    assert.equal((await guard(() => Promise.resolve(success))).calls, 1);
    assert.equal((await guard(() => Promise.reject(new Error("x")))).calls, 1);

    // Including the path that throws out of the wrapper.
    const control = thrownBy(() => nextNavigation.redirect("/login"));
    let calls = 0;
    await assert.rejects(async () => {
      await runGuardedSubmission<TestState>({
        submit: () => {
          calls += 1;
          return Promise.reject(control);
        },
        rethrowControlFlow: nextNavigation.unstable_rethrow,
        previousState: PREVIOUS,
        operationalFailureState: OPERATIONAL,
      });
    });
    assert.equal(calls, 1, "the upload was retried");
  });

  test("22. a resolved action's own state is returned unchanged", async () => {
    const fromServer: TestState = {
      fieldErrors: { receipt: "That file is too large." },
      formError: null,
      successMessage: null,
      selectedShopId: PREVIOUS.selectedShopId,
    };

    const { result } = await guard(() => Promise.resolve(fromServer));
    assert.equal(result, fromServer);
  });

  test("23. a resolved-but-empty action falls back to the previous state", async () => {
    const { result } = await guard(() => Promise.resolve(undefined));
    assert.equal(result, PREVIOUS);
    assert.equal(result.selectedShopId, PREVIOUS.selectedShopId);
  });
});

// ---------------------------------------------------------------------------
// 3. The portal error boundary's escape route works for every member
// ---------------------------------------------------------------------------

describe("3. the portal error boundary has no owner-only dead end", () => {
  test("24. it no longer links to the Owner-only overview", () => {
    const code = stripComments(BOUNDARY);
    assert.ok(
      !/href="\/retailer"/.test(code),
      'the boundary links to "/retailer", whose page redirects a Sales Staff member ' +
        "or a Manager to /retailer-access-denied",
    );
  });

  test("25. its escape route is the current path", () => {
    const code = stripComments(BOUNDARY);
    assert.match(code, /usePathname\(\)/);
    assert.match(code, /href=\{pathname\}/);
  });

  test("26. it still renders nothing from the error object", () => {
    // Unchanged by this milestone, and re-asserted so the edit above cannot have
    // loosened it: no message, no stack, no digest reaches the page.
    const code = stripComments(BOUNDARY);
    for (const forbidden of ["error.message", "error.stack", "error.digest"]) {
      assert.ok(!code.includes(forbidden), `the boundary renders ${forbidden}`);
    }
    assert.ok(!/console\./.test(code), "the boundary logs from the browser");
  });
});

// ---------------------------------------------------------------------------
// 4. The copy tells the truth about what happened
// ---------------------------------------------------------------------------

describe("4. operational messages never read as authorization messages", () => {
  /** Every user-facing string constant in the shared state module. */
  const MESSAGES = [...stripComments(STATE).matchAll(/"((?:[^"\\]|\\.){12,})"/g)].map(
    (match) => match[1],
  );

  test("27. the messages were found", () => {
    assert.ok(MESSAGES.length >= 8, `only found ${MESSAGES.length} message strings`);
  });

  test("28. none of them claims the account lacks access", () => {
    const FORBIDDEN = /\b(access|denied|permission|not allowed|unauthori[sz]ed|sign in|signed in)\b/i;
    for (const message of MESSAGES) {
      assert.ok(
        !FORBIDDEN.test(message),
        `a receipt message reads as an authorization refusal: ${message}`,
      );
    }
  });

  test("29. none of them leaks a status code, a framework, or storage detail", () => {
    const FORBIDDEN =
      /\b(413|500|next\.?js|server action|supabase|postgres|storage|bucket|s3|sha256|stack)\b/i;
    for (const message of MESSAGES) {
      assert.ok(!FORBIDDEN.test(message), `a receipt message leaks internals: ${message}`);
    }
  });

  test("30. the transport message says nothing was submitted, so retrying is safe", () => {
    // The upload is a mutation with no idempotency contract, so the only honest way to
    // offer a retry is for the failure to be one where nothing was recorded — which is
    // exactly the case this message covers: the request never reached the action.
    assert.match(STATE, /RECEIPT_TRANSPORT_ERROR[\s\S]{0,200}?Nothing was submitted/);
  });

  test("31. no automatic retry of the mutation exists", () => {
    for (const source of [FORM, ACTION]) {
      const code = stripComments(source);
      assert.ok(
        !/setTimeout|setInterval|retry|attempt\s*\+\+|while\s*\(/i.test(code),
        "an automatic retry of a non-idempotent upload was introduced",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The Server Action's own classification is unchanged
// ---------------------------------------------------------------------------

describe("5. the Server Action still separates denial from failure", () => {
  const code = stripComments(ACTION);

  test("32. an unauthenticated caller still goes to /login", () => {
    assert.match(code, /access\.status === "unauthenticated"[\s\S]{0,60}?redirect\("\/login"\)/);
  });

  test("33. an unauthorized caller still goes to /retailer-access-denied", () => {
    assert.match(
      code,
      /access\.status === "unauthorized"[\s\S]{0,80}?redirect\("\/retailer-access-denied"\)/,
    );
  });

  test("34. an UNAVAILABLE read returns a message rather than redirecting", () => {
    // The distinction the portal has always drawn, re-asserted because it is the same
    // distinction this milestone extends to the transport layer: a read that failed is
    // not a person who was refused.
    assert.match(code, /access\.status === "unavailable"[\s\S]{0,120}?GENERIC_ERROR/);
  });

  test("35. an upload failure returns a message and never redirects", () => {
    const uploadBranch = /case "upload-failed":[\s\S]{0,200}?;/.exec(code)?.[0] ?? "";
    assert.ok(uploadBranch.includes("UPLOAD_FAILED_ERROR"));
    assert.ok(!uploadBranch.includes("redirect"), "an upload failure redirects");
  });

  test("36. a too-large file returns a field message and never redirects", () => {
    const sizeBranch = /part\.size > MAX_RECEIPT_FILE_BYTES[\s\S]{0,220}?\n  \}/.exec(code)?.[0] ?? "";
    assert.ok(sizeBranch.length > 0, "the size branch could not be located");
    assert.ok(sizeBranch.includes('FILE_MESSAGES["too-large"]'));
    assert.ok(!sizeBranch.includes("redirect"), "an over-sized file redirects");
  });
});

// ---------------------------------------------------------------------------
// 6. The server-side uploader reports failure as a status, never as a denial
// ---------------------------------------------------------------------------

/**
 * lib/receipts/receipt-submissions.ts is the module that actually hands receipt bytes to
 * private Storage, and it is declared in DECLARED_UPLOAD_SURFACES alongside the form and
 * the Server Action. This section is what that declaration names as its
 * operational-error coverage, so it asserts the thing the registry claims: that when this
 * module fails, the failure travels as a STATUS and cannot become an authorization
 * outcome or leak a provider detail on the way out.
 *
 * Source-level, for the reason stated at the top of this file: the module imports the
 * service-role client and next/headers, so it cannot be loaded under
 * `node --experimental-strip-types`. What it can be held to is its shape, and its shape is
 * what decides whether a Storage error can reach a person as "access denied".
 */
const SUBMISSIONS_PATH = "lib/receipts/receipt-submissions.ts";
const SUBMISSIONS = stripComments(read(SUBMISSIONS_PATH));

describe("6. the server-side uploader's failures stay operational", () => {
  test("37. it never redirects and never reaches for the router", () => {
    // A redirect from here would be an authorization answer given by an I/O module, which
    // is the defect in its purest form.
    assert.ok(!/\bredirect\s*\(/.test(SUBMISSIONS), `${SUBMISSIONS_PATH} redirects`);
    assert.ok(
      !/next\/navigation/.test(SUBMISSIONS),
      `${SUBMISSIONS_PATH} imports the router`,
    );
    assert.ok(
      !/access-denied/.test(SUBMISSIONS),
      `${SUBMISSIONS_PATH} names an access-denied route`,
    );
  });

  test("38. every failure it reports is a bare status literal", () => {
    const returns = [...SUBMISSIONS.matchAll(/return\s*\{\s*status:\s*"([a-z-]+)"([^}]*)\}/g)];

    assert.ok(returns.length >= 8, `only found ${returns.length} status returns`);

    // The failure statuses this module is allowed to produce. `ok` carries the ids the
    // flow needs internally; every OTHER status must carry nothing at all, because
    // anything it carried would be a Storage or database detail travelling outward.
    const FAILURE_STATUSES = new Set([
      "unavailable",
      "failed",
      "duplicate",
      "denied",
      "invalid",
    ]);

    let failures = 0;
    for (const [, status, remainder] of returns) {
      if (!FAILURE_STATUSES.has(status)) continue;
      failures += 1;
      assert.equal(
        remainder.trim(),
        "",
        `${SUBMISSIONS_PATH} returns "${status}" with a payload: ${remainder.trim()}`,
      );
    }
    assert.ok(failures >= 6, `only ${failures} failure returns were checked`);
  });

  test("39. no error object, message, path, bucket or hash is bound or logged", () => {
    // Only the SQLSTATE is read anywhere in this module — asserted positively, so that a
    // future edit reading `.message` to "improve" a log fails here.
    assert.ok(
      !/\berror\.(message|details|hint|stack)\b/.test(SUBMISSIONS),
      `${SUBMISSIONS_PATH} reads an error's text`,
    );

    const logLines = SUBMISSIONS.split("\n").filter((line) => /console\./.test(line));
    assert.equal(logLines.length, 1, "the single logging chokepoint moved");
    for (const line of logLines) {
      for (const [, expression] of line.matchAll(/\$\{([^}]*)\}/g)) {
        assert.equal(
          expression.trim(),
          "category",
          `${SUBMISSIONS_PATH} logs "${expression.trim()}"`,
        );
      }
    }
  });

  test("40. the Server Action turns every one of those statuses into a message", () => {
    // The other end of the same wire: whatever status this module produces, the action
    // answers with a sentence. No branch of that switch navigates.
    const actionCode = stripComments(ACTION);
    const switchBlock = /switch \(result\.status\)[\s\S]*?\n  \}/.exec(actionCode)?.[0] ?? "";
    assert.ok(switchBlock.length > 0, "the status switch could not be located");

    for (const status of ["duplicate", "upload-failed", "denied", "invalid", "unavailable"]) {
      assert.ok(
        switchBlock.includes(`case "${status}":`),
        `the action does not handle the "${status}" status`,
      );
    }
    assert.ok(
      !/redirect\s*\(/.test(switchBlock),
      "a submission status is answered with a redirect rather than a message",
    );
    assert.ok(
      /default:/.test(switchBlock),
      "an unrecognised status would fall through with no message",
    );
  });
});
