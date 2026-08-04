-- =============================================================================
-- Fitness Plus — Supabase schema, Row Level Security and Storage policies
-- Change: cms-fitness-plus · Slice 1 (data layer)
--
-- Run ONCE in the Supabase SQL Editor (Project → SQL Editor → New query) or
-- via `supabase db push` against a fresh project, BEFORE running the seed:
--
--     node scripts/seed.js        (service key from .env.local, never committed)
--
-- Re-running the file is NOT supported (objects already exist → errors), so it
-- is intentionally not wrapped in IF NOT EXISTS guards. To restore/rollback,
-- re-seed with scripts/seed.js; to wipe, drop the tables/bucket manually.
--
-- Conventions enforced here (mirrors design.md):
--   * offer_price CHECK: offer must be null or strictly < price (DB-level rule)
--   * category_id FK ON DELETE CASCADE: deleting a category removes its products
--   * RLS: anonymous SELECT on all tables; writes only for authenticated users
--   * Storage bucket `productos`: public read, authenticated write
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
  sort_order int not null default 0
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
  home_order int
);

create table site_texts (
  key text primary key,
  value text not null
);

create index products_category_idx on products (category_id, sort_order);
create index products_featured_idx on products (is_featured, home_order) where is_featured;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table categories enable row level security;
alter table products enable row level security;
alter table site_texts enable row level security;

-- One SELECT policy (no role = applies to everyone, including anon) +
-- authenticated write policies per table. Anonymous writes are denied by RLS
-- even though the anon key ships in static JS (defense in depth).

create policy categories_select on categories for select using (true);
create policy categories_insert on categories for insert to authenticated with check (true);
create policy categories_update on categories for update to authenticated using (true);
create policy categories_delete on categories for delete to authenticated using (true);

create policy products_select on products for select using (true);
create policy products_insert on products for insert to authenticated with check (true);
create policy products_update on products for update to authenticated using (true);
create policy products_delete on products for delete to authenticated using (true);

create policy site_texts_select on site_texts for select using (true);
create policy site_texts_insert on site_texts for insert to authenticated with check (true);
create policy site_texts_update on site_texts for update to authenticated using (true);
create policy site_texts_delete on site_texts for delete to authenticated using (true);

-- -----------------------------------------------------------------------------
-- Storage: bucket `productos` (public read / authenticated write)
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('productos', 'productos', true)
on conflict (id) do nothing;

create policy productos_public_read on storage.objects
  for select using (bucket_id = 'productos');

create policy productos_auth_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'productos');

create policy productos_auth_update on storage.objects
  for update to authenticated using (bucket_id = 'productos');

create policy productos_auth_delete on storage.objects
  for delete to authenticated using (bucket_id = 'productos');
