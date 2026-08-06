# Generic Auth invitation completion

## The distinction this flow exists to make

**Auth confirmation is not application authorization.**

Supabase Auth answers one question: *is this person in control of this mailbox, and
do they hold a credential?* SalesReward answers a different one: *what is this person
allowed to do?* The second is decided entirely in PostgreSQL, from a `public.profiles`
row, an `organization_members` row and a `member_roles` assignment — none of which
Auth knows about or can create.

Confusing the two is what produced the defect this flow fixes. `/invitations/accept`
verified an invitation token correctly and established a session, then handed off to
`/invitations/complete`, which assumed every invited person also had a pending
**Retailer** invitation row. An invited Vendor-side user has none, so the page sent
them to `/invitations/error` — "This invitation link cannot be used" — even though
their token had just been accepted successfully. The link was fine; the destination
was missing.

## The two completion outcomes

Token verification is unchanged and remains in one place:

```
invitation email
  → /invitations/accept?token_hash=…&type=invite
      verifyOtp({ type: "invite", token_hash })
        ├─ failure → /invitations/error          (generic, non-oracular)
        └─ success → /invitations/complete
```

`/invitations/complete` then routes on what the session is actually authorized for,
in this order:

| # | Condition | Outcome |
|---|---|---|
| 1 | No verified session | `/invitations/error` |
| 2 | A pending Retailer invitation exists | **Retailer completion, unchanged** |
| 3 | No Retailer invitation, but a portal exists | that user's normal landing |
| 4 | No Retailer invitation, portal is NONE | `/invitations/account-setup` |

A transport or PostgREST failure on the invitation lookup is treated as an
**operational failure**, not as "this person has no invitation" — it goes to
`/invitations/error`. Treating a transient fault as absence would route a genuine
Retailer invitee into generic setup and leave their invitation unaccepted.

Nothing in this decision reads an email address, a query-string role or a
browser-supplied organization id. It calls `resolveAuthenticatedLanding()`, which
takes no arguments and resolves everything from `auth.uid()`.

## Why the Retailer flow stays separate

The Retailer action sets a password **and then** calls
`accept_retailer_owner_invitation()`, flipping a membership from `INVITED` to
`ACTIVE`. That second step is authorization, and it is correct there because a
pending invitation row is what authorizes it.

A generic invitee has no such row, so there is nothing to accept. Reusing that action
would have meant either inventing an invitation or making the acceptance conditional
— and a conditional authorization step is exactly the kind of branch that later
becomes a bypass. Two actions, one that authorizes and one that cannot, are unable to
drift into each other.

## What generic account setup does, and does not, do

`/invitations/account-setup` requires a verified session and an already-confirmed
address, refuses anyone who already has a portal, and then does exactly one thing:
sets a password on the caller's own Auth account through the ordinary authenticated
client, and signs them out.

It does **not**:

- create a `public.profiles` row
- create an `organization_members` row
- assign a `member_roles` entry
- write `audit_logs`
- call any RPC at all
- import or use a service-role client

**So finishing this form grants no application access.** With no profile row, every
portal resolver in the database — Vendor, Retailer and Claim Review alike — returns
zero rows for that account. The person can authenticate and do nothing else. That is
the intended end state, and the sign-in page says so:

> Your account has been confirmed. An administrator must finish setting up your
> access before you can sign in to SalesReward.

Profile, organization membership and role assignment are granted **later, through a
separately approved administrative process**, and never by anything a browser can
reach.

## Scope of this milestone

This milestone creates **no Claim Reviewer access**. It adds no permission, no role
mapping, no membership and no migration; the database is untouched. The page is
deliberately role-neutral and names no role, because it is reached by whichever
invited account happens to have no portal yet, and it is meant to stay reusable for
future Vendor-side invitees.

The reviewer database bootstrap — profile, Vendor membership, `CLAIM_REVIEWER`
assignment and its audit event — **remains pending** as its own separately reviewed,
atomic, one-off administrative transaction.
