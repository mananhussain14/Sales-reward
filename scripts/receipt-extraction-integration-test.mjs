#!/usr/bin/env node
/**
 * LOCAL INTEGRATION TEST for the three receipt-extraction Edge Functions.
 *
 * Run with:
 *   npx supabase start -x edge-runtime   # the stack, WITHOUT its built-in Edge Runtime
 *   npx supabase db reset                # apply every migration
 *   npm run test:extraction:integration
 *
 * `-x edge-runtime` is required, not optional. That built-in service answers the same
 * /functions/v1 routes this harness must own, and two servers cannot share a route — see
 * START_COMMAND below. The harness refuses to run against a route it does not own rather
 * than silently reusing somebody else's function server.
 *
 * Exits 0 on success and NON-ZERO on the first failure, so it is usable in CI. On EVERY exit
 * path — success, assertion failure, thrown error, SIGINT, SIGTERM — it stops the function
 * server it started and restores public.receipt_extraction_runtime.mode to DISABLED, then
 * reads the row back to verify it.
 *
 * ============================================================================
 * WHY THIS EXISTS WHEN THERE IS ALREADY A pgTAP SUITE AND A SOURCE-SAFETY TEST
 * ============================================================================
 * The pgTAP suites prove what the DATABASE enforces. The source-safety test proves what the
 * functions' SOURCE says. Neither can prove what the deployed units actually DO with a real
 * JWT, a real Storage object and a real service-role key — which is the only thing that
 * matters for functions that hold that key.
 *
 * ============================================================================
 * IT MANAGES `functions serve` ITSELF, AND THAT IS THE POINT
 * ============================================================================
 * The whole feature is gated by an ENVIRONMENT VARIABLE, so proving the gate works means
 * running the same code with the variable set and unset. A test that could only observe one
 * configuration could not test the thing most likely to be got wrong. This script therefore
 * starts, stops and restarts the local function server with different environments between
 * phases, and asserts the behaviour of each.
 *
 * ============================================================================
 * LOCAL SETTLING IS HANDLED IN THE HARNESS, NOT IN THE PRODUCT
 * ============================================================================
 * Restarting the function server means the local gateway briefly has no function upstream
 * attached. Two harness-only mechanisms absorb that, and NEITHER describes product behaviour:
 *
 *   1. startServe waits until ALL THREE function routes answer a preflight, on two
 *      consecutive rounds, bounded by a fixed deadline.
 *   2. The one read issued immediately after a restart may be retried at most twice, and only
 *      on a transport error or a 502/503/504 from the gateway.
 *
 * A 500 and every client status are surfaced on the first attempt, and no mutating call is
 * ever retried. The deployed Edge Functions retry NOTHING — retry is the caller's explicit
 * act, which is the only thing that respects the three-attempt cap.
 *
 * ============================================================================
 * NO SECRET IS TRACKED IN THIS FILE
 * ============================================================================
 * Every key and URL is obtained at RUNTIME from `supabase status -o json`; fixture passwords
 * are generated per run with crypto.randomUUID(). Nothing is hard-coded or written to a
 * tracked path — the temporary env files live under the OS temp directory and are removed.
 *
 * ============================================================================
 * WHY FIXTURES GO THROUGH psql RATHER THAN PostgREST
 * ============================================================================
 * service_role holds NO table privileges in this schema — every migration revokes them — so
 * a REST insert as service_role returns 42501. That is the posture the design wants, so the
 * fixtures are applied through `supabase db query` — the CLI's own local-database command —
 * rather than by weakening it. This harness therefore names no Docker container, runs no
 * `docker exec`, and never handles the database URL or password.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PATH_WITH_TOOLS = `/Library/Developer/CommandLineTools/usr/bin:${process.env.PATH ?? ""}`;

/**
 * THE ENVIRONMENT EVERY SUPABASE CLI INVOCATION RUNS WITH.
 *
 * Disabling CLI telemetry is load-bearing here, not a preference. The CLI uploads analytics to
 * an external endpoint as it shuts down, and when that upload times out it exits NON-ZERO even
 * though the command itself succeeded:
 *
 *   Timeout while shutting down PostHog. Some events may not have been sent.
 *
 * Measured at roughly one invocation in 120 on this machine. psql() treats a non-zero status as
 * a failed statement — correctly, since it cannot tell the difference — so the run died with
 * "a database statement failed" on a statement that had in fact run. A local integration
 * harness must not depend on reaching an analytics endpoint at all, so the network call is
 * removed rather than the exit status second-guessed. Both spellings are set because the CLI
 * honours either.
 */
const CLI_ENV = {
  ...process.env,
  PATH: PATH_WITH_TOOLS,
  SUPABASE_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
};

// ============================================================================
// Tiny test harness
// ============================================================================
let passed = 0;
const failures = [];
let currentCase = "(startup)";

// Declared HERE, above the first thing that can call cleanup(). A startup failure calls
// fatal() -> cleanup() -> stopServe(), and a `let` declared further down would still be in
// its temporal dead zone at that point — turning a clear configuration message into an
// opaque ReferenceError.
let serveProcess = null;

/**
 * Cleanup runs at most once, and every caller AWAITS THE SAME WORK.
 *
 * A boolean "already done" flag is not enough. Two SIGINTs, or a signal arriving while the
 * finally block is mid-cleanup, would let the second caller see "in progress" and fall
 * straight through to process.exit — killing the run while the first cleanup was still
 * restoring the gate. Holding the PROMISE means the second caller waits for the real answer.
 */
let cleanupRuns = 0;

/**
 * TEST-ONLY fault injection, read from the environment and from nowhere else.
 *
 * The harness's own cleanup guarantees can only be proved by making a run FAIL and then
 * inspecting what it left behind. This variable is how the self-checks in section 9 make a
 * child run of this same script fail on purpose. It is read once, here, from `process.env`;
 * no request, argument or fixture can set it, and it is never forwarded to a function server.
 *
 * A child running with a fault set skips section 9, so the self-checks cannot recurse.
 */
const FAULT = typeof process.env.RECEIPT_EXTRACTION_TEST_FAULT === "string"
  ? process.env.RECEIPT_EXTRACTION_TEST_FAULT
  : "";

/** The single statement that reads the gate back. Used by cleanup and by the self-checks. */
const GATE_QUERY = "select mode from public.receipt_extraction_runtime;";

/** Where the self-check source scan stops reading. Must appear exactly once, in section 9. */
const SELF_CHECK_MARKER = "---- this harness manages processes, never containers";

/** Printed by a "hang" child so the parent knows when it is safe to interrupt it. */
const HANG_MARKER = "[harness] holding a server and an open gate";

/** Thrown by fatal(); carries no value, only a fixed message. */
class HarnessError extends Error {}

function maybeFault(point) {
  if (FAULT === point) throw new HarnessError(`injected fault at "${point}"`);
}

function section(name) {
  currentCase = name;
  process.stdout.write(`\n== ${name}\n`);
}

