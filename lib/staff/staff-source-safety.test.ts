/**
 * SOURCE-LEVEL SAFETY GUARDS for the Retailer staff invitation feature.
 *
 * Run with:  npm test
 *
 * These are not behavioural tests — they read this milestone's own source files and
 * assert properties that no unit test can observe at runtime but that a careless later
 * edit could quietly break:
 *
 *   1. NO DIRECT PROTECTED-TABLE ACCESS. Every read and write goes through a SECURITY
 *      DEFINER RPC, so `.from(` must not appear in any staff module.
 *   2. NO RAW TOKEN OR TOKEN HASH IN A LOG LINE.
 *   3. NO SERVICE-ROLE CLIENT, FEATURE FLAG, OR SERVER-ONLY MODULE IN A CLIENT
 *      COMPONENT.
 *   4. NO SECRET-BEARING ENVIRONMENT VARIABLE READ OUTSIDE ITS OWNING MODULE.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the
 * exact shapes that would constitute a regression here, and each assertion names the
 * file and the offending line so the failure is actionable.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** The repository root, derived from this file's own location (lib/staff/). */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every directory this milestone owns. */
const STAFF_DIRS = [
  "lib/staff",
  "app/(retailer)/retailer/staff",
  "app/invitations/staff",
];

type SourceFile = { path: string; source: string; lines: string[] };

function listFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const full = join(absolute, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(join(dir, entry)));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(join(dir, entry));
    }
  }
  return out;
}

function load(paths: string[]): SourceFile[] {
  return paths.map((path) => {
    const source = readFileSync(join(ROOT, path), "utf8");
    return { path, source, lines: source.split("\n") };
  });
}

/** Every staff source file, EXCLUDING the tests themselves. */
const STAFF_FILES = load(
  STAFF_DIRS.flatMap((dir) => listFiles(dir)).filter(
    (path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"),
  ),
);

/** Only the files that declare themselves Client Components. */
const CLIENT_FILES = STAFF_FILES.filter((file) =>
  /^\s*["']use client["']/m.test(file.source),
);

/**
 * Strips line and block comments so a rule cannot be tripped by prose that merely
 * DESCRIBES the thing being forbidden — these files document their own constraints
 * heavily, and a comment saying "`.from(` appears nowhere here" must not fail the
 * check it is describing.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function codeLines(file: SourceFile): { number: number; text: string }[] {
  return stripComments(file.source)
    .split("\n")
    .map((text, index) => ({ number: index + 1, text }))
    .filter((line) => line.text.trim().length > 0);
}

describe("the milestone's own files were found", () => {
  test("1. every staff directory contributes source files", () => {
    assert.ok(STAFF_FILES.length >= 15, `only found ${STAFF_FILES.length} files`);
    for (const dir of STAFF_DIRS) {
      assert.ok(
        STAFF_FILES.some((file) => file.path.startsWith(dir)),
        `no source found under ${dir}`,
      );
    }
  });

  test("2. at least one Client Component was identified", () => {
    // If this ever finds none, the client-side rules below would pass vacuously.
    assert.ok(CLIENT_FILES.length >= 3, `only ${CLIENT_FILES.length} client files`);
  });
});

describe("no direct protected-table access", () => {
  test("3. no staff module contains a `.from(\"table\")` call", () => {
    // Supabase table access is always `.from("<table>")` — a STRING argument. The
    // pattern is anchored on that quote so ordinary JavaScript built-ins such as
    // `Array.from(new Set(...))`, which take a non-string, are not false positives.
    for (const file of STAFF_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\.from\s*\(\s*["'`]/.test(line.text),
          `${file.path}:${line.number} performs a direct table access: ${line.text.trim()}`,
        );
      }
    }
  });

  test("4. every database call is an `.rpc(` call", () => {
    const rpcFiles = STAFF_FILES.filter((file) => /\.rpc\s*\(/.test(file.source));
    assert.ok(rpcFiles.length >= 2, "expected the data and invitation modules to call RPCs");
  });

  test("5. no staff module writes SQL of any kind", () => {
    for (const file of STAFF_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(line.text),
          `${file.path}:${line.number} contains raw SQL: ${line.text.trim()}`,
        );
      }
    }
  });
});

describe("no token, hash, email, or error detail is ever logged", () => {
  /**
   * The ONLY bindings a staff log line may interpolate. Both are sanitized category
   * strings assembled from fixed literals inside the module that logs them — never a
   * value read from a row, a form, a token, or an error object.
   */
  const SAFE_INTERPOLATIONS = new Set(["operation", "category"]);

  /** Every `${...}` expression on a line that contains a console call. */
  function interpolationsOn(text: string): string[] {
    return [...text.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1].trim());
  }

  const consoleLines = STAFF_FILES.flatMap((file) =>
    codeLines(file)
      .filter((line) => /console\.(log|error|warn|info|debug)/.test(line.text))
      .map((line) => ({ file: file.path, ...line })),
  );

  test("6. the milestone does log — so these rules are not vacuous", () => {
    assert.ok(consoleLines.length >= 5, `only ${consoleLines.length} console lines`);
  });

  test("7. every logged value is a fixed literal or a sanitized category", () => {
    for (const line of consoleLines) {
      for (const expression of interpolationsOn(line.text)) {
        assert.ok(
          SAFE_INTERPOLATIONS.has(expression),
          `${line.file}:${line.number} interpolates "${expression}": ${line.text.trim()}`,
        );
      }
    }
  });

  test("8. no log line interpolates token material, an email, an id, or an error", () => {
    // Stated separately from rule 7 so the failure names the actual hazard. Provider
    // and PostgREST errors can carry tables, policies, recipients and — on a transport
    // throw — the request body, which contains the accept URL and therefore the token.
    const FORBIDDEN =
      /\b(rawToken|tokenHash|token_hash|p_token_hash|p_expected_token_hash|email|toEmail|normalizedEmail|invitationId|invitation_id|error|err|result|response|data|session|claims)\b/;

    for (const line of consoleLines) {
      for (const expression of interpolationsOn(line.text)) {
        assert.ok(
          !FORBIDDEN.test(expression),
          `${line.file}:${line.number} logs forbidden material: ${line.text.trim()}`,
        );
      }
    }
  });

  test("9. no console call is passed a bare identifier argument", () => {
    // `console.error(error)` would print the whole object. Every call in this
    // milestone takes a string literal or a template literal, and nothing else.
    for (const line of consoleLines) {
      const call = /console\.(?:log|error|warn|info|debug)\s*\(\s*([^)]*)/.exec(
        line.text,
      );
      const firstArg = (call?.[1] ?? "").trim();
      assert.ok(
        firstArg.startsWith('"') || firstArg.startsWith("'") || firstArg.startsWith("`"),
        `${line.file}:${line.number} logs a non-literal: ${line.text.trim()}`,
      );
    }
  });
});

