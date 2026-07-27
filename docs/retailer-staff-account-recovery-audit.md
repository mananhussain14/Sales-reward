# Secure Retailer Staff Account Recovery — Audit

**Milestone:** repair the staff registration-context defect and add secure password recovery
**Branch:** `fix/retailer-staff-account-recovery`
**Base commit:** `38a05dc` (`origin/main`)
**Scope:** backend / web repository only. **No Flutter file is touched.**
**Relationship to PR #39:** none. That branch is untouched and unmerged; see § L.

---

## 0. Conclusion, stated first

**Root cause: the registration context classified the invited address with a presence
test.** `public.get_retailer_staff_registration_context` (migration `20260728090000`)
returned

```sql
exists (select 1 from auth.users u where lower(btrim(u.email)) = v_inv.email)
  as has_auth_account
```

and the application rendered "Sign in" whenever that was true. It read no confirmation
state, no password state, no ban or delete state, and no identity. **Any** `auth.users`
row counted as an account.

An address invited earlier through the Retailer Owner NEW_USER flow
(`auth.admin.inviteUserByEmail`) has a row that is **unconfirmed and carries no
password** until that invitation is completed. Invite it as staff and the person is
offered a sign-in they cannot perform, while the activation form that would let them set
a password is never shown. There is no supported way out of that screen — which is
exactly what hosted verification hit.

**The obvious fix is unsafe, and this milestone does not use it.**
`public.finalize_retailer_owner_invitation` (migration `20260720092755`, lines ~1187–1250)
creates a `profiles` row, an `INVITED` `organization_members` row and a `RETAILER_OWNER`
`member_roles` assignment **against that same unconfirmed, password-less auth user**. A
stranded row is therefore not an empty shell; in the owner case it is a pre-provisioned
Retailer Owner identity waiting to be claimed. Letting a **staff** invitation token set
its first password would let whoever holds that token claim that identity and then accept
the still-live owner invitation — converting the token from a *discovery pointer* (inert
on its own, because acceptance separately requires a confirmed session whose email
matches) into an *account credential*.

So the classification now distinguishes **five** states, and the dangerous middle case
gets an emailed password-recovery link instead. Recovery proves **current** control of the
invited mailbox; a possibly-old, possibly-forwarded invitation token does not.

| | |
|---|---|
| Migration | **one** — `20260808090000_repair_retailer_staff_registration_context.sql` |
| Functions repaired | 1 (`get_retailer_staff_registration_context`) |
| Functions added | 2 (`resolve_retailer_staff_invitation_recipient`, `retailer_staff_invitation_gate`) |
| Other RPCs changed | **none** — acceptance, reserve/prepare/record and the owner functions are untouched |
| New invitation table or lifecycle RPC | **none** |
| Flutter files changed | **none** |

---

## 1. Files changed

### Added

| Path | What it is |
|---|---|
| `supabase/migrations/20260808090000_repair_retailer_staff_registration_context.sql` | the repair |
| `supabase/templates/recovery.html` | server-verifiable recovery email |
| `lib/staff/staff-account-state.ts` | the five-state vocabulary and the state → screen map (pure) |
| `app/invitations/staff/recover/route.ts` | the recovery landing (verifies the token) |
| `app/invitations/staff/set-password/page.tsx` | the set-new-password step |
| `app/invitations/staff/set-password/actions.ts` | the password update |
| `app/invitations/staff/set-password/set-password-form.tsx` | its form |
| `app/invitations/staff/set-password/set-password-state.ts` | its state type |
| `supabase/tests/database/retailer_staff_registration_context_test.sql` | 37 pgTAP assertions |
| `lib/staff/staff-account-state.test.ts` | 20 tests |
| `lib/staff/staff-account-recovery-safety.test.ts` | 36 source-level rules |
| `docs/retailer-staff-account-recovery-audit.md` | this document |

### Modified

