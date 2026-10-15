-- Run after 001_account_saves.sql in the Supabase SQL Editor as the owner.
-- Membership is managed by the database owner, never by a browser or user metadata.
begin;

create schema if not exists game_private;
revoke all on schema game_private from public, anon, authenticated;

create table if not exists game_private.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table game_private.admin_users enable row level security;
revoke all on table game_private.admin_users from public, anon, authenticated;

create or replace function public.is_game_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from game_private.admin_users as admins
    where admins.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_game_admin() from public, anon, authenticated;
grant execute on function public.is_game_admin() to authenticated;

-- Read the same collateral-capped position values as TradingEngine.positionValue.
-- Do not sum history: the game keeps only the most recent 200 closed trades.
-- Invalid client snapshots produce a marked row, not an error for the whole page.
create or replace function game_private.saved_player_metrics(p_payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_state jsonb;
  v_position jsonb;
  v_quote jsonb;
  v_cash numeric;
  v_debt numeric := 0;
  v_position_value numeric := 0;
  v_unrealized numeric := 0;
  v_net numeric;
  v_amount numeric;
  v_fee numeric;
  v_entry numeric;
  v_price numeric;
  v_leverage numeric;
  v_value numeric;
  v_trades numeric;
  v_wins numeric;
begin
  if p_payload is null then
    return pg_catalog.jsonb_build_object(
      'stats_valid', true, 'status', 'not_started', 'cash', 100000,
      'position_value', 0, 'equity', 100000, 'debt', 0, 'net_equity', 100000,
      'total_pnl', 0, 'realized_pnl', 0, 'unrealized_pnl', 0,
      'trades', 0, 'wins', 0, 'open_positions', 0
    );
  end if;
  v_state := p_payload #> '{game,state}';
  if (p_payload -> 'schemaVersion' = '1'::jsonb
    and p_payload #> '{game,version}' = '1'::jsonb
    and pg_catalog.jsonb_typeof(v_state) = 'object'
    and pg_catalog.jsonb_typeof(v_state -> 'cash') = 'number'
    and pg_catalog.jsonb_typeof(v_state -> 'positions') = 'array'
    and pg_catalog.jsonb_typeof(v_state -> 'trades') = 'number'
    and pg_catalog.jsonb_typeof(v_state -> 'wins') = 'number'
    and v_state ->> 'status' in ('playing', 'bankrupt', 'gameover')
  ) is not true then
    raise exception 'INVALID_SAVE';
  end if;
  v_cash := (v_state ->> 'cash')::numeric;
  v_trades := (v_state ->> 'trades')::numeric;
  v_wins := (v_state ->> 'wins')::numeric;
  if v_cash < 0 or v_cash > 1e18 or v_trades < 0 or v_trades <> pg_catalog.trunc(v_trades)
    or v_wins < 0 or v_wins > v_trades or v_wins <> pg_catalog.trunc(v_wins)
    or pg_catalog.jsonb_array_length(v_state -> 'positions') > 200 then
    raise exception 'INVALID_SAVE';
  end if;
  if v_state -> 'loan' is null then
    raise exception 'INVALID_SAVE';
  elsif v_state -> 'loan' <> 'null'::jsonb then
    if (pg_catalog.jsonb_typeof(v_state -> 'loan') = 'object'
      and v_state #> '{loan,amount}' = '100000'::jsonb) is not true then
      raise exception 'INVALID_SAVE';
    end if;
    v_debt := 100000;
  end if;
  for v_position in select value from pg_catalog.jsonb_array_elements(v_state -> 'positions') loop
    v_quote := p_payload #> array['game', 'markets', v_position ->> 'stockId'];
    if (pg_catalog.jsonb_typeof(v_position -> 'amount') = 'number'
      and pg_catalog.jsonb_typeof(v_position -> 'fee') = 'number'
      and pg_catalog.jsonb_typeof(v_position -> 'entryPrice') = 'number'
      and pg_catalog.jsonb_typeof(v_position -> 'leverage') = 'number'
      and pg_catalog.jsonb_typeof(v_quote -> 'price') = 'number'
      and v_position ->> 'direction' in ('high', 'low')) is not true then
      raise exception 'INVALID_SAVE';
    end if;
    v_amount := (v_position ->> 'amount')::numeric;
    v_fee := (v_position ->> 'fee')::numeric;
    v_entry := (v_position ->> 'entryPrice')::numeric;
    v_price := (v_quote ->> 'price')::numeric;
    v_leverage := (v_position ->> 'leverage')::numeric;
    if v_amount < 1 or v_amount > 1e18 or v_fee < 0 or v_fee > 1e18
      or v_entry <= 0 or v_entry > 1e12 or v_price <= 0 or v_price > 1e12
      or v_leverage < 1 or v_leverage > 100 or v_leverage <> pg_catalog.trunc(v_leverage) then
      raise exception 'INVALID_SAVE';
    end if;
    v_value := greatest(0, v_amount * (1 +
      (case when v_position ->> 'direction' = 'high' then 1 else -1 end)
      * (v_price / v_entry - 1) * v_leverage));
    v_position_value := v_position_value + v_value;
    v_unrealized := v_unrealized + v_value - v_amount - v_fee;
  end loop;
  v_net := v_cash + v_position_value - v_debt;
  return pg_catalog.jsonb_build_object(
    'stats_valid', true, 'status', v_state ->> 'status',
    'cash', pg_catalog.round(v_cash, 2),
    'position_value', pg_catalog.round(v_position_value, 2),
    'equity', pg_catalog.round(v_cash + v_position_value, 2),
    'debt', v_debt, 'net_equity', pg_catalog.round(v_net, 2),
    'total_pnl', pg_catalog.round(v_net - 100000, 2),
    'realized_pnl', pg_catalog.round(v_net - 100000 - v_unrealized, 2),
    'unrealized_pnl', pg_catalog.round(v_unrealized, 2),
    'trades', v_trades, 'wins', v_wins,
    'open_positions', pg_catalog.jsonb_array_length(v_state -> 'positions')
  );
exception when others then
  return pg_catalog.jsonb_build_object(
    'stats_valid', false, 'status', 'invalid_save', 'cash', null,
    'position_value', null, 'equity', null, 'debt', null, 'net_equity', null,
    'total_pnl', null, 'realized_pnl', null, 'unrealized_pnl', null,
    'trades', null, 'wins', null, 'open_positions', null
  );
end;
$$;
revoke all on function game_private.saved_player_metrics(jsonb) from public, anon, authenticated;

create or replace function public.admin_player_stats(
  p_search text default '',
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_search text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, '')));
  v_result jsonb;
