-- Run this in the Supabase SQL editor for your project.
-- It creates a single `bills` table that the app upserts to during sync.

create table if not exists public.bills (
  id uuid primary key,
  token_no integer not null,
  plates integer not null,
  meal_type text not null check (meal_type in ('lunch','dinner')),
  price_per_plate integer not null,
  total integer not null,
  payment_mode text not null check (payment_mode in ('cash','upi')),
  created_at timestamptz not null,
  synced_at timestamptz not null default now()
);

create index if not exists idx_bills_created_at on public.bills (created_at);

-- Row-level security: keep table writeable from the app's anon key.
-- For a single-restaurant app where only the owner has the key, this is fine.
-- If you want to lock it down, add an `inserted_by` column and use auth.uid().
alter table public.bills enable row level security;

drop policy if exists "anon insert/update bills" on public.bills;
create policy "anon insert/update bills" on public.bills
  for all
  to anon
  using (true)
  with check (true);