| Path | Change |
|---|---|
| `lib/staff/staff-registration.ts` | consumes the five states; branches activation; adds the recovery request |
| `app/invitations/staff/page.tsx` | two new screens (`recover`, `blocked`) |
| `app/invitations/staff/accept-forms.tsx` | the recovery request form |
| `app/invitations/staff/accept-state.ts` | recovery state + the one confirmation string |
| `app/invitations/staff/actions.ts` | the recovery-request action; activation refuses the recovery state |
| `lib/supabase/proxy-routing.ts` | `/invitations/staff/recover` added to the public allowlist |
| `supabase/config.toml` | recovery template + two redirect allow-list entries |
| `lib/auth/unified-login-activation.test.ts` | rule 14 follows the renamed binding |
| `lib/products/vendor-product-assignment-writes-contract.test.ts` | its migration tripwire fired correctly; re-pointed and strengthened |

---

## 2. The account-state model

| State | Condition | Action |
|---|---|---|
| `NO_ACCOUNT` | no `auth.users` row for the invited address | create the account; first-password activation |
| `ACTIVATION_REQUIRED` | a row exists, **unconfirmed**, **no password**, and **no** profile / membership / role assignment | complete the empty shell; first-password activation |
| `SIGN_IN` | confirmed, password-capable, not banned or deleted | ordinary sign-in |
| `RECOVERY_REQUIRED` | cannot sign in, but carries a password **or** a confirmed address **or** a provisioned identity | emailed password-reset link — **never** a password set from the invitation token |
| `ACCOUNT_BLOCKED` | banned, soft-deleted, anonymous, or **ambiguous** (more than one row for the address) | neutral support message, no reason disclosed |

### The fail-safe direction, and one case the tests corrected

Uncertainty resolves toward `SIGN_IN` or `ACCOUNT_BLOCKED`, never toward
`ACTIVATION_REQUIRED`. Misclassifying a usable or provisioned identity as "safe
first-time activation" is an account takeover; misclassifying a shell as "sign in" is only
the inconvenience this milestone exists to fix.

**The pgTAP suite caught a real defect in the first draft of the SQL.** A *confirmed*
address with no password and nothing provisioned was being classified
`ACTIVATION_REQUIRED` — it meets the literal definition of an empty shell. But
confirmation means somebody proved control of that mailbox at some point, and a confirmed
password-less row is the shape a magic-link or OAuth identity has. Neither is used by this
application today, which is precisely why classifying one would be a guess. It is now
`RECOVERY_REQUIRED`, so `ACTIVATION_REQUIRED` is the **narrowest possible** definition of
"never touched": unconfirmed **and** password-less **and** unprovisioned. Test E2 pins it.

---

## 3. Migration and RPC changes

One migration, three functions, no table/column/policy/grant changes elsewhere.

### `retailer_staff_invitation_gate(text)` — new, internal

The shared validity gate: the same preconditions the previous function applied (live
PENDING token, ACTIVE Retailer, ACTIVE staff role, valid shop set, role/shop consistency),
returning the invitation id or raising the single generic exception.

Factored out so the two public functions cannot drift — if the classification said
"activate" for an invitation that recipient-resolution would refuse, the application would
create an account for an invitation acceptance then rejects.

`SECURITY INVOKER` (the default) and **EXECUTE revoked from every role including
`service_role`**: it is called only from inside the two `SECURITY DEFINER` functions,
where the effective user is already the owner. Verified unreachable on the hosted project
(§ 8).

### `get_retailer_staff_registration_context(text)` — repaired

```
returns table (account_state text, expires_at timestamptz)
```

Dropped and recreated, because the return type changes. **It no longer returns the invited
email at all.**

It reads, and discloses **none** of: `email_confirmed_at`, `encrypted_password`,
`banned_until`, `deleted_at`, `is_anonymous`, the auth user id, the profile, the
membership, the role assignment. The entire output is one of five fixed words plus the
invitation's expiry.

The password is inspected **only** for existence — `coalesce(u.encrypted_password, '') <> ''`
— which handles both the `NULL` and the `''` spellings GoTrue uses. Rule 31 of the
source-safety suite fails the build if that expression is ever written differently.

### `resolve_retailer_staff_invitation_recipient(text)` — new

Returns `invited_email` and nothing else, behind the same gate. Split out deliberately:
only two operations need the mailbox (creating the account, sending the recovery email),
and **the page's path can no longer obtain an address at all**. That is a narrowing — the
previous design returned the email to every caller of the context lookup.

Both public functions: `STABLE`, `SECURITY DEFINER`, `set search_path = ''`, revoked from
`anon` and `authenticated`, granted to `service_role` only. Neither writes; neither audits.

---

## 4. The recovery request flow

