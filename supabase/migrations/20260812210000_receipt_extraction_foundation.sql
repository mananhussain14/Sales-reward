-- Migration: receipt_extraction_foundation
-- Purpose: The storage + authorization foundation for receipt extraction and
--          confirmation. It adds, and only adds:
--            1. The RECEIPT_EXTRACTION_REVIEW permission, mapped to SALES_STAFF and to no
--               other role.
--            2. public.receipt_extraction_runtime — the single-row DATABASE gate.
--            3. public.receipt_extractions — one row per provider attempt.
--            4. public.receipt_extraction_line_items — informational, worker-written.
--            5. public.receipt_confirmations — one immutable confirmation per receipt.
--          Plus every CHECK, index, trigger, and default-deny RLS + privilege hardening.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No RPC — every operation lives in the two ordered operations migrations that follow.
--   No raw-payload table: public.receipt_extraction_payloads DOES NOT EXIST and is not
--   created here. Milestone A stores only the NORMALIZED extraction, its normalized line
--   items, closed failure codes and provider-neutral operational metadata. A retention
--   table without a working purge job is a liability, and the fake provider produces
--   nothing worth retaining.
--   No product matching, no reward, no incentive, no claim, no coin, no payout, no review
--   queue, no Vendor or Retailer visibility, no duplicate signal beyond the exact
--   image-hash rule migration 20260726090000 already enforces, no PDF, no multi-page.
--   No storage bucket, no storage policy, and no change to the `receipts` bucket.
--   NOTHING IN public.receipt_submissions IS TOUCHED — not a column, constraint, index,
--   trigger, status value or function. Extraction is strictly additive and begins only
--   after a receipt is already SUBMITTED.
--
-- NO AZURE. No provider endpoint, credential, SDK, region or service name appears in this
--   migration or anywhere in Milestone A. `receipt_extractions_provider_allowed` restricts
--   the provider column to the single literal 'FAKE', which makes "no real provider was
--   called" an invariant of the DATA rather than a claim about the code. A later milestone
--   widens that CHECK in its own migration, which is a visible, reviewable act.
--
-- Idempotency posture: plain CREATE / INSERT (no IF NOT EXISTS, no CREATE OR REPLACE, no
--   ON CONFLICT except the runtime seed's structural single-row guard). A conflicting
--   existing object FAILS the migration rather than silently overwriting it. No fixed
--   UUIDs — the permission row takes the table's gen_random_uuid() default and is joined by
--   CODE below. No dynamic SQL. All identifiers are <= 63 bytes. Every reference is
--   schema-qualified because every function runs with an EMPTY search_path.
--
-- Dependencies: 20260716124419 (profiles, organizations), 20260716125559 (roles,
--   permissions, role_permissions), 20260717094520 (retailer_shops), 20260726090000
--   (receipt_submissions), 20260812090000 (iso_currency_codes).

-- ============================================================================
-- PART 1 — the RECEIPT_EXTRACTION_REVIEW permission and its single role mapping
-- ============================================================================
-- WHY A NEW PERMISSION RATHER THAN REUSING RECEIPT_SUBMIT
--   Reuse would couple two lifecycles: revoking extraction review from a staff member
--   would also stop them submitting receipts, and vice versa. This project already
--   declined that coupling once — migration 20260730090000 added RECEIPT_PRODUCTS_READ
--   rather than reusing RECEIPT_SUBMIT for the products read.
--
--   Separately, IMAGE PREVIEW IS A GENUINELY NEW CAPABILITY. Reading the object bytes of a
--   stored receipt is something RECEIPT_SUBMIT never implied, and folding it into an
--   existing permission would silently widen what that permission means for everyone who
--   already holds it. A new code makes the widening explicit and auditable.
--
-- IT DOES NOT WIDEN ACCESS. The permission grants a CAPABILITY; it never grants a ROW.
-- Three independent conditions must all hold, and this mapping satisfies only the first:
--   1. resolve_retailer_member_organization('RECEIPT_EXTRACTION_REVIEW') must resolve —
--      which requires an ACTIVE profile owned by auth.uid(), an ACTIVE membership, an
--      ACTIVE RETAILER organization, an ACTIVE role, and this permission reached through
--      that role. Because the mapping below is SALES_STAFF-ALONE, a Vendor Super Admin, a
--      Retailer Owner and a Retailer Manager all resolve NULL and are refused.
--   2. The receipt must satisfy submitted_by_profile_id = auth.uid() — so a DIFFERENT
--      Sales Staff member at the same Retailer, holding this identical permission, still
--      sees zero rows.
--   3. The receipt must belong to the resolved Retailer.
-- No function added by this milestone names a role code anywhere; the mapping is the sole
-- authority, and deactivating the SALES_STAFF role revokes the whole feature with no code
-- change.
insert into public.permissions (code, name, description, module)
values (
  'RECEIPT_EXTRACTION_REVIEW',
  'Review receipt extraction',
  'Request extraction of a submitted receipt, review the extracted values, preview the '
  'receipt image, and confirm the receipt, for receipts this staff member submitted '
  'themselves.',
  'RECEIPTS'
);

-- Mapped to SALES_STAFF and to nothing else. Joined by CODE rather than by a literal UUID
-- so this migration depends on the seeded catalogue rather than restating it.
--
-- NOT mapped to: VENDOR_SUPER_ADMIN, RETAILER_OWNER, RETAILER_MANAGER, CLAIM_REVIEWER,
-- FINANCE_ADMIN. Vendor, Owner and Manager receive NO receipt access in Milestone A.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'RECEIPT_EXTRACTION_REVIEW'
where r.code = 'SALES_STAFF';

-- ============================================================================
-- PART 2 — public.receipt_extraction_runtime, the DATABASE gate
-- ============================================================================
-- ONE ROW, SEEDED 'DISABLED', AND NO FUNCTION MAY CHANGE IT.
--
-- WHY THIS TABLE EXISTS. request_receipt_extraction is granted to `authenticated`, so a
-- client holding a valid session reaches it through PostgREST whether or not any Edge
-- Function is deployed. Without a gate in the DATABASE, applying this milestone to a
-- project would let such a client accumulate QUEUED attempts that no worker can ever claim
-- — each one holding receipt_extractions_active_attempt_unique_idx and permanently
-- blocking further attempts on that receipt. An environment variable on a function that is
-- not deployed cannot prevent that; this row can.
--
-- FAIL CLOSED BY CONSTRUCTION. The seed is 'DISABLED', so applying these migrations to ANY
-- project — including production — leaves extraction off. Enabling it is a deliberate
-- operator UPDATE executed as the table owner. NO FUNCTION IN THIS MILESTONE, AT ANY
-- PRIVILEGE LEVEL, WRITES THIS COLUMN: there is no code path, reachable with any input by
-- any role, that turns fake extraction on. The Edge Functions carry a second, independent
-- gate (RECEIPT_EXTRACTION_MODE); two independent blocks, matching the "no policy AND no
-- privilege" posture every table in this schema already uses.
create table public.receipt_extraction_runtime (
  -- The standard single-row idiom: `true` is the only value the primary key admits, so a
  -- second row is structurally impossible rather than merely discouraged.
  id boolean not null default true,

  mode text not null default 'DISABLED',

  updated_at timestamptz not null default now(),

  constraint receipt_extraction_runtime_pkey primary key (id),
  constraint receipt_extraction_runtime_single_row check (id),
  constraint receipt_extraction_runtime_mode_allowed
    check (mode = any (array['DISABLED'::text, 'FAKE'::text]))
);

comment on table public.receipt_extraction_runtime is
  'Single-row database gate for receipt extraction. Seeded DISABLED; changed only by a deliberate operator UPDATE. No function writes mode.';

insert into public.receipt_extraction_runtime (id, mode) values (true, 'DISABLED');

alter table public.receipt_extraction_runtime enable row level security;
revoke all on table public.receipt_extraction_runtime from public;
revoke all on table public.receipt_extraction_runtime from anon;
revoke all on table public.receipt_extraction_runtime from authenticated;
-- service_role TOO. Supabase's default privileges grant ALL on a new public table to
-- service_role, and revoking only from public/anon/authenticated leaves REFERENCES,
-- TRIGGER and TRUNCATE behind. TRUNCATE is the one that matters: it BYPASSES ROW
-- TRIGGERS, so it would defeat the never-delete and immutability guards on this table
-- outright. service_role reaches this table only through SECURITY DEFINER functions,
-- which run as the owner and are unaffected by the revoke.
revoke all on table public.receipt_extraction_runtime from service_role;

-- ============================================================================
-- PART 3 — public.receipt_extractions
-- ============================================================================
-- ONE ROW PER ATTEMPT. A retry is a NEW ROW, never a reset of an old one, so the history
-- of what was tried is preserved and a terminal result can be made permanently immutable.
create table public.receipt_extractions (
  id uuid primary key default gen_random_uuid(),

  -- The receipt this attempt reads. RESTRICT because an attempt is a record of something
  -- that happened and must not vanish with the row it describes.
  receipt_submission_id uuid not null
    references public.receipt_submissions (id) on delete restrict,

  -- Tenant scope. DERIVED from the submission by the RPC and re-asserted by the trigger
  -- below; never supplied by a caller.
  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  -- ACTOR CONSISTENCY. Always the submission's own submitter — the trigger below refuses
  -- anything else, so an attempt can never be attributed to a person who did not submit
  -- the receipt.
  requested_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  -- 1, 2 or 3. SERVER-DERIVED as count(*) + 1; there is no parameter for it anywhere.
  attempt_number integer not null,

  status text not null default 'QUEUED',

  -- ---- Worker state --------------------------------------------------------
  -- All five are NULL while QUEUED and are written only by the service-role worker RPCs.
  -- None is ever returned to an authenticated caller.
  provider text,
  provider_model text,
  provider_operation_id text,

  -- A server-generated nonce identifying WHICH worker holds this job.
  --
  -- WHY A TOKEN RATHER THAN RE-ASSERTING STORED FACTS. finalize_receipt_submission_upload
  -- (migration 20260726210000) defends a stale callback by re-asserting the hash and path
  -- recorded at reservation, and that works there because reserve -> upload -> finalize is
  -- a single invocation with no rival. Extraction's whole threat model is a SECOND WORKER,
  -- and re-assertion cannot help: any caller able to read the row can restate its facts.
  -- Those facts identify the ROW; only a nonce issued at claim time identifies the WORKER.
  worker_claim_token uuid,

  -- ONE deadline column serving both open states: set to now() + 15 minutes at INSERT (the
  -- queue deadline) and RESET to now() + 5 minutes at claim (the work deadline). One
  -- column means one reaper predicate and no state where a stuck row is invisible to it.
  --
  -- BOTH open states need a deadline. A crash between the request RPC and the claim leaves
  -- a QUEUED row; a crash between the claim and the completion leaves a PROCESSING row.
  -- Either one holds the active-attempt index and would otherwise brick the receipt
  -- forever. The values are RPC-controlled literals and are never parameters — a worker
  -- must not choose its own deadline.
  expires_at timestamptz not null,

  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,

  failure_code text,

  -- ---- The normalized reading ----------------------------------------------
  -- Present only on a SUCCEEDED row; receipt_extractions_values_only_when_succeeded
  -- enforces that. Each field carries its VALUE, the SOURCE TEXT it was read from, and a
  -- CONFIDENCE.
  --
  -- SOURCE TEXT MAY EXIST WHEN THE VALUE IS NULL, and that is the important case rather
  -- than an edge case: an amount whose decimal separator could not be resolved is stored
  -- as a NULL value with its printed text intact and AMBIGUOUS_AMOUNT_FORMAT warned, so the
  -- reviewer sees exactly what was printed and types the figure themselves. Nothing here
  -- requires a normalized counterpart to be non-null.
  merchant_name text,
  merchant_name_source_text text,
  merchant_name_confidence numeric(4,3),

  document_number text,
  document_number_source_text text,
  document_number_confidence numeric(4,3),

  -- A printed receipt date is a CIVIL DATE with no zone. `date`, never `timestamptz`:
  -- storing it with a zone would silently shift it by a day for half the world.
  transaction_date date,
  transaction_date_source_text text,
  transaction_date_confidence numeric(4,3),

  -- Minute precision. Receipts print HH:MM, and a provider emitting :00 seconds must not
  -- read as a human correction when the confirmation is compared.
  transaction_time time without time zone,
  transaction_time_source_text text,
  transaction_time_confidence numeric(4,3),

  currency_code text
    references public.iso_currency_codes (code) on delete restrict,
  currency_code_source_text text,
  currency_code_confidence numeric(4,3),

  -- Integer MINOR units throughout. No numeric, no float, no decimal-degree rounding rule.
  total_minor bigint,
  total_source_text text,
  total_confidence numeric(4,3),

  subtotal_minor bigint,
  subtotal_source_text text,
  subtotal_confidence numeric(4,3),

  tax_total_minor bigint,
  tax_source_text text,
  tax_confidence numeric(4,3),

  warning_codes text[] not null default '{}'::text[],

  created_at timestamptz not null default now(),

  -- NO set_updated_at TRIGGER IS ATTACHED TO THIS TABLE — see PART 3c. updated_at is
  -- written explicitly inside each permitted transition, which is what allows terminal
  -- immutability to be TOTAL rather than carrying an updated_at exemption.
  updated_at timestamptz not null default now(),

  -- ---- Lifecycle -----------------------------------------------------------
  constraint receipt_extractions_status_allowed
    check (status = any (array['QUEUED'::text, 'PROCESSING'::text, 'SUCCEEDED'::text, 'FAILED'::text])),

  -- THE MAXIMUM-ATTEMPTS AUTHORITY. A fourth row cannot be inserted at all, so the limit is
  -- structural rather than a count the RPC remembers to check. EVERY PERSISTED ROW CONSUMES
  -- ONE ATTEMPT, whatever its status or failure code: there is no second counter and no
  -- exempt failure, so attempts_used is exactly count(*) and attempt_number is a dense
  -- 1..3 sequence.
  constraint receipt_extractions_attempt_number_range
    check (attempt_number between 1 and 3),

  -- ---- Per-status shape ----------------------------------------------------
  -- Written as one constraint per status rather than as a web of pairwise implications, so
  -- the state machine can be read off the table definition.
  constraint receipt_extractions_queued_shape
    check (
      status <> 'QUEUED'
      or (
        started_at is null
        and completed_at is null
        and worker_claim_token is null
        and provider is null
        and provider_model is null
        and provider_operation_id is null
        and failure_code is null
      )
    ),
  constraint receipt_extractions_processing_shape
    check (
      status <> 'PROCESSING'
      or (
        started_at is not null
        and completed_at is null
        and worker_claim_token is not null
        and provider is not null
        and provider_model is not null
        and failure_code is null
      )
    ),
  constraint receipt_extractions_succeeded_shape
    check (
      status <> 'SUCCEEDED'
      or (
        started_at is not null
        and completed_at is not null
        and worker_claim_token is not null
        and provider_operation_id is not null
        and failure_code is null
      )
    ),
  constraint receipt_extractions_failed_shape
    check (
      status <> 'FAILED'
      or (completed_at is not null and failure_code is not null)
    ),

  -- A never-claimed row is one no worker ever touched, so it must carry no worker state at
  -- all. This is what stops the reaper's QUEUED path being used to fabricate the appearance
  -- of a claim.
  constraint receipt_extractions_never_claimed_shape
    check (
      failure_code is distinct from 'NEVER_CLAIMED'
      or (
        started_at is null
        and worker_claim_token is null
        and provider is null
        and provider_model is null
        and provider_operation_id is null
      )
    ),

  -- Ten codes. Two of them — WORKER_ABANDONED and NEVER_CLAIMED — are writable ONLY by
  -- expire_stale_receipt_extraction_claims; record_receipt_extraction_failure refuses both,
  -- so a reaped row can always be trusted to mean the deadline actually passed.
  constraint receipt_extractions_failure_code_allowed
    check (
      failure_code is null
      or failure_code = any (array[
        'PROVIDER_UNAVAILABLE'::text,
        'PROVIDER_QUOTA_EXCEEDED'::text,
        'PROVIDER_TIMEOUT'::text,
        'PROVIDER_REJECTED_DOCUMENT'::text,
        'OBJECT_UNREADABLE'::text,
        'UNSUPPORTED_IMAGE'::text,
        'NORMALIZATION_FAILED'::text,
        'WORKER_ABANDONED'::text,
        'NEVER_CLAIMED'::text,
        'INTERNAL'::text
      ])
    ),

  -- ---- Provider ------------------------------------------------------------
  -- THE NO-REAL-PROVIDER INVARIANT. Milestone A admits exactly one provider name, and a row
  -- naming any other cannot exist. This is what makes "no external document service was
  -- called" a property of the database rather than a promise about the application.
  constraint receipt_extractions_provider_allowed
    check (provider is null or provider = 'FAKE'),
  constraint receipt_extractions_provider_model_shape
    check (
      provider_model is null
      or (provider_model = btrim(provider_model) and length(provider_model) between 1 and 100)
    ),
  constraint receipt_extractions_operation_id_shape
    check (
      provider_operation_id is null
      or (
        provider_operation_id = btrim(provider_operation_id)
        and length(provider_operation_id) between 1 and 200
      )
    ),

  -- ---- Values exist only on a successful attempt ---------------------------
  -- A failed or open attempt carries NO extracted value of any kind: no field, no source
  -- text, no confidence, no warning.
  constraint receipt_extractions_values_only_when_succeeded
    check (
      status = 'SUCCEEDED'
      or (
        merchant_name is null and merchant_name_source_text is null
        and merchant_name_confidence is null
        and document_number is null and document_number_source_text is null
        and document_number_confidence is null
        and transaction_date is null and transaction_date_source_text is null
        and transaction_date_confidence is null
        and transaction_time is null and transaction_time_source_text is null
        and transaction_time_confidence is null
        and currency_code is null and currency_code_source_text is null
        and currency_code_confidence is null
        and total_minor is null and total_source_text is null and total_confidence is null
        and subtotal_minor is null and subtotal_source_text is null
        and subtotal_confidence is null
        and tax_total_minor is null and tax_source_text is null and tax_confidence is null
        and cardinality(warning_codes) = 0
      )
    ),

  constraint receipt_extractions_warning_codes_allowed
    check (
      warning_codes <@ array[
        'LOW_CONFIDENCE_TOTAL'::text,
        'LOW_CONFIDENCE_DATE'::text,
        'MISSING_MERCHANT_NAME'::text,
        'MISSING_DOCUMENT_NUMBER'::text,
        'MISSING_TRANSACTION_TIME'::text,
        'SUBTOTAL_TAX_TOTAL_MISMATCH'::text,
        'AMBIGUOUS_AMOUNT_FORMAT'::text,
        'NEGATIVE_AMOUNT_REJECTED'::text,
        'ZERO_TOTAL'::text,
        'DATE_IN_FUTURE'::text,
        'CURRENCY_INFERRED_FROM_DEFAULT'::text,
        'MULTIPLE_TOTALS_FOUND'::text
      ]
    ),

  -- ---- Value bounds --------------------------------------------------------
  constraint receipt_extractions_merchant_name_shape
    check (
      merchant_name is null
      or (merchant_name = btrim(merchant_name) and length(merchant_name) between 1 and 255)
    ),
  constraint receipt_extractions_document_number_shape
    check (
      document_number is null
      or (document_number = btrim(document_number) and length(document_number) between 1 and 100)
    ),

  -- SOURCE TEXT: nullable, trimmed and nonblank when present, and bounded. NO CONSTRAINT
  -- REQUIRES THE NORMALIZED COUNTERPART TO BE NON-NULL — an unresolvable amount keeps its
  -- printed text precisely so a human can read it. Every OCR-derived text column in this
  -- schema is bounded; none is unlimited.
  constraint receipt_extractions_merchant_name_source_shape
    check (
      merchant_name_source_text is null
      or (
        merchant_name_source_text = btrim(merchant_name_source_text)
        and length(merchant_name_source_text) between 1 and 500
      )
    ),
  constraint receipt_extractions_document_number_source_shape
    check (
      document_number_source_text is null
      or (
        document_number_source_text = btrim(document_number_source_text)
        and length(document_number_source_text) between 1 and 250
      )
    ),
  constraint receipt_extractions_transaction_date_source_shape
    check (
      transaction_date_source_text is null
      or (
        transaction_date_source_text = btrim(transaction_date_source_text)
        and length(transaction_date_source_text) between 1 and 100
      )
    ),
  constraint receipt_extractions_transaction_time_source_shape
    check (
      transaction_time_source_text is null
      or (
        transaction_time_source_text = btrim(transaction_time_source_text)
        and length(transaction_time_source_text) between 1 and 100
      )
    ),
  constraint receipt_extractions_currency_code_source_shape
    check (
      currency_code_source_text is null
      or (
        currency_code_source_text = btrim(currency_code_source_text)
        and length(currency_code_source_text) between 1 and 50
      )
    ),
  constraint receipt_extractions_total_source_shape
    check (
      total_source_text is null
      or (
        total_source_text = btrim(total_source_text)
        and length(total_source_text) between 1 and 100
      )
    ),
  constraint receipt_extractions_subtotal_source_shape
    check (
      subtotal_source_text is null
      or (
        subtotal_source_text = btrim(subtotal_source_text)
        and length(subtotal_source_text) between 1 and 100
      )
    ),
  constraint receipt_extractions_tax_source_shape
    check (
      tax_source_text is null
      or (tax_source_text = btrim(tax_source_text) and length(tax_source_text) between 1 and 100)
    ),

  -- ---- Monetary ------------------------------------------------------------
  -- Non-negative: a refund or credit note is out of scope for Milestone A, and a negative
  -- read as a purchase would be a reward paid out wrongly. Ceiling 10^12 minor units — far
  -- above any retail receipt and low enough that a barcode misread as a total fails loudly.
  -- ZERO IS PERMITTED: a fully discounted receipt is real, and the ZERO_TOTAL warning
  -- carries the signal instead.
  --
  -- THERE IS DELIBERATELY NO `subtotal + tax = total` CONSTRAINT. Real receipts round their
  -- lines independently of their total, so that equality is not a fact about receipts. The
  -- SUBTOTAL_TAX_TOTAL_MISMATCH warning exists to draw a reviewer's eye, and nothing more.
  constraint receipt_extractions_total_range
    check (total_minor is null or (total_minor >= 0 and total_minor <= 1000000000000)),
  constraint receipt_extractions_subtotal_range
    check (subtotal_minor is null or (subtotal_minor >= 0 and subtotal_minor <= 1000000000000)),
  constraint receipt_extractions_tax_range
    check (tax_total_minor is null or (tax_total_minor >= 0 and tax_total_minor <= 1000000000000)),

  constraint receipt_extractions_merchant_confidence_range
    check (merchant_name_confidence is null or merchant_name_confidence between 0 and 1),
  constraint receipt_extractions_document_confidence_range
    check (document_number_confidence is null or document_number_confidence between 0 and 1),
  constraint receipt_extractions_date_confidence_range
    check (transaction_date_confidence is null or transaction_date_confidence between 0 and 1),
  constraint receipt_extractions_time_confidence_range
    check (transaction_time_confidence is null or transaction_time_confidence between 0 and 1),
  constraint receipt_extractions_currency_confidence_range
    check (currency_code_confidence is null or currency_code_confidence between 0 and 1),
  constraint receipt_extractions_total_confidence_range
    check (total_confidence is null or total_confidence between 0 and 1),
  constraint receipt_extractions_subtotal_confidence_range
    check (subtotal_confidence is null or subtotal_confidence between 0 and 1),
  constraint receipt_extractions_tax_confidence_range
    check (tax_confidence is null or tax_confidence between 0 and 1),

  -- A floor guards an OCR year misread. There is no upper CHECK because now() is not
  -- IMMUTABLE and therefore cannot appear in one; a future date is reported by the
  -- DATE_IN_FUTURE warning instead.
  constraint receipt_extractions_transaction_date_floor
    check (transaction_date is null or transaction_date >= date '2000-01-01'),

  -- Minute precision, matching the comparison rule the confirmation uses.
  constraint receipt_extractions_transaction_time_minute
    check (transaction_time is null or date_part('second', transaction_time) = 0),

  constraint receipt_extractions_timestamp_order
    check (
      (started_at is null or started_at >= requested_at)
      and (completed_at is null or started_at is null or completed_at >= started_at)
    )
);

comment on table public.receipt_extractions is
  'One provider extraction attempt for one submitted receipt. Every persisted row consumes one of three attempts. Terminal rows are immutable and are never deleted.';

-- ---- Indexes ---------------------------------------------------------------

create unique index receipt_extractions_submission_attempt_unique_idx
  on public.receipt_extractions (receipt_submission_id, attempt_number);

-- THE ONE-ACTIVE-ATTEMPT CONCURRENCY AUTHORITY. Two concurrent requests for one receipt
-- cannot both create an attempt; the loser catches the unique violation, re-reads, and
-- reports the winner's state.
create unique index receipt_extractions_active_attempt_unique_idx
  on public.receipt_extractions (receipt_submission_id)
  where status in ('QUEUED', 'PROCESSING');

-- Makes "at most one SUCCEEDED attempt" structural, which is what lets the confirmation
-- speak of "the successful extraction" without ambiguity.
create unique index receipt_extractions_succeeded_unique_idx
  on public.receipt_extractions (receipt_submission_id)
  where status = 'SUCCEEDED';

-- One provider operation belongs to at most one attempt, across the whole table.
create unique index receipt_extractions_operation_unique_idx
  on public.receipt_extractions (provider_operation_id)
  where provider_operation_id is not null;

-- The latest-attempt read, which every authenticated projection performs.
create index receipt_extractions_submission_latest_idx
  on public.receipt_extractions (receipt_submission_id, attempt_number desc);

-- Serves both the scoped reaper (equality on id, then this predicate) and a future
-- Milestone B sweep over all expired rows.
create index receipt_extractions_open_expiry_idx
  on public.receipt_extractions (expires_at)
  where status in ('QUEUED', 'PROCESSING');

create index receipt_extractions_retailer_requested_idx
  on public.receipt_extractions (retailer_organization_id, requested_at desc);

-- ---- PART 3a — tenant and actor consistency --------------------------------
-- Reachable despite the foreign keys: BEFORE ROW triggers fire before FKs are checked
-- (foreign keys are AFTER ROW triggers), so this validator runs against an id no row owns.
-- The messages name the RULE and never a row — an error string is not a safe place to
-- describe data the caller may not read.
--
-- BEFORE INSERT ONLY. Updates are covered by the identity clause of the update guard in
-- PART 3c, which is unconditional and cannot be bypassed by a column-scoped SET list. Two
-- update triggers would also break the "exactly one BEFORE UPDATE trigger" property the
-- pgTAP suite asserts.
create function public.receipt_extractions_assert_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission public.receipt_submissions%rowtype;
begin
  select * into v_submission
  from public.receipt_submissions s
  where s.id = new.receipt_submission_id;

  if v_submission.id is null then
    raise exception 'Referenced receipt submission does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_submission.status <> 'SUBMITTED' then
    raise exception 'Receipt extraction requires a submitted receipt'
      using errcode = 'check_violation';
  end if;

  if new.retailer_organization_id <> v_submission.retailer_organization_id then
    raise exception 'Receipt extraction Retailer must match the submission'
      using errcode = 'check_violation';
  end if;

  -- ACTOR CONSISTENCY: an attempt is always attributed to the person who submitted the
  -- receipt, and to nobody else.
  if new.requested_by_profile_id <> v_submission.submitted_by_profile_id then
    raise exception 'Receipt extraction requester must be the receipt submitter'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger receipt_extractions_assert_tenant
  before insert on public.receipt_extractions
  for each row execute function public.receipt_extractions_assert_tenant();

-- ---- PART 3b — the update guard --------------------------------------------
-- FIVE PERMITTED TRANSITIONS AND NOTHING ELSE. Each names the columns it may change; every
-- other column must be byte-equivalent, and that is checked with a jsonb difference over
-- the whole row rather than by enumerating forty columns. A column added by a future
-- migration is therefore protected AUTOMATICALLY, instead of being protected only if
-- somebody remembers to add it to a list.
--
-- TERMINAL IS TOTAL. Once SUCCEEDED or FAILED, EVERY update raises — including an
-- updated_at-only update. That is possible only because public.set_updated_at() is NOT
-- attached to this table: with it attached, the guard would have to tolerate an updated_at
-- change on a terminal row, and its correctness would then depend on firing before that
-- trigger, i.e. on alphabetical trigger ordering. Writing updated_at explicitly inside each
-- transition removes the exemption and the ordering question together.
--
-- ORDERING IS NOT RELIED UPON, TWICE OVER:
--   * The jsonb difference is taken against the FINAL value of NEW, so whatever any
--     earlier trigger did is visible here and is rejected unless it is permitted.
--   * That nothing runs AFTER this guard is guaranteed by the pgTAP suite, which asserts
--     the trigger inventory of this table is exactly three entries, one of them this
--     BEFORE UPDATE trigger with no column list.
--
-- THE TRIGGER IS UNQUALIFIED (`before update`, not `before update of ...`) DELIBERATELY. A
-- column-scoped trigger does not fire for `UPDATE ... SET updated_at = now()`, which is
-- exactly the update terminal immutability must reject.
create function public.receipt_extractions_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutable text[];
begin
  -- 1. TERMINAL IS TERMINAL. No column, no exception, updated_at included.
  if old.status = 'SUCCEEDED' or old.status = 'FAILED' then
    raise exception 'Receipt extraction attempt is immutable once complete'
      using errcode = 'check_violation';
  end if;

  -- 2. Identity is fixed at insert, in every state.
  if new.id is distinct from old.id
     or new.receipt_submission_id is distinct from old.receipt_submission_id
     or new.retailer_organization_id is distinct from old.retailer_organization_id
     or new.requested_by_profile_id is distinct from old.requested_by_profile_id
     or new.attempt_number is distinct from old.attempt_number
     or new.requested_at is distinct from old.requested_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Receipt extraction attempt identity is immutable'
      using errcode = 'check_violation';
  end if;

  if new.updated_at < old.updated_at then
    raise exception 'Receipt extraction updated_at may not move backwards'
      using errcode = 'check_violation';
  end if;

  -- 3. Select the transition and the columns it may change.
  if old.status = 'QUEUED' and new.status = 'PROCESSING' then
    -- A. The claim.
    v_mutable := array[
      'status', 'provider', 'provider_model', 'worker_claim_token',
      'started_at', 'expires_at', 'updated_at'
    ];

  elsif old.status = 'PROCESSING' and new.status = 'PROCESSING' then
    -- B. Operation registration, and nothing else. Permitted EXACTLY ONCE, because it
    --    requires the stored operation id to be null and leaves it non-null. There is no
    --    heartbeat and no claim extension in Milestone A: expires_at is deliberately NOT
    --    in the mutable set here.
    if old.provider_operation_id is not null
       or new.provider_operation_id is null
       or new.provider_operation_id <> btrim(new.provider_operation_id)
       or length(new.provider_operation_id) not between 1 and 200 then
      raise exception 'Receipt extraction operation registration is not permitted'
        using errcode = 'check_violation';
    end if;
    v_mutable := array['provider_operation_id', 'updated_at'];

  elsif old.status = 'PROCESSING' and new.status = 'SUCCEEDED' then
    -- C. Completion with a result. Provider, model, claim token, operation id, identity and
    --    start time all remain unchanged — none is in the mutable set.
    v_mutable := array[
      'status', 'completed_at', 'updated_at', 'warning_codes',
      'merchant_name', 'merchant_name_source_text', 'merchant_name_confidence',
      'document_number', 'document_number_source_text', 'document_number_confidence',
      'transaction_date', 'transaction_date_source_text', 'transaction_date_confidence',
      'transaction_time', 'transaction_time_source_text', 'transaction_time_confidence',
      'currency_code', 'currency_code_source_text', 'currency_code_confidence',
      'total_minor', 'total_source_text', 'total_confidence',
      'subtotal_minor', 'subtotal_source_text', 'subtotal_confidence',
      'tax_total_minor', 'tax_source_text', 'tax_confidence'
    ];

  elsif old.status = 'PROCESSING' and new.status = 'FAILED' then
    -- D. Completion with a failure.
    v_mutable := array['status', 'failure_code', 'completed_at', 'updated_at'];

  elsif old.status = 'QUEUED' and new.status = 'FAILED' then
    -- E. The reaper's queue path. Only one code is reachable here, and
    --    record_receipt_extraction_failure independently requires PROCESSING, so this
    --    transition belongs to expire_stale_receipt_extraction_claims alone.
    if new.failure_code is distinct from 'NEVER_CLAIMED' then
      raise exception 'Receipt extraction status transition is not permitted'
        using errcode = 'check_violation';
    end if;
    v_mutable := array['status', 'failure_code', 'completed_at', 'updated_at'];

  else
    raise exception 'Receipt extraction status transition is not permitted'
      using errcode = 'check_violation';
  end if;

  -- 4. EVERYTHING ELSE MUST BE BYTE-EQUIVALENT.
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'Receipt extraction attempt column is immutable for this transition'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger receipt_extractions_guard_update
  before update on public.receipt_extractions
  for each row execute function public.receipt_extractions_guard_update();

-- ---- PART 3c — no deletion -------------------------------------------------
-- An attempt log that can be deleted is not an attempt log. Also the reason the line-item
-- ON DELETE CASCADE below is unreachable in practice.
create function public.receipt_extractions_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Receipt extraction attempts are never deleted'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_extractions_guard_delete
  before delete on public.receipt_extractions
  for each row execute function public.receipt_extractions_guard_delete();

-- ---- RLS and privilege hardening -------------------------------------------
-- RLS ON, ZERO POLICIES, and no privilege for any role including service_role. Every read
-- and write goes through a SECURITY DEFINER RPC. A "members may read their own rows" policy
-- would be a second, independent definition of who may see what, and the RPCs already
-- answer that question correctly.
alter table public.receipt_extractions enable row level security;
revoke all on table public.receipt_extractions from public;
revoke all on table public.receipt_extractions from anon;
revoke all on table public.receipt_extractions from authenticated;
-- service_role TOO. Supabase's default privileges grant ALL on a new public table to
-- service_role, and revoking only from public/anon/authenticated leaves REFERENCES,
-- TRIGGER and TRUNCATE behind. TRUNCATE is the one that matters: it BYPASSES ROW
-- TRIGGERS, so it would defeat the never-delete and immutability guards on this table
-- outright. service_role reaches this table only through SECURITY DEFINER functions,
-- which run as the owner and are unaffected by the revoke.
revoke all on table public.receipt_extractions from service_role;

revoke all on function public.receipt_extractions_assert_tenant() from public;
revoke all on function public.receipt_extractions_guard_update() from public;
revoke all on function public.receipt_extractions_guard_delete() from public;

-- ============================================================================
-- PART 4 — public.receipt_extraction_line_items
-- ============================================================================
-- INFORMATIONAL ONLY IN MILESTONE A. Line items are shown beside the fields being reviewed
-- and nothing else: they are not confirmation evidence, they are not copied into
-- public.receipt_confirmations (which has no line-item column and no child table), and they
-- grant no reward eligibility — no reward, coin, campaign, claim or payout object exists in
-- this milestone or references this table.
create table public.receipt_extraction_line_items (
  id uuid primary key default gen_random_uuid(),

  -- ON DELETE CASCADE is the only cascade in this schema, and it is deliberate: a line item
  -- has no meaning without its extraction. It is UNREACHABLE in practice because
  -- receipt_extractions_guard_delete forbids deleting the parent; it exists so the foreign
  -- key can never become the reason a future, deliberate cleanup is impossible.
  receipt_extraction_id uuid not null
    references public.receipt_extractions (id) on delete cascade,

  -- 1-based, dense, unique within the extraction.
  line_number integer not null,

  description text,
  description_source_text text,

  -- The ONLY non-integer numeric in the extraction schema. Money is never numeric here.
  quantity numeric(12,3),
  quantity_source_text text,

  unit_price_minor bigint,
  unit_price_source_text text,

  line_total_minor bigint,
  line_total_source_text text,

  confidence numeric(4,3),

  -- No updated_at and no update trigger: written once, inside the same transaction as the
  -- parent's transition to SUCCEEDED, and never revised.
  created_at timestamptz not null default now(),

  constraint receipt_extraction_line_items_line_number_range
    check (line_number between 1 and 200),

  constraint receipt_extraction_line_items_description_shape
    check (
      description is null
      or (description = btrim(description) and length(description) between 1 and 500)
    ),

  -- Source text: nullable, trimmed, nonblank, bounded. As on the parent, nothing requires
  -- the normalized counterpart to be non-null.
  constraint receipt_extraction_line_items_description_source_shape
    check (
      description_source_text is null
      or (
        description_source_text = btrim(description_source_text)
        and length(description_source_text) between 1 and 1000
      )
    ),
  constraint receipt_extraction_line_items_quantity_source_shape
    check (
      quantity_source_text is null
      or (
        quantity_source_text = btrim(quantity_source_text)
        and length(quantity_source_text) between 1 and 100
      )
    ),
  constraint receipt_extraction_line_items_unit_price_source_shape
    check (
      unit_price_source_text is null
      or (
        unit_price_source_text = btrim(unit_price_source_text)
        and length(unit_price_source_text) between 1 and 100
      )
    ),
  constraint receipt_extraction_line_items_line_total_source_shape
    check (
      line_total_source_text is null
      or (
        line_total_source_text = btrim(line_total_source_text)
        and length(line_total_source_text) between 1 and 100
      )
    ),

  constraint receipt_extraction_line_items_quantity_range
    check (quantity is null or (quantity >= 0 and quantity <= 1000000)),
  constraint receipt_extraction_line_items_unit_price_range
    check (
      unit_price_minor is null
      or (unit_price_minor >= 0 and unit_price_minor <= 1000000000000)
    ),
  constraint receipt_extraction_line_items_line_total_range
    check (
      line_total_minor is null
      or (line_total_minor >= 0 and line_total_minor <= 1000000000000)
    ),
  constraint receipt_extraction_line_items_confidence_range
    check (confidence is null or confidence between 0 and 1)
);

comment on table public.receipt_extraction_line_items is
  'Informational normalized line items for a SUCCEEDED extraction. Worker-written, written once, never updated or deleted, and never confirmation evidence.';

create unique index receipt_extraction_line_items_ordinal_unique_idx
  on public.receipt_extraction_line_items (receipt_extraction_id, line_number);

-- Line items may exist only for a SUCCEEDED attempt. This is why
-- record_receipt_extraction_success transitions the parent FIRST and inserts second.
create function public.receipt_extraction_line_items_assert_parent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select x.status into v_status
  from public.receipt_extractions x
  where x.id = new.receipt_extraction_id;

  if v_status is null then
    raise exception 'Referenced receipt extraction does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_status <> 'SUCCEEDED' then
    raise exception 'Receipt extraction line items require a successful extraction'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger receipt_extraction_line_items_assert_parent
  before insert on public.receipt_extraction_line_items
  for each row execute function public.receipt_extraction_line_items_assert_parent();

-- Written once. Unqualified, so an updated_at-style no-op update is refused too.
create function public.receipt_extraction_line_items_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Receipt extraction line items are immutable'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_extraction_line_items_guard_change
  before update or delete on public.receipt_extraction_line_items
  for each row execute function public.receipt_extraction_line_items_guard_change();

alter table public.receipt_extraction_line_items enable row level security;
revoke all on table public.receipt_extraction_line_items from public;
revoke all on table public.receipt_extraction_line_items from anon;
revoke all on table public.receipt_extraction_line_items from authenticated;
-- service_role TOO. Supabase's default privileges grant ALL on a new public table to
-- service_role, and revoking only from public/anon/authenticated leaves REFERENCES,
-- TRIGGER and TRUNCATE behind. TRUNCATE is the one that matters: it BYPASSES ROW
-- TRIGGERS, so it would defeat the never-delete and immutability guards on this table
-- outright. service_role reaches this table only through SECURITY DEFINER functions,
-- which run as the owner and are unaffected by the revoke.
revoke all on table public.receipt_extraction_line_items from service_role;

revoke all on function public.receipt_extraction_line_items_assert_parent() from public;
revoke all on function public.receipt_extraction_line_items_guard_change() from public;

-- ============================================================================
-- PART 5 — public.receipt_confirmations
-- ============================================================================
-- ONE IMMUTABLE CONFIRMATION PER RECEIPT. No update, no delete, no revision in Milestone A.
--
-- NO DUPLICATE-SIGNAL COLUMN. Recording a "likely duplicate" flag now would be an IMMUTABLE
-- claim computed by a rule nobody has agreed, frozen into a table with no correction path,
-- and with no consumer: there is no review queue, no reward calculation and no Vendor or
-- Retailer visibility in this milestone. The exact image-hash rule that migration
-- 20260726090000 already enforces is unchanged and remains the only duplicate protection.
create table public.receipt_confirmations (
  id uuid primary key default gen_random_uuid(),

  -- The unique constraint IS the one-confirmation-per-receipt concurrency authority: two
  -- concurrent confirmations cannot both succeed, and the loser re-reads and reports
  -- ALREADY_CONFIRMED rather than raising.
  receipt_submission_id uuid not null
    references public.receipt_submissions (id) on delete restrict,

  -- All four are SERVER-DERIVED from the submission. There is no parameter for any of them.
  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,
  retailer_shop_id uuid not null
    references public.retailer_shops (id) on delete restrict,
  confirmed_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  -- SERVER-DERIVED: the SUCCEEDED attempt for this submission, or NULL when none exists.
  -- Never accepted as a parameter, so a caller cannot attribute their values to somebody
  -- else's extraction.
  source_extraction_id uuid
    references public.receipt_extractions (id) on delete restrict,

  -- SERVER-DERIVED by comparison. No parameter.
  entry_mode text not null,
  changed_fields text[] not null default '{}'::text[],

  -- ---- The confirmed values ------------------------------------------------
  -- Required: three. Optional: five.
  transaction_date date not null,
  transaction_time time without time zone,
  currency_code text not null
    references public.iso_currency_codes (code) on delete restrict,
  total_minor bigint not null,
  subtotal_minor bigint,
  tax_total_minor bigint,
  merchant_name text,
  document_number text,

  -- No updated_at and no set_updated_at trigger: the table is append-only, like
  -- public.audit_logs.
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint receipt_confirmations_submission_unique unique (receipt_submission_id),

  constraint receipt_confirmations_entry_mode_allowed
    check (entry_mode = any (array['MANUAL'::text, 'EXTRACTED'::text, 'MIXED'::text])),

  -- Ties the mode to the evidence honestly: MANUAL means there was no successful extraction
  -- to compare against, and that is exactly when source_extraction_id is null.
  constraint receipt_confirmations_manual_has_no_source
    check ((entry_mode = 'MANUAL') = (source_extraction_id is null)),
  constraint receipt_confirmations_extracted_unchanged
    check (entry_mode <> 'EXTRACTED' or cardinality(changed_fields) = 0),
  constraint receipt_confirmations_manual_unchanged
    check (entry_mode <> 'MANUAL' or cardinality(changed_fields) = 0),
  constraint receipt_confirmations_mixed_has_changes
    check (entry_mode <> 'MIXED' or cardinality(changed_fields) >= 1),

  constraint receipt_confirmations_changed_fields_allowed
    check (
      changed_fields <@ array[
        'currency_code'::text,
        'document_number'::text,
        'merchant_name'::text,
        'subtotal_minor'::text,
        'tax_total_minor'::text,
        'total_minor'::text,
        'transaction_date'::text,
        'transaction_time'::text
      ]
    ),

  -- Same monetary rules as the extraction, and again NO subtotal + tax = total constraint.
  constraint receipt_confirmations_total_range
    check (total_minor >= 0 and total_minor <= 1000000000000),
  constraint receipt_confirmations_subtotal_range
    check (subtotal_minor is null or (subtotal_minor >= 0 and subtotal_minor <= 1000000000000)),
  constraint receipt_confirmations_tax_range
    check (tax_total_minor is null or (tax_total_minor >= 0 and tax_total_minor <= 1000000000000)),

  constraint receipt_confirmations_transaction_date_floor
    check (transaction_date >= date '2000-01-01'),
  constraint receipt_confirmations_transaction_time_minute
    check (transaction_time is null or date_part('second', transaction_time) = 0),

  constraint receipt_confirmations_merchant_name_shape
    check (
      merchant_name is null
      or (merchant_name = btrim(merchant_name) and length(merchant_name) between 1 and 255)
    ),
  constraint receipt_confirmations_document_number_shape
    check (
      document_number is null
      or (document_number = btrim(document_number) and length(document_number) between 1 and 100)
    )
);

comment on table public.receipt_confirmations is
  'One immutable confirmation per receipt submission. Retailer, shop, profile, source extraction, entry mode and changed fields are all server-derived.';

create index receipt_confirmations_retailer_confirmed_idx
  on public.receipt_confirmations (retailer_organization_id, confirmed_at desc);
create index receipt_confirmations_profile_confirmed_idx
  on public.receipt_confirmations (confirmed_by_profile_id, confirmed_at desc);
create index receipt_confirmations_source_extraction_idx
  on public.receipt_confirmations (source_extraction_id)
  where source_extraction_id is not null;

create function public.receipt_confirmations_assert_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission public.receipt_submissions%rowtype;
  v_extraction public.receipt_extractions%rowtype;
begin
  select * into v_submission
  from public.receipt_submissions s
  where s.id = new.receipt_submission_id;

  if v_submission.id is null then
    raise exception 'Referenced receipt submission does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_submission.status <> 'SUBMITTED' then
    raise exception 'Receipt confirmation requires a submitted receipt'
      using errcode = 'check_violation';
  end if;

  if new.retailer_organization_id <> v_submission.retailer_organization_id
     or new.retailer_shop_id <> v_submission.retailer_shop_id then
    raise exception 'Receipt confirmation tenant must match the submission'
      using errcode = 'check_violation';
  end if;

  if new.confirmed_by_profile_id <> v_submission.submitted_by_profile_id then
    raise exception 'Receipt confirmation actor must be the receipt submitter'
      using errcode = 'check_violation';
  end if;

  if new.source_extraction_id is not null then
    select * into v_extraction
    from public.receipt_extractions x
    where x.id = new.source_extraction_id;

    if v_extraction.id is null then
      raise exception 'Referenced receipt extraction does not exist'
        using errcode = 'foreign_key_violation';
    end if;
    -- The evidence must belong to THIS receipt and must actually have succeeded.
    if v_extraction.receipt_submission_id <> new.receipt_submission_id then
      raise exception 'Receipt confirmation evidence must belong to the same receipt'
        using errcode = 'check_violation';
    end if;
    if v_extraction.status <> 'SUCCEEDED' then
      raise exception 'Receipt confirmation evidence must be a successful extraction'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger receipt_confirmations_assert_tenant
  before insert on public.receipt_confirmations
  for each row execute function public.receipt_confirmations_assert_tenant();

-- Immutability. Unqualified, so no column and no no-op update slips through, and DELETE is
-- refused by the same function.
create function public.receipt_confirmations_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A receipt confirmation is immutable'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_confirmations_guard_change
  before update or delete on public.receipt_confirmations
  for each row execute function public.receipt_confirmations_guard_change();

alter table public.receipt_confirmations enable row level security;
revoke all on table public.receipt_confirmations from public;
revoke all on table public.receipt_confirmations from anon;
revoke all on table public.receipt_confirmations from authenticated;
-- service_role TOO. Supabase's default privileges grant ALL on a new public table to
-- service_role, and revoking only from public/anon/authenticated leaves REFERENCES,
-- TRIGGER and TRUNCATE behind. TRUNCATE is the one that matters: it BYPASSES ROW
-- TRIGGERS, so it would defeat the never-delete and immutability guards on this table
-- outright. service_role reaches this table only through SECURITY DEFINER functions,
-- which run as the owner and are unaffected by the revoke.
revoke all on table public.receipt_confirmations from service_role;

revoke all on function public.receipt_confirmations_assert_tenant() from public;
revoke all on function public.receipt_confirmations_guard_change() from public;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One permission, one role mapping, four tables with their constraints, indexes and
-- triggers, and one seeded runtime row. No RPC. No raw-payload table. No storage bucket and
-- no storage policy. No existing table, column, constraint, index, trigger, function, role,
-- permission or mapping is created, altered or dropped — public.receipt_submissions and all
-- five of its operations are byte-untouched — and no table privilege is granted to any
-- role, including service_role.
