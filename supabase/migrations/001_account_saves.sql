-- Run once in the Supabase SQL Editor as the project database owner.
-- The authenticated browser can read only its own row. All writes go through
-- save_game so that a stale tab cannot overwrite a newer device's progress.
begin;

create table if not exists public.game_saves (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null,
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint game_saves_payload_valid check ((
    pg_catalog.jsonb_typeof(payload) = 'object'
    and payload -> 'schemaVersion' = '1'::jsonb
    and pg_catalog.jsonb_typeof(payload -> 'game') = 'object'
    and payload -> 'game' -> 'version' = '1'::jsonb
    and pg_catalog.jsonb_typeof(payload -> 'game' -> 'state') = 'object'
    and pg_catalog.jsonb_typeof(payload -> 'game' -> 'markets') = 'object'
    and pg_catalog.jsonb_typeof(payload -> 'preferences') = 'object'
  ) is true),
  constraint game_saves_payload_size check (
    pg_catalog.octet_length(payload::text) <= 2097152
  )
);

alter table public.game_saves enable row level security;

-- Supabase may give API roles table privileges by default. Remove them
-- explicitly before granting only the read operation required by the UI.
revoke all on table public.game_saves from public, anon, authenticated;
grant select on table public.game_saves to authenticated;

drop policy if exists game_saves_read_own on public.game_saves;
create policy game_saves_read_own
  on public.game_saves for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.save_game(
  p_payload jsonb,
  p_expected_revision bigint
)
returns table (payload jsonb, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_saved public.game_saves%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'INVALID_REVISION';
  end if;

  if p_expected_revision = 0 then
    -- A unique primary key serializes simultaneous first saves. The loser
    -- receives SAVE_CONFLICT instead of replacing the winner's initial save.
    insert into public.game_saves as saved (user_id, payload, revision)
      values (v_user_id, p_payload, 1)
      on conflict (user_id) do nothing
      returning saved.* into v_saved;
  else
    -- UPDATE takes a row lock and rechecks this condition after waiting for
    -- another writer. Only one request using a particular revision can win.
    update public.game_saves as saved
      set payload = p_payload,
          revision = saved.revision + 1,
          updated_at = pg_catalog.clock_timestamp()
      where saved.user_id = v_user_id
        and saved.revision = p_expected_revision
      returning saved.* into v_saved;
  end if;

  if not found then
    raise exception using errcode = 'P0001', message = 'SAVE_CONFLICT';
  end if;

  return query select v_saved.payload, v_saved.revision, v_saved.updated_at;
end;
$$;

-- SECURITY DEFINER deliberately bypasses write policies only after binding
-- the write to auth.uid(). There is no caller-supplied user_id parameter.
revoke all on function public.save_game(jsonb, bigint) from public, anon, authenticated;
grant execute on function public.save_game(jsonb, bigint) to authenticated;

comment on table public.game_saves is
  'One fictional trading-game save per Supabase auth user; no passwords or real funds.';
comment on function public.save_game(jsonb, bigint) is
  'Atomic revision-checked save. Expected revision 0 creates a save; stale writes raise SAVE_CONFLICT.';

commit;
