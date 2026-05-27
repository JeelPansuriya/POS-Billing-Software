-- Run this ONCE in the Supabase SQL editor if your project still has the
-- original permissive `anon insert/update bills` policy that the lint rule
-- 0024_permissive_rls_policy flagged.
--
-- Effect: replaces the always-true ALL policy with an INSERT-only policy
-- (with sanity bounds) plus a SELECT policy for diagnostics. anon can no
-- longer UPDATE or DELETE rows in public.bills.

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

create policy "anon read bills"
  on public.bills
  for select
  to anon
  using (true);