`requestStaffPasswordRecoveryAction` → `requestInvitedStaffPasswordRecovery`.

1. **The token hash comes from the scoped HttpOnly cookie and nowhere else.** The action
   reads **no form field at all** — its `_formData` parameter is unused, by name, and rule
   7 asserts that. No email, user id, invitation id or organization id is accepted from
   the browser.
2. The state is classified. **Only `RECOVERY_REQUIRED` is admitted** — `allowsPasswordRecovery`.
   `SIGN_IN` is refused on purpose: a usable account has the ordinary sign-in path, and
   letting an invitation token trigger recovery mail for one would turn the token into a
   way to disturb a working account, and a forwarded token into a nudge to reset a
   password that did not need resetting.
3. The address is resolved server-side from the invitation, used, and discarded.
4. `resetPasswordForEmail` is called with the **publishable** key — recovery is a public
   Auth endpoint and needs no elevation. The client is built for this one call with
   `persistSession: false` and `flowType: "implicit"`: it establishes no session, writes
   no cookie, and stores no PKCE verifier, because the emailed link is verified
   server-side from its token hash rather than exchanged from a code. **The service-role
   key is not used for the send.**
5. `redirectTo` is `${APP_ORIGIN}/invitations/staff/recover` — a fixed internal path plus
   validated configuration. GoTrue additionally checks it against the project's redirect
   allow-list, so it cannot become an open redirect.
6. The reply is a generic confirmation. It does **not** claim an email was delivered
   (Supabase throttles repeat requests) and does **not** name the address.
7. Every refusal — dead invitation, wrong state, provider rate limit, transport error —
   returns the same message. Nothing new is disclosed: the recovery screen was already
   rendered for this state.

---

## 5. The recovery completion flow

`/invitations/staff/recover` → `/invitations/staff/set-password` → `/invitations/staff`.

1. **The landing verifies the token server-side.** `verifyOtp({ type: "recovery",
   token_hash })`, with `type` pinned so a token minted for `invite`, `magiclink`,
   `signup` or `email_change` cannot be replayed here. It uses the publishable-key server
   client; the service role has no part in it.
2. It **grants nothing else**: it does not set a password, does not read or clear the
   invitation cookie, and **does not accept the invitation**. Accepting there would spend
   the invitation while the person still has no password — the same defect
   `/invitations/accept` documents, and an email-preview fetch following the link would be
   enough to cause it. Rule 13 lists every forbidden symbol.
3. It redirects with the query stripped (`url.search = ""`) and
   `Referrer-Policy: no-referrer`, so the token survives into no history entry, referrer,
   or access log. Every failure lands on the one generic error page.
4. `/invitations/staff/set-password` requires the session the landing established. It is
   deliberately **not** on the Proxy's public allowlist, and both the page and the action
   verify the session with `getClaims()` — never `getSession()`.
5. The action calls `supabase.auth.updateUser({ password })` **on the recovery session**.
   No email parameter, no user id, no service-role client: the session identifies exactly
   one account, so the browser cannot nominate whose password changes.
6. It returns to `/invitations/staff`, where the **existing** signed-in path applies the
   **unchanged** check: `public.accept_retailer_staff_invitation` requires the session's
   **confirmed email to equal the invitation's canonical address**, decided in SQL.
   **Resetting a password does not accept an invitation.** Someone who recovers an account
   that was never the invited address simply finds no invitation waiting.
7. The invitation cookie is deliberately **not** cleared by the recovery steps — acceptance
   consumes it, and the acceptance action already clears it on every terminal outcome.
   Clearing it earlier would strand the person one step from the finish.

**The raw staff invitation token is never in the recovery URL.** The two credentials are
separate: the recovery link grants a session, never an acceptance.

---

## 6. The email template

`supabase/templates/recovery.html` emits `{{ .TokenHash }}` as an ordinary query
parameter, exactly as `invite.html` does and for the same reason — GoTrue's default
`{{ .ConfirmationURL }}` puts the token in a **fragment**, readable only by client-side
JavaScript, which would force the credential through the browser before it could be
exchanged.

