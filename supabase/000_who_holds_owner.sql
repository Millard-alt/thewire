-- =============================================================================
--  THE WIRE - WHO IS HOLDING THE OWNER SEAT?   (READ-ONLY: changes nothing)
-- =============================================================================
--  WHY YOU NEED THIS
--      Signup says "that username is already taken", sign-in says "incorrect
--      username or password", and `node test-auth.mjs` reports
--          "At least one account ALREADY exists."
--      All three are the same single fact: `staff_accounts` is not empty, so the
--      first-run Owner claim is unavailable and every new signup is created only
--      as 'pending'. This report shows exactly which rows are in the way.
--
--  THIS SCRIPT IS PURELY A REPORT. No insert, no update, no delete.
--  Run it as often as you like. Read the "Data output" grid it returns.
--
--  THEN, to actually clear the newsroom, run 000_reset_accounts.sql.
-- =============================================================================

select
  username,
  display_name,
  role,
  status,
  is_owner,
  to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') as created,
  -- password_hash is deliberately NOT selected: it is a bcrypt digest and is
  -- of no use to anyone reading this grid.
  case
    when is_owner and status = 'active'
      then 'BLOCKS the Owner seat - this is the one'
    when is_owner
      then 'claims Owner rights but is not active'
    when status = 'active'
      then 'active staff member (no Owner rights)'
    when status = 'pending'
      then 'waiting for Owner approval'
    else status
  end as why_it_matters
from public.staff_accounts
order by created_at asc;
