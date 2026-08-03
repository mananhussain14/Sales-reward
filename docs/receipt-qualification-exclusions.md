# Receipt qualification exclusions (Phase 1D-0)

An append-only, audited way to say *"this receipt may not proceed toward a sale or
a reward"* **without changing its review decision**.

Migration `20260820090000`. One permission, one table, two RPCs, one internal
helper. No sale, reward, coin, balance or payout object is created here.

## Two different questions

`receipt_review_decisions` answers one question:

> Was the submitted **image** accepted or rejected during image review?

`receipt_qualification_events` answers a different one:

> May this record proceed toward an authoritative sale, campaign qualification and
> a reward?

They are deliberately not the same column, row or table.

The concrete reason is a receipt already in the hosted project: its decision is
`VERIFIED`, and the image turned out to be a computer desktop screenshot rather
than a customer receipt. That decision is immutable and *correct as history* — a
reviewer did look at the image and did accept it. What must change is only what
happens next. Collapsing the two into one status would force a choice between
rewriting review history and letting test data earn coins. This table refuses that
choice.

## A VERIFIED decision is not reward eligibility

It never was. `VERIFIED` means one person judged one image legible and plausible.
It does not mean a sale exists, that transaction figures were confirmed, that any
product was matched, or that a campaign was evaluated — none of which are built
yet.

The UI states this explicitly. "Not excluded from future qualification" is worded
to say what it means: the **absence of one specific block**, not an approval.

## An effective exclusion means, precisely

- the receipt review decision remains visible and unchanged;
- a `VERIFIED` decision remains `VERIFIED`;
- the receipt remains in immutable review history;
- **no** authoritative sale may be finalized from it;
- **no** campaign qualification may evaluate it;
- **no** reward, coin, balance or payout may be created from it.

## Why events, not a status column

A mutable `is_excluded` column would answer "is it excluded now" and destroy "who
excluded it, when, why, and did anyone change their mind". For a control whose
whole job is keeping test data out of a financial calculation, the second question
is the one an auditor asks.

So the table stores **events** and the state is **derived**. Reversal is another
event, never an `UPDATE` and never a `DELETE`.

| Column | Notes |
|---|---|
| `event_type` | exactly `EXCLUDED` or `REINSTATED` |
| `exclusion_reason` | exactly `TEST_DATA`, `NON_QUALIFYING`, `DUPLICATE` — required on `EXCLUDED`, forbidden on `REINSTATED` |
| `reverses_event_id` | required on `REINSTATED`, forbidden on `EXCLUDED`; unique, so one exclusion is reversed at most once |
| `reviewer_note` | trimmed, 1–500 chars or null; **required** for `NON_QUALIFYING` |
| `classified_by_profile_id`, `classified_at` | who and when |

Both shape rules are written as biconditionals (`(event_type = 'EXCLUDED') =
(exclusion_reason is not null)`) so neither half can drift from the other.

There is deliberately **no `ADMINISTRATIVE_EXCLUSION`**. It would mean nothing
operationally and would become a dumping ground; a new reason can be added by
migration when a real case appears.

`NON_QUALIFYING` is the one reason that requires a note, because it asserts a
judgement the image cannot evidence — *this is real but does not count*. `TEST_DATA`
and `DUPLICATE` describe what the record **is**, which the receipt already shows.

## Effective state

A receipt is excluded while at least one `EXCLUDED` event exists that no
`REINSTATED` event references:

```sql
exists (
  select 1 from public.receipt_qualification_events x
  where x.receipt_submission_id = <receipt>
    and x.event_type = 'EXCLUDED'
    and not exists (
      select 1 from public.receipt_qualification_events rv
      where rv.reverses_event_id = x.id
    )
)
```

This supports the full cycle: exclude → reinstate → exclude again, with all three
events preserved and exactly one active exclusion at any moment.

## Fail closed — the contract future phases must use

`public.receipt_qualification_is_excluded(uuid)` wraps exactly that predicate.

**Every future sale-finalization and reward path must call it and fail closed.**
Nothing calls it yet, because Phase 1D-0 builds no sale and no reward. It exists
now, with its meaning fixed and its tests written, so Phase 1D-B has one obvious
predicate to depend on instead of re-deriving the anti-join and getting it subtly
wrong.

It is **not granted to any browser role** — `authenticated`, `anon` and `PUBLIC`
are all revoked — so it adds no executable surface. It is an internal helper for
other `SECURITY DEFINER` functions, exactly like
`resolve_claim_reviewer_organization`. It takes no Vendor and performs no
authorization, because it answers a question about a receipt rather than about a
caller; its callers must already have established the tenant boundary.

## Authorization

New permission **`RECEIPT_QUALIFICATION_CLASSIFY`** (module `CLAIM_REVIEW`), mapped
to **`CLAIM_REVIEWER` and nothing else**.

Not Vendor Super Admin: deciding a receipt is test data is a claim-review judgement
about an image somebody looked at, and the reviewer is the only role that has
already seen it. Not Finance Admin either — this is not a money operation, it is a
statement about evidence.

