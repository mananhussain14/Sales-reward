-- Migration: receipt_submission_operations
-- Purpose: The five operations over the receipt-submission storage foundation
--          (migration 20260726090000). Adds exactly FIVE functions and nothing else:
--            1. list_my_assigned_receipt_shops()                 [authenticated]
--            2. reserve_receipt_submission(uuid, text, text, bigint, text)
--                                                                [authenticated]
--            3. finalize_receipt_submission_upload(uuid, text, text, text, bigint)
--                                                                [service_role]
--            4. record_receipt_submission_upload_failure(uuid, text)
--                                                                [service_role]
--            5. list_my_receipt_submissions()                    [authenticated]
--
-- THE RESERVE -> UPLOAD -> FINALIZE CONTRACT
--   The object bytes never pass through PostgreSQL, so the database cannot observe the
--   upload directly. It therefore brackets it:
--
--     reserve   (caller's own token) authorizes the person, validates the shop
--               assignment, records the file's facts INCLUDING its SHA-256, and
--               generates the private object path from ids it derived itself. The row
--               is RESERVED: it exists, but claims nothing about an object.
--     upload    happens outside SQL, in server-only application code, through the
--               service-role Storage client.
--     finalize  (service_role) re-asserts every fact the reservation recorded — hash,
--               path, type, size — and only then marks the row SUBMITTED. A finalize
--               that disagrees on any of them is refused, so a stale or crossed
--               callback can never attach a different file to this row.
--
--   The two ends are split across two privilege levels ON PURPOSE. Reservation must
--   run as the staff member so auth.uid() means something; finalization must not be
--   reachable by a browser at all, because a caller who could invoke it would be able
--   to mark a submission complete without ever uploading anything.
--
-- WHAT THE BROWSER MAY INFLUENCE, EXHAUSTIVELY
--   One shop id, and the file. Everything else — the Retailer, the submitting profile,
--   the membership, the bucket, the object path, the status, and the hash the database
--   trusts — is derived here or supplied by server-only code. There is no parameter for
--   an organization id, a profile id, a membership id, a role id, or a status anywhere
--   in this file.
--
--   No optional receipt metadata is accepted in this MVP: no purchase amount, date,
--   invoice number, or free text. None is required by the vertical slice, and every
--   field accepted from a browser is a field that must be validated, stored, displayed
--   and eventually migrated.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No OCR, no receipt parsing, no product or SKU matching, no reviewer queue, no
--   approval or rejection, no incentive, campaign, reward, coin or payout logic, and no
--   Vendor reporting. No signed-URL function: the history UI in this milestone shows
--   submission facts, not the image, so an operation that mints a link to a customer's
--   receipt would be an unused capability. When receipt viewing is built, the safe
--   shape is an ownership-check RPC plus a short-lived signed URL minted in server-only
--   application code — never a permanent URL returned from SQL.
--   No table, column, constraint, index, trigger, policy, role, permission or mapping
--   is created or altered here, and no existing function is touched.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration. No fixed UUIDs. No dynamic SQL.
--   All identifiers are <= 63 bytes. Every reference is schema-qualified because every
--   function runs with an EMPTY search_path.
--
-- Dependencies: 20260716124419 (profiles, organizations), 20260717094520
--   (retailer_shops, retailer_shop_members, organization_members),
--   20260723090000 (resolve_retailer_member_organization), 20260726090000
--   (receipt_submissions, the RECEIPT_SUBMIT permission and the `receipts` bucket).

-- ============================================================================
-- FUNCTION 1 — list_my_assigned_receipt_shops()
-- ============================================================================
-- The ACTIVE shops the calling Sales Staff member is ACTIVELY assigned to, and no
-- others. This is the only source of shop ids the receipt UI has.
--
-- NO TENANT INPUT. Zero arguments: there is no Retailer id, membership id or profile id
-- to pass, so no URL segment, form field, header or cookie can nominate whose shops are
-- returned. The Retailer is derived from auth.uid() through the established resolver on
-- RECEIPT_SUBMIT — a permission mapped to SALES_STAFF alone, so a Retailer Owner or
-- Manager resolves NULL here and is refused.
--
-- UNAUTHORIZED IS AN EXCEPTION, NOT AN EMPTY LIST. A denial and "you have no shops
-- assigned yet" are different facts and the page renders them differently; collapsing
-- them would tell an unassigned staff member they lack permission.
create function public.list_my_assigned_receipt_shops()
returns table (
  shop_id   uuid,
  shop_name text,
  shop_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_SUBMIT');

  if v_retailer is null then
    raise exception 'Not authorized to submit receipts'
      using errcode = 'insufficient_privilege';
  end if;

  -- The assignment chain, stated once: the caller's ACTIVE membership of the resolved
  -- Retailer, a LIVE shop assignment on it (removed_at is null), and a shop that is
  -- ACTIVE and belongs to that same Retailer. Ordering is deterministic so the
  -- selector's option order is stable across renders.
  return query
  select s.id, s.name, s.code
  from public.organization_members m
  join public.retailer_shop_members sm
    on sm.organization_member_id = m.id
   and sm.removed_at is null
  join public.retailer_shops s
    on s.id = sm.retailer_shop_id
  where m.organization_id = v_retailer
    and m.user_id = auth.uid()
    and m.status = 'ACTIVE'
    and s.retailer_organization_id = v_retailer
    and s.status = 'ACTIVE'
  order by s.name, s.code nulls last, s.id;
end;
$$;

revoke all     on function public.list_my_assigned_receipt_shops() from public;
revoke execute on function public.list_my_assigned_receipt_shops() from anon;
grant  execute on function public.list_my_assigned_receipt_shops() to authenticated;

-- ============================================================================
-- FUNCTION 2 — reserve_receipt_submission(uuid, text, text, bigint, text)
-- ============================================================================
-- Authorizes the submission, validates the chosen shop, and creates the RESERVED row —
-- before a single byte is uploaded, so a refusal costs nothing and leaves nothing
-- behind.
--
-- IT RETURNS THE OBJECT PATH IT GENERATED, and that is the point. The path is built
-- from the Retailer id, the profile id and the new submission id — three values the
-- caller does not have and must not supply — plus a random component. Handing it back
-- to the server-only uploader is what makes "the browser cannot choose where the file
-- lands" structural rather than a convention: finalization later re-asserts that the
-- path it is given equals the one stored here.
--
-- The two returned values never reach a browser. They are consumed by server-only
-- application code and are absent from every value that code returns to the page.
create function public.reserve_receipt_submission(
  p_shop_id            uuid,
  p_original_file_name text,
  p_mime_type          text,
  p_file_size_bytes    bigint,
  p_file_sha256        text
)
returns table (
  submission_id       uuid,
  storage_bucket      text,
  storage_object_path text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_retailer    uuid;
  v_uid         uuid;
  v_member_id   uuid;
  v_shop_id     uuid;
  v_name        text;
  v_id          uuid;
  v_path        text;
  v_extension   text;
  v_constraint  text;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization — identity and Retailer, never browser-supplied
  -- --------------------------------------------------------------------------
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Not authorized to submit receipts'
      using errcode = 'insufficient_privilege';
  end if;

  v_retailer := public.resolve_retailer_member_organization('RECEIPT_SUBMIT');
  if v_retailer is null then
    raise exception 'Not authorized to submit receipts'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Input validation
  -- --------------------------------------------------------------------------
  -- The application validates all of this first (and derives the MIME type from the
  -- file's own signature rather than the browser's claim). It is restated here because
  -- an RPC granted to `authenticated` is a public endpoint, reachable by a hand-crafted
  -- call that never went near the form. The table's CHECK constraints are the final
  -- authority; these produce a clean refusal before an INSERT is attempted.
  v_name := btrim(coalesce(p_original_file_name, ''));

  if v_name = '' or length(v_name) > 255 then
    raise exception 'That receipt file could not be accepted'
      using errcode = 'check_violation';
  end if;
  if p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'That receipt file could not be accepted'
      using errcode = 'check_violation';
  end if;
  if p_file_size_bytes is null or p_file_size_bytes <= 0 or p_file_size_bytes > 10485760 then
    raise exception 'That receipt file could not be accepted'
      using errcode = 'check_violation';
  end if;
  if p_file_sha256 is null or p_file_sha256 collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'That receipt file could not be accepted'
      using errcode = 'check_violation';
  end if;
  if p_shop_id is null then
    raise exception 'Select one of your assigned shops'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. The caller's ACTIVE membership of the resolved Retailer
  -- --------------------------------------------------------------------------
  -- The resolver already proved this exists; it is re-read because the SHOP ASSIGNMENT
  -- is keyed by membership id, and deriving that id here rather than accepting one is
  -- what stops a caller submitting under someone else's assignment.
  select m.id
    into v_member_id
  from public.organization_members m
  where m.organization_id = v_retailer
    and m.user_id = v_uid
    and m.status = 'ACTIVE';

  if v_member_id is null then
    raise exception 'Not authorized to submit receipts'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. The chosen shop must be ACTIVE, this Retailer's, and ACTIVELY ASSIGNED
  -- --------------------------------------------------------------------------
  -- One query, four conditions, one generic refusal. An unassigned shop, an inactive
  -- shop, another Retailer's shop and a shop id that does not exist are reported
  -- IDENTICALLY — distinguishing them would let a staff member probe another
  -- Retailer's estate one id at a time.
  --
  -- FOR SHARE holds the shop against a concurrent status change until this transaction
  -- ends, so a shop cannot be deactivated between this check and the insert.
  select s.id
    into v_shop_id
  from public.retailer_shops s
  join public.retailer_shop_members sm
    on sm.retailer_shop_id = s.id
   and sm.organization_member_id = v_member_id
   and sm.removed_at is null
  where s.id = p_shop_id
    and s.retailer_organization_id = v_retailer
    and s.status = 'ACTIVE'
  for share of s;

  if v_shop_id is null then
    raise exception 'Select one of your assigned shops'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Generate the private object path
  -- --------------------------------------------------------------------------
  -- <retailer>/<profile>/<submission>/<random>.<ext>
  --
  -- Every segment is derived, none is supplied. The random leaf means the path cannot
  -- be guessed from the ids alone, and the extension is mapped from the VALIDATED type
  -- rather than taken from the uploaded filename — a filename is attacker-controlled
  -- text and has no business shaping a storage key.
  v_id := gen_random_uuid();
  v_extension := case p_mime_type
    when 'image/jpeg' then '.jpg'
    when 'image/png'  then '.png'
    when 'image/webp' then '.webp'
  end;

  v_path := v_retailer::text || '/' || v_uid::text || '/' || v_id::text || '/'
            || gen_random_uuid()::text || v_extension;

  -- --------------------------------------------------------------------------
  -- 6. Reserve
  -- --------------------------------------------------------------------------
  -- receipt_submissions_active_hash_unique_idx is the concurrency authority for
  -- duplicate protection: it permits at most one non-failed row per
  -- (Retailer, submitter, file hash), so two concurrent submissions of the same file
  -- cannot both reserve. It is caught and reported as a distinct, SAFE outcome — the
  -- index is scoped to the caller's own submissions, so "you have already submitted
  -- this receipt" describes only their own data and reveals nothing about anyone else's.
  -- Any OTHER unique violation is re-raised unchanged.
  begin
    insert into public.receipt_submissions (
      id,
      retailer_organization_id,
      retailer_shop_id,
      submitted_by_profile_id,
      storage_bucket,
      storage_object_path,
      original_file_name,
      mime_type,
      file_size_bytes,
      file_sha256,
      status
    )
    values (
      v_id,
      v_retailer,
      v_shop_id,
      v_uid,
      'receipts',
      v_path,
      v_name,
      p_mime_type,
      p_file_size_bytes,
      p_file_sha256,
      'RESERVED'
    );
  exception when unique_violation then
    declare
      v_inner text;
    begin
      get stacked diagnostics v_inner = constraint_name;
      if v_inner = 'receipt_submissions_active_hash_unique_idx' then
        raise exception 'You have already submitted this receipt'
          using errcode = 'unique_violation';
      end if;
      raise;
    end;
  end;

  return query select v_id, 'receipts'::text, v_path;
end;
$$;

revoke all     on function public.reserve_receipt_submission(uuid, text, text, bigint, text) from public;
revoke execute on function public.reserve_receipt_submission(uuid, text, text, bigint, text) from anon;
grant  execute on function public.reserve_receipt_submission(uuid, text, text, bigint, text) to authenticated;

-- ============================================================================
-- FUNCTION 3 — finalize_receipt_submission_upload(uuid, text, text, text, bigint)
-- ============================================================================
-- The "the object is really in the bucket" callback. Marks a RESERVED submission
-- SUBMITTED, and only when every fact it is given matches the reservation exactly.
--
-- WHY service_role ONLY
--   This function runs on behalf of trusted server-side code with no auth.uid(): the
--   uploader has no browser session of its own, and the row it names was reserved
--   moments earlier by that same server code. Reachable by a browser role, it would let
--   any caller who learned a submission id mark a receipt as submitted without ever
--   uploading a file. Every browser role is stripped explicitly.
--
-- REPEATED AND STALE FINALIZATION
--   A duplicate callback for a row that is already SUBMITTED with the SAME hash and
--   path is an idempotent no-op — a retried request must not become an error the
--   uploader reports to a staff member whose receipt is safely stored. Anything else —
--   an unknown id, a mismatched hash, path, type or size, or a row that is
--   UPLOAD_FAILED — is refused generically. No partial update is possible: the single
--   UPDATE is the only write.
create function public.finalize_receipt_submission_upload(
  p_submission_id         uuid,
  p_expected_file_sha256  text,
  p_storage_object_path   text,
  p_mime_type             text,
  p_file_size_bytes       bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row       public.receipt_submissions%rowtype;
  v_finalized integer;
begin
  if p_submission_id is null
     or p_expected_file_sha256 is null
     or p_expected_file_sha256 collate "C" !~ '^[0-9a-f]{64}$'
     or p_storage_object_path is null
     or p_mime_type is null
     or p_file_size_bytes is null then
    raise exception 'Receipt submission could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- Lock the row; concurrent finalizations serialize here.
  select * into v_row
  from public.receipt_submissions
  where id = p_submission_id
  for update;

  if v_row.id is null then
    raise exception 'Receipt submission could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- Every fact must match the reservation. This is what makes a stale or crossed
  -- callback harmless: it cannot attach a different file, a different object, or
  -- different metadata to a row that was reserved for something else.
  if v_row.file_sha256 <> p_expected_file_sha256
     or v_row.storage_object_path <> p_storage_object_path
     or v_row.mime_type <> p_mime_type
     or v_row.file_size_bytes <> p_file_size_bytes then
    raise exception 'Receipt submission could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- Idempotent duplicate callback for a row that is already complete.
  if v_row.status = 'SUBMITTED' then
    return;
  end if;

  -- A failed row is not finalizable. The retry path is a fresh reservation, which the
  -- duplicate-protection index permits because UPLOAD_FAILED rows are excluded from it.
  if v_row.status <> 'RESERVED' then
    raise exception 'Receipt submission could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- status and submitted_at move together, which
  -- receipt_submissions_submitted_consistent requires. The WHERE re-asserts RESERVED
  -- so a concurrent transition cannot be overwritten, and the affected-row count is
  -- checked rather than assumed.
  update public.receipt_submissions
  set
    status              = 'SUBMITTED',
    submitted_at        = now(),
    failure_code        = null,
    failure_recorded_at = null
  where id = v_row.id
    and status = 'RESERVED';

  get diagnostics v_finalized = row_count;

  if v_finalized <> 1 then
    raise exception 'Receipt submission could not be finalized'
      using errcode = 'check_violation';
  end if;
end;
$$;

revoke all     on function public.finalize_receipt_submission_upload(uuid, text, text, text, bigint) from public;
revoke execute on function public.finalize_receipt_submission_upload(uuid, text, text, text, bigint) from anon;
revoke execute on function public.finalize_receipt_submission_upload(uuid, text, text, text, bigint) from authenticated;
grant  execute on function public.finalize_receipt_submission_upload(uuid, text, text, text, bigint) to service_role;

-- ============================================================================
-- FUNCTION 4 — record_receipt_submission_upload_failure(uuid, text)
-- ============================================================================
-- The "the object did not make it into the bucket" callback.
--
-- IT ACCEPTS NO ERROR TEXT. The failure code is a fixed literal written by this
-- function; there is no parameter through which a provider message, status code,
-- request id or bucket name could be stored. A Storage error can name the bucket, the
-- key and the account, and an audit row is not a safe place for any of that.
--
-- The row is KEPT rather than deleted, deliberately. Deleting it would erase the
-- evidence that a submission was attempted, and the staff member's history is the one
-- place they can see that their upload failed and should be retried. Keeping it costs
-- nothing: UPLOAD_FAILED rows are excluded from the duplicate-protection index, so the
-- same file can be submitted again immediately.
--
-- A duplicate failure callback for the same row is an idempotent no-op. A row that is
-- already SUBMITTED is NEVER flipped to failed — a late failure callback for an upload
-- that actually succeeded must not corrupt a good record.
create function public.record_receipt_submission_upload_failure(
  p_submission_id        uuid,
  p_expected_file_sha256 text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.receipt_submissions%rowtype;
begin
  if p_submission_id is null
     or p_expected_file_sha256 is null
     or p_expected_file_sha256 collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'Receipt upload failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  select * into v_row
  from public.receipt_submissions
  where id = p_submission_id
  for update;

  if v_row.id is null or v_row.file_sha256 <> p_expected_file_sha256 then
    raise exception 'Receipt upload failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- Already recorded: idempotent no-op.
  if v_row.status = 'UPLOAD_FAILED' then
    return;
  end if;

  -- The upload succeeded and was finalized. A failure cannot arrive for it.
  if v_row.status <> 'RESERVED' then
    raise exception 'Receipt upload failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  update public.receipt_submissions
  set
    status              = 'UPLOAD_FAILED',
    failure_code        = 'STORAGE_UPLOAD_FAILED',
    failure_recorded_at = now(),
    submitted_at        = null
  where id = v_row.id
    and status = 'RESERVED';
end;
$$;

revoke all     on function public.record_receipt_submission_upload_failure(uuid, text) from public;
revoke execute on function public.record_receipt_submission_upload_failure(uuid, text) from anon;
revoke execute on function public.record_receipt_submission_upload_failure(uuid, text) from authenticated;
grant  execute on function public.record_receipt_submission_upload_failure(uuid, text) to service_role;

-- ============================================================================
-- FUNCTION 5 — list_my_receipt_submissions()
-- ============================================================================
-- The calling staff member's OWN submission history, newest first.
--
-- Filtered on BOTH submitted_by_profile_id = auth.uid() AND the resolved Retailer.
-- Either alone would be sufficient today; both are applied because they answer
-- different questions — "is this mine?" and "is this the Retailer I am authorized
-- for?" — and a person may legitimately be staff at more than one Retailer over time.
--
-- NOT RETURNED, and the reason each is withheld:
--   storage_bucket, storage_object_path  a private object location is not display data
--                                        and would let a holder attempt a direct fetch.
--   file_sha256                          an internal integrity value; publishing it
--                                        would let one person test whether a file they
--                                        hold matches a submission.
--   submitted_by_profile_id,
--   retailer_organization_id             internal identifiers with no use on the page.
--   failure_code                         an internal classification. The UPLOAD_FAILED
--                                        status already says everything the staff
--                                        member can act on.
-- The submission id IS returned: a list needs a stable key, and it is the caller's own
-- row within their own tenant.
create function public.list_my_receipt_submissions()
returns table (
  submission_id      uuid,
  shop_name          text,
  shop_code          text,
  status             text,
  original_file_name text,
  mime_type          text,
  file_size_bytes    bigint,
  submitted_at       timestamptz,
  created_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_SUBMIT');

  if v_retailer is null then
    raise exception 'Not authorized to view receipt submissions'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    rs.id,
    s.name,
    s.code,
    rs.status,
    rs.original_file_name,
    rs.mime_type,
    rs.file_size_bytes,
    rs.submitted_at,
    rs.created_at
  from public.receipt_submissions rs
  join public.retailer_shops s on s.id = rs.retailer_shop_id
  where rs.submitted_by_profile_id = auth.uid()
    and rs.retailer_organization_id = v_retailer
  order by rs.created_at desc, rs.id desc;
end;
$$;

revoke all     on function public.list_my_receipt_submissions() from public;
revoke execute on function public.list_my_receipt_submissions() from anon;
grant  execute on function public.list_my_receipt_submissions() to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- Five functions added; nothing else exists in this migration. No table, column,
-- constraint, index, trigger, policy, role, permission or role-permission mapping is
-- created, altered or dropped, no existing function is touched, and no table privilege
-- is granted to any browser role — public.receipt_submissions stays default-deny with
-- zero policies, and the `receipts` bucket stays private with no storage policy at all.
