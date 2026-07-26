-- Migration: repair_vendor_product_write_normalization
-- Purpose: Close ONE confirmed defect in the two Vendor product WRITE functions released
--          in migration 20260727210000, so the shared write contract is safe to expose to
--          a second client. It adds two pure text helpers and CREATE OR REPLACEs exactly
--          two existing functions:
--            1. public.normalize_product_line(text)   [new, internal]
--            2. public.normalize_product_block(text)  [new, internal]
--            3. public.create_vendor_product(text, text, text, text, text)  [REPLACED]
--            4. public.update_vendor_product(uuid, text, text, text, text)  [REPLACED]
--
-- NO NEW WRITE RPC IS CREATED, AND NO SIGNATURE CHANGES. create_vendor_product still
--   takes the same five text arguments in the same order and still `returns uuid`;
--   update_vendor_product still takes the same (uuid, text, text, text, text) and still
--   `returns void`. Language, volatility, SECURITY DEFINER, `set search_path = ''`,
--   ownership and the privilege set are all unchanged, and the REVOKE/GRANT statements
--   below restate the existing posture rather than altering it. The audit
--   (docs/mobile-vendor-product-writes-audit.md) found that those two functions plus
--   public.set_vendor_product_status(uuid, text) ALREADY are the shared, tenant-derived,
--   permission-gated, transactionally-audited write contract that a mobile client needs;
--   duplicating them for mobile would be a second definition of "create a product", free
--   to drift from the one the web already calls. This migration therefore repairs, and
--   adds nothing to, that contract.
--
-- public.set_vendor_product_status(uuid, text) IS DELIBERATELY NOT TOUCHED. Its only
--   normalization is `upper(btrim(coalesce(p_status, '')))` feeding a closed
--   `in ('ACTIVE','INACTIVE')` test, so every malformed input — including the whitespace
--   below — already fails that test and is reported with its own safe message
--   ('Choose a valid product status'). It has no path to a raw constraint error, so
--   replacing it would be a change with no defect behind it.
--
-- ============================================================================
-- THE DEFECT
-- ============================================================================
-- Both functions normalized text in this order:
--
--     btrim(...)  ->  regexp_replace(..., '\s+', ' ', 'g')
--
-- btrim/1 removes ONLY U+0020 SPACE. It does not remove a tab, newline, carriage
-- return, form feed, vertical tab, or any Unicode space separator. So for an input whose
-- leading or trailing whitespace was not a plain space, btrim was a no-op, the collapse
-- step then turned that character INTO a plain space, and nothing trimmed it afterwards.
-- The value handed to INSERT/UPDATE therefore carried a leading or trailing space that
-- the function's own validation does not test for — and walked straight into a table
-- CHECK constraint.
--
-- Confirmed against a fresh local database, before this migration:
--
--   create_vendor_product('P1', E'\tWidget')
--     -> 23514  new row for relation "vendor_products" violates check constraint
--               "vendor_products_name_trimmed"
--   create_vendor_product(E'P2\t', 'Widget Two')
--     -> 23514  ... violates check constraint "vendor_products_code_normalized"
--   create_vendor_product('P3', 'Widget Three', null, E'\t')
--     -> 23514  ... violates check constraint "vendor_products_brand_shape"
--   create_vendor_product('P4', 'Widget Four', null, E'\nAcme')
--     -> 23514  ... violates check constraint "vendor_products_brand_shape"
--   create_vendor_product('P7', E' Widget Seven')
--     -> 23514  ... violates check constraint "vendor_products_name_trimmed"
--   update_vendor_product(<own product>, E'\tRenamed')
--     -> 23514  ... violates check constraint "vendor_products_name_trimmed"
--
-- WHY IT MATTERS, AND WHAT IT IS NOT. The constraints held: nothing was stored
-- malformed, no transaction committed half-done, no audit row survived a failed write,
-- and no cross-tenant access was possible. The defect is that the DATABASE'S OWN error
-- text — naming the table `vendor_products` and the constraint — is what PostgREST
-- returns to the caller, in a repository whose stated discipline is that a client must
-- never receive a raw constraint name, SQL fragment or table name. It is reachable by
-- any authenticated Vendor Super Admin holding PRODUCTS_MANAGE through a direct RPC
-- call. That is precisely the caller a mobile client is.
--
-- WHY THE WEB NEVER HIT IT, AND WHY THAT IS NOT A DEFENCE. lib/products/product-input.ts
-- normalizes in JavaScript FIRST — `value.trim().replace(/\s+/g, " ")`, where JS `.trim()`
-- does remove tabs, newlines and Unicode space separators — so the browser only ever
-- sends already-normalized text and the SQL path is never exercised with anything else.
-- That made the rule TypeScript-only in practice, which is exactly the shape this
-- project's shared-backend principle forbids: a rule a second client can bypass is not
-- enforced. The repair moves the whole rule into PostgreSQL, where both clients get it.
--
-- ============================================================================
-- THE FIX, AND WHY IT CHANGES NO VISIBLE WEB BEHAVIOUR
-- ============================================================================
-- Normalization is reordered to COLLAPSE FIRST, THEN TRIM, and the whitespace set is
-- stated EXPLICITLY instead of being inherited from btrim (spaces only) and from
-- `[[:space:]]` (whose membership is locale-dependent for multibyte encodings, so the
-- same input could normalize differently on a different host).
--
-- The explicit set is exactly JavaScript's `\s`:
--   U+0020 space, U+0009 tab, U+000A newline, U+000B vertical tab, U+000C form feed,
--   U+000D carriage return, U+00A0 no-break space, U+1680 ogham space mark,
--   U+2000..U+200A the en/em quad family, U+2028 line separator, U+2029 paragraph
--   separator, U+202F narrow no-break space, U+205F medium mathematical space,
--   U+3000 ideographic space, U+FEFF zero-width no-break space.
-- Matching lib/products/product-input.ts character-for-character is the point: web and
-- mobile must not disagree about what "SR-100" means, or one client would report a code
-- as available that the other's unique index then rejects as a duplicate.
--
-- FOR EVERY INPUT THE WEB CAN SEND, THE RESULT IS BYTE-IDENTICAL. The browser trims and
-- collapses before the value leaves the page, so it arrives with no leading, trailing or
-- repeated whitespace; collapse-then-trim and trim-then-collapse agree exactly on such a
-- value. Verified on a live database before and after: the call
--   create_vendor_product('  sr-100  ', '  Clean   Name  ', ' 012 345-678-905 ',
--                         '  Acme  Co ', '  Hello  ')
-- stores code 'SR-100', name 'Clean Name', barcode '012345678905', brand 'Acme Co' and
-- description 'Hello' both before and after this migration. What changes is confined to
-- inputs the web cannot produce: they now normalize correctly, or are refused with the
-- function's OWN safe message, instead of raising a raw constraint error.
--
-- ONE BEHAVIOUR IS DELIBERATELY WIDENED: description. It was trimmed with btrim, so a
-- description submitted with a leading tab or newline was STORED with it (the
-- description CHECK also uses btrim, so it agreed and no error occurred) — while the web
-- stripped it in JavaScript. Two clients therefore stored different text for the same
-- keystrokes. Description is now trimmed against the same explicit set, so both agree.
-- Internal formatting is still preserved untouched, which is the one thing that makes
-- description different from a name: a paragraph break belongs to its author.
--
-- ============================================================================
-- WHAT THIS MIGRATION DOES NOT DO
-- ============================================================================
-- No table, column, constraint, index, trigger, RLS policy, role, permission or
-- role-permission mapping is created, altered or dropped. No seed row is written. No
-- existing row is read, updated or backfilled — the defect could never store a bad
-- value, so there is nothing to repair in the data. No function is DROPped: both
-- replacements keep their identity, so every existing grant, and the web's calls,
-- continue against the same object. No assignment write is added or changed
-- (assign_vendor_product_to_retailer and unassign_vendor_product_from_retailer are
-- untouched, and product assignment writes remain a separate, deferred milestone). There
-- is no DELETE statement in this file, and no product deletion anywhere in the schema.
-- No privilege is granted to service_role, to anon, or to any browser role on any table.
--
-- Idempotency posture: plain CREATE FUNCTION for the two new helpers (a conflicting
--   existing object FAILS the migration) and CREATE OR REPLACE for the two existing
--   functions, whose replacement is the entire point. No fixed UUIDs. No dynamic SQL.
--   All identifiers are <= 63 bytes. Every reference is schema-qualified because every
--   function here runs with an EMPTY search_path.
--
-- Dependencies: 20260716130351 (audit_logs), 20260716131104
--   (has_organization_permission), 20260717083515 (get_vendor_super_admin_context),
--   20260727090000 (vendor_products and its constraints), 20260727210000 (the two
--   functions replaced below).