After this migration `CLAIM_REVIEWER` holds exactly four permissions:
`CLAIM_REVIEW_PORTAL_READ`, `RECEIPT_REVIEW_READ`, `RECEIPT_REVIEW_DECIDE`,
`RECEIPT_QUALIFICATION_CLASSIFY`.

## Tenant isolation and eligibility

Neither RPC accepts a Vendor. It is resolved in SQL from `auth.uid()` through the
Phase 1B resolver.

A `BEFORE INSERT` trigger re-checks everything the write function already checked,
so a future bug in that function — or a second writer nobody has written yet —
still cannot record an illegal row: the receipt exists and is `SUBMITTED`; it has a
final review decision and that decision is `VERIFIED`; the named Vendor is an
`ACTIVE` Vendor; an `ACTIVE` `vendor_retailers` link connects it to the receipt's
Retailer; the actor has an `ACTIVE` membership in that Vendor with an `ACTIVE`
`CLAIM_REVIEWER` role carrying the permission; and a reversal names an unreversed
`EXCLUDED` event on the same receipt and Vendor.

Deliberately **not** checked: whether the receipt's shop or submitting staff member
is still active. A receipt submitted months ago by someone who has since left is
exactly the kind of record most likely to need classifying, and refusing it would
strand it permanently.

A `REJECTED` receipt cannot be classified. It is already out of the reward path by
being rejected, and a second redundant control would imply the rejection was not
enough.

The table has RLS enabled with **zero policies** and is revoked from `PUBLIC`,
`anon`, `authenticated` **and `service_role`** — the last because Supabase's default
privileges grant `TRUNCATE`, which bypasses row triggers. A statement-level truncate
trigger closes that too; both together is the shipped pattern.

## Concurrency and idempotency

The write function locks the `receipt_submissions` row `FOR UPDATE` and reads the
effective state under that lock, so two reviewers classifying the same receipt
queue rather than race. "At most one active exclusion" is therefore true rather
than merely likely, and it is additionally guaranteed by the unique index on
`reverses_event_id`.

**The browser never supplies the event id to reverse.** A stale page holding an old
exclusion's id could otherwise reverse an exclusion recorded after it loaded. The
target is resolved server-side under the lock, so a stale page reverses whatever is
currently in force, or nothing.

| Outcome | Meaning |
|---|---|
| `EXCLUDED` | this call recorded it (`changed = true`) |
| `ALREADY_EXCLUDED` | the same reviewer already recorded the identical exclusion — an idempotent retry, not a failure |
| `REINSTATED` | this call reversed the active exclusion (`changed = true`) |
| `ALREADY_REINSTATED` | the same reviewer already reversed it |
| `CONFLICT` | the stored state is not what this call assumed; nothing written, nothing overwritten |

Idempotency is **per-actor**: a second reviewer repeating the same values gets
`CONFLICT`, not `ALREADY_EXCLUDED`, so one reviewer cannot silently adopt another's
classification.

`ALREADY_EXCLUDED`, `ALREADY_REINSTATED` and `CONFLICT` write **no event and no
Audit Log row**.

## Audit Log

Exactly one event per real state change, written in the same transaction:

| Action | Metadata keys |
|---|---|
| `RECEIPT_QUALIFICATION_EXCLUDED` | `qualification_action`, `exclusion_reason`, `note_present` |
| `RECEIPT_QUALIFICATION_REINSTATED` | `qualification_action`, `previous_exclusion_reason`, `note_present` |

`entity_type` is `RECEIPT_SUBMISSION`, `entity_id` the receipt id as text,
`organization_id` the reviewer's Vendor, `actor_profile_id` the reviewer.

**Never logged**: the reviewer note text, receipt filename, image details, bucket,
object path, SHA-256, submitter name, email, any UUID in metadata, tokens,
credentials, amounts, merchant or customer information. `note_present` records
*whether* a note was written without copying free text into a second,
differently-governed table.

## Why there is no mutation or deletion

There is no administrative path to edit or remove an event, by design. The whole
value of this record is that it cannot be quietly rewritten after a reward dispute.
A misclassification is corrected by recording a reversal, which is itself audited
and leaves both events visible.

## The development screenshot

The existing hosted `VERIFIED` desktop screenshot is the reason this milestone
exists. It has **not** been classified — this milestone builds the mechanism only.
Classifying it is a separate, controlled step after migration 62 is deployed, done
through the ordinary UI with reason `TEST_DATA`.

Nothing in this implementation hard-codes that receipt, its filename, its reviewer
or any UUID. The action works for any authorized `VERIFIED` receipt, and a test
pins the absence of hard-coded identifiers.

## How the panel reports a write

The Server Action returns the authoritative outcome and revalidates nothing, then
the panel renders that outcome and re-reads the route once. An incomplete request
is reported as *uncertain* rather than as failure, and idempotency remains the
database's. See `docs/server-action-authoritative-settlement.md` — that document
exists because an earlier version of this panel revalidated its own route and left
a committed, audited exclusion showing "Recording…" indefinitely.

## Next

**Phase 1D-A** — the authoritative sale header: `verified_sales`, the resolved UTC
sale instant with DST disambiguation, and reviewer confirmation of the transaction
figures. Sale finalization there must call
`receipt_qualification_is_excluded` and fail closed.
