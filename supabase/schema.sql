-- Run this in the Supabase SQL editor for your project.
-- Creates the `bills` table the app upserts to during sync.

create table if not exists public.bills (
  id uuid primary key,
  token_no integer not null,
  plates integer not null,
  meal_type text not null check (meal_type in ('lunch','dinner')),
  price_per_plate integer not null,
  total integer not null,
  payment_mode text not null check (payment_mode in ('cash','upi')),
  created_at timestamptz not null,
  voided_at timestamptz,
  void_reason text,
  synced_at timestamptz not null default now()
);

create index if not exists idx_bills_created_at on public.bills (created_at);
create index if not exists idx_bills_active     on public.bills (created_at) where voided_at is null;

-- Void RPC: anon cannot UPDATE rows directly (RLS forbids it), so to mark a
-- previously-synced bill as voided we expose a SECURITY DEFINER function
-- that performs only this specific update with no extra privilege.
create or replace function public.void_bill(p_id uuid, p_reason text default '')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.bills
     set voided_at   = coalesce(voided_at, now()),
         void_reason = case when voided_at is null then p_reason else void_reason end
   where id = p_id;
end;
$$;

revoke all on function public.void_bill(uuid, text) from public;
grant execute on function public.void_bill(uuid, text) to anon;

-- Row-level security.
-- The app embeds the project's anon key in a desktop installer, so we treat
-- the anon role as low-trust: it may only INSERT new bills with sanity-bound
-- values, never UPDATE or DELETE existing rows. Idempotent retries are
-- handled with PostgREST's `resolution=ignore-duplicates` (INSERT … ON
-- CONFLICT DO NOTHING) — that path only needs INSERT privilege.
alter table public.bills enable row level security;

-- Drop any old permissive ALL policy from earlier versions of this schema.
drop policy if exists "anon insert/update bills" on public.bills;
drop policy if exists "anon insert bills"        on public.bills;
drop policy if exists "anon read bills"          on public.bills;

create policy "anon insert bills"
  on public.bills
  for insert
  to anon
  with check (
        plates           between 1 and 1000
    and total            >= 0
    and price_per_plate  >= 0
    and meal_type        in ('lunch','dinner')
    and payment_mode     in ('cash','upi')
    and created_at       >= now() - interval '30 days'
    and created_at       <= now() + interval '1 hour'
  );

-- Read access for diagnostics (e.g. owner browsing the table from the
-- Supabase dashboard while logged in). Dashboard usage goes through the
-- service-role token, NOT anon, so this stays restrictive: anon can SELECT
-- but cannot do anything else.
create policy "anon read bills"
  on public.bills
  for select
  to anon
  using (true);