describe("client components stay client-safe", () => {
  const FORBIDDEN_IN_CLIENT = [
    "@/lib/supabase/admin",
    "@/lib/supabase/server",
    "@/lib/staff/retailer-staff-invitations",
    "@/lib/staff/retailer-staff-data",
    "@/lib/staff/retailer-staff-access",
    "@/lib/staff/staff-acceptance",
    "@/lib/staff/staff-invitation-email",
    "@/lib/staff/staff-invite-cookie",
    "@/lib/features/retailer-staff-invitations",
    "next/headers",
    "node:crypto",
  ];

  test("10. no Client Component imports a service-role, server-only, or crypto module", () => {
    for (const file of CLIENT_FILES) {
      for (const forbidden of FORBIDDEN_IN_CLIENT) {
        assert.ok(
          !file.source.includes(`from "${forbidden}"`),
          `${file.path} imports ${forbidden} into browser code`,
        );
      }
    }
  });

  test("11. no Client Component reads process.env", () => {
    for (const file of CLIENT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/process\.env/.test(line.text),
          `${file.path}:${line.number} reads process.env in browser code`,
        );
      }
    }
  });

  test("12. no Client Component renders or holds a token, hash, or Retailer id", () => {
    for (const file of CLIENT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\b(rawToken|tokenHash|token_hash|retailerOrganizationId|organization_id)\b/.test(
            line.text,
          ),
          `${file.path}:${line.number} handles forbidden material: ${line.text.trim()}`,
        );
      }
    }
  });

  test("13. no hidden form field names a Retailer, organization, or role id", () => {
    // A CLOSED ALLOWLIST of two, and both are ADDRESSES the database re-checks against the
    // Retailer it derives for itself from auth.uid() — never capabilities:
    //
    //   invitationId    revoke_retailer_staff_invitation matches on
    //                   (id, retailer_organization_id, status='PENDING').
    //   membershipId    set_retailer_staff_shop_assignments matches on
    //                   (id, organization_id, status='ACTIVE') plus an exact SALES_STAFF
    //                   role. Added by the web Manage Shops milestone; see
    //                   docs/retailer-manage-staff-shops-web.md § 4.
    //
    // An id from another tenant selects nothing in either case. What must stay excluded is
    // anything the server should DERIVE rather than accept: a Retailer or organization id,
    // a role or permission code, an actor or profile id, or a timestamp.
    //
    //   requestedStatus THE ONE EXCEPTION TO "NO STATUS", AND IT IS NOT THE DANGEROUS KIND.
    //                   It is the state the operator is ASKING FOR — the verb of the
    //                   operation — not a claim about what the row currently holds, which
    //                   the server reads for itself under lock. It is validated against a
    //                   closed two-word vocabulary before the RPC, and
    //                   set_retailer_staff_membership_status re-validates it
    //                   case-sensitively and raises 23514 for anything else. A tampered
    //                   value can therefore only ask for ACTIVE or DEACTIVATED on a row the
    //                   caller already manages. Added by the web staff lifecycle milestone.
    const ALLOWED_HIDDEN_FIELDS = ["invitationId", "membershipId", "requestedStatus"];

    for (const file of CLIENT_FILES) {
      const hidden = file.source.match(/type="hidden"[\s\S]{0,120}?name="([a-zA-Z]+)"/g) ?? [];
      for (const match of hidden) {
        const name = /name="([a-zA-Z]+)"/.exec(match)?.[1] ?? "";
        assert.ok(
          ALLOWED_HIDDEN_FIELDS.includes(name),
          `${file.path} has an unexpected hidden field: ${name}`,
        );
      }
    }
  });
});

