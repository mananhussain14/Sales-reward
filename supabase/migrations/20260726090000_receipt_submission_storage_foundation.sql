-- Migration: receipt_submission_storage_foundation
-- Purpose: The storage + authorization-root foundation for Sales Staff receipt
--          submission. It adds, and only adds:
--            1. The RECEIPT_SUBMIT permission, mapped to SALES_STAFF and to no other
--               role — the single fact that makes this a Sales Staff capability.
--            2. public.receipt_submissions — the tenant-scoped submission record.
--            3. The private `receipts` Supabase Storage bucket.
--          Plus the validation/immutability triggers, indexes (including the
--          duplicate-protection unique index), and default-deny RLS + privilege
--          hardening.
--
-- WHY A NEW PERMISSION RATHER THAN REUSING ONE
--   Before this migration SALES_STAFF held exactly one mapping, RETAILER_PORTAL_READ,
--   which RETAILER_OWNER and RETAILER_MANAGER also hold. Gating submission on any
--   existing permission would therefore have let an Owner or a Manager submit a
--   receipt merely because they run the Retailer — precisely what this milestone must
--   prevent. RECEIPT_SUBMIT is mapped to SALES_STAFF ALONE, so
--   resolve_retailer_member_organization('RECEIPT_SUBMIT') resolves for a Sales Staff
--   member and for nobody else. The mapping is the authority: no operation added here
--   or in the operations migration names a role code.
--
-- WHY NO NEW RESOLVER
--   public.resolve_retailer_member_organization(text) (migration 20260723090000)
--   already evaluates the whole chain in SQL — ACTIVE profile owned by auth.uid(),
--   ACTIVE membership, ACTIVE RETAILER organization, ACTIVE role reached through that
--   membership, and the named permission — and fails closed when a caller resolves to
--   zero or to more than one qualifying Retailer. A second resolver would be a second
--   definition free to drift, and only one of the two could be right.
--
-- THE FILE NEVER ENTERS POSTGRESQL. This table records METADATA about an object that
--   lives in Supabase Storage. There is no bytea column, no base64 column, and no
--   large-object reference. The only link is storage_bucket + storage_object_path.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No OCR, no receipt parsing, no product or SKU matching, no reviewer queue, no
--   approval or rejection state, no incentive, campaign, reward, coin or payout
--   object, and no Vendor reporting. No RPC — every operation lives in the ordered
--   operations migration that follows. No storage POLICY of any kind: storage.objects
--   and storage.buckets already have RLS enabled with zero policies, which is exactly
--   the default-deny posture this MVP wants, and adding a policy would open a browser
--   path to object bytes that server-mediated upload does not need.
--
-- Idempotency posture: plain CREATE / INSERT (no IF NOT EXISTS, no CREATE OR REPLACE,
--   no ON CONFLICT). A conflicting existing object FAILS the migration. No fixed
--   UUIDs — the permission row takes the table's gen_random_uuid() default and is
--   joined by CODE below. All identifiers are <= 63 bytes.
--
-- Dependencies: 20260716124419 (profiles, organizations), 20260716125559 (roles,
--   permissions, role_permissions, set_updated_at), 20260717094520 (retailer_shops,
--   retailer_shop_members), 20260723090000 (resolve_retailer_member_organization).

-- ============================================================================
-- PART 1 — the RECEIPT_SUBMIT permission and its single role mapping
-- ============================================================================
insert into public.permissions (code, name, description, module)
values (
  'RECEIPT_SUBMIT',
  'Submit sales receipts',
  'Submit a customer receipt for the shops this staff member is actively assigned to.',
  'RECEIPTS'
);

-- Mapped to SALES_STAFF and to nothing else. Joined by CODE rather than by a literal
-- UUID so this migration depends on the seeded catalogue rather than restating it.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'RECEIPT_SUBMIT'
where r.code = 'SALES_STAFF';

