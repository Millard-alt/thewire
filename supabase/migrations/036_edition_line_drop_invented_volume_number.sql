-- =============================================================================
--  036_edition_line_drop_invented_volume_number
-- =============================================================================
--  WHY
--
--  The masthead's top strip read "Vol. CXIV - No. 32,841 - Nakuru, Kenya".
--  Neither the volume nor the issue number has ever meant anything: they were
--  invented to make the strip look like a newspaper, and they change on no
--  schedule. On a publication that says every dispatch is verified, an
--  invented citation sitting in the masthead is exactly the wrong thing to
--  print.
--
--  It also had to be removed in THREE places, not one. src/views/public.js:79
--  overwrites `#edition-line` from `site_settings.edition` at runtime, so
--  editing index.html alone would have let the placeholder reappear the moment
--  the app booted:
--
--      index.html                     the static text (what a crawler reads)
--      src/lib/seed.js                demo mode
--      supabase/002_seed_content.sql  a fresh database seed
--      this file                      the live row that is already seeded
--
--  "Nakuru, Kenya" is honest: it is the one fact in that strip that is true,
--  and it is already printed directly below the masthead.
-- =============================================================================

begin;

update public.site_settings
   set edition = 'Nakuru, Kenya'
 where edition is distinct from 'Nakuru, Kenya';

-- Verify, so a database where the row has drifted is reported rather than
-- assumed fixed.
do $$
declare
  v_edition text;
begin
  select edition into v_edition
    from public.site_settings
   where id = 1;

  if v_edition is null then
    raise exception
      'No site_settings row with id = 1. The masthead would render empty.';
  end if;

  if v_edition ~* 'cxiv|32,?841' then
    raise exception
      'site_settings.edition still contains the invented volume number: %', v_edition;
  end if;

  raise notice 'site_settings.edition is now: %', v_edition;
end;
$$;

commit;