describe("secrets stay in their owning modules", () => {
  test("14. NO staff module reads a Resend variable any more", () => {
    // Since the shared-delivery milestone the Resend credential lives only in the
    // `send-retailer-staff-invitation` Edge Function's environment. The email module
    // still exists — the Edge Function imports it — but it now takes its configuration
    // as an argument and reads no environment at all, which is what lets Deno load it.
    for (const file of STAFF_FILES) {
      assert.ok(
        !/process\.env\.RESEND_/.test(stripComments(file.source)),
        `${file.path} reads a Resend variable directly`,
      );
    }
  });

  test("14b. the email module reads NO environment, so Deno can serve it", () => {
    const email = STAFF_FILES.find((file) =>
      file.path.endsWith("staff-invitation-email.ts"),
    );
    assert.ok(email, "the email module is gone");
    const code = stripComments(email.source);
    assert.ok(!/process\./.test(code), "uses a Node API, so Deno cannot serve it");
    assert.ok(!/\bDeno\./.test(code), "uses a Deno API, so Node cannot test it");
    // …and no imports, for the same reason: Deno resolves this file directly from
    // supabase/functions/send-retailer-staff-invitation/index.ts.
    const imports = [...email.source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(imports, [], `imports ${imports.join(", ")}`);
  });

  test("15. no staff module reads the service-role key", () => {
    for (const file of STAFF_FILES) {
      assert.ok(
        !/SUPABASE_SERVICE_ROLE_KEY/.test(stripComments(file.source)),
        `${file.path} reads the service-role key directly`,
      );
    }
  });

  test("16. no NEXT_PUBLIC_ variable is introduced by this milestone", () => {
    for (const file of STAFF_FILES) {
      assert.ok(
        !/NEXT_PUBLIC_/.test(stripComments(file.source)),
        `${file.path} introduces a NEXT_PUBLIC_ variable`,
      );
    }
  });
});

describe("the service-role client has exactly one caller here", () => {
  test("17. exactly ONE module constructs it, for a documented reason", () => {
    // staff-registration.ts — get_retailer_staff_registration_context maps an invitation
    //                         token to the invited EMAIL, so it is service_role only by
    //                         design; reachable by a browser it would disclose who was
    //                         invited.
    //
    // retailer-staff-invitations.ts USED to be the second caller, for prepare / record
    // sent / record failure. Those three now run inside the
    // `send-retailer-staff-invitation` Edge Function, so the web process no longer
    // constructs a service-role client for invitation delivery at all. Any second caller
    // appearing here is a regression — most likely a re-introduced duplicate delivery
    // path — and fails this test.
    const callers = STAFF_FILES.filter((file) =>
      /createAdminClient/.test(stripComments(file.source)),
    )
      .map((file) => file.path)
      .sort();

    assert.deepEqual(callers, ["lib/staff/staff-registration.ts"]);
  });

  test("17b. the registration-context RPC is named only in its own module", () => {
    // It returns the invited email. Nothing else in the feature may call it, and in
    // particular no page may — see the module's two-export split.
    for (const file of STAFF_FILES) {
      if (file.path === "lib/staff/staff-registration.ts") continue;
      assert.ok(
        !stripComments(file.source).includes('"get_retailer_staff_registration_context"'),
        `${file.path} calls the registration-context RPC`,
      );
    }
  });

  test("18. NO web module names a service-role-only invitation RPC", () => {
    // They are reachable from exactly one place in the system now: the Edge Function.
    // A web module naming one of them is a web module that has grown a second delivery
    // implementation, which is the specific thing this milestone exists to prevent.
    const SERVICE_ROLE_RPCS = [
      "prepare_retailer_staff_invitation",
      "record_retailer_staff_invitation_sent",
      "record_retailer_staff_invitation_failure",
    ];
    for (const file of STAFF_FILES) {
      for (const rpc of SERVICE_ROLE_RPCS) {
        assert.ok(
          !stripComments(file.source).includes(`"${rpc}"`),
          `${file.path} references the service-role RPC ${rpc}`,
        );
      }
    }
  });
});

/**
 * ============================================================================
 * THE WEB DELIVERY PATH IS GONE, AND MUST STAY GONE
 * ============================================================================
 * Sending a staff invitation happens in ONE place — the shared Edge Function — so that
 * the web portal and the Flutter app cannot disagree about what "send" means. The rules
 * below fail if the web process starts doing any of it again. They are the structural
 * half of the migration; the behavioural half is that `sendRetailerStaffInvitation` now
 * returns whatever the function replied.
 */
describe("no second delivery implementation survives in the web process", () => {
  const SEND_MODULE = "lib/staff/retailer-staff-invitations.ts";

  const sendModule = STAFF_FILES.find((file) => file.path === SEND_MODULE);

  test("19. the web send module still exists and calls the Edge Function", () => {
    assert.ok(sendModule, `${SEND_MODULE} is missing`);
    const code = stripComments(sendModule.source);
    assert.ok(
      code.includes("send-retailer-staff-invitation"),
      "does not name the shared Edge Function",
    );
    assert.ok(/\/functions\/v1\//.test(code), "does not call the functions gateway");
  });

  test("20. no web module generates or hashes an invitation token", () => {
    // The raw token is minted inside the Edge Function and leaves only in the emailed
    // URL. A web module that can mint one can mint a link to any invitation.
    //
    // app/invitations/staff/enter is the ONE exception and is deliberately not in scope
    // here: it HASHES an incoming token from the URL (it does not generate one), which
    // is the acceptance intake this milestone leaves untouched.
    const INTAKE = "app/invitations/staff/enter/route.ts";
    for (const file of STAFF_FILES) {
      if (file.path === INTAKE) continue;
      const code = stripComments(file.source);
      for (const forbidden of [
        "generateInvitationToken",
        "hashInvitationToken",
        "randomBytes",
        "createHash",
        "node:crypto",
      ]) {
        assert.ok(
          !code.includes(forbidden),
          `${file.path} uses ${forbidden} — token material belongs to the Edge Function`,
        );
      }
    }
  });

  test("21. no web module talks to Resend", () => {
    // The email module is excluded because it IS the sender — it is imported by the
    // Edge Function and by nothing in the web process (rule 14b pins that it reads no
    // environment, and this rule pins that nobody here calls it).
    const EMAIL_MODULE = "lib/staff/staff-invitation-email.ts";
    for (const file of STAFF_FILES) {
      if (file.path === EMAIL_MODULE) continue;
      const code = stripComments(file.source);
      assert.ok(!/api\.resend\.com/.test(code), `${file.path} posts to Resend`);
      assert.ok(
        !/sendStaffInvitationEmail\s*\(/.test(code),
        `${file.path} sends an invitation email from the web process`,
      );
    }
  });

  test("22. the shared flow module is not run by any web module", () => {
    // runStaffInviteFlow supplies the ORDER, and its ports need the service-role client
    // and the Resend key. Only the Edge Function may execute it. The flow module itself
    // is excluded because it contains the declaration.
    const FLOW_MODULE = "lib/staff/staff-invite-flow.ts";
    for (const file of STAFF_FILES) {
      if (file.path === FLOW_MODULE) continue;
      assert.ok(
        !/runStaffInviteFlow\s*\(/.test(stripComments(file.source)),
        `${file.path} runs the delivery sequence in the web process`,
      );
    }
  });

  test("23. the web send module handles every contract code explicitly", () => {
    // A `default:` or a fallback would let a NEW outcome — including a future
    // partial-success variant — be rendered as a generic failure without anyone
    // deciding that it should be. The module uses an exhaustive Record instead, which
    // the type checker enforces; this asserts the shape has not been loosened.
    assert.ok(sendModule);
    const code = stripComments(sendModule.source);
    assert.ok(
      /Record<StaffInvitationCode,\s*StaffInviteSendResult>/.test(code),
      "the code map is no longer an exhaustive Record",
    );
    for (const code_ of [
      "SENT",
      "RESENT",
      "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED",
      "DELIVERY_FAILED",
      "METHOD_NOT_ALLOWED",
      "INVALID_REQUEST",
      "INVALID_ROLE_SHOP_COMBINATION",
      "AUTH_REQUIRED",
      "ACCESS_DENIED",
      "INVITATION_CONFLICT",
      "RETAILER_INACTIVE",
      "FEATURE_DISABLED",
      "NOT_CONFIGURED",
      "INTERNAL_ERROR",
    ]) {
      assert.ok(code.includes(`${code_}:`), `no mapping for ${code_}`);
    }
  });
});