begin
  if auth.uid() is null or not public.is_game_admin() then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100
    or p_offset is null or p_offset < 0 or p_offset > 1000000
    or pg_catalog.length(v_search) > 64 then
    raise exception using errcode = '22023', message = 'INVALID_PAGINATION';
  end if;

  with accounts as (
    select users.id as user_id,
      case when users.email like '%@players.mock.invalid'
        then pg_catalog.split_part(users.email, '@', 1)
        else 'account-' || pg_catalog.left(users.id::text, 8) end as username,
      users.created_at, users.last_sign_in_at,
      saved.updated_at as last_saved_at, saved.user_id is not null as has_save,
      admins.user_id is not null as is_admin, saved.payload
    from auth.users as users
    left join public.game_saves as saved on saved.user_id = users.id
    left join game_private.admin_users as admins on admins.user_id = users.id
  ), matching as materialized (
    select accounts.user_id, accounts.username, accounts.created_at,
      accounts.last_sign_in_at, accounts.last_saved_at, accounts.has_save,
      accounts.is_admin, game_private.saved_player_metrics(accounts.payload) as metrics
    from accounts where pg_catalog.strpos(pg_catalog.lower(accounts.username), v_search) > 0
  ), page as (
    select * from matching
    order by created_at desc, user_id
    limit p_limit offset p_offset
  )
  select pg_catalog.jsonb_build_object(
    'players', (select coalesce(pg_catalog.jsonb_agg(
      (pg_catalog.to_jsonb(page) - 'metrics') || page.metrics
      order by page.created_at desc, page.user_id), '[]'::jsonb) from page),
    'total_count', (select count(*) from matching),
    'summary', (select pg_catalog.jsonb_build_object(
      'player_count', count(*), 'saved_count', count(*) filter (where has_save),
      'invalid_count', count(*) filter (where metrics ->> 'stats_valid' = 'false'),
      'net_equity', coalesce(sum((metrics ->> 'net_equity')::numeric), 0),
      'total_pnl', coalesce(sum((metrics ->> 'total_pnl')::numeric), 0),
      'profit', coalesce(sum(greatest((metrics ->> 'total_pnl')::numeric, 0)), 0),
      'loss', coalesce(sum(greatest(-(metrics ->> 'total_pnl')::numeric, 0)), 0),
      'winners', count(*) filter (where (metrics ->> 'total_pnl')::numeric > 0),
      'losers', count(*) filter (where (metrics ->> 'total_pnl')::numeric < 0)
    ) from matching),
    'generated_at', pg_catalog.clock_timestamp()
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.admin_player_stats(text, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_player_stats(text, integer, integer) to authenticated;

comment on table game_private.admin_users is
  'Server-managed admin membership. Never grant membership based on username or editable metadata.';
comment on function public.admin_player_stats(text, integer, integer) is
  'Admin-only saved-game snapshot statistics. Current game P&L subtracts debt and starting 100000 KRW; includes fees. Does not expose password hashes or emails.';

commit;