It links to **`{{ .RedirectTo }}`, not `{{ .SiteURL }}`**, and that is load-bearing: the
invitation hash lives in an HttpOnly cookie scoped to `/invitations/staff` **on the host
that set it**, and `site_url` and `APP_ORIGIN` are not always the same spelling of the
same machine (locally one is `127.0.0.1`, the other `localhost`). Landing on the wrong one
would arrive without the invitation hash and strand the person a second time.

The email carries no identifier of any kind, no Retailer/role/recipient name, no staff
invitation token, no JavaScript, and no remote resources.

---

## 7. Security properties

| Property | How it is held |
|---|---|
| An invitation token never becomes a credential | `allowsFirstPasswordActivation` admits only `NO_ACCOUNT` and `ACTIVATION_REQUIRED`; `RECOVERY_REQUIRED` is refused **in the server module**, not just hidden in the UI (rules 2, 3, 5) |
| A provisioned identity is never activated | the SQL consults `profiles`, `organization_members` **and** `member_roles` (pgTAP D1–D3, rule 35) |
| The browser cannot nominate an address | the recovery action reads no form field; no export takes or returns an email (rules 6–9) |
| No client component sees the address or the state | rules 10, 11 |
| Encrypted-password state never leaves SQL | only `<> ''` is evaluated; the output has two columns (rules 29–31) |
| No auth user id is returned by any RPC | rule 30; the id is resolved only inside the server module for the activation branch |
| No service-role key in browser code | rule 10; the recovery send uses the publishable key |
| No open redirect | every destination is a module constant; no `next`/`redirectTo`/`returnUrl` is read; GoTrue re-checks the one configured redirect (rules 17–20) |
| Setting a password does not accept an invitation | rules 21–23; acceptance still runs through `accept_retailer_staff_invitation` |
| Acceptance still requires the exact invited address | unchanged RPC; rule 23 |
| `ACCOUNT_BLOCKED` discloses no reason | banned, deleted and ambiguous are indistinguishable; the screen offers no control (rules 27, 28) |
| Nothing sensitive is logged | every log call is a fixed literal; a caught error is bound only for an `instanceof` check and never used otherwise (rules 25, 26) |

---

## 8. Verification

### Automated — all green

| Check | Result |
|---|---|
| `npm test` | **1142 tests, 262 suites, 0 failures** |
| `supabase test db` (pgTAP) | **1497 assertions across 12 files, 0 failures** — including the new 37 |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | succeeded; `/invitations/staff/recover` and `/invitations/staff/set-password` compiled |
| `git diff --check` | clean |

**pgTAP was executed**, against a local Supabase stack started for this milestone. The
suite covers every state (NO_ACCOUNT, ACTIVATION_REQUIRED, SIGN_IN, RECOVERY_REQUIRED,
ACCOUNT_BLOCKED), confirmed-with-password, confirmed-without-password,
unconfirmed-with-password, invited-passwordless-without-identity,
invited-passwordless-with-profile, membership- and role-forced recovery, banned, deleted,
ambiguous, and unknown / malformed / expired / revoked / accepted / inactive-Retailer
tokens, plus the grants and the minimal output.

### Against the hosted project

Migration applied: `supabase db push --linked` — **42 local, 42 remote**, including
`20260808090000`.

| Call | Result |
|---|---|
| `get_retailer_staff_registration_context` as `service_role`, unknown token | `23514 This invitation is not available` |
| `resolve_retailer_staff_invitation_recipient` as `service_role`, unknown token | the **same** generic refusal |
| `retailer_staff_invitation_gate` as `service_role` | `42501 permission denied` — the internal gate is unreachable even by the service role |
| all three as `anon` | `42501 permission denied` |
| selecting `has_auth_account` | `42703 column does not exist` — the old boolean is gone |

### Not performed

**The hosted end-to-end verification was not performed, and one deployment step remains
outstanding — see § 9.** Browser automation is unavailable in this session, so the ten
hosted scenarios in § 10 have not been executed.

---

## 9. Deployment — one manual step remains

Done:

* the migration is applied to the linked project.

**Outstanding, and required before hosted recovery can work:**

> The **recovery email template** must be pasted into the Supabase Dashboard under
> **Authentication → Emails → Reset password**, from `supabase/templates/recovery.html`,
> with subject *"Set your SalesReward password"*.
>
> The redirect URL `<APP_ORIGIN>/invitations/staff/recover` must be added under
> **Authentication → URL Configuration → Redirect URLs**.

