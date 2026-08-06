# Shop Time Zone Management — Phase 1A

The server-authoritative ability for a Vendor operator to configure the IANA time zone of a
Retailer shop. **This milestone is code and tests only — it does not configure any hosted
shop, and it does not implement receipt verification.**

---

## 1. Why this exists

Migration `20260817210000` (Phase 0) added `retailer_shops.timezone_name`, its Region/City
shape `CHECK`, its `pg_timezone_names` validation trigger, and made
`public.resolve_sale_instant` refuse with SQLSTATE `55000` while the column is null. It
deliberately added **no writer**, recording that Phase 1 must supply one.

This is that writer. Until a shop has a zone, no printed sale time at that shop can be
placed on the clock, so **every later verification milestone is blocked**. That is why this
is the first piece of Phase 1 rather than a later convenience.

---

## 2. Who owns the setting, and who does not

**`VENDOR_SUPER_ADMIN` alone**, through the new `SHOP_TIMEZONE_MANAGE` permission.

Explicitly **not** granted to `CLAIM_REVIEWER`, `FINANCE_ADMIN`, `RETAILER_OWNER`,
`RETAILER_MANAGER` or `SALES_STAFF`.

| Role | May set a shop's time zone | Why |
| --- | --- | --- |
| `VENDOR_SUPER_ADMIN` | **Yes** | Already creates shops; is not the beneficiary of the rewards a sale earns. |
| `RETAILER_OWNER` | **No** | **The Retailer benefits from the rewards.** Letting the beneficiary set the clock that decides which campaign window a sale falls into is the same defect as letting Sales Staff verify their own receipts. The Owner holds `RETAILER_SHOPS_READ` — read, never write. |
| `CLAIM_REVIEWER` | **No** | A reviewer who could also fix the clock could move a sale across a campaign boundary while verifying it. A reviewer **reports or escalates** an unresolved or wrong zone; a Vendor operator sets it. |
| `FINANCE_ADMIN`, `RETAILER_MANAGER`, `SALES_STAFF` | **No** | No business reason, and each is a separate blast radius. |

A **new** permission code was added rather than reusing `RETAILER_SHOPS_CREATE`: creating a
shop and setting the clock that prices its sales are different decisions, and keeping them
separate means the financial clock can be revoked without revoking shop administration.

---

## 3. The value is an IANA identifier, never an offset

Only Region/City IANA names are accepted — `Asia/Dubai`, `Asia/Kuwait`, `Europe/London`,
`Europe/Paris`, `America/New_York`, `America/Argentina/Buenos_Aires`.

Refused: `UTC+3`, `GMT+3`, `+04:00`, bare `UTC`, bare `EST`, and every `Etc/*` entry.

A fixed offset cannot follow the daylight-saving rules of the place a shop stands in, so a
summer sale would resolve to the wrong instant and shift relative to a campaign window.
`Etc/GMT+3` is a real IANA name and is still a fixed offset, which is why it is refused by
name.

**Validation has exactly one authority: the Phase 0 `retailer_shops_timezone_name_shape`
CHECK and `retailer_shops_assert_timezone()`.** The RPC does not restate either rule — it
checks only that a value was supplied at all, and lets the constraint and trigger decide.
`lib/reference/iana-timezone-shape.ts` mirrors the *shape* rule in the browser for fast
feedback and is explicitly not a security control; it deliberately does **not** mirror the
catalogue rule, because a baked list of zone names would drift from the host's tzdata.

---

## 4. Nothing is ever guessed

The value must be supplied deliberately by the authorized operator. There is **no**
inference from:

- `country_code` — a country is not a time zone; several span many;
- the shop's city;
- the browser or device (`Intl.DateTimeFormat().resolvedOptions().timeZone`);
- any fallback to UTC.

When a shop has no zone the input starts **empty**. A prefilled value is a value an operator
will accept without reading, and this field decides what sales are worth. Source-level tests
assert the absence of every one of these inference routes.

---

## 5. Future verified sales freeze the time zone

The Phase 1 verification record will freeze `sale_at`, `sale_timezone_name` and
`sale_time_precision` at the moment it is written.

**Changing a shop's time zone later therefore cannot alter an already-verified sale.** What
a change affects is future resolutions, plus any already-verified sale later discovered to
have used the wrong zone — and the answer to that is a verification revision, not a
retroactive re-read.

