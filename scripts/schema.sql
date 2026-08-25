-- =============================================================================
-- Fitness Plus — Supabase schema, Row Level Security and Storage policies
-- Change: cms-fitness-plus · Slice 1 (data layer)
--
-- Run ONCE in the Supabase SQL Editor (Project → SQL Editor → New query) or
-- via `supabase db push` against a fresh project, BEFORE running the seed:
--
--     node scripts/seed.js        (service key from .env.local, never committed)
--
-- Re-running the whole file is NOT supported (objects already exist → errors);
-- to restore/rollback, re-seed with scripts/seed.js; to wipe, drop the
-- tables/bucket manually. The RLS and storage policy sections below ARE safe to
-- re-run (drop policy if exists / create policy) — re-run them to apply policy
-- changes, e.g. after replacing 4d436f61-3081-4572-8f67-375d7bdc31e5.
--
-- Conventions enforced here (mirrors design.md):
--   * offer_price CHECK: offer must be null or strictly < price (DB-level rule)
--   * category_id FK ON DELETE CASCADE: deleting a category removes its products
--   * RLS: anonymous SELECT on all tables; INSERT/UPDATE/DELETE restricted to a
--     single admin user (4d436f61-3081-4572-8f67-375d7bdc31e5) — see the RLS section below
--   * Storage bucket `productos`: public read; writes restricted to the admin
--     user, paths under admin/, png/jpg/jpeg/webp, ≤ 2MB
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  hero_title text not null,
  hero_subtitle text not null,
  section_title text not null,
  section_subtitle text not null,
  sort_order int not null default 0,
  hero_image_url text
);

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_id uuid not null references categories(id) on delete cascade,
  price int not null check (price > 0),
  offer_price int check (offer_price is null or offer_price < price),
  short_desc text not null,
  full_desc text not null,
  image_url text not null,
  nutrition_image_url text,
  brand text not null,
  in_stock boolean not null default true,
  is_featured boolean not null default false,
  sort_order int not null default 0,
  home_order int,
  -- NULL or [] = no variants (current behavior); shape [{name, in_stock, image_url?}]
  variants jsonb
);

create table site_texts (
  key text primary key,
  value text not null
);

create index products_category_idx on products (category_id, sort_order);
create index products_featured_idx on products (is_featured, home_order) where is_featured;

-- -----------------------------------------------------------------------------
-- Flavor variants — live DB migration (SAFE TO RE-RUN)
-- -----------------------------------------------------------------------------
-- Adds the `variants` column to products on databases created before the
-- column existed (fresh installs get it from the create table block above).
-- Idempotent, unlike the run-once create-table section: re-running it is a
-- no-op. Run this once in the Supabase SQL Editor (Project → SQL Editor →
-- New query) against the live DB:
--
--     alter table products add column if not exists variants jsonb;

alter table products add column if not exists variants jsonb;

-- -----------------------------------------------------------------------------
-- Variant shape reshape {stock:number} → {in_stock:boolean} (SAFE TO RE-RUN)
-- -----------------------------------------------------------------------------
-- Commit c206fa3 flipped the per-element shape from {name, stock:number} to
-- {name, in_stock:boolean, image_url?} without a data migration. Legacy rows
-- read `in_stock === undefined` → the storefront renders those products SIN
-- STOCK while the admin checkbox masks it (checked). This rewrite converts
-- every legacy element (numeric `stock`, no boolean `in_stock`): stock > 0
-- becomes in_stock true, otherwise false; the old `stock` key is dropped and
-- name / image_url are preserved. Already-converted elements pass through
-- unchanged, so re-running it is a no-op.
--
-- Kept commented out on purpose: unlike add-column-if-not-exists, this UPDATE
-- rewrites row data on every execution. Run it ONCE in the Supabase SQL Editor
-- against any database created before c206fa3:
--
--     update products
--        set variants = (
--          select coalesce(jsonb_agg(converted order by ord), '[]'::jsonb)
--            from jsonb_array_elements(variants) with ordinality as src(elem, ord),
--                 lateral (
--                   select case
--                            when elem ? 'stock'
--                                 and jsonb_typeof(elem -> 'stock') = 'number'
--                                 and not coalesce(
--                                       jsonb_typeof(elem -> 'in_stock') = 'boolean',
--                                       false)
--                              then jsonb_build_object(
--                                     'name',      elem -> 'name',
--                                     'in_stock',  coalesce((elem ->> 'stock')::numeric, 0) > 0,
--                                     'image_url', elem -> 'image_url')
--                            else elem
--                          end as converted
--                 ) conv
--        )
--      where variants is not null
--        and jsonb_typeof(variants) = 'array';

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
--
-- The admin user UUID below (4d436f61-3081-4572-8f67-375d7bdc31e5) is the only
-- account that can write (INSERT/UPDATE/DELETE) categories, products,
-- site_texts and objects in the `productos` storage bucket; every other
-- visitors are denied writes.
--
-- Public signups MUST be disabled in the dashboard (Authentication → Providers
-- → Email → disable "Allow new users to sign up") so no second account can ever
-- be created. Anonymous SELECT stays open so the public store keeps working.
--
-- Policies use drop-if-exists/create so this section can be re-run safely.