-- ============================================================================
-- PART 1 — the two normalization helpers
-- ============================================================================
-- Both are pure text transforms: no table is read, no identity is resolved, nothing is
-- written. They are SECURITY INVOKER (the default) precisely because they need no
-- authority of their own — the SECURITY DEFINER functions below run as the owner and
-- call them from there.
--
-- IMMUTABLE is honest here only because the character set is written out literally. A
-- `[[:space:]]` class would make the result depend on the database's locale, and
-- labelling that IMMUTABLE would be a lie the planner is entitled to believe.
--
-- The regex escapes below are ARE escapes interpreted by the regex engine, so this file
-- contains no invisible characters: every whitespace character in the class is spelled
-- as `\t`, `\n`, ` ` and so on, and can be read and reviewed as text.

-- Trim + collapse. For values that are ONE LINE by nature: the product code, the product
-- name and the brand. Every whitespace character becomes a plain space, every run of
-- spaces becomes one space, and the ends are trimmed — in that order, which is the whole
-- correction. A null or all-whitespace input returns '' (never null), so the callers'
-- existing `= ''` and `nullif(..., '')` tests behave exactly as they already do.
create function public.normalize_product_line(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(
           regexp_replace(
             regexp_replace(
               coalesce(p_value, ''),
               E'[ \\t\\n\\v\\f\\r\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]',
               ' ',
               'g'
             ),
             ' +', ' ', 'g'
           ),
           ' '
         );
$$;

comment on function public.normalize_product_line(text) is
  'Internal. Trims and whitespace-collapses a single-line product value (code, name, brand). Never returns null.';

-- Trim only. For the DESCRIPTION, whose internal formatting is the author's and must
-- survive verbatim. Only leading and trailing whitespace is removed; a blank line in the
-- middle of a description is content, not noise.
create function public.normalize_product_block(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
           coalesce(p_value, ''),
           E'^[ \\t\\n\\v\\f\\r\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+|[ \\t\\n\\v\\f\\r\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+$',
           '',
           'g'
         );
$$;

comment on function public.normalize_product_block(text) is
  'Internal. Trims a multi-line product value (description) without disturbing its internal formatting. Never returns null.';

-- Internal, exactly like the storage migration's trigger validators: nothing but the
-- product write functions may call them, and neither browser role is granted anything.
revoke all on function public.normalize_product_line(text) from public;
revoke all on function public.normalize_product_block(text) from public;


-- ============================================================================
-- PART 2 — create_vendor_product(text, text, text, text, text)  [REPLACED]
-- ============================================================================
-- Creates one product in the calling Vendor's catalog and returns its id.
--
-- UNCHANGED FROM 20260727210000, and restated here only because CREATE OR REPLACE
-- rewrites the whole body: the argument list and its order, the uuid return, the
-- authorization chain (auth.uid() -> get_vendor_super_admin_context() -> lowest
-- organization id -> PRODUCTS_MANAGE), the refusal messages and their SQLSTATEs, the
-- unconditional 'ACTIVE' initial status, the created_by_profile_id taken from auth.uid()
-- and from nowhere else, the two unique-index catches and their two safe messages, and
-- the audit row — same action PRODUCT_CREATED, same entity_type VENDOR_PRODUCT, same
-- entity_id, same four metadata keys, same transaction.
--
-- THE ONLY CHANGE IS THE FIVE NORMALIZATION EXPRESSIONS. See the header.
--
-- THERE IS STILL NO ORGANIZATION ARGUMENT, and no user, profile, membership, role,
-- permission, actor or tenant argument. The Vendor is derived; a caller cannot nominate
-- one. The initial status is not a parameter either, because the web offers no choice of
-- it — inventing one here would be a mobile-only capability the product has never had.
create or replace function public.create_vendor_product(
  p_product_code text,
  p_product_name text,
  p_barcode      text default null,
  p_brand        text default null,
  p_description  text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor      uuid;
  v_actor       uuid;
  v_code        text;
  v_name        text;
  v_barcode     text;
  v_brand       text;
  v_description text;
  v_id          uuid;
  v_constraint  text;
  v_vendor_name text;
begin
  v_actor := auth.uid();

  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_actor is null
     or v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCTS_MANAGE') then
    raise exception 'Not authorized to manage products'
      using errcode = 'insufficient_privilege';
  end if;

  -- Normalize. COLLAPSE THEN TRIM, over an explicit whitespace set — the repair.
  -- upper() is applied after normalization, so the stored code satisfies
  -- vendor_products_code_normalized (= upper(btrim(code))) by construction, and the
  -- collapse guarantees vendor_products_code_shape's no-double-space half.
  v_code := upper(public.normalize_product_line(p_product_code));
  v_name := public.normalize_product_line(p_product_name);

  -- A barcode is a number that people transcribe with separators. Every whitespace
  -- character becomes a space via the same helper, then spaces and hyphens are removed,
  -- so an empty result is "no barcode" rather than an empty string.
  v_barcode := nullif(
    replace(replace(public.normalize_product_line(p_barcode), ' ', ''), '-', ''),
    ''
  );

  v_brand       := nullif(public.normalize_product_line(p_brand), '');
  v_description := nullif(public.normalize_product_block(p_description), '');

  if v_code = '' or length(v_code) > 64 or (v_code collate "C") !~ '^[A-Z0-9][A-Z0-9 ._/-]*$' then
    raise exception 'Enter a valid product code'
      using errcode = 'check_violation';
  end if;
  if v_name = '' or length(v_name) > 200 then
    raise exception 'Enter a product name'
      using errcode = 'check_violation';
  end if;
  if v_barcode is not null and (v_barcode collate "C") !~ '^[0-9]{8,14}$' then
    raise exception 'Enter a valid barcode, or leave it blank'
      using errcode = 'check_violation';
  end if;
  if v_brand is not null and length(v_brand) > 120 then
    raise exception 'Brand is too long'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 2000 then
    raise exception 'Description is too long'
      using errcode = 'check_violation';
  end if;

  begin
    insert into public.vendor_products (
      vendor_organization_id,
      product_code,
      barcode,
      product_name,
      brand,
      description,
      status,
      created_by_profile_id
    )
    values (v_vendor, v_code, v_barcode, v_name, v_brand, v_description, 'ACTIVE', v_actor)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'vendor_products_code_unique_idx' then
      raise exception 'A product with that code already exists'
        using errcode = 'unique_violation';
    end if;
    if v_constraint = 'vendor_products_barcode_unique_idx' then
      raise exception 'A product with that barcode already exists'
        using errcode = 'unique_violation';
    end if;
    raise;
  end;

  select o.name into v_vendor_name from public.organizations o where o.id = v_vendor;

  -- Metadata carries display-only fields. No creator Auth metadata, no organization id,
  -- no membership internals, no secret, and no provider text. ip_address and user_agent
  -- are left null: this function cannot observe them truthfully.
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    'PRODUCT_CREATED',
    'VENDOR_PRODUCT',
    v_id::text,
    jsonb_build_object(
      'product_code',   v_code,
      'product_name',   v_name,
      'product_status', 'ACTIVE',
      'vendor_name',    v_vendor_name
    )
  );

  return v_id;
end;
$$;

-- Restates the posture 20260727210000 established. CREATE OR REPLACE preserves the
-- existing ACL, so these are assertions of intent rather than changes; stating them keeps
-- the privilege set readable in the same file as the body it protects.
revoke all     on function public.create_vendor_product(text, text, text, text, text) from public;
revoke execute on function public.create_vendor_product(text, text, text, text, text) from anon;
grant  execute on function public.create_vendor_product(text, text, text, text, text) to authenticated;


-- ============================================================================
-- PART 3 — update_vendor_product(uuid, text, text, text, text)  [REPLACED]
-- ============================================================================
-- Edits a product's DISPLAY details: name, barcode, brand, description.
--
-- UNCHANGED FROM 20260727210000 apart from the four normalization expressions: the
-- argument list and order, the void return, the authorization chain, the two-column
-- (id AND derived Vendor) FOR UPDATE lookup that makes a foreign or unknown id
-- indistinguishable from a denial, the no-op short-circuit that writes and audits
-- nothing when no value changed, the barcode unique-index catch, and the audit row —
-- same action PRODUCT_UPDATED, same entity_type, same three metadata keys, same
-- transaction.
--
-- THE PRODUCT CODE IS STILL NOT A PARAMETER. It is the canonical key that assignments
-- are made against and that a future receipt-matching step will resolve, so re-keying an
-- entry in place would silently change what every downstream reference means; the storage
-- migration enforces that with a trigger, and this function still offers no way to
-- attempt it. A miscoded product is replaced, not renamed.
--
-- THE NO-OP COMPARISON IS WHY THE NORMALIZATION FIX MATTERS TWICE OVER. It compares
-- normalized input against stored values, so a fix that changed what "normalized" means
-- for an already-clean value would turn no-op edits into real ones and fill the audit log
-- with entries that correspond to no change. It does not: for any value the web can send,
-- and for any value already stored (every stored value satisfies the table's own trimmed
-- constraints), the new expressions return exactly what the old ones did.
create or replace function public.update_vendor_product(
  p_product_id   uuid,
  p_product_name text,
  p_barcode      text default null,
  p_brand        text default null,
  p_description  text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor      uuid;
  v_actor       uuid;
  v_row         public.vendor_products%rowtype;
  v_name        text;
  v_barcode     text;
  v_brand       text;
  v_description text;
  v_constraint  text;
begin
  v_actor := auth.uid();

  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_actor is null
     or v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCTS_MANAGE') then
    raise exception 'Not authorized to manage products'
      using errcode = 'insufficient_privilege';
  end if;

  -- The two-column filter is the whole security boundary for the caller-supplied id.
  -- FOR UPDATE serializes concurrent edits of the same product.
  select * into v_row
  from public.vendor_products
  where id = p_product_id
    and vendor_organization_id = v_vendor
  for update;

  -- A null id, an id that names nothing, and an id owned by another Vendor all land
  -- here and are reported identically to "you are not authorized".
  if v_row.id is null then
    raise exception 'Not authorized to manage this product'
      using errcode = 'insufficient_privilege';
  end if;

  -- The same four expressions as create_vendor_product, so a value means the same thing
  -- whether it is being created or corrected.
  v_name    := public.normalize_product_line(p_product_name);
  v_barcode := nullif(
    replace(replace(public.normalize_product_line(p_barcode), ' ', ''), '-', ''),
    ''
  );
  v_brand       := nullif(public.normalize_product_line(p_brand), '');
  v_description := nullif(public.normalize_product_block(p_description), '');

  if v_name = '' or length(v_name) > 200 then
    raise exception 'Enter a product name'
      using errcode = 'check_violation';
  end if;
  if v_barcode is not null and (v_barcode collate "C") !~ '^[0-9]{8,14}$' then
    raise exception 'Enter a valid barcode, or leave it blank'
      using errcode = 'check_violation';
  end if;
  if v_brand is not null and length(v_brand) > 120 then
    raise exception 'Brand is too long'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 2000 then
    raise exception 'Description is too long'
      using errcode = 'check_violation';
  end if;

  -- Nothing meaningful changed: succeed silently, write nothing, audit nothing.
  if v_row.product_name is not distinct from v_name
     and v_row.barcode is not distinct from v_barcode
     and v_row.brand is not distinct from v_brand
     and v_row.description is not distinct from v_description then
    return;
  end if;

  begin
    update public.vendor_products
    set product_name = v_name,
        barcode      = v_barcode,
        brand        = v_brand,
        description  = v_description
    where id = v_row.id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'vendor_products_barcode_unique_idx' then
      raise exception 'A product with that barcode already exists'
        using errcode = 'unique_violation';
    end if;
    raise;
  end;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    'PRODUCT_UPDATED',
    'VENDOR_PRODUCT',
    v_row.id::text,
    jsonb_build_object(
      'product_code',   v_row.product_code,
      'product_name',   v_name,
      'product_status', v_row.status
    )
  );
end;
$$;

revoke all     on function public.update_vendor_product(uuid, text, text, text, text) from public;
revoke execute on function public.update_vendor_product(uuid, text, text, text, text) from anon;
grant  execute on function public.update_vendor_product(uuid, text, text, text, text) to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- Two internal helper functions added; two existing functions replaced in place with
-- identical signatures, return types, volatility, security context, search_path and
-- privileges. Nothing else exists in this migration: no table, column, constraint, index,
-- trigger, RLS policy, role, permission or mapping is created, altered or dropped; no
-- seed row is written; no existing row is read or backfilled; no assignment write is
-- added or changed; there is no DELETE anywhere; and no table privilege is granted to any
-- browser role — public.vendor_products and public.vendor_product_retailer_assignments
-- stay default-deny with zero policies, exactly as 20260727090000 left them.
--
-- service_role is granted nothing. Both replaced functions derive their authority from
-- auth.uid(), which a service-role connection does not have, so granting it would produce
-- a function that can only ever refuse.
--
-- No index is added. The repair touches no predicate: the product-code and barcode unique
-- indexes remain the concurrency authorities they already were, and the update's target
-- lookup is still the primary key filtered by vendor_organization_id.