-- ============================================================================
-- PART 2 — public.receipt_submissions
-- ============================================================================
create table public.receipt_submissions (
  id uuid primary key default gen_random_uuid(),

  -- Tenant scope. DERIVED by the reservation RPC from auth.uid(); never supplied by a
  -- browser. RESTRICT on delete because a submission is a record of something that
  -- happened and must not vanish with its organization.
  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  -- The shop the receipt was taken at. The browser DOES choose this, and it is the
  -- only identifier it may choose — the reservation RPC then proves the caller is
  -- actively assigned to it, that it is ACTIVE, and that it belongs to the Retailer it
  -- derived. The trigger below is defence in depth over that last check.
  retailer_shop_id uuid not null
    references public.retailer_shops (id) on delete restrict,

  -- Who submitted it. ALWAYS auth.uid(); there is no parameter for it anywhere.
  submitted_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  -- Where the object lives. BOTH are generated by the reservation RPC — the bucket is
  -- a fixed literal and the path is built from ids the RPC derived — so no browser
  -- value reaches either, and finalization re-asserts the path it stored here.
  storage_bucket text not null,
  storage_object_path text not null,

  -- Display metadata. The filename is the SANITIZED original, kept only so the staff
  -- member recognises their own submission in the history list. It never forms part of
  -- the storage path.
  original_file_name text not null,
  mime_type text not null,
  file_size_bytes bigint not null,

  -- The server-computed SHA-256 of the file bytes, lowercase hex. Recorded at
  -- RESERVATION so the duplicate-protection index below can act before anything is
  -- uploaded, and re-asserted at finalization so a stale finalize cannot attach a
  -- different file to this row.
  file_sha256 text not null,

  status text not null default 'RESERVED',

  -- Delivery-failure classification. A fixed vocabulary; no provider text is ever
  -- accepted or stored.
  failure_code text,
  failure_recorded_at timestamptz,

  submitted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ---- Lifecycle -----------------------------------------------------------
  -- Three states and no more. RESERVED (row exists, object not yet uploaded),
  -- SUBMITTED (object uploaded and recorded), UPLOAD_FAILED (the upload did not
  -- complete). There is deliberately NO review, approval, rejection, or payout state:
  -- none of those workflows exists yet, and inventing the vocabulary now would fix a
  -- shape before the requirement is known.
  constraint receipt_submissions_status_allowed
    check (status = any (array['RESERVED'::text, 'SUBMITTED'::text, 'UPLOAD_FAILED'::text])),

  -- submitted_at moves with the status, in one direction, so a row can never claim to
  -- be SUBMITTED without recording when.
  constraint receipt_submissions_submitted_consistent
    check ((status = 'SUBMITTED') = (submitted_at is not null)),

  constraint receipt_submissions_failure_consistent
    check ((failure_code is null) = (failure_recorded_at is null)),

  -- A failure classification may exist only on a failed row, and only one value is
  -- permitted. A provider message could name a bucket, a key, or a request id.
  constraint receipt_submissions_failure_context
    check (failure_code is null or status = 'UPLOAD_FAILED'),
  constraint receipt_submissions_failure_code_allowed
    check (failure_code is null or failure_code = 'STORAGE_UPLOAD_FAILED'),

  -- ---- File facts ----------------------------------------------------------
  -- Byte-identical to the shape the application computes with node:crypto.
  constraint receipt_submissions_file_sha256_format
    check ((file_sha256 collate "C") ~ '^[0-9a-f]{64}$'),

  -- The accepted image types for this MVP. PDF is deliberately absent: no existing
  -- product requirement or storage convention in this repository supports it, and
  -- accepting a format the application cannot verify by file signature would make the
  -- declared type authoritative again.
  constraint receipt_submissions_mime_type_allowed
    check (mime_type = any (array['image/jpeg'::text, 'image/png'::text, 'image/webp'::text])),

  -- Empty files are rejected, and 10 MB is the MVP ceiling (no prior convention
  -- existed). The bucket carries the same limit, so the two agree.
  constraint receipt_submissions_file_size_range
    check (file_size_bytes > 0 and file_size_bytes <= 10485760),

  constraint receipt_submissions_file_name_not_empty
    check (length(btrim(original_file_name)) > 0 and length(original_file_name) <= 255),
  constraint receipt_submissions_file_name_trimmed
    check (original_file_name = btrim(original_file_name)),

  constraint receipt_submissions_bucket_not_empty
    check (length(btrim(storage_bucket)) > 0),

  -- A path may not be absolute, may not traverse, and may not be blank. The path is
  -- server-generated, so this can only fire on a defect — which is why it is here.
  constraint receipt_submissions_object_path_shape
    check (
      length(btrim(storage_object_path)) > 0
      and storage_object_path not like '/%'
      and storage_object_path not like '%..%'
    )
);