alter table categories enable row level security;
alter table products enable row level security;
alter table site_texts enable row level security;

-- SELECT: one policy with no role = everyone (including anon) can read.
-- Anonymous writes are denied by RLS even though the anon key ships in static JS.

drop policy if exists categories_select on categories;
create policy categories_select on categories for select using (true);
drop policy if exists categories_insert on categories;
create policy categories_insert on categories for insert to authenticated
  with check (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');
drop policy if exists categories_update on categories;
create policy categories_update on categories for update to authenticated
  using (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5')
  with check (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');
drop policy if exists categories_delete on categories;
create policy categories_delete on categories for delete to authenticated
  using (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');

drop policy if exists products_select on products;
create policy products_select on products for select using (true);
drop policy if exists products_insert on products;
create policy products_insert on products for insert to authenticated
  with check (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');
drop policy if exists products_update on products;
create policy products_update on products for update to authenticated
  using (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5')
  with check (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');
drop policy if exists products_delete on products;
create policy products_delete on products for delete to authenticated
  using (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');

drop policy if exists site_texts_select on site_texts;
create policy site_texts_select on site_texts for select using (true);
drop policy if exists site_texts_insert on site_texts;
create policy site_texts_insert on site_texts for insert to authenticated
  with check (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');
drop policy if exists site_texts_update on site_texts;
create policy site_texts_update on site_texts for update to authenticated
  using (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5')
  with check (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');
drop policy if exists site_texts_delete on site_texts;
create policy site_texts_delete on site_texts for delete to authenticated
  using (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');

-- -----------------------------------------------------------------------------
-- Storage: bucket `productos` (public read / admin-only write)
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('productos', 'productos', true)
on conflict (id) do nothing;

-- NO anonymous SELECT policy here, on purpose (hardened state): public reads
-- of /storage/v1/object/public/... rely on the bucket's `public` flag above,
-- not on RLS. A blanket SELECT policy would additionally allow anyone to LIST
-- the whole bucket via POST /storage/v1/object/list. The drop-if-exists below
-- keeps databases created from older versions of this file hardened when this
-- (re-runnable) section is applied again.
drop policy if exists productos_public_read on storage.objects;

-- Write policies: admin only, bucket `productos`, paths under admin/, image
-- extensions only, max 2MB. `name` holds the full object path, so the 'admin/'
-- prefix is checked with left(name, 6); `metadata->>'size'` is the byte size
-- recorded by Supabase on upload (coalesce keeps rows without metadata safe).

drop policy if exists productos_auth_insert on storage.objects;
create policy productos_auth_insert on storage.objects
  for insert to authenticated
  with check (
    auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5'
    and bucket_id = 'productos'
    and left(name, 6) = 'admin/'
    and storage.extension(name) in ('png', 'jpg', 'jpeg', 'webp')
    and coalesce((metadata->>'size')::int, 0) <= 2097152
  );

drop policy if exists productos_auth_update on storage.objects;
create policy productos_auth_update on storage.objects
  for update to authenticated
  using (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5')
  with check (
    auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5'
    and bucket_id = 'productos'
    and left(name, 6) = 'admin/'
    and storage.extension(name) in ('png', 'jpg', 'jpeg', 'webp')
    and coalesce((metadata->>'size')::int, 0) <= 2097152
  );

drop policy if exists productos_auth_delete on storage.objects;
create policy productos_auth_delete on storage.objects
  for delete to authenticated
  using (auth.uid() = '4d436f61-3081-4572-8f67-375d7bdc31e5');