function check(condition, description, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${description}\n`);
  } else {
    failures.push(`${currentCase}: ${description}${detail ? ` (${detail})` : ""}`);
    process.stdout.write(`  FAIL ${description}${detail ? ` — ${detail}` : ""}\n`);
  }
}

/**
 * Aborts the run.
 *
 * It THROWS rather than calling process.exit, so the single structured cleanup path at the
 * bottom of this file always runs before the process ends. Exiting here would skip restoring
 * the database gate — the exact failure this harness is required not to have.
 */
function fatal(message) {
  throw new HarnessError(message);
}

// ============================================================================
// Local stack configuration, read at runtime
// ============================================================================
/**
 * THE ONE COMMAND THIS HARNESS REQUIRES, quoted verbatim in every diagnostic below.
 *
 * The stack must come up WITHOUT its built-in Edge Runtime. That service answers the same
 * /functions/v1 routes this harness needs to own: the harness starts and stops its OWN
 * function server so it can change the fake-provider configuration between phases, and two
 * servers cannot share the route. `-x edge-runtime` is the CLI's supported exclusion flag
 * (`supabase start --help`), not a Docker-level workaround.
 */
const START_COMMAND = "npx supabase start -x edge-runtime";

// Read at module scope but NOT fatal here: a failure is recorded and raised from inside the
// structured try/finally below, so cleanup always owns the exit path.
let STATUS = null;
let configError = null;
try {
  STATUS = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: CLI_ENV,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch {
  configError =
    "could not read `supabase status -o json` — the local stack is not running.\n" +
    `  Start it with:  ${START_COMMAND}`;
}

const API_URL = STATUS?.API_URL;
const ANON_KEY = STATUS?.ANON_KEY;
const SERVICE_ROLE_KEY = STATUS?.SERVICE_ROLE_KEY;

if (configError === null && (!API_URL || !ANON_KEY || !SERVICE_ROLE_KEY)) {
  configError = "supabase status did not report API_URL / ANON_KEY / SERVICE_ROLE_KEY";
}

const REQUEST_URL = `${API_URL}/functions/v1/request-receipt-extraction`;
const GET_URL = `${API_URL}/functions/v1/get-receipt-extraction`;
const PREVIEW_URL = `${API_URL}/functions/v1/receipt-image-preview`;

/**
 * ALL THREE routes this harness serves. Readiness means all three, not one.
 *
 * The local runtime attaches its routes to the gateway as it comes up, and a preflight on
 * ONE of them is not evidence that the others are attached. This suite restarts the server
 * between phases and then calls whichever function that phase needs, so the readiness gate
 * has to cover every route the run can touch.
 */
const FUNCTION_ROUTES = [REQUEST_URL, GET_URL, PREVIEW_URL];

const TEMP_DIR = mkdtempSync(join(tmpdir(), "extraction-integration-"));

// ============================================================================
// The function server, restarted between phases so both gate states are tested
// ============================================================================
/**
 * THE SINGLE CLEANUP PATH. Idempotent, and the only place the process is put back in order.
 *
 * It runs from the finally block of the structured runner at the bottom of this file AND
 * from the signal handlers, so it is written to be safe when both fire — `cleanupRuns`
 * makes every call after the first a no-op that returns the first call's verdict.
 *
 * Its three responsibilities, in order:
 *   1. stop the function-server child THIS SCRIPT started (and nothing else);
 *   2. restore public.receipt_extraction_runtime.mode to DISABLED;
 *   3. READ THE ROW BACK and verify it.
 *
 * Step 3 is why this returns a verdict rather than nothing. The database gate is the
 * milestone's fail-closed contract, and a harness that flipped it open and then merely
 * ATTEMPTED to close it would be asserting something it had not checked.
 *
 * The mode is restored to DISABLED unconditionally — never to whatever it was before. The
 * required final state is the shipped default, not the state this run happened to inherit.
 */
/**
 * Runs `work` at most once and hands every caller THE SAME promise.
 *
 * Extracted so the property can be tested directly, without running the real cleanup. An
 * earlier version proved idempotence by calling cleanup() mid-run — which consumed the single
 * flight, so the finally block later found the work "already done" and skipped restoring the
 * gate. Testing the mechanism instead of the instance avoids that entirely.
 */
function singleFlight(work) {
  let promise = null;
  return () => {
    if (promise === null) promise = work();
    return promise;
  };
}

const cleanup = singleFlight(performCleanup);

async function performCleanup() {
  cleanupRuns += 1;

  await stopServe();

  let restored = false;
  try {
    setMode("DISABLED");
    restored = psql("select mode from public.receipt_extraction_runtime;") === "DISABLED";
  } catch {
    // psql output can echo a connection string; it is not bound, printed or re-thrown.
    restored = false;
  }

  if (!restored) {
    process.stderr.write(
      "\nCLEANUP FAILED: could not verify public.receipt_extraction_runtime.mode = 'DISABLED'.\n" +
        "  The local database gate may still be open. See the report for the exact statement.\n",
    );
  }

  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // Nothing useful to do; the OS reclaims its own temp directory.
  }

  return restored;
}

/**
 * Stops the function server THIS SCRIPT STARTED, and waits for that exact child to exit.
 *
 * The child's own `exit` event is the authority — not a port probe. Polling the route to
 * decide whether "the server" has stopped cannot distinguish our child from somebody else's
 * server, which is precisely the confusion that made an earlier version of this harness hang
 * for twenty seconds and then abort. `npx` is a wrapper around a longer-lived child, so the
 * whole process GROUP is signalled (the child is spawned detached for that reason), with a
 * bounded escalation to SIGKILL.
 *
 * IT NEVER STOPS A DOCKER CONTAINER, and it never signals a process it did not spawn.
 */
async function stopServe() {
  const child = serveProcess;
  if (child === null) return;
  serveProcess = null;

  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once("exit", () => resolve()));

  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };

  signalGroup("SIGTERM");
  const escalation = setTimeout(() => signalGroup("SIGKILL"), 5000);
  await exited;
  clearTimeout(escalation);
}

/**
 * What is answering the function route right now.
 *
 *   "serving"      a function server is attached and handling the route.
 *   "gateway-only" the API gateway is up but no function runtime is behind it (503/404).
 *   "unreachable"  nothing is listening at all.
 *
 * The distinction between the last two matters: the gateway answers on this port whether or
 * not a function runtime exists, so "the connection was refused" is NOT the signal for
 * "no function server". Only a successful preflight means a function is loaded.
 */
async function probeRoute(url) {
  try {
    const response = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
      signal: AbortSignal.timeout(2000),
    });
    return response.status === 204 || response.status === 200 ? "serving" : "gateway-only";
  } catch {
    return "unreachable";
  }
}

/** Ownership of the route is judged on one function; readiness is judged on all three. */
function probeFunctionRoute() {
  return probeRoute(REQUEST_URL);
}

/** True only when EVERY function route answers a preflight. No body is read or printed. */
async function allFunctionRoutesServing() {
  for (const url of FUNCTION_ROUTES) {
    if ((await probeRoute(url)) !== "serving") return false;
  }
  return true;
}

/**
 * True when the local stack is up, judged from a route this harness does NOT manage.
 *
 * The functions route cannot answer that question. `supabase functions serve` repoints the
 * gateway's function upstream at its own runtime, and when that runtime goes away the
 * upstream is simply gone — so the route stops answering ENTIRELY (a connection failure)
 * rather than returning the 503 it gives on a freshly started stack. Treating that as "the
 * stack is down" would make the harness unrunnable a second time, which is precisely the
 * repeatability property it is supposed to have. REST is used instead because nothing in this
 * harness ever touches it.
 */
async function stackIsUp() {
  try {
    const response = await fetch(`${API_URL}/rest/v1/`, {
      method: "GET",
      headers: { apikey: ANON_KEY },
      signal: AbortSignal.timeout(3000),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

/** The fixed diagnostic for a route this harness cannot own. Contains no runtime value. */
function competingServerDiagnostic() {
  return (
    "a function server is ALREADY answering the local /functions/v1 route.\n" +
    "  This harness starts and stops its own function server so it can change the fake\n" +
    "  provider configuration between phases, so it cannot share that route with the\n" +
    "  built-in Edge Runtime or with a `supabase functions serve` you started yourself.\n" +
    "\n" +
    "  Start the stack WITHOUT the built-in Edge Runtime:\n" +
    "\n" +
    "    npx supabase stop\n" +
    `    ${START_COMMAND}\n` +
    "    npm run test:extraction:integration\n"
  );
}

/**
 * FAST, DETERMINISTIC PREFLIGHT. One probe, no retry loop, no timeout to sit through.
 *
 * Called once before the first child is spawned. It refuses to run against a route somebody
 * else owns rather than silently reusing an unknown function server — a run against a server
 * whose environment this harness did not set would report green while testing nothing.
 */
async function assertRouteIsFree() {
  if ((await probeFunctionRoute()) === "serving") fatal(competingServerDiagnostic());
  if (!(await stackIsUp())) {
    fatal(
      "the local Supabase stack is not running.\n" +
        `  Start it with:  ${START_COMMAND}\n`,
    );
  }
}

/** Waits, bounded, for the function route to stop being served. */
async function waitForRouteToStopServing(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeFunctionRoute()) !== "serving") return true;
    await sleep(500);
  }
  return false;
}

/** Readiness bounds. Fixed literals — never read from the environment or a response. */
const READINESS_DEADLINE_MS = 90_000;
const READINESS_ROUND_PAUSE_MS = 500;
const READINESS_CONSECUTIVE_ROUNDS = 2;

async function startServe(env) {
  await stopServe();

  const envPath = join(TEMP_DIR, `env-${randomUUID()}.env`);
  writeFileSync(
    envPath,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  const child = spawn(
    "npx",
    ["supabase", "functions", "serve", "--env-file", envPath, "--no-verify-jwt"],
    {
      cwd: ROOT,
      env: CLI_ENV,
      stdio: ["ignore", "ignore", "ignore"],
      // Its own process group, so stopServe can signal the whole tree rather than the npx
      // wrapper alone.
      detached: true,
    },
  );
  serveProcess = child;

  // ==========================================================================
  // READINESS: ALL THREE ROUTES, TWICE IN A ROW, BOUNDED BY A DEADLINE.
  // ==========================================================================
  // Readiness is tied to THIS child. A preflight needs no token and no body, so it is the
  // cheapest probe that proves a function is loaded rather than merely that the gateway is
  // listening — but it is only accepted while our own child is still alive. If the child
  // dies, the loop stops immediately instead of waiting out a timeout against whatever else
  // might answer the route.
  //
  // WHY ALL THREE, AND WHY TWICE. The old gate probed request-receipt-extraction ONCE and
  // returned. Section 4 is the only phase that restarts the server and then IMMEDIATELY makes
  // an application request with no intervening work — every other phase builds a fixture
  // first, which incidentally gives the runtime a few hundred milliseconds to settle. So
  // section 4 was the one place where "one route answered once" was the entire guarantee, and
  // it is the one place that intermittently failed. Requiring every route this suite can call
  // to answer, on two consecutive rounds, closes the window that a single sample leaves open.
  //
  // Bounded on both axes: a fixed wall-clock deadline, and a fixed pause between rounds.
  // Neither loop can run away, and a child that dies fails the run at once.
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  let consecutiveReadyRounds = 0;
  while (Date.now() < deadline) {
    await sleep(READINESS_ROUND_PAUSE_MS);
    if (child.exitCode !== null || child.signalCode !== null) {
      serveProcess = null;
      fatal(
        "the function server this harness started exited before it became ready.\n" +
          `  Check that the stack is running:  ${START_COMMAND}\n`,
      );
    }
    if (await allFunctionRoutesServing()) {
      consecutiveReadyRounds += 1;
      if (consecutiveReadyRounds >= READINESS_CONSECUTIVE_ROUNDS) return;
    } else {
      // A single unready route resets the streak: two rounds must be CONSECUTIVE.
      consecutiveReadyRounds = 0;
    }
  }
  fatal("the function server this harness started did not become ready in time");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch, with ONE reconnect on a transport error.
 *
 * This suite deliberately restarts the function server between phases, and Node's HTTP agent
 * keeps connections to the API gateway pooled across those restarts. The first request after
 * a restart can therefore be written to a socket the gateway has already closed, which
 * surfaces as `TypeError: fetch failed` — a property of the connection pool, not of anything
 * under test. Retrying once distinguishes the two: a real failure fails twice.
 */
async function resilientFetch(url, options = {}) {
  try {
    return await fetch(url, options);
  } catch {
    await sleep(750);
    return await fetch(url, options);
  }
}

// ============================================================================
// A NARROW RETRY FOR A SETTLING GATEWAY — AND FOR NOTHING ELSE
// ============================================================================
/**
 * The only statuses that mean "the infrastructure is still settling".
 *
 * 502/503/504 are produced by the API GATEWAY when the function upstream is not attached yet
 * — they are never produced by the functions under test, which answer 200/400/401/403/404 and
 * nothing else. That is what makes retrying them safe: no product outcome is being papered
 * over, because no product outcome can arrive with one of these statuses.
 *
 * 500 is deliberately ABSENT. A 500 is the function itself failing, which is exactly the kind
 * of real defect this suite exists to catch, so it is surfaced on the first attempt.
 */
const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Three attempts total, therefore at most two retries. Fixed, short, no jitter. */
const SETTLING_ATTEMPTS = 3;
const SETTLING_BACKOFF_MS = [250, 750];

/**
 * Performs a request, retrying ONLY a transport error or a settling-gateway status.
 *
 * `fetchImpl` is injected so the POLICY can be tested deterministically, with no network, by
 * the self-checks in section 9. Production callers leave it at the default.
 *
 * Returns { response, attempts, category }. It NEVER inspects or returns a body — the caller
 * asserts on the response exactly as it would on an unretried one, so a 2xx carrying an
 * application error, or a malformed 2xx, reaches the assertions unchanged and unretried.
 *
 * Throws the final transport error when every attempt fails at the transport layer.
 */
async function fetchThroughSettling(url, options, fetchImpl = fetch) {
  let transportError = null;

  for (let attempt = 1; attempt <= SETTLING_ATTEMPTS; attempt += 1) {
    let response = null;
    try {
      // The SAME url and the SAME options object, byte for byte, on every attempt. No token
      // is refreshed, no body is rebuilt, no header is recomputed.
      response = await fetchImpl(url, options);
      transportError = null;
    } catch (error) {
      transportError = error;
    }

    if (response !== null && !TRANSIENT_GATEWAY_STATUSES.has(response.status)) {
      // Anything that is not a settling status is the answer, first time, every time.
      return { response, attempts: attempt, category: "application-response" };
    }

    if (attempt === SETTLING_ATTEMPTS) {
      if (response !== null) {
        return { response, attempts: attempt, category: "transient-gateway" };
      }
      throw transportError;
    }

    await sleep(SETTLING_BACKOFF_MS[attempt - 1]);
  }

  // Unreachable: the loop always returns or throws on its final attempt.
  throw new HarnessError("the settling retry did not terminate");
}

/** A fixed, redacted description of how a response was obtained. Carries no data. */
function settlingDetail(response) {
  return `http ${response.status}, ${response.category ?? "application-response"}, ` +
    `attempt ${response.attempts ?? 1} of ${SETTLING_ATTEMPTS}`;
}

// `--no-verify-jwt` is passed above so the GATEWAY does not reject before the function runs;
// the functions perform their OWN getUser() revalidation, which is the check under test here.
// In a deployed environment verify_jwt = true adds the gateway check back on top, and
// receipt-extraction-safety.test.ts asserts that declaration in supabase/config.toml.
const BASE_ENV = {
  SUPABASE_URL: "http://host.docker.internal:54321",
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
};

// ============================================================================
// Database helpers
// ============================================================================
/**
 * Runs ONE SQL statement against the local database via the Supabase CLI.
 *
 * `supabase db query` is the CLI's own supported way to reach the local database. It resolves
 * the connection itself, so this harness never constructs a container name, never runs
 * `docker exec`, never discovers containers, and never handles — let alone prints — the
 * database URL or password.
 *
 * ONE STATEMENT AT A TIME, and that is a hard limit rather than a style choice: the CLI sends
 * the text as a prepared statement, so a semicolon-separated script or a DO block is rejected
 * outright. Callers that need several statements use sqlScript() below.
 *
 * Returns the first column of the first row as a string, or "" when the statement returned no
 * rows (a DML statement, for instance). Errors propagate; the CLI's own output is not echoed.
 */
function psql(statement) {
  // `detached` puts the CLI in its OWN process group. Ctrl-C sends SIGINT to the whole
  // FOREGROUND group, so without this a second Ctrl-C would kill the very command cleanup
  // uses to restore the gate — and the run would end with the gate still open. Isolating it
  // is what makes cleanup survive an impatient operator.
  const result = spawnSync(
    "npx",
    ["supabase", "db", "query", statement, "-o", "json"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: CLI_ENV,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new HarnessError("a database statement failed");
  const raw = result.stdout ?? "";

  // The CLI prints a progress line before the JSON document; take the document only.
  const start = raw.indexOf("{");
  if (start < 0) return "";
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    return "";
  }
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  if (rows.length === 0) return "";
  const first = Object.values(rows[0])[0];
  return first === null || first === undefined ? "" : String(first);
}

/** Runs several statements in order. Split here because the CLI accepts only one at a time. */
function sqlScript(statements) {
  for (const statement of statements) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) psql(trimmed);
  }
}

function setMode(mode) {
  psql(`update public.receipt_extraction_runtime set mode = '${mode}' where id;`);
}

// ============================================================================
// Auth helpers
// ============================================================================
async function createUser(label) {
  const email = `${label}-${randomUUID()}@extraction.invalid`;
  const password = randomUUID();
  const response = await resilientFetch(`${API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.id) fatal(`could not create the ${label} user`);
  return { id: body.id, email, password };
}