comment on table public.receipt_submissions is
  'One customer receipt submitted by a Sales Staff member for one assigned shop. Metadata only: the file itself lives in the private `receipts` Storage bucket.';

-- ---- Indexes ---------------------------------------------------------------

-- DUPLICATE PROTECTION, and the concurrency authority for it.
--
-- Scoped to (Retailer, submitter, hash) so it answers exactly one question: "has THIS
-- person already got a live submission of THIS file for THIS Retailer?" It is NOT a
-- global hash index, deliberately — a cross-tenant unique index would turn any upload
-- into an oracle for whether some stranger had already submitted the same image.
--
-- UPLOAD_FAILED rows are excluded from the index so a staff member whose upload failed
-- can immediately retry the same file. RESERVED rows ARE included, so two concurrent
-- submissions of one file cannot both reserve.
create unique index receipt_submissions_active_hash_unique_idx
  on public.receipt_submissions (retailer_organization_id, submitted_by_profile_id, file_sha256)
  where status <> 'UPLOAD_FAILED';

-- The personal history read: one staff member's rows, newest first.
create index receipt_submissions_submitter_created_idx
  on public.receipt_submissions (submitted_by_profile_id, created_at desc);

-- Tenant-scoped scans, for future Retailer-level reporting.
create index receipt_submissions_retailer_created_idx
  on public.receipt_submissions (retailer_organization_id, created_at desc);

create index receipt_submissions_shop_idx
  on public.receipt_submissions (retailer_shop_id);

-- The object path is unique across the table: it is built from the submission's own
-- id plus a random component, so a collision would mean two rows pointing at one
-- object — which must be impossible, not merely unlikely.
create unique index receipt_submissions_object_path_unique_idx
  on public.receipt_submissions (storage_bucket, storage_object_path);

-- ---- Triggers --------------------------------------------------------------

create trigger set_updated_at_on_receipt_submissions
  before update on public.receipt_submissions
  for each row execute function public.set_updated_at();

-- The shop must belong to the submission's own Retailer.
--
-- Reachable despite the foreign keys: BEFORE ROW triggers fire before FKs are checked
-- (foreign keys are AFTER ROW triggers), so this validator can run against an id no
-- row owns. Denying here is both correct and earlier than the FK would be. The message
-- names the RULE and never a row — an error string is not a safe place to describe
-- data the caller may not read.
create function public.receipt_submissions_assert_shop_retailer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop_retailer uuid;
begin
  select s.retailer_organization_id
    into v_shop_retailer
  from public.retailer_shops s
  where s.id = new.retailer_shop_id;

  if v_shop_retailer is null then
    raise exception 'Referenced shop does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_shop_retailer <> new.retailer_organization_id then
    raise exception 'Receipt shop must belong to the same Retailer as the submission'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger receipt_submissions_assert_shop_on_insert
  before insert on public.receipt_submissions
  for each row execute function public.receipt_submissions_assert_shop_retailer();

create trigger receipt_submissions_assert_shop_on_update
  before update of retailer_organization_id, retailer_shop_id
  on public.receipt_submissions
  for each row
  when (
    new.retailer_organization_id is distinct from old.retailer_organization_id
    or new.retailer_shop_id is distinct from old.retailer_shop_id
  )
  execute function public.receipt_submissions_assert_shop_retailer();

