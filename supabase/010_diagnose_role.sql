-- 010_diagnose_role.sql
-- -----------------------------------------------------------------------------
-- READ-ONLY. Changes nothing. Run this FIRST and paste the output back.
--
-- Every previous fix to this bug was written from inference: the error message
-- names a constraint, and I guessed which constraint was live. That guessing is
-- what made this drag on across several rounds -- each migration "succeeded"
-- and the very next signup failed with the identical error.
--
-- This file ends the guessing. It prints the ground truth from the live
-- database: every constraint actually attached to staff_accounts, its exact
-- definition, and every row's role. Read the output and the cause is
-- unambiguous.
--
-- Safe to run. It is SELECT only -- no INSERT, no UPDATE, no ALTER.
-- -----------------------------------------------------------------------------

-- 1. Every CHECK constraint on the table, with its real definition.
--    Look for one whose definition does NOT list 'Writer'.
select
  c.conname                                       as constraint_name,
  pg_get_constraintdef(c.oid)                     as definition,
  c.convalidated                                   as validated,
  array_to_string(c.conkey, ',')                  as column_ids,
  (select string_agg(a.attname, ',')
     from pg_attribute a
    where a.attrelid = c.conrelid
      and a.attnum = any (c.conkey))              as columns
from pg_constraint c
join pg_class t     on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where t.relname  = 'staff_accounts'
  and n.nspname  = 'public'
  and c.contype  = 'c'
order by c.conname;

-- 2. Which of those constraints would reject the role the app actually sends?
--    This is the direct answer to "is the fix in place?". If the definition for
--    the live role constraint does not contain 'Writer', the signup failure is
--    still live and 011 has not taken effect.
--
--    A plain substring test is enough HERE, where the file only reports. The
--    repair in 011 does not rely on it -- it matches on pg_constraint.conkey,
--    which is exact. This is only here so a human can read one row and see
--    whether 'Writer' appears in the guard.
select
  c.conname                                       as constraint_name,
  pg_get_constraintdef(c.oid)                     as definition,
  (pg_get_constraintdef(c.oid) ilike '%Writer%')  as mentions_writer
from pg_constraint c
join pg_class t     on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where t.relname  = 'staff_accounts'
  and n.nspname  = 'public'
  and c.contype  = 'c'
  and pg_get_constraintdef(c.oid) ilike '%role%'
order by c.conname;

-- 3. The actual data. Any role here outside the three valid values is what a
--    re-run of 010 would rewrite.
select username, display_name, role, status, is_owner
from public.staff_accounts
order by created_at asc;

-- 4. Is the single-Owner partial index present and satisfied?
select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename  = 'staff_accounts'
order by indexname;
-- -----------------------------------------------------------------------------