async function signIn(user) {
  const response = await resilientFetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) fatal(`could not sign in as ${user.email}`);
  return body.access_token;
}

/**
 * Sends a request the way a browser would, so CORS is genuinely exercised.
 *
 * `throughSettling` is OPT-IN and deliberately not the default. It is for a READ issued
 * immediately after a server restart, where a settling gateway can answer before the function
 * upstream is attached. It is never used for a call that can create or change a row — see the
 * mutation note at its single call site.
 */
async function call(url, token, body, { throughSettling = false } = {}) {
  const headers = {
    Origin: "http://localhost:3000",
    apikey: ANON_KEY,
    "Content-Type": "application/json",
    "x-client-info": "extraction-integration-test",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  const request = {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };

  let response;
  let attempts = 1;
  let category = "application-response";
  if (throughSettling) {
    const settled = await fetchThroughSettling(url, request);
    response = settled.response;
    attempts = settled.attempts;
    category = settled.category;
  } else {
    response = await resilientFetch(url, request);
  }

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null; the caller asserts on the status. Recorded as a CATEGORY, never as content.
    category = "invalid-json";
  }
  return { status: response.status, headers: response.headers, body: json, text, attempts, category };
}

/** A browser discards a reply it cannot read, whatever its status line says. */
function checkBrowserReadable(response, description) {
  check(
    response.headers.get("access-control-allow-origin") !== null,
    `${description} carries an Access-Control-Allow-Origin header`,
  );
}