-- The identity of a submission is fixed at reservation.
--
-- Finalization records WHERE the object landed and that it is SUBMITTED; it must never
-- be able to move a submission to another Retailer, another shop, another person,
-- another file, or another bucket/path than the one reserved. Making that structural
-- is what lets the finalization RPC be simple.
create function public.receipt_submissions_assert_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.retailer_organization_id is distinct from old.retailer_organization_id then
    raise exception 'Receipt submission Retailer is immutable'
      using errcode = 'check_violation';
  end if;
  if new.retailer_shop_id is distinct from old.retailer_shop_id then
    raise exception 'Receipt submission shop is immutable'
      using errcode = 'check_violation';
  end if;
  if new.submitted_by_profile_id is distinct from old.submitted_by_profile_id then
    raise exception 'Receipt submission submitter is immutable'
      using errcode = 'check_violation';
  end if;
  if new.file_sha256 is distinct from old.file_sha256 then
    raise exception 'Receipt submission file hash is immutable'
      using errcode = 'check_violation';
  end if;
  if new.storage_bucket is distinct from old.storage_bucket
     or new.storage_object_path is distinct from old.storage_object_path then
    raise exception 'Receipt submission storage location is immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger receipt_submissions_assert_immutable_on_update
  before update of
    retailer_organization_id,
    retailer_shop_id,
    submitted_by_profile_id,
    file_sha256,
    storage_bucket,
    storage_object_path
  on public.receipt_submissions
  for each row execute function public.receipt_submissions_assert_immutable();

-- ---- RLS and privilege hardening -------------------------------------------
--
-- RLS ON, and ZERO POLICIES. Default deny is the whole design: every read and write
-- goes through a SECURITY DEFINER RPC that resolves the caller from auth.uid(). A
-- "members may read their own rows" policy would be a second, independent definition
-- of who may see what, and the RPC already answers that question correctly.
--
-- No privilege is granted to anon or authenticated, so a browser cannot SELECT,
-- INSERT, UPDATE or DELETE this table even if a policy were added by mistake.
alter table public.receipt_submissions enable row level security;

revoke all on table public.receipt_submissions from public;
revoke all on table public.receipt_submissions from anon;
revoke all on table public.receipt_submissions from authenticated;

-- The trigger functions are internal; nothing but the table's own triggers may call
-- them. Matches the posture of every other validator in this schema.
revoke all on function public.receipt_submissions_assert_shop_retailer() from public;
revoke all on function public.receipt_submissions_assert_immutable() from public;

-- ============================================================================
-- PART 3 — the private `receipts` Storage bucket
-- ============================================================================
-- PRIVATE, and it must stay private: `public = false` means Storage will not serve an
-- object from this bucket over an unauthenticated URL, so there is no permanent public
-- link to a customer's receipt. Reading one requires either the service-role key or a
-- short-lived signed URL minted server-side after an ownership check.
--
-- NO STORAGE POLICY IS CREATED. storage.objects and storage.buckets already have RLS
-- enabled with zero policies, so anon and authenticated can neither read nor write an
-- object; only the service-role client (which bypasses RLS) can. That is exactly the
-- server-mediated posture this MVP wants, and it is achieved by adding nothing.
--
-- The limits below are a second, independent ceiling: the application validates the
-- size and the file signature before uploading, the table constrains the recorded
-- values, and Storage itself refuses anything outside these bounds. Three agreeing
-- checks, none relying on the browser's declared content type.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
);

-- ============================================================================
-- Closing note
-- ============================================================================
-- One permission, one role mapping, one table (with its indexes and triggers), and one
-- private bucket. No RPC, no policy on any table in any schema, no change to any
-- existing table, function, role, or permission mapping, and no privilege granted to
-- any browser role. OCR, parsing, SKU matching, review, approval, incentives, rewards,
-- coins, payouts and Vendor reporting are all deliberately absent.
