# Server Action authoritative settlement

How an immutable, audited write reports itself to the reviewer who made it.

Written after a real incident during the first controlled receipt qualification.
It is the pattern every future irreversible action — starting with Phase 1D-A
sale-header finalization — must follow.

## What happened

A Claim Reviewer classified a receipt as `TEST_DATA` through the Phase 1D-0
qualification panel. The database did exactly what it was supposed to:

- one immutable `EXCLUDED` qualification event was created;
- one `RECEIPT_QUALIFICATION_EXCLUDED` Audit Log row was created;
- the receipt's `VERIFIED` review decision was untouched;
- no second event and no duplicate audit row appeared.

The browser never said so. The confirmation dialog stayed on **“Recording…”**
indefinitely, with its controls disabled. The reviewer had no way to tell whether
an irreversible financial control had been recorded. A plain page refresh showed
the correct excluded state — the write had committed long before.

Nothing was corrupted. The failure was one of *reporting*, and on an action whose
entire purpose is to be auditable, that is serious: an operator who cannot tell
whether a write happened is an operator who eventually presses the button again.

## Why the browser stayed pending

The action ended with `revalidatePath('/review/{id}')` — the path the reviewer
was already viewing.

Next.js documents the consequence directly:

> The mutation, the cache invalidation, and the page re-render all complete in a
> single roundtrip.

and, for `revalidatePath` called in a Server Function:

> Updates the UI immediately (if viewing the affected path).

So the action's reply was not sent until the receipt-detail route had finished
re-rendering. That route is not cheap: the reviewer layout re-runs its auth and
permission checks, then the page awaits `get_claim_review_detail`, then
`get_claim_receipt_qualification` — several sequential round trips to a database
in another region. `useActionState` keeps `pending` true for that entire window.

The write was durable before any of that started. The reviewer was watching a
re-render, not a transaction.

The same page of documentation states the remedy:

> An action that does none of the above carries only its return value, and the
> current route is not re-rendered.

## The corrected sequence

1. The form submits. `pending` is true, controls are disabled, the dialog says
   **“Recording…”**.
2. If the request is merely slow, after a short presentation delay the dialog
   adds **“Still recording. Do not submit again. The result will be checked
   before another attempt.”** This changes nothing but the screen — it cancels
   nothing, retries nothing, and claims no failure.
3. The RPC returns. The Server Action maps the outcome and **returns
   immediately**. It revalidates nothing.
4. `pending` clears. The panel renders the authoritative sentence for that
   outcome, and the submission form is gone for good.
5. *Only then* the panel asks the server for fresh data itself, once, via the
   client router refresh. The refresh merges the new payload “without losing
   unaffected client-side React (e.g. `useState`)”, so the outcome the reviewer
   is reading survives it.
6. When the refresh lands, the server-rendered current state (excluded, or not
   excluded) is shown beneath the outcome.

The reviewer therefore always learns what the database did **before** anything
slow is attempted, and never learns it from a guess.

## Uncertain results

A transport failure is neither success nor failure. The call did not complete, so
whether it committed is unknown — and only the database knows.

That state is carried explicitly as `uncertain` and is worded to match:

> We could not confirm whether this was recorded. Refresh the qualification
> status below before trying again — if it already went through, submitting
> again will not create a second event.

It deliberately does **not** say “nothing was recorded”. That sentence would be a
claim the client cannot support, and it is the single most likely trigger for a
duplicate attempt. The panel offers a **Refresh qualification status** button
rather than a retry, and the reviewer decides.

There is no automatic retry anywhere in this flow, and no polling loop.

## Idempotency stays in the database

The client-side protections — a settled state that short-circuits resubmission,
disabled controls while pending, one submit control, a slow-request warning — all
reduce the chance of a second attempt. None of them is the guarantee.

The guarantee is `record_claim_receipt_qualification`: it locks the receipt row,
re-reads the effective state under that lock, and answers a repeated identical
request with `ALREADY_EXCLUDED` or `ALREADY_REINSTATED` — no second event, no
second Audit Log. A reviewer who ignores every warning and submits again still
cannot create a duplicate.

## The rule this changed, and why

`lib/ui/navigation-performance.test.ts` forbids `router.refresh()` across `app/`
and `components/`, with a single allow-listed file. Its original rationale said
post-mutation sync should use `revalidatePath` from the Server Action instead.

That rationale is what this incident disproved for a heavy, cross-region route.
The allow-list now holds a second file — the qualification panel — with the same
justification the first one has: this is not navigation and not a write, it is a
re-attempt of a Server Component read. Everything else the rule forbids is
unchanged, the one-call-per-file cap still applies, and a new assertion pins that
the qualification action may never reintroduce same-route revalidation.

## The pattern for Phase 1D-A

Sale-header finalization is a larger version of the same problem: an immutable,
audited, financially meaningful write on the same slow route. It must reuse this
sequence exactly.

- Return the authoritative outcome from the action; revalidate nothing on the
  route the reviewer is on.
- Put the outcome vocabulary and its copy in a **pure module** so each outcome is
  a real behavioural assertion rather than a source grep. See
  `lib/review/claim-receipt-qualification-settlement.ts`.
- Render the outcome, then refresh once, gated on
  `shouldRefreshAfterSettlement`-style logic so a refresh can never race a
  request that is still in flight.
- Treat an incomplete request as `uncertain`, never as failure.
- Never retry automatically. Never poll.
- Let the database own idempotency, and say so in the copy.

A shared helper was deliberately **not** extracted. There is one action using this
today; a second one arriving in Phase 1D-A is the right moment to judge what, if
anything, genuinely generalises. The pure settlement module is already the reusable
part.

**Second consumer (Phase 1D-A).** Sale-header finalization follows this sequence
exactly — see `docs/claim-reviewer-sale-header-finalization-web.md`. Having built
it twice, the reusable part is still just *a pure settlement module per action*:
the two share a shape but not a line of code, and the copy, the outcome vocabulary
and the unsettled-question case (`AMBIGUOUS_TIME_REQUIRES_CHOICE`) differ enough
that a generic abstraction would have to be parameterised into meaninglessness. It
stays unextracted deliberately.

## Limitations

- The correction removes the *response-critical* re-render, not the underlying
  latency. The refresh that follows settlement is still a cross-region read and
  can still take seconds — it simply happens after the reviewer has been told the
  answer, and with its own honest status line.
- The slow-request notice is a fixed presentation delay, not a measurement of the
  request. A request that completes just after the threshold will briefly show
  the notice. That is deliberate: the alternative is showing nothing while a
  reviewer waits.
- Other Server Actions in this repository still revalidate their own routes. They
  are on lighter pages and have not shown this symptom, so they were left alone
  rather than changed speculatively. If one of them ever hangs, this document is
  the fix.
- No hosted data was written to produce or verify this correction. The behaviour
  is covered by behavioural tests over the pure settlement module and strict
  source rules over the action and panel.
