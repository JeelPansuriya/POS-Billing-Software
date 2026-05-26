-- Run this ONCE in the Supabase SQL editor if you already created the bills
-- table with the old ('cash','online') check constraint.

alter table public.bills drop constraint if exists bills_payment_mode_check;
update public.bills set payment_mode = 'upi' where payment_mode = 'online';
alter table public.bills add constraint bills_payment_mode_check
  check (payment_mode in ('cash','upi'));
