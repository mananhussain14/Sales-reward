/**
 * SOURCE-LEVEL SAFETY GUARDS for the `send-retailer-staff-invitation` Edge Function.
 *
 * Run with:  npm test
 *
 * The Edge Function cannot be unit-tested from Node — it calls `Deno.serve`, reads
 * `Deno.env`, and imports from `npm:`. What CAN be asserted, and what matters most, are
 * the structural properties a careless later edit would quietly break. Each rule below
 * corresponds to a security claim this milestone makes:
 *
 *   1.  IT DOES NOT RE-IMPLEMENT THE SHARED LOGIC. The request contract, the delivery
 *       ORDER, the token/hash construction, the email content and the CORS policy all
 *       come from lib/, which is where the web and the tests get them too.
 *   2.  THE TWO CLIENTS KEEP THEIR OWN KEYS AND THEIR OWN JOBS. The caller's token goes
 *       only to the caller client; the reservation runs there; the three service-only
 *       RPCs run only under the service client.
 *   3.  THE CLIENT CANNOT NOMINATE ANYTHING PRIVILEGED. No organization / actor /
 *       profile / membership / invitation id, no token, no hash, no audit data.
 *   4.  NOTHING SECRET REACHES A LOG LINE OR A RESPONSE.
 *   5.  NO DIRECT TABLE WRITE OF ANY KIND.
 *   6.  verify_jwt IS ENABLED, and the flag is enforced by the function itself.
 *   7.  NO SERVICE-ROLE KEY OR RESEND KEY CAN REACH BROWSER CODE.
 *   8.  NO OUT-OF-SCOPE WORK (acceptance, memberships, shop reassignment, role/status
 *       changes) was introduced.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the
 * exact shapes that would constitute a regression, naming the line.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** The repository root, derived from this file's own location (lib/staff/). */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FUNCTION_NAME = "send-retailer-staff-invitation";
const FUNCTION_PATH = `supabase/functions/${FUNCTION_NAME}/index.ts`;
const CONFIG_PATH = "supabase/config.toml";

const SOURCE = readFileSync(join(ROOT, FUNCTION_PATH), "utf8");
const CONFIG = readFileSync(join(ROOT, CONFIG_PATH), "utf8");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const CODE = stripComments(SOURCE);

const CODE_LINES = CODE.split("\n")
  .map((text, index) => ({ number: index + 1, text }))
  .filter((line) => line.text.trim().length > 0);

/** Every `from "…"` specifier in the file, in source order. */
const IMPORT_SPECIFIERS = [...SOURCE.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
  (match) => match[1],
);

