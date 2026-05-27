-- Run this ONCE in the Supabase SQL editor if your `public.bills` table was
-- created before void support was added. Adds void columns and the RPC the
-- desktop app calls to mark already-synced bills as voided.

alter table public.bills add column if not exists voided_at   timestamptz;
alter table public.bills add column if not exists void_reason text;

create index if not exists idx_bills_active on public.bills (created_at) where voided_at is null;

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