This was left manual deliberately, following this repository's existing convention for the
**invite** template (`supabase/config.toml` states the same requirement for it): auth email
templates are project-wide configuration, and a blanket `config push` would also overwrite
hosted settings that legitimately differ from the local file — `site_url` in particular
points at a loopback host locally.

**Until the template is set, hosted recovery emails use GoTrue's default fragment-based
link and `/invitations/staff/recover` will reject them**, sending the person to the generic
error page. Nothing else regresses: the other four states are unaffected.

---

## 10. Hosted verification checklist (to be run manually)

Use fresh Gmail aliases. **Revoke and re-send the previously shared invitation before
testing** — its raw token has been discussed and must not be reused. **Do not paste any
raw invitation or recovery token into a report.**

| # | Scenario | How to set it up | Expected |
|---|---|---|---|
| 1 | `NO_ACCOUNT` | invite a completely new alias | "Set your password" activation form; account created; signed in; invitation accepted |
| 2 | `SIGN_IN` | invite an alias with an established account | "You already have a SalesReward account" → sign in → auto-accept |
| 3 | `ACTIVATION_REQUIRED` | an auth row that is unconfirmed, password-less **and** has no profile/membership/role | activation form, as in 1 |
| 4 | `RECOVERY_REQUIRED` | invite an alias that is mid-way through an **owner** invitation (unconfirmed, password-less, provisioned) | **"Finish securing your existing account"** with a *Send password reset email* button and **no password field** |
| 5 | recovery email | press the button | generic confirmation; email arrives with a `?token_hash=…&type=recovery` link |
| 6 | set the password | open the link | lands on `/invitations/staff/set-password` with **no token in the URL**; password saved |
| 7 | return | after saving | back on `/invitations/staff`; invitation accepted automatically |
| 8 | exact-address rule | recover an account that was **not** the invited address | password is set, but **no invitation is accepted** |
| 9 | role and shops | after 7 | roster shows the intended role; a Sales Staff invite shows its selected shops |
| 10 | `ACCOUNT_BLOCKED` | ban the auth user in the Dashboard, then open the invitation | neutral "contact support" copy, **no reason, no control** |

Also confirm: signing out mid-flow, and re-opening an already-used recovery link, both land
on the generic error page.

---

## 11. Known limitations

1. **The hosted recovery template is not yet installed** (§ 9). This is the one thing
   blocking hosted verification of states 4–8.
2. **The `ACTIVATION_REQUIRED` branch resolves the existing shell's auth user id by
   scanning.** The installed `@supabase/auth-js` admin API exposes no lookup-by-email
   (`listUsers` takes only `page`/`perPage`), so the id is found by paging, bounded at 10
   pages × 1000. Far beyond this application's scale, and it **fails closed** to a generic
   error if exceeded. The other four states need no id.
3. **No in-app "forgot password" flow exists.** Recovery is reachable only from an
   invitation in the `RECOVERY_REQUIRED` state. A general flow is a separate milestone, and
   if added it must land on a callback of the same shape or the shared recovery template
   needs a branch (noted in `config.toml`).
4. **The recovery template is project-wide.** Today the staff invitation flow is the only
   thing in this application that requests a recovery.
5. **`RECOVERY_REQUIRED` is deliberately broad.** A confirmed-without-password account is
   classified there rather than as an empty shell (§ 2). That is a fail-safe choice, not a
   precision one: it sends a small number of genuinely-empty accounts through an email
   round trip they did not strictly need.
6. **The defect's original row has already been remediated.** The address reported by
   hosted verification now has a confirmed email, a password and a sign-in — a password
   recovery was completed on it manually. Reproducing state 4 needs a **fresh** unconfirmed
   invite.
7. **Ambiguity is treated as blocked, not repaired.** Two auth rows for one address
   (possible for an SSO identity alongside a password identity) produces
   `ACCOUNT_BLOCKED` and needs an operator.

---

## 12. Explicitly NOT in this milestone

* any change to PR #39 or to invitation **delivery**
* Flutter work of any kind — no Invite Staff UI, no acceptance, no deep links
* post-acceptance shop reassignment, shop writes, staff status changes, staff role changes
* a general-purpose forgot-password flow
* any change to `accept_retailer_staff_invitation`, the reserve/prepare/record RPCs, or the
  owner invitation functions