describe("the Edge Function exists and was found", () => {
  test("1. the entrypoint is present and non-trivial", () => {
    assert.ok(existsSync(join(ROOT, FUNCTION_PATH)), `${FUNCTION_PATH} is missing`);
    assert.ok(CODE_LINES.length >= 100, `only ${CODE_LINES.length} code lines`);
  });

  test("2. it is a Deno request handler, not a Next.js module", () => {
    assert.ok(/Deno\.serve\s*\(/.test(SOURCE), "no Deno.serve entrypoint");
    assert.ok(!/"use server"|"use client"/.test(SOURCE), "carries a Next.js directive");
    assert.ok(
      !IMPORT_SPECIFIERS.some((specifier) => specifier.startsWith("@/")),
      "uses a Next.js path alias, which Deno cannot resolve",
    );
  });

  test("3. it is the ONLY new function this milestone adds", () => {
    const functions = readdirSync(join(ROOT, "supabase/functions"))
      .filter((entry) => statSync(join(ROOT, "supabase/functions", entry)).isDirectory())
      .sort();
    assert.deepEqual(functions, ["send-retailer-staff-invitation", "submit-receipt"]);
  });
});

describe("the shared logic is imported, never restated", () => {
  test("4. the request contract, the flow, the email and the CORS policy come from lib/", () => {
    const REQUIRED: [string, string][] = [
      ["parseStaffInvitationRequest", "lib/staff/staff-invitation-delivery-contract.ts"],
      ["runStaffInviteFlow", "lib/staff/staff-invite-flow.ts"],
      ["sendStaffInvitationEmail", "lib/staff/staff-invitation-email.ts"],
      ["corsJsonResponse", "lib/staff/staff-invitation-cors.ts"],
      ["generateInvitationToken", "lib/invitations/existing-user-token.ts"],
    ];
    for (const [symbol, module] of REQUIRED) {
      assert.ok(new RegExp(`\\b${symbol}\\b`).test(CODE), `does not use ${symbol}`);
      assert.ok(
        IMPORT_SPECIFIERS.some((specifier) => specifier.endsWith(module)),
        `does not import from ${module}`,
      );
    }
  });

  test("5. token generation and hashing are NOT re-implemented", () => {
    // A second definition of "a token" would mean the value stored and the value the
    // intake route hashes could diverge, and acceptance would silently break.
    assert.ok(!/createHash|node:crypto|digest\s*\(/.test(CODE), "hashes here");
    assert.ok(!/randomBytes|crypto\.getRandomValues|Math\.random/.test(CODE), "mints here");
    assert.ok(!/base64url/.test(CODE), "encodes a token here");
  });

  test("6. the request rules are NOT re-implemented", () => {
    // Everything about what a valid request is lives in the contract module. A regex
    // for an email, a uuid, or a role code here would be a second, drifting definition.
    for (const line of CODE_LINES) {
      assert.ok(
        !/\[0-9a-f\]\{8\}|RETAILER_MANAGER|SALES_STAFF|\[\^\\s@\]/.test(line.text),
        `${FUNCTION_PATH}:${line.number} restates a request rule: ${line.text.trim()}`,
      );
    }
  });

  test("7. the delivery ORDER is not restated", () => {
    // This file supplies PORTS only. If it called the RPCs in its own sequence, the web
    // and mobile clients could execute different orders.
    assert.ok(/runStaffInviteFlow\s*\(/.test(CODE), "does not call the shared flow");
    const flowAt = CODE.indexOf("runStaffInviteFlow(");
    // Every RPC call appears inside the ports object, which is declared BEFORE the flow
    // is run; nothing may call an RPC after the sequence has produced its answer.
    assert.ok(CODE.lastIndexOf(".rpc(") < flowAt, "calls an RPC outside the shared flow");
  });

  test("8. the email content is not restated", () => {
    assert.ok(!/api\.resend\.com/.test(CODE), "posts to Resend directly");
    assert.ok(!/<div|<p |subject:/i.test(CODE), "builds message content here");
    assert.ok(!/invitations\/staff\/enter/.test(CODE), "builds the accept URL here");
  });

  test("9. the CORS policy is not restated", () => {
    for (const line of CODE_LINES) {
      assert.ok(
        !/Access-Control-/i.test(line.text),
        `${FUNCTION_PATH}:${line.number} restates a CORS header: ${line.text.trim()}`,
      );
    }
  });
});

describe("the imports resolve the way Deno requires", () => {
  test("10. every local import is relative and carries an explicit .ts extension", () => {
    const local = IMPORT_SPECIFIERS.filter((specifier) => specifier.startsWith("."));
    assert.ok(local.length >= 5, `expected at least five local imports, found ${local.length}`);
    for (const specifier of local) {
      assert.ok(
        specifier.endsWith(".ts"),
        `"${specifier}" has no .ts extension; Deno will not resolve it`,
      );
    }
  });

  test("11. every local import points at a file that exists", () => {
    const functionDir = dirname(join(ROOT, FUNCTION_PATH));
    for (const specifier of IMPORT_SPECIFIERS.filter((s) => s.startsWith("."))) {
      const target = resolve(functionDir, specifier);
      assert.ok(existsSync(target), `"${specifier}" resolves to a missing file: ${target}`);
    }
  });

  test("12. every imported lib module is loadable by BOTH runtimes", () => {
    // Deno serves them and Node tests them, so none may reach for the other's API. The
    // token module is the one exception and is allowed exactly one: `node:crypto`,
    // which Deno 2 supports — the same precedent lib/receipts/receipt-file.ts set.
    const TOKEN_MODULE = "lib/invitations/existing-user-token.ts";
    const functionDir = dirname(join(ROOT, FUNCTION_PATH));

    for (const specifier of IMPORT_SPECIFIERS.filter((s) => s.startsWith("."))) {
      const target = resolve(functionDir, specifier);
      const moduleCode = stripComments(readFileSync(target, "utf8"));
      assert.ok(!/\bDeno\./.test(moduleCode), `${specifier} uses a Deno API`);
      assert.ok(!/\bprocess\./.test(moduleCode), `${specifier} uses a Node process API`);
      assert.ok(!/next\/headers/.test(moduleCode), `${specifier} imports next/headers`);

      const nested = [...moduleCode.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const nestedSpecifier of nested) {
        if (specifier.endsWith(TOKEN_MODULE) && nestedSpecifier === "node:crypto") continue;
        assert.ok(
          nestedSpecifier.startsWith(".") && nestedSpecifier.endsWith(".ts"),
          `${specifier} imports "${nestedSpecifier}", which Deno cannot resolve`,
        );
      }
    }
  });

  test("13. the pinned supabase-js version matches package.json", () => {
    const pinned = /npm:@supabase\/supabase-js@([\d.]+)/.exec(SOURCE)?.[1];
    assert.ok(pinned, "supabase-js is not pinned to an exact version");
    const declared = PACKAGE.dependencies["@supabase/supabase-js"].replace(/^[^\d]*/, "");
    assert.equal(
      pinned,
      declared,
      `Edge Function pins ${pinned} but package.json declares ${declared}`,
    );
  });
});

describe("the two clients keep their own keys and their own jobs", () => {
  test("14. the service-role key is read once and used for exactly one client", () => {
    const reads = [...CODE.matchAll(/SUPABASE_SERVICE_ROLE_KEY/g)];
    assert.equal(reads.length, 1, `service-role key read ${reads.length} times`);

    const clients = [...CODE.matchAll(/createClient\(\s*(\w+)\s*,\s*(\w+)/g)];
    assert.equal(clients.length, 2, `expected two clients, found ${clients.length}`);
    const keysUsed = clients.map((match) => match[2]).sort();
    assert.deepEqual(
      keysUsed,
      ["publishableKey", "serviceRoleKey"],
      `clients are built with ${keysUsed.join(", ")}`,
    );
  });

  test("15. the caller's access token is forwarded ONLY to the caller client", () => {
    // If the token were attached to the service client, that client would still hold
    // service-role authority — but the point of the split is that exactly one client
    // can act as the person and exactly one can act as the system.
    const callerClient =
      /const asCaller[\s\S]*?\n  \}\);/.exec(CODE)?.[0] ??
      /const asCaller[\s\S]*?\}\);/.exec(CODE)?.[0] ??
      "";
    assert.ok(/accessToken/.test(callerClient), "the caller client has no access token");

    const serviceClient = /const asService[\s\S]*?\}\);/.exec(CODE)?.[0] ?? "";
    assert.ok(serviceClient.length > 0, "the service client is gone");
    assert.ok(!/accessToken/.test(serviceClient), "the service client carries the token");
    assert.ok(
      !/Authorization/.test(serviceClient),
      "the service client sets an Authorization header",
    );
  });

  test("16. the RESERVATION runs as the caller; the other three run as the service role", () => {
    assert.ok(
      /asCaller\.rpc\(\s*RESERVE_RPC/.test(CODE),
      "reserve does not run under the caller's own token",
    );
    for (const rpc of ["PREPARE_RPC", "RECORD_SENT_RPC", "RECORD_FAILURE_RPC"]) {
      assert.ok(
        new RegExp(`asService\\.rpc\\(\\s*${rpc}`).test(CODE),
        `${rpc} does not run as the service role`,
      );
      assert.ok(
        !new RegExp(`asCaller\\.rpc\\(\\s*${rpc}`).test(CODE),
        `${rpc} is reachable under the caller's token`,
      );
    }
    assert.ok(
      !/asService\.rpc\(\s*RESERVE_RPC/.test(CODE),
      "the reservation is reachable under the service role, which would bypass auth.uid()",
    );
  });

  test("17. the service client is built only AFTER the reservation is authorized", () => {
    // Not a correctness requirement so much as a shape one: constructing it earlier
    // makes it available to code that has not yet proven who is calling.
    const serviceAt = CODE.indexOf("const asService");
    const authAt = CODE.indexOf("auth.getUser(");
    const parseAt = CODE.indexOf("parseStaffInvitationRequest(");
    assert.ok(serviceAt > authAt, "the service client is built before authentication");
    assert.ok(serviceAt > parseAt, "the service client is built before validation");
  });

  test("18. the token is revalidated with the Auth server, not merely decoded", () => {
    assert.ok(/auth\.getUser\(\s*accessToken\s*\)/.test(CODE), "does not revalidate");
    assert.ok(!/getSession\(\)/.test(CODE), "trusts getSession()");
    assert.ok(!/\bjwtDecode|atob\(|decodeJwt/.test(CODE), "decodes the JWT itself");
  });
});

describe("the client cannot nominate anything privileged", () => {
  test("19. the invitation id reaching the service RPCs comes only from the reservation", () => {
    // The three service RPC calls are keyed by `invitationId`, and the ONLY binding of
    // that name is the port parameter the shared flow supplies from the reservation
    // result. Nothing in this file reads an id from the request.
    for (const match of CODE.matchAll(/p_invitation_id:\s*([A-Za-z_.]+)/g)) {
      assert.equal(
        match[1],
        "invitationId",
        `a service RPC is keyed by "${match[1]}" rather than the reserved id`,
      );
    }
    assert.ok(
      !/parsed\.request\.[A-Za-z]*[Ii]d|body\.[A-Za-z]*[Ii]d|decoded\./.test(CODE),
      "reads an identifier from the request body",
    );
  });

  test("20. no privileged parameter name appears anywhere in the file", () => {
    const FORBIDDEN =
      /\b(retailerOrganizationId|organization_id|organizationId|p_organization_id|p_retailer_organization_id|actorProfileId|actor_profile_id|p_actor|membershipId|membership_id|profileId|profile_id|p_role_id|roleId|permissionCode|p_permission)\b/;
    for (const line of CODE_LINES) {
      assert.ok(
        !FORBIDDEN.test(line.text),
        `${FUNCTION_PATH}:${line.number} names a privileged parameter: ${line.text.trim()}`,
      );
    }
  });

  test("21. the request is validated by the shared parser and by nothing else", () => {
    // A second, looser path into the flow would bypass every rule in the contract.
    const parseAt = CODE.indexOf("parseStaffInvitationRequest(");
    const flowAt = CODE.indexOf("runStaffInviteFlow(");
    assert.ok(parseAt > -1 && flowAt > parseAt, "the flow runs before the parser");
    assert.ok(
      /runStaffInviteFlow\(\s*parsed\.request/.test(CODE),
      "the flow is fed something other than the parsed request",
    );
  });

  test("22. no protected table is read or written directly", () => {
    for (const line of CODE_LINES) {
      assert.ok(
        !/\.from\s*\(\s*["'`]/.test(line.text),
        `${FUNCTION_PATH}:${line.number} direct table access: ${line.text.trim()}`,
      );
      assert.ok(
        !/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(line.text),
        `${FUNCTION_PATH}:${line.number} raw SQL: ${line.text.trim()}`,
      );
    }
    // Named explicitly because they are the two tables an invitation feature would be
    // tempted to touch, and both must stay behind their RPCs.
    for (const table of [
      "retailer_staff_invitations",
      "retailer_shop_members",
      "retailer_invitation_shop_assignments",
      "audit_logs",
    ]) {
      assert.ok(!CODE.includes(table), `references the ${table} table directly`);
    }
  });

  test("23. exactly four RPCs are called, and they are the reused ones", () => {
    const rpcNames = [...CODE.matchAll(/const \w+_RPC = "([a-z_]+)"/g)]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(rpcNames, [
      "prepare_retailer_staff_invitation",
      "record_retailer_staff_invitation_failure",
      "record_retailer_staff_invitation_sent",
      "reserve_retailer_staff_invitation",
    ]);
    // And every `.rpc(` call site uses one of those constants — never a literal.
    for (const line of CODE_LINES) {
      const call = /\.rpc\(\s*([^,)]+)/.exec(line.text);
      if (!call) continue;
      assert.match(
        call[1].trim(),
        /^[A-Z_]+_RPC$/,
        `${FUNCTION_PATH}:${line.number} calls an RPC by literal: ${line.text.trim()}`,
      );
    }
  });
});

describe("nothing secret reaches a log line", () => {
  const consoleLines = CODE_LINES.filter((line) =>
    /console\.(log|error|warn|info|debug)/.test(line.text),
  );

  test("24. logging is funnelled through exactly one helper", () => {
    assert.equal(
      consoleLines.length,
      1,
      `expected one logging chokepoint, found ${consoleLines.length}`,
    );
  });

  test("25. the single log line interpolates only a sanitized category", () => {
    for (const line of consoleLines) {
      const interpolated = [...line.text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
      for (const expression of interpolated) {
        assert.equal(expression, "category", `interpolates "${expression}"`);
      }
      const firstArg = (
        /console\.(?:log|error|warn|info|debug)\s*\(\s*([^)]*)/.exec(line.text)?.[1] ?? ""
      ).trim();
      assert.ok(/^[`"']/.test(firstArg), `logs a non-literal: ${line.text.trim()}`);
    }
  });

  test("26. every log call site passes a fixed literal naming nothing sensitive", () => {
    const FORBIDDEN =
      /\b(rawToken|tokenHash|token|invitationId|email|toEmail|normalizedEmail|firstName|lastName|acceptUrl|error|err|result|response|body|accessToken|serviceRoleKey|publishableKey|apiKey|claims|user)\b/;
    let callSites = 0;

    for (const line of CODE_LINES) {
      if (/function\s+logFailure/.test(line.text)) continue;
      const call = /\blogFailure\s*\(\s*([^)]*)\)/.exec(line.text);
      if (!call) continue;
      callSites += 1;

      const argument = call[1].trim();
      assert.ok(
        /^["'`]/.test(argument),
        `${FUNCTION_PATH}:${line.number} logs a non-literal category`,
      );
      for (const match of argument.matchAll(/\$\{([^}]*)\}/g)) {
        assert.ok(!FORBIDDEN.test(match[1]), `interpolates forbidden material: ${match[1]}`);
      }
    }

    assert.ok(callSites >= 5, `only ${callSites} log call sites — the rule is near-vacuous`);
  });

  test("27. an auth failure is not logged at all", () => {
    // A log line at the authentication branch would record who tried to send, which is
    // the one failure that names a person.
    const authBranch = /if \(userResult === null[\s\S]*?\n  \}/.exec(CODE)?.[0] ?? "";
    assert.ok(authBranch.length > 0, "the authentication branch is gone");
    assert.ok(!/logFailure|console\./.test(authBranch), "the auth failure is logged");
  });
});

describe("nothing secret reaches a response body", () => {
  test("28. every reply is built by the ONE helper, from the shared contract", () => {
    for (const line of CODE_LINES) {
      assert.ok(
        !/new Response\(|Response\.(json|redirect|error)\(/.test(line.text),
        `${FUNCTION_PATH}:${line.number} builds a reply outside the helper`,
      );
    }
    const helper = /function respond\([\s\S]*?\n}/.exec(CODE)?.[0];
    assert.ok(helper, "the respond() helper is gone");
    assert.ok(/corsJsonResponse\(/.test(helper), "respond() bypasses the CORS helper");
    assert.ok(
      /staffInvitationResponse\(/.test(helper),
      "respond() builds a body of its own rather than using the contract",
    );
    assert.ok(
      /STAFF_INVITATION_HTTP_STATUS\[/.test(helper),
      "respond() chooses its own HTTP status rather than the contract's",
    );
  });

  test("29. respond() takes ONLY a code — there is no channel for extra fields", () => {
    // submit-receipt's json() takes an `extra` object; this one deliberately does not,
    // because there is nothing about an invitation that a client may be told.
    const signature = /function respond\(([\s\S]*?)\)\s*:/.exec(CODE)?.[1] ?? "";
    assert.equal(
      signature.replace(/\s+/g, " ").replace(/,\s*$/, "").trim(),
      "code: StaffInvitationCode",
      `respond() signature widened to: ${signature.trim()}`,
    );
    // Every call site is one of exactly two shapes: a literal code, or the code the
    // shared flow returned. Anything else — an object, a second argument, a spread — is
    // a channel for a field the contract does not declare.
    const callSites = CODE_LINES.filter(
      (line) => /\brespond\(/.test(line.text) && !/function respond/.test(line.text),
    );
    assert.ok(callSites.length >= 7, `only ${callSites.length} respond() call sites`);

    for (const line of callSites) {
      const literal = /\brespond\(\s*["'][A-Z_]+["']\s*\)/.test(line.text);
      const fromFlow = /\brespond\(\s*await runStaffInviteFlow\([^)]*\)\s*\)/.test(line.text);
      const fromParser = /\brespond\(\s*parsed\.code\s*\)/.test(line.text);
      assert.ok(
        literal || fromFlow || fromParser,
        `${FUNCTION_PATH}:${line.number} passes something other than a code: ${line.text.trim()}`,
      );
    }
  });

  test("30. every code returned is declared in the shared contract", () => {
    const contract = readFileSync(
      join(ROOT, "lib/staff/staff-invitation-delivery-contract.ts"),
      "utf8",
    );
    const returned = [...CODE.matchAll(/\brespond\(\s*["']([A-Z_]+)["']\s*\)/g)].map(
      (match) => match[1],
    );
    assert.ok(returned.length >= 6, `only ${returned.length} literal codes returned`);
    for (const code of returned) {
      assert.ok(
        new RegExp(`\\|\\s*"${code}"|^  \\| "${code}"`, "m").test(contract) ||
          contract.includes(`  ${code}: `),
        `"${code}" is not declared in the contract module`,
      );
    }
  });

  test("31. no secret material is named near anything that produces a reply", () => {
    const FORBIDDEN =
      /\b(rawToken|tokenHash|accessToken|serviceRoleKey|publishableKey|apiKey|invitationId|normalizedEmail)\b/;
    for (const line of CODE_LINES) {
      if (!/respond\(|corsJsonResponse\(|corsPreflightResponse\(|JSON\.stringify\(/.test(line.text))
        continue;
      assert.ok(
        !FORBIDDEN.test(line.text),
        `${FUNCTION_PATH}:${line.number} puts secret material in a response: ${line.text.trim()}`,
      );
    }
  });

  test("32. the raw token is never bound here, and the hash only as a port argument", () => {
    // `generateInvitationToken()` is returned straight to the shared flow, which hands
    // the raw value only to the email sender. This file never names it.
    assert.ok(!/\brawToken\b/.test(CODE), "the Edge Function handles the raw token itself");

    // The hash IS named — it is what keys the three service RPCs — but every mention
    // must be either a destructured port parameter or the value of an RPC argument.
    // Anything else (a log line, a response field, a variable it is copied into) would
    // be the hash escaping the sequence.
    const hashLines = CODE_LINES.filter((line) => /\btokenHash\b/.test(line.text));
    assert.ok(hashLines.length >= 6, `only ${hashLines.length} tokenHash mentions`);
    for (const line of hashLines) {
      const isPortParameter = /\(\{\s*invitationId,\s*tokenHash\s*\}/.test(line.text);
      const isRpcArgument = /^\s*p_(expected_)?token_hash:\s*tokenHash,\s*$/.test(line.text);
      assert.ok(
        isPortParameter || isRpcArgument,
        `${FUNCTION_PATH}:${line.number} handles the token hash outside a port: ${line.text.trim()}`,
      );
    }
  });

  test("33. an unexpected throw is answered, not left to the runtime", () => {
    const wrapper = /Deno\.serve\(([\s\S]*)\)\s*;?\s*$/.exec(CODE)?.[1];
    assert.ok(wrapper, "no Deno.serve entrypoint");
    assert.ok(/\btry\s*\{/.test(wrapper), "the entrypoint does not catch anything");
    assert.ok(
      /\bcatch\b[\s\S]*?respond\(\s*["']INTERNAL_ERROR["']\s*\)/.test(wrapper),
      "an unexpected throw does not return a CORS-carrying INTERNAL_ERROR",
    );
    assert.ok(
      !/\bcatch\s*\([^)]+\)/.test(wrapper),
      "the entrypoint binds the caught error, which can carry provider text",
    );
  });
});

describe("the method and preflight handling", () => {
  test("34. OPTIONS is answered by the shared preflight, BEFORE authentication", () => {
    const optionsAt = CODE.search(/request\.method\s*===\s*["']OPTIONS["']/);
    assert.ok(optionsAt > -1, "the OPTIONS method is not handled at all");

    const preflightAt = CODE.indexOf("corsPreflightResponse()");
    assert.ok(preflightAt > optionsAt, "OPTIONS is not answered by corsPreflightResponse()");

    const authAt = CODE.indexOf(`headers.get("Authorization")`);
    assert.ok(authAt > -1, "the authentication step disappeared");
    assert.ok(preflightAt < authAt, "the preflight is answered after authentication");
  });

  test("35. anything that is not POST or OPTIONS is METHOD_NOT_ALLOWED", () => {
    assert.ok(
      /request\.method\s*!==\s*["']POST["'][\s\S]{0,80}?respond\(\s*["']METHOD_NOT_ALLOWED["']/.test(
        CODE,
      ),
      "a non-POST is not refused with METHOD_NOT_ALLOWED",
    );
  });

  test("36. the preflight does not weaken authentication", () => {
    // It is answered before the token is read, but it returns 204 with no body and no
    // path into the flow — asserted by the fact that the only statement in the branch
    // is the preflight response.
    const branch =
      /if \(request\.method === "OPTIONS"\) \{([\s\S]*?)\}/.exec(CODE)?.[1] ?? "";
    assert.equal(branch.trim(), "return corsPreflightResponse();");
  });
});

describe("configuration, secrets, and the feature flag", () => {
  test("37. every required secret is read from Deno.env, by name, exactly once", () => {
    const REQUIRED = [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "RESEND_API_KEY",
      "RESEND_FROM",
      "APP_ORIGIN",
      "RETAILER_STAFF_INVITATIONS_ENABLED",
    ];
    for (const name of REQUIRED) {
      const reads = [...CODE.matchAll(new RegExp(`Deno\\.env\\.get\\("${name}"\\)`, "g"))];
      assert.equal(reads.length, 1, `${name} is read ${reads.length} times`);
    }
    // The publishable key has two accepted spellings (new and legacy scheme).
    assert.ok(/SUPABASE_PUBLISHABLE_KEY/.test(CODE) && /SUPABASE_ANON_KEY/.test(CODE));
  });

  test("38. no secret VALUE is ever logged, returned, or interpolated into a string", () => {
    for (const line of CODE_LINES) {
      if (!/\$\{/.test(line.text)) continue;
      for (const match of line.text.matchAll(/\$\{([^}]*)\}/g)) {
        assert.ok(
          !/serviceRoleKey|apiKey|RESEND|SERVICE_ROLE/.test(match[1]),
          `${FUNCTION_PATH}:${line.number} interpolates a secret: ${line.text.trim()}`,
        );
      }
    }
    // The one templated secret-adjacent value is the caller's own bearer token, in the
    // Authorization header of the caller client. That is its purpose.
    const templated = [...CODE.matchAll(/`([^`]*\$\{[^}]*\}[^`]*)`/g)].map((m) => m[1]);
    for (const template of templated) {
      if (template.startsWith("Bearer ")) continue;
      assert.ok(
        !/accessToken/.test(template),
        `the access token is interpolated into: ${template}`,
      );
    }
  });

  test("39. the function enforces the feature flag ITSELF", () => {
    assert.ok(
      /isStaffInvitationSendingEnabled\(\s*Deno\.env\.get\("RETAILER_STAFF_INVITATIONS_ENABLED"\)\s*\)/.test(
        CODE.replace(/\s+/g, " ").replace(/ \(/g, "("),
      ) ||
        /isStaffInvitationSendingEnabled\([\s\S]{0,80}RETAILER_STAFF_INVITATIONS_ENABLED/.test(
          CODE,
        ),
      "the flag is not read and compared by the shared helper",
    );
    assert.ok(
      /respond\(\s*["']FEATURE_DISABLED["']\s*\)/.test(CODE),
      "a disabled deployment does not return FEATURE_DISABLED",
    );
  });

  test("40. the flag is checked BEFORE anything is reserved", () => {
    const flagAt = CODE.indexOf("FEATURE_DISABLED");
    const flowAt = CODE.indexOf("runStaffInviteFlow(");
    const parseAt = CODE.indexOf("parseStaffInvitationRequest(");
    assert.ok(flagAt < parseAt, "the flag is checked after the body is parsed");
    assert.ok(flagAt < flowAt, "the flag is checked after the sequence has run");
  });

  test("41. a configuration gap is refused before the flow, as NOT_CONFIGURED", () => {
    const notConfiguredAt = CODE.lastIndexOf("NOT_CONFIGURED");
    const flowAt = CODE.indexOf("runStaffInviteFlow(");
    assert.ok(notConfiguredAt > -1 && notConfiguredAt < flowAt);
    assert.ok(
      /validateStaffInvitationEmailConfig\(/.test(CODE),
      "the Resend configuration is not validated at request time",
    );
  });
});

describe("the deployment declares JWT verification", () => {
  test("42. supabase/config.toml enables the function with verify_jwt = true", () => {
    const block = new RegExp(`\\[functions\\.${FUNCTION_NAME}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(
      CONFIG,
    )?.[1];
    assert.ok(block, `no [functions.${FUNCTION_NAME}] section in supabase/config.toml`);
    assert.ok(/^\s*enabled\s*=\s*true\s*$/m.test(block), "the function is not enabled");
    assert.ok(
      /^\s*verify_jwt\s*=\s*true\s*$/m.test(block),
      "verify_jwt is not true — the gateway would admit unauthenticated requests",
    );
    assert.ok(
      new RegExp(`entrypoint\\s*=\\s*["']\\./functions/${FUNCTION_NAME}/index\\.ts["']`).test(
        block,
      ),
      "the entrypoint does not point at the function",
    );
  });

  test("43. no secret VALUE appears in the committed config", () => {
    // Secret names may be documented; values may never be committed.
    assert.ok(!/re_[A-Za-z0-9]{10,}/.test(CONFIG), "a Resend key is committed");
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(CONFIG), "a JWT-shaped key is committed");
  });
});

describe("no secret can reach browser code", () => {
  test("44. no browser-exposed variable name is introduced anywhere", () => {
    assert.ok(!/NEXT_PUBLIC_/.test(CODE), "the Edge Function names a NEXT_PUBLIC_ variable");
  });

  test("45. no client component or client-reachable module names a server secret", () => {
    // The Edge Function holds the service-role key and the Resend key; nothing that can
    // be bundled for a browser may mention either.
    const roots = ["app", "components", "lib"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const rel = join(dir, entry);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(rel);
      }
    };
    for (const root of roots) walk(root);
    assert.ok(files.length >= 50, `only scanned ${files.length} files`);

    for (const path of files) {
      const source = stripComments(readFileSync(join(ROOT, path), "utf8"));
      if (!/^\s*["']use client["']/m.test(source)) continue;
      for (const secret of [
        "SUPABASE_SERVICE_ROLE_KEY",
        "RESEND_API_KEY",
        "RESEND_FROM",
        "APP_ORIGIN",
        "RETAILER_STAFF_INVITATIONS_ENABLED",
      ]) {
        assert.ok(!source.includes(secret), `${path} names ${secret} in browser code`);
      }
    }
  });
});

describe("no out-of-scope work was introduced", () => {
  test("46. no acceptance, membership, shop-assignment, or status/role change", () => {
    // This milestone delivers invitations. It does not accept them, does not create a
    // membership, and does not add, remove or reassign a shop after acceptance.
    const FORBIDDEN =
      /\b(accept_retailer_staff_invitation|get_retailer_staff_invitation_for_recipient|revoke_retailer_staff_invitation|get_retailer_staff_registration_context|add_retailer_shop_member|remove_retailer_shop_member|reassign|deactivate_retailer_staff|change_retailer_staff_role|deepLink|deep_link)\b/i;
    for (const line of CODE_LINES) {
      assert.ok(
        !FORBIDDEN.test(line.text),
        `${FUNCTION_PATH}:${line.number} out-of-scope work: ${line.text.trim()}`,
      );
    }
  });

  test("47. no receipt, product, campaign, coin or payout vocabulary appears", () => {
    const FORBIDDEN =
      /\b(receipt|ocr|product|sku|incentive|campaign|reward|payout|coinBalance|claim)\b/i;
    for (const line of CODE_LINES) {
      assert.ok(
        !FORBIDDEN.test(line.text),
        `${FUNCTION_PATH}:${line.number} out-of-scope vocabulary: ${line.text.trim()}`,
      );
    }
  });

  test("48. no migration was added by this milestone", () => {
    // The contract is satisfied by the RPCs that already exist. A migration here would
    // mean the reused contract was not, in fact, sufficient.
    const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((name) =>
      /invitation_delivery|staff_invitation_send|shared_delivery/i.test(name),
    );
    assert.deepEqual(
      migrations,
      ["20260724090000_retailer_staff_invitation_delivery_operations.sql"],
      "an unexpected invitation-delivery migration is present",
    );
  });

  test("49. no rate limiter is claimed anywhere", () => {
    assert.ok(!/RATE_LIMITED|rateLimit|rate_limit/i.test(CODE), "claims rate limiting");
  });
});