/** Nothing sensitive may appear in a response body, ever. */
function checkNoLeakage(response, description, extraSecrets = []) {
  const text = response.text ?? "";
  const secrets = [
    ["the service-role key", SERVICE_ROLE_KEY],
    ["a storage bucket reference", "receipts/"],
    ["a fake operation id", "fake:"],
    ["a claim token field", "claim_token"],
    ["an object path field", "storage_object_path"],
    ["a file hash field", "file_sha256"],
    ["a provider field", '"provider"'],
    ...extraSecrets,
  ];
  for (const [name, secret] of secrets) {
    check(!text.includes(secret), `${description} does not contain ${name}`);
  }
  check(!/[0-9a-f]{64}/.test(text), `${description} contains no 64-hex value`);
}

// ============================================================================
// Fixtures
// ============================================================================
async function buildFixtures() {
  const retailer = randomUUID();
  const shop = randomUUID();

  const sales = await createUser("sales");
  const other = await createUser("other");
  const owner = await createUser("owner");

  // ONE STATEMENT PER CALL. `supabase db query` sends the text as a prepared statement, so a
  // semicolon-separated script is rejected; sqlScript runs them in order instead.
  sqlScript([
    `insert into public.organizations (id, name, organization_type, status)
     values ('${retailer}', 'Integration Retailer ${retailer.slice(0, 8)}', 'RETAILER', 'ACTIVE')`,

    `insert into public.retailer_shops (id, retailer_organization_id, name, code, status)
     values ('${shop}', '${retailer}', 'Integration Shop', 'I${retailer.slice(0, 4)}', 'ACTIVE')`,

    `insert into public.profiles (id, first_name, last_name, status) values
       ('${sales.id}', 'Sales', 'Tester', 'ACTIVE'),
       ('${other.id}', 'Other', 'Tester', 'ACTIVE'),
       ('${owner.id}', 'Owner', 'Tester', 'ACTIVE')
     on conflict (id) do update set status = 'ACTIVE'`,

    `with m as (
       insert into public.organization_members (organization_id, user_id, status) values
         ('${retailer}', '${sales.id}', 'ACTIVE'),
         ('${retailer}', '${other.id}', 'ACTIVE'),
         ('${retailer}', '${owner.id}', 'ACTIVE')
       returning id, user_id
     )
     insert into public.member_roles (organization_member_id, role_id)
     select m.id, r.id from m
     join public.roles r on r.code = case when m.user_id = '${owner.id}'
                                          then 'RETAILER_OWNER' else 'SALES_STAFF' end`,
  ]);

  return { retailer, shop, sales, other, owner };
}