**This is why there is no `shop_timezone_history` table**, and the omission is deliberate
rather than an oversight. The two Phase 0 timelines (campaign status, product status) exist
because those facts are read *as of* a past instant. A shop's zone is not read that way once
a sale has frozen it, so an interval table would carry cost without buying a guarantee.

---

## 6. Audit events

Written in the **same transaction** as the change, through the same `audit_logs` conventions
every audited operation uses.

| Action | `entity_type` | `entity_id` | Metadata |
| --- | --- | --- | --- |
| `SHOP_TIMEZONE_CONFIGURED` | `RETAILER_SHOP` | the shop id | `timezone_name` |
| `SHOP_TIMEZONE_CHANGED` | `RETAILER_SHOP` | the shop id | `timezone_before`, `timezone_after` |

Metadata carries **zone names and nothing else** — no shop name, Retailer name, city or
address, no staff or user identity, no email, no receipt data. A zone name is not personal
data; everything else there would be. The actor and organization travel in their own columns.

**A no-op writes no audit row.** Re-submitting the value a shop already holds returns
`changed = false`, does not rewrite the row, and records nothing — so every
`SHOP_TIMEZONE_CHANGED` row means an actual change. A test proves the row is not physically
rewritten by comparing its `ctid` across the call.

---

## 7. The write path

```
Vendor Admin retailer detail page
  └─ ShopTimeZoneControl            (Client Component: pending / error / success only)
       └─ setShopTimeZone           (Server Action, AUTHENTICATED client — never service role)
            └─ public.set_retailer_shop_timezone(p_retailer_shop_id, p_timezone_name)
                 ├─ auth.uid() → get_vendor_super_admin_context() → SHOP_TIMEZONE_MANAGE
                 ├─ shop joined through vendor_retailers to the DERIVED Vendor
                 ├─ SELECT … FOR UPDATE on the shop
                 ├─ UPDATE  (validated by the Phase 0 CHECK + trigger)
                 └─ INSERT audit_logs      ← same transaction
```

**The signature is the security boundary.** The RPC takes a shop id and a zone, and nothing
else — no Vendor organization id, Retailer organization id, relationship id, actor id, role
code, permission code or resolved UTC offset. Every one of those is derived from
`auth.uid()`, because a caller-controlled tenant id is exactly how a cross-tenant write
happens.

**The shop id is an address, never authorization.** An id belonging to another Vendor matches
zero rows and is refused with the **same byte-identical exception** as an id that does not
exist, so the function cannot be swept to discover which shops are real. The Server Action
collapses every non-field failure into one generic message for the same reason — and because
a PostgreSQL `CHECK` violation on `retailer_shops` emits a `DETAIL` line containing the
entire failing row.

No table privilege was granted, no RLS policy was added, and `service_role` was granted
nothing: every legitimate path derives its authority from a session, and a service-role path
would change a shop's financial clock with no actor to record.

---

## 8. Read model

`lib/retailers/vendor-retailer-detail.ts` now selects `id` and `timezone_name` alongside the
columns it already read, still governed by the existing
`retailer_shops_select_vendor_authorized` policy — no row became readable that was not
before.

This module previously carried **no ids at all**. It now carries exactly one, the **shop
id**, because a shop's zone has to be addressable and nothing else on the page identifies a
shop uniquely. That is a stated, single exception, and it is safe for the reason above: the
id is an address the RPC re-authorizes for itself.

`list_vendor_retailer_shops` was deliberately **left unchanged** — the Flutter Vendor
experience consumes it, and widening a `returns table` requires `DROP` + `CREATE`, which
could break that client's parser.

---

## 9. What Phase 1A does **not** do

No Claim Reviewer permission, routing or invitation · no review queue · no receipt
verification tables · no verified sale items · no product matching · no reviewer image
preview · no corrections or revisions · no campaign evaluation, contributions, awards, coins,
balances or payouts · no Flutter change · no Edge Function change · no OCR change (the
runtime remains `DISABLED`) · **no hosted deployment and no hosted shop update**.

`add_vendor_retailer_shop`'s signature is unchanged; whether a new shop should require a zone
at creation is a separate, later decision.

---

## 10. Hosted state

**All four hosted shops still have `timezone_name = NULL` and remain unresolved.** Nothing in
this milestone has been deployed, and no hosted value has been written.

Configuring them is a later, separately approved step that requires **operator-confirmed
zones for each of the four shops** — two carry `country_code = 'AE'` and two carry no country
at all, and neither fact may be used to infer a zone. Until then,
`resolve_sale_instant` continues to refuse for every hosted shop, which is the correct
fail-closed behaviour.
