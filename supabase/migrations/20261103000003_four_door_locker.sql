-- =====================================================================
-- Classroom360 — the key locker has four doors
-- One locker station is one four-door cabinet, so its compartments are numbered 1 to 4
-- (the existing unique (tenant, station, compartment) rule then caps a station at four keys).
--
-- The rule is added NOT VALID: every new or changed locker must obey it straight away, while
-- rows left over from the old nine-door demo data are cleaned up when supabase/seed.sql runs
-- again (the seed then validates the rule). Run order is therefore not important.
-- =====================================================================
alter table public.lockers drop constraint if exists lockers_compartment_no_check;
alter table public.lockers drop constraint if exists lockers_four_doors_check;
alter table public.lockers
  add constraint lockers_four_doors_check check (compartment_no between 1 and 4) not valid;

comment on column public.lockers.compartment_no is 'Door number on the four-door key locker (1 to 4).';