/** Creates a SUBMITTED receipt and uploads a real object for it. */
async function newSubmission(fixtures, ownerId) {
  const id = randomUUID();
  const objectPath = `${fixtures.retailer}/${ownerId}/${id}/object.jpg`;
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    Buffer.from(randomUUID()),
  ]);

  const upload = await resilientFetch(`${API_URL}/storage/v1/object/receipts/${objectPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "image/jpeg",
    },
    body: bytes,
  });
  if (!upload.ok) fatal(`could not upload the fixture object (${upload.status})`);

  psql(`
    insert into public.receipt_submissions (
      id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
      storage_bucket, storage_object_path, original_file_name, mime_type, file_size_bytes,
      file_sha256, status, submitted_at
    ) values (
      '${id}', '${fixtures.retailer}', '${fixtures.shop}', '${ownerId}',
      'receipts', '${objectPath}', 'receipt.jpg', 'image/jpeg', ${bytes.length},
      md5('${id}') || md5('${id}x'), 'SUBMITTED', now()
    )
  `);
  return { id, objectPath, bytes };
}

function attemptCount(submissionId) {
  return Number.parseInt(
    psql(
      `select count(*) from public.receipt_extractions where receipt_submission_id = '${submissionId}';`,
    ),
    10,
  );
}

function auditCount(action) {
  return Number.parseInt(
    psql(`select count(*) from public.audit_logs where action = '${action}';`),
    10,
  );
}

// ============================================================================
// The run
// ============================================================================
async function main() {
  if (configError !== null) fatal(configError);

  // --------------------------------------------------------------------------
  section("0. preflight — this harness must own the function route");
  // --------------------------------------------------------------------------
  // ONE probe, decided immediately. The documented starting state is the stack running
  // WITHOUT its built-in Edge Runtime, so the route must be answered by the gateway alone.
  const initialRoute = await probeFunctionRoute();
  check(
    initialRoute !== "serving",
    "the function route is free — the stack was started without the built-in Edge Runtime",
    `something is already serving it; start with: ${START_COMMAND}`,
  );
  check(await stackIsUp(), "and the rest of the stack is up", `start with: ${START_COMMAND}`);
  await assertRouteIsFree();

  // The diagnostic a competing server produces is a fixed string: it names the command to
  // run and carries no key, token, URL or response body.
  const diagnostic = competingServerDiagnostic();
  check(diagnostic.includes(START_COMMAND), "the competing-server diagnostic names the exact start command");
  check(
    !diagnostic.includes(SERVICE_ROLE_KEY) && !diagnostic.includes(ANON_KEY) &&
      !diagnostic.includes(API_URL),
    "and contains no key, token or URL",
  );

  const fixtures = await buildFixtures();
  const salesToken = await signIn(fixtures.sales);
  const otherToken = await signIn(fixtures.other);
  const ownerToken = await signIn(fixtures.owner);

  // --------------------------------------------------------------------------
  section("1. DISABLED at the EDGE — with the DATABASE gate wide open");
  // --------------------------------------------------------------------------
  // The hostile configuration: the database says FAKE, the Edge environment says nothing.
  // Nothing at all may be created.
  setMode("FAKE");
  await startServe(BASE_ENV); // RECEIPT_EXTRACTION_MODE deliberately absent

  const subDisabled = await newSubmission(fixtures, fixtures.sales.id);
  const claimsBefore = auditCount("RECEIPT_EXTRACTION_CLAIMED");

  const disabled = await call(REQUEST_URL, salesToken, { submission_id: subDisabled.id });
  check(disabled.status === 200, "a disabled request still answers 200", `got ${disabled.status}`);
  check(
    disabled.body?.outcome === "EXTRACTION_UNAVAILABLE",
    "and reports EXTRACTION_UNAVAILABLE",
    JSON.stringify(disabled.body?.outcome),
  );
  check(disabled.body?.attempts_used === 0, "attempts_used is 0 — FACTUAL");
  check(disabled.body?.attempts_remaining === 3, "attempts_remaining is 3 — NOT zeroed");
  check(disabled.body?.retry_allowed === false, "retry_allowed is false");
  check(
    disabled.body?.manual_confirmation_allowed === true,
    "manual confirmation remains available",
  );
  check(attemptCount(subDisabled.id) === 0, "NO extraction row was created");
  check(
    auditCount("RECEIPT_EXTRACTION_CLAIMED") === claimsBefore,
    "NO claim was made",
  );
  check(
    !disabled.text.toLowerCase().includes("mode") &&
      !disabled.text.toLowerCase().includes("disabled") &&
      !disabled.text.includes("RECEIPT_EXTRACTION"),
    "and the response reveals no configuration detail",
  );
  checkBrowserReadable(disabled, "the disabled response");
  checkNoLeakage(disabled, "the disabled response");

  // A fault point for the self-checks. At this instant the run holds BOTH a running function
  // server and an open database gate, which is exactly the state whose cleanup must survive
  // an interruption. Inert unless the environment names it.
  if (FAULT === "hang") {
    process.stdout.write(`${HANG_MARKER}\n`);
    await sleep(180_000);
  }

  // --------------------------------------------------------------------------
  section("2. every refusal precedes the disabled response");
  // --------------------------------------------------------------------------
  const unauth = await call(REQUEST_URL, null, { submission_id: subDisabled.id });
  check(unauth.status === 401, "an unauthenticated caller gets 401", `got ${unauth.status}`);
  check(unauth.body?.status === "unauthenticated", "with the unauthenticated status");
  checkBrowserReadable(unauth, "the 401");

  const badToken = await call(REQUEST_URL, "not.a.token", { submission_id: subDisabled.id });
  check(badToken.status === 401, "an invalid token gets 401", `got ${badToken.status}`);

  const malformed = await call(REQUEST_URL, salesToken, "{ not json");
  check(malformed.status === 400, "a malformed body gets 400", `got ${malformed.status}`);

  const unknownField = await call(REQUEST_URL, salesToken, {
    submission_id: subDisabled.id,
    fixture: "REJECTED_DOCUMENT",
  });
  check(unknownField.status === 400, "AN UNKNOWN FIELD IS REFUSED, not ignored");
  check(unknownField.body?.reason === "unknown-field", "and named as such");

  const denied = await call(REQUEST_URL, ownerToken, { submission_id: subDisabled.id });
  check(denied.status === 403, "a Retailer Owner gets 403", `got ${denied.status}`);

  const notMine = await call(REQUEST_URL, otherToken, { submission_id: subDisabled.id });
  check(notMine.status === 404, "another Sales Staff member gets 404", `got ${notMine.status}`);

  const unknownId = await call(REQUEST_URL, salesToken, { submission_id: randomUUID() });
  check(unknownId.status === 404, "an unknown id gets 404 — byte-identical");
  check(
    JSON.stringify(notMine.body) === JSON.stringify(unknownId.body),
    "and the two 404 bodies are indistinguishable",
  );

  // --------------------------------------------------------------------------
  section("3. the full success path, with the asynchronous shape intact");
  // --------------------------------------------------------------------------
  await startServe({ ...BASE_ENV, RECEIPT_EXTRACTION_MODE: "fake" });

  const subOk = await newSubmission(fixtures, fixtures.sales.id);
  const requested = await call(REQUEST_URL, salesToken, { submission_id: subOk.id });

  check(requested.status === 200, "the request succeeds", `got ${requested.status}`);
  check(requested.body?.outcome === "QUEUED", "and reports QUEUED");
  check(
    requested.body?.extraction?.status === "PROCESSING",
    "THE ATTEMPT IS LEFT PROCESSING — the request function never completes it",
    JSON.stringify(requested.body?.extraction?.status),
  );
  check(requested.body?.attempts_used === 1, "one attempt is consumed");
  check(requested.body?.attempts_remaining === 2, "two remain");
  checkNoLeakage(requested, "the queued response");

  // The provider reports PENDING for 1500 ms by default, so the first poll must not resolve.
  const earlyPoll = await call(GET_URL, salesToken, { submission_id: subOk.id });
  check(
    earlyPoll.body?.extraction?.status === "PROCESSING",
    "AN IMMEDIATE POLL STILL REPORTS PROCESSING — the PENDING branch is real",
    JSON.stringify(earlyPoll.body?.extraction?.status),
  );

  await sleep(1800);
  const completed = await call(GET_URL, salesToken, { submission_id: subOk.id });
  check(
    completed.body?.extraction?.status === "SUCCEEDED",
    "the second poll completes it",
    JSON.stringify(completed.body?.extraction?.status),
  );
  check(
    completed.body?.extraction?.total_minor === 123456,
    "the AED total parsed to exact minor units",
    JSON.stringify(completed.body?.extraction?.total_minor),
  );
  check(
    completed.body?.extraction?.currency_minor_unit === 2,
    "and carries its minor unit",
  );
  check(
    completed.body?.extraction?.merchant_name === "Lulu Hypermarket",
    "the merchant name came through",
  );
  check(completed.body?.extraction?.line_item_count === 2, "both line items were recorded");
  checkNoLeakage(completed, "the succeeded response");

  const confirmedRow = psql(
    `select coalesce((select 'yes' from public.receipt_extractions
       where receipt_submission_id = '${subOk.id}' and status = 'SUCCEEDED'), 'no');`,
  );
  check(confirmedRow === "yes", "the database agrees the attempt succeeded");

  // --------------------------------------------------------------------------
  section("4. a SUCCEEDED result stays readable with the Edge gate shut");
  // --------------------------------------------------------------------------
  await startServe(BASE_ENV);

  // THE ONE CALL IN THIS SUITE THAT RETRIES A SETTLING GATEWAY, and the only one that needs
  // to: it is the sole application request issued IMMEDIATELY after a restart, with no
  // fixture-building in between to let the runtime attach its routes.
  //
  // MUTATION SAFETY. Retrying is sound here because this exact request, in this exact state,
  // cannot write anything. get-receipt-extraction only claims, polls or completes an attempt
  // that is still OPEN and only while the Edge gate is open; here the attempt is already
  // SUCCEEDED (asserted against the database at the end of section 3) and the gate is SHUT,
  // so the function reports stored state and stops. The scope-expire step it performs is the
  // single-id reaper, which matches only QUEUED or PROCESSING rows and therefore matches
  // nothing for a terminal one. Repeating the request cannot produce a second effect.
  //
  // Any retry is bounded at three attempts and is reported, redacted, in the detail below.
  const whileDisabled = await call(
    GET_URL,
    salesToken,
    { submission_id: subOk.id },
    { throughSettling: true },
  );
  const settled = settlingDetail(whileDisabled);
  check(
    whileDisabled.body?.extraction?.status === "SUCCEEDED",
    "DISABLING EXECUTION DOES NOT HIDE STORED EVIDENCE",
    settled,
  );
  check(
    whileDisabled.body?.extraction?.total_minor === 123456,
    "the extracted values are still there",
    settled,
  );
  check(
    whileDisabled.body?.extraction?.retry_allowed === false,
    "and retry_allowed is narrowed to false by the Edge gate",
    settled,
  );

  // --------------------------------------------------------------------------
  section("5. the provider-rejected path, a retry, and manual confirmation");
  // --------------------------------------------------------------------------
  await startServe({
    ...BASE_ENV,
    RECEIPT_EXTRACTION_MODE: "fake",
    RECEIPT_EXTRACTION_FIXTURE: "REJECTED_DOCUMENT",
    RECEIPT_EXTRACTION_FAKE_PENDING_MS: "0",
  });

  const subFail = await newSubmission(fixtures, fixtures.sales.id);
  await call(REQUEST_URL, salesToken, { submission_id: subFail.id });
  const failed = await call(GET_URL, salesToken, { submission_id: subFail.id });

  check(
    failed.body?.extraction?.status === "FAILED",
    "the rejected document fails the attempt",
    JSON.stringify(failed.body?.extraction?.status),
  );
  check(
    failed.body?.extraction?.failure_code === "IMAGE_NOT_A_RECEIPT",
    "and the CLIENT sees the mapped code, never the internal one",
    JSON.stringify(failed.body?.extraction?.failure_code),
  );
  check(
    !failed.text.includes("PROVIDER_REJECTED_DOCUMENT"),
    "the internal failure code does not appear in the response",
  );
  check(failed.body?.extraction?.retry_allowed === true, "a retry is offered");
  check(failed.body?.extraction?.attempts_remaining === 2, "with two attempts left");

  const retried = await call(REQUEST_URL, salesToken, { submission_id: subFail.id });
  check(retried.body?.outcome === "QUEUED", "the retry creates a new attempt");
  check(retried.body?.attempts_used === 2, "which consumes the second attempt");
  check(attemptCount(subFail.id) === 2, "two rows exist");

  await call(GET_URL, salesToken, { submission_id: subFail.id });
  const thirdRequest = await call(REQUEST_URL, salesToken, { submission_id: subFail.id });
  check(thirdRequest.body?.outcome === "QUEUED", "and a third");
  await call(GET_URL, salesToken, { submission_id: subFail.id });

  const exhausted = await call(REQUEST_URL, salesToken, { submission_id: subFail.id });
  check(exhausted.body?.outcome === "EXHAUSTED", "the fourth request is EXHAUSTED");
  check(exhausted.body?.attempts_used === 3, "three attempts used");
  check(exhausted.body?.attempts_remaining === 0, "zero remaining — factually, not as a signal");
  check(attemptCount(subFail.id) === 3, "AND NO FOURTH ROW EXISTS");
  check(
    exhausted.body?.manual_confirmation_allowed === true,
    "manual confirmation remains the way through",
  );

  // --------------------------------------------------------------------------
  section("6. the image preview");
  // --------------------------------------------------------------------------
  const preview = await call(PREVIEW_URL, salesToken, { submission_id: subOk.id });
  check(preview.status === 200, "the owner gets a preview URL", `got ${preview.status}`);
  check(typeof preview.body?.url === "string", "the response carries a url");
  check(preview.body?.expires_in_seconds === 120, "with a 120-second TTL");
  check(
    preview.headers.get("cache-control") === "no-store",
    "and Cache-Control: no-store, because the body is a live capability",
  );
  check(preview.headers.get("pragma") === "no-cache", "and Pragma: no-cache");
  checkBrowserReadable(preview, "the preview response");

  // WHAT "NO BUCKET OR PATH IN THE RESPONSE" CAN AND CANNOT MEAN HERE.
  // A Supabase signed URL ADDRESSES the object, so the bucket and the object path are inside
  // the URL string by construction — that is inherent to the signed-URL mechanism and is the
  // one thing the byte-proxy alternative would have avoided. What the contract can and does
  // require is that no SEPARATE bucket, path, MIME or hash FIELD is returned, and that the
  // only occurrence anywhere in the body is the URL itself. Both are asserted.
  //
  // The disclosure is bounded: the path is <retailer>/<profile>/<submission>/<random>, all of
  // which are the CALLER'S OWN identifiers, and the bucket is private so the path alone grants
  // nothing to anyone.
  const previewKeys = Object.keys(preview.body ?? {});
  check(
    previewKeys.sort().join(",") === "expires_in_seconds,status,url",
    "the response has exactly three keys: status, url, expires_in_seconds",
    previewKeys.join(","),
  );
  const withoutUrl = JSON.stringify({ ...preview.body, url: "" });
  check(
    !withoutUrl.includes("receipts") && !withoutUrl.includes(subOk.objectPath),
    "and outside the signed URL itself, no bucket or object path appears",
  );
  check(!withoutUrl.includes("mime"), "and no MIME type");
  check(!preview.text.includes(SERVICE_ROLE_KEY), "and no service-role key");

  // The function builds its URLs from its own SUPABASE_URL, which inside the local container
  // is a Docker-internal host this process cannot resolve. Only the ORIGIN is rewritten, and
  // only here: this is a TEST-ENVIRONMENT concern, and in a deployed environment the
  // function's URL and the client's agree. The path and the signature are left untouched.
  const reachable = (url) => {
    const target = new URL(API_URL);
    if (!/^https?:\/\//.test(url)) {
      return `${target.origin}${url.startsWith("/") ? "" : "/"}${url}`;
    }
    const parsed = new URL(url);
    parsed.protocol = target.protocol;
    parsed.host = target.host;
    return parsed.toString();
  };

  const fetched = await resilientFetch(reachable(preview.body.url));
  check(fetched.ok, "the signed URL fetches the image before expiry", `got ${fetched.status}`);
  const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
  check(fetchedBytes.length === subOk.bytes.length, "and returns the right object");

  const previewOther = await call(PREVIEW_URL, otherToken, { submission_id: subOk.id });
  check(previewOther.status === 404, "another Sales Staff member gets 404");
  const previewOwner = await call(PREVIEW_URL, ownerToken, { submission_id: subOk.id });
  check(previewOwner.status === 403, "a Retailer Owner gets 403");

  // EXPIRY. A 120-second sleep would make this suite two minutes slower for no extra
  // information, so the two properties are asserted separately and honestly: the FUNCTION's
  // TTL is read from its own response above, and STORAGE's enforcement of an elapsed TTL is
  // proved here with a deliberately short-lived URL. The exact status is NOT asserted — only
  // that it is not a success — because that code belongs to Storage, not to this contract.
  const shortLived = await resilientFetch(
    `${API_URL}/storage/v1/object/sign/receipts/${subOk.objectPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 1 }),
    },
  );
  const shortLivedBody = await shortLived.json().catch(() => null);
  if (shortLivedBody?.signedURL) {
    const shortUrl = `${API_URL}/storage/v1${shortLivedBody.signedURL}`;
    const beforeExpiry = await resilientFetch(shortUrl);
    check(beforeExpiry.ok, "a short-lived URL works before it expires");
    await sleep(2500);
    const afterExpiry = await resilientFetch(shortUrl);
    check(!afterExpiry.ok, "and returns a NON-2XX status once expired", `got ${afterExpiry.status}`);
  } else {
    check(false, "could not mint a short-lived URL for the expiry check");
  }

  const refreshed = await call(PREVIEW_URL, salesToken, { submission_id: subOk.id });
  check(refreshed.status === 200, "a fresh URL is obtainable afterwards");
  const refetched = await resilientFetch(reachable(refreshed.body.url));
  check(refetched.ok, "and it works");

  // --------------------------------------------------------------------------
  section("7. audit metadata carries no extracted value");
  // --------------------------------------------------------------------------
  const leaked = psql(`
    select count(*) from public.audit_logs
    where action like 'RECEIPT_%'
      and (metadata::text like '%Lulu%' or metadata::text like '%123456%'
        or metadata::text like '%fake:%' or metadata::text like '%receipts/%');
  `);
  check(leaked === "0", "no merchant, amount, operation id or path in any audit row");

  const workerActors = psql(`
    select count(*) from public.audit_logs
    where action in ('RECEIPT_EXTRACTION_CLAIMED','RECEIPT_EXTRACTION_SUCCEEDED',
                     'RECEIPT_EXTRACTION_FAILED')
      and (actor_profile_id is not null or metadata->>'actor_kind' is distinct from 'SYSTEM_WORKER');
  `);
  check(workerActors === "0", "every worker event is a null actor marked SYSTEM_WORKER");

  // --------------------------------------------------------------------------
  section("8. no global reaper ran");
  // --------------------------------------------------------------------------
  // Every hot-path call is scoped to one id. If a global sweep had run, the unrelated queued
  // rows created above by other phases would have been touched; none were expired.
  const abandoned = psql(`
    select count(*) from public.receipt_extractions
    where failure_code in ('WORKER_ABANDONED','NEVER_CLAIMED');
  `);
  check(abandoned === "0", "not one attempt was reaped — no sweep reached an unrelated row");

  // A fault point for the self-checks below. Inert unless the environment names it.
  maybeFault("after-phases");

  // --------------------------------------------------------------------------
  section("9. harness self-checks — what this script leaves behind");
  // --------------------------------------------------------------------------
  // A harness that flips the database gate open and starts a server has to prove it puts
  // both back, on EVERY exit path. The only honest way to show that is to make a run fail on
  // purpose and inspect the wreckage — so these checks re-run THIS SAME SCRIPT as a child
  // with a fault injected, and then look at the route and the gate.
  //
  // Skipped inside such a child (FAULT is set) so the self-checks cannot recurse.
  if (FAULT !== "") return;

  await stopServe();

  // The authoritative signal is that OUR child process is gone — stopServe awaited its exit.
  // The route follows a moment later, because the CLI tears its runtime down asynchronously,
  // so it is given a bounded settle rather than being sampled instantly.
  check(serveProcess === null, "after a successful run the harness holds no server handle");
  check(
    await waitForRouteToStopServing(),
    "and the function server it started has stopped answering the route",
  );

  // ---- the single-flight mechanism, tested directly -------------------------
  // The real cleanup is NOT run here. Doing so would consume its single flight, and the
  // finally block would then find the work already done and skip restoring the gate — which
  // is exactly the bug this arrangement exists to avoid. The mechanism is proved instead, and
  // the real cleanup's EFFECT is proved by the child runs below.
  let dummyRuns = 0;
  const dummy = singleFlight(async () => {
    dummyRuns += 1;
    await sleep(50);
    return "done";
  });
  const [a, b, c] = await Promise.all([dummy(), dummy(), dummy()]);
  check(dummyRuns === 1, "single-flight runs the work exactly once under concurrent callers");
  check(a === "done" && b === "done" && c === "done", "and every caller gets the same verdict");
  check((await dummy()) === "done", "and a later caller gets it too, without re-running");
  check(dummyRuns === 1, "still exactly once");
  check(cleanupRuns === 0, "the real cleanup has NOT run yet — the finally block still owns it");

  // ---- the settling-retry POLICY, tested with no network at all --------------
  // A retry policy that is only exercised against a healthy local stack is a policy nobody
  // has tested: the interesting cases are the ones that must NOT retry, and those never occur
  // when everything works. fetchThroughSettling therefore takes its fetch as a parameter, and
  // these checks drive it with a scripted fake. No socket is opened.
  //
  // A step of "throw" raises a transport error; a number is answered as that status. A step
  // beyond the end of the script answers 599, which is NOT retryable — so an extra attempt
  // shows up as a larger call count rather than being quietly absorbed.
  const scriptedFetch = (script, bodyText = "{}") => {
    const seen = [];
    const impl = async (url, options) => {
      seen.push({
        url,
        method: options.method,
        headers: JSON.stringify(options.headers),
        body: options.body,
      });
      const step = script[seen.length - 1];
      if (step === "throw") throw new TypeError("fetch failed");
      return {
        status: step ?? 599,
        headers: new Headers(),
        text: async () => bodyText,
      };
    };
    return { impl, seen };
  };

  const REQUEST_SHAPE = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-only-not-a-real-token" },
    body: JSON.stringify({ submission_id: "00000000-0000-0000-0000-000000000000" }),
  };
  const drive = async (script, bodyText) => {
    const { impl, seen } = scriptedFetch(script, bodyText);
    const result = await fetchThroughSettling("http://harness.invalid/probe", REQUEST_SHAPE, impl);
    return { ...result, seen };
  };

  const t1 = await drive(["throw", 200]);
  check(
    t1.response.status === 200 && t1.attempts === 2 && t1.seen.length === 2,
    "settling retry: a transport error then 200 retries once and returns 200",
    `status ${t1.response.status}, ${t1.attempts} attempts`,
  );

  const t2 = await drive([502, 200]);
  check(
    t2.response.status === 200 && t2.attempts === 2 && t2.seen.length === 2,
    "settling retry: 502 then 200 retries once",
    `status ${t2.response.status}, ${t2.attempts} attempts`,
  );

  const t3 = await drive([503, 200]);
  check(
    t3.response.status === 200 && t3.attempts === 2 && t3.seen.length === 2,
    "settling retry: 503 then 200 retries once",
    `status ${t3.response.status}, ${t3.attempts} attempts`,
  );

  const t4 = await drive([504, 503, 200]);
  check(
    t4.response.status === 200 && t4.attempts === 3 && t4.seen.length === 3,
    "settling retry: 504, 503, then 200 performs exactly three attempts",
    `status ${t4.response.status}, ${t4.attempts} attempts`,
  );

  const t5 = await drive([503, 503, 503]);
  check(
    t5.response.status === 503 && t5.attempts === 3 && t5.seen.length === 3 &&
      t5.category === "transient-gateway",
    "settling retry: three 503s return the third 503 and make NO fourth attempt",
    `status ${t5.response.status}, ${t5.attempts} attempts`,
  );

  // The statuses that must be surfaced immediately. 500 is the important one: a function
  // that has genuinely broken must not be retried until it looks intermittent.
  for (const status of [500, 401, 404, 429, 400, 403, 409, 422]) {
    const t = await drive([status, 200]);
    check(
      t.response.status === status && t.attempts === 1 && t.seen.length === 1,
      `settling retry: ${status} is returned after ONE attempt and never retried`,
      `status ${t.response.status}, ${t.attempts} attempts`,
    );
  }

  const t10 = await drive([200], "this is not json at all");
  check(
    t10.response.status === 200 && t10.attempts === 1 && t10.seen.length === 1,
    "settling retry: a malformed 2xx is NOT retried — the body is the caller's business",
    `status ${t10.response.status}, ${t10.attempts} attempts`,
  );

  const t11 = await drive([503, 503, 200]);
  const distinctRequests = new Set(t11.seen.map((entry) => JSON.stringify(entry)));
  check(
    t11.seen.length === 3 && distinctRequests.size === 1,
    "settling retry: url, method, headers and body are byte-identical on every attempt",
    `${t11.seen.length} attempts, ${distinctRequests.size} distinct request(s)`,
  );

  let transportThrew = null;
  try {
    await drive(["throw", "throw", "throw"]);
  } catch (error) {
    transportThrew = error;
  }
  check(
    transportThrew instanceof TypeError,
    "settling retry: when every attempt fails at the transport layer the error is thrown",
  );

  // The redacted diagnostic really is redacted. It is built from a response, so this is the
  // string that would be printed on a genuine section-4 failure.
  const redactedDetail = settlingDetail({ status: 503, category: "transient-gateway", attempts: 3 });
  check(
    !redactedDetail.includes(SERVICE_ROLE_KEY) && !redactedDetail.includes(ANON_KEY) &&
      !redactedDetail.includes(API_URL) && !redactedDetail.includes(subOk.id) &&
      !redactedDetail.includes("Bearer") && !redactedDetail.includes("{"),
    "settling retry: its diagnostic carries no key, token, URL, id or response body",
    redactedDetail,
  );

  // The gate really can be opened, so "it ends DISABLED" is a meaningful claim.
  setMode("FAKE");
  check(psql(GATE_QUERY) === "FAKE", "the gate can be opened, so restoring it is a real check");
  setMode("DISABLED");

  // ---- a run that FAILS must still clean up --------------------------------
  const faultedRun = await runSelfAsChild("after-phases");
  check(faultedRun.code !== 0, "a run with an injected fault exits NON-ZERO", `code ${faultedRun.code}`);
  check(psql(GATE_QUERY) === "DISABLED", "and still leaves the gate DISABLED");
  check(await waitForRouteToStopServing(), "and still leaves no function server behind");
  check(
    !faultedRun.output.includes(SERVICE_ROLE_KEY) && !faultedRun.output.includes(ANON_KEY),
    "and prints no key on the failure path",
  );

  // ---- a run INTERRUPTED by a signal must still clean up -------------------
  const interrupted = await runSelfAsChild("hang", "SIGINT");
  check(interrupted.code !== 0, "a twice-SIGINT'd run exits NON-ZERO", `code ${interrupted.code}`);
  // The regression for the re-entrancy race is the GATE assertion below, not a log line: a
  // second signal used to reach process.exit while the first cleanup was still restoring the
  // gate, and the symptom was a gate left at FAKE. Whether the repeat signal lands before or
  // after cleanup finishes is a timing detail; the state it leaves behind is not.
  check(psql(GATE_QUERY) === "DISABLED", "and SIGINT still leaves the gate DISABLED");
  check(await waitForRouteToStopServing(), "and SIGINT still leaves no function server behind");
  check(
    !interrupted.output.includes(SERVICE_ROLE_KEY) && !interrupted.output.includes(ANON_KEY),
    "and prints no key on the signal path",
  );

  // ---- this harness manages processes, never containers --------------------
  // SCANNED REGION: everything ABOVE this self-check block, with comments removed but STRING
  // LITERALS INTACT. Stripping literals would make these checks vacuous — a container name and
  // a command name are literals — and scanning the whole file would make each check match its
  // own description. Cutting at the marker gives the operational code and nothing else.
  const ownSource = readFileSync(new URL(import.meta.url), "utf8");
  const operational = ownSource
    // lastIndexOf, not indexOf: the first occurrence is the constant's own definition near
    // the top of this file, and cutting there would leave almost nothing to scan.
    .slice(0, ownSource.lastIndexOf(SELF_CHECK_MARKER))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  check(
    operational.length > ownSource.length / 2,
    "the scanned region really is the operational code, not a truncated sliver",
    `${operational.length} of ${ownSource.length} chars`,
  );

  // NO container name at all. Database access goes through `supabase db query`, the CLI's own
  // local-database command, so this harness never needs to know what the containers are called.
  check(
    !/supabase_[a-z_]+_[a-z0-9-]+/.test(operational),
    "no Supabase container name is hard-coded anywhere in the operational code",
  );

  // NO docker invocation of any kind — not even `exec`, and therefore not stop, kill or rm.
  // `host.docker.internal` is a HOSTNAME the function server resolves, not a command.
  check(
    !/execFileSync\(\s*["']docker["']|spawn\(\s*["']docker["']/.test(operational),
    "the harness never executes docker",
  );
  check(
    !/\bdocker\s+(stop|kill|rm|down|compose|ps)\b/.test(operational),
    "and never issues docker stop, kill, rm, down, compose or ps",
  );

  // Database access is the CLI's supported command, and no connection string is handled.
  const dbCalls = [
    ...operational.matchAll(/(?:execFileSync|spawnSync)\(\s*["']npx["']\s*,\s*\[([^\]]*)\]/g),
  ].map((match) => match[1].replace(/\s+/g, " "));
  check(dbCalls.length > 0, "the script does shell out to the CLI, so this check is not vacuous");
  check(
    dbCalls.some((args) => args.includes('"db"') && args.includes('"query"')),
    "database access goes through `supabase db query`",
  );
  check(
    !/DB_URL|postgresql:\/\/|PGPASSWORD/.test(operational),
    "no database URL or password is constructed, passed or printed",
  );

  check(
    !/\bpkill\b|\bkillall\b/.test(operational),
    "no unrelated process is killed by name",
  );

  // Every signal this script sends is aimed at a child it spawned itself.
  const killTargets = [...operational.matchAll(/process\.kill\(\s*(-?)\s*([A-Za-z0-9_.]+)/g)]
    .map((match) => match[2]);
  check(killTargets.length > 0, "the script does send signals, so this check is not vacuous");
  check(
    killTargets.every((target) => target.endsWith("child.pid")),
    "and every one targets a child process this script spawned",
    killTargets.join(","),
  );
}

/**
 * Re-runs THIS script as a child with a fault injected, optionally interrupting it.
 *
 * Synchronous on purpose: the checks that follow inspect the database and the route, and
 * they must not race the child's cleanup. Output is captured so it can be scanned for key
 * material — and is never echoed.
 */
async function runSelfAsChild(fault, signal = null) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    env: {
      ...CLI_ENV,
      RECEIPT_EXTRACTION_TEST_FAULT: fault,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));

  const exited = new Promise((resolve) =>
    child.once("exit", (code, viaSignal) => resolve({ code, viaSignal })),
  );

  if (signal !== null) {
    // Wait until the child announces it has reached the hang point, so the signal lands while
    // it genuinely holds a running server and an open gate — which is the state whose cleanup
    // is under test.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !output.includes(HANG_MARKER)) await sleep(500);

    // Delivered TWICE, deliberately. An impatient operator presses Ctrl-C again, and a second
    // signal must not tear the process down while the first cleanup is still restoring the
    // gate — a race that really did leave the gate open before the handler was made re-entrant.
    const deliver = () => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    deliver();
    await sleep(300);
    deliver();
  }

  const { code, viaSignal } = await exited;
  // A process killed by a signal reports a null code; that is still a non-zero outcome.
  return { code: code === null ? (viaSignal ? 137 : 1) : code, output };
}

// ============================================================================
// THE SINGLE STRUCTURED EXIT PATH
// ============================================================================
// Every route out of this process — success, assertion failure, thrown error, SIGINT,
// SIGTERM — funnels through the same finally block, so cleanup() always runs before the
// process ends. Nothing calls process.exit before that has happened.
let exitCode = 0;

let signalled = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // A repeat signal is ACKNOWLEDGED AND IGNORED. Letting it through would re-enter this
    // handler and reach process.exit while the first cleanup was still restoring the gate —
    // which is exactly how an interrupted run can leave the gate open.
    if (signalled) {
      process.stderr.write("\nalready cleaning up — please wait\n");
      return;
    }
    signalled = true;
    void (async () => {
      process.stderr.write(`\nreceived ${signal} — cleaning up\n`);
      const ok = await cleanup();
      process.exit(ok ? (signal === "SIGINT" ? 130 : 143) : 3);
    })();
  });
}

try {
  await main();
  process.stdout.write(`\n${passed} checks passed, ${failures.length} failed\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  exitCode = failures.length > 0 ? 1 : 0;
} catch (error) {
  // The message is printed without the stack or any bound value: this script holds a
  // service-role key and a set of access tokens. A HarnessError's own text is a fixed
  // diagnostic written by this file and is safe to show.
  const detail = error instanceof HarnessError ? error.message : (error?.name ?? "Error");
  process.stderr.write(`\nFATAL in "${currentCase}": ${detail}\n`);
  exitCode = 2;
} finally {
  const restored = await cleanup();
  if (!restored && exitCode === 0) exitCode = 3;
}

process.exit(exitCode);
