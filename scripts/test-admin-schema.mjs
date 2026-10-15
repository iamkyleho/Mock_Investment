// Database integration checks run with npm test after npm ci.
// An explicit installed @electric-sql/pglite module path can also be supplied.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TradingEngine } from '../src/engine.js';
import { STOCKS } from '../src/stocks.js';

const { PGlite } = await import(process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href : '@electric-sql/pglite');
const db = new PGlite();
const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`);
let checks = 0;
const checked = () => { checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checked(); };
const denied = async (sql, code = '42501') => {
  await assert.rejects(db.query(sql), error => error.code === code, sql); checked();
};
const queryValue = async sql => Object.values((await db.query(sql)).rows[0])[0];
const asUser = async (id, role = 'authenticated') => {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? '']);
  await db.exec(`set role ${role}`);
};

try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (
      id uuid primary key, email text, created_at timestamptz default now(),
      last_sign_in_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
  `);
  for (const file of ['001_account_saves.sql', '002_admin_dashboard.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  // A repeat migration should not change existing membership or grants.
  const migration = await readFile(new URL('../supabase/migrations/002_admin_dashboard.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  checked();
  const names = ['admin', 'alice_one', 'bob', 'newplayer', 'forged', 'broken', 'external'];
  for (let i = 0; i < ids.length; i += 1) {
    await db.query('insert into auth.users(id,email,created_at,raw_user_meta_data) values ($1,$2,$3,$4)',
      [ids[i], i === 6 ? 'private@example.com' : `${names[i]}@players.mock.invalid`,
        `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        i === 4 ? { username: 'admin', role: 'admin', is_admin: true } : {}]);
  }
  await db.query('insert into game_private.admin_users(user_id) values ($1)', [ids[0]]);
  const stockId = STOCKS[0].id;
  const first = new TradingEngine({ random: () => 0.5, now: () => 1_800_000_000_000 });
  first.markets[stockId].price = 100;
  first.openPosition({ stockId, direction: 'high', amount: 10000, leverage: 2 });
  first.markets[stockId].price = 110;
  first.state.cash += 25000;
  first.state.trades = 300;
  first.state.wins = 200;
  first.state.history = []; // Historical totals must survive history truncation.
  const second = new TradingEngine({ random: () => 0.5, now: () => 1_800_000_000_000 });
  second.state.cash = 0;
  second.state.status = 'bankrupt';
  second.borrow();
  second.markets[stockId].price = 100;
  second.openPosition({ stockId, direction: 'low', amount: 1000, leverage: 10 });
  second.markets[stockId].price = 150; // Collateral cap: position value is zero.
  const payload = engine => ({ schemaVersion: 1, game: engine.serialize(), preferences: {} });
  for (const [id, snapshot] of [[ids[1], payload(first)], [ids[2], payload(second)],
    [ids[5], { schemaVersion: 1, game: { version: 1, state: { cash: 'bad', positions: {} }, markets: {} }, preferences: {} }]]) {
    await db.query('insert into public.game_saves(user_id,payload,revision) values ($1,$2,1)', [id, snapshot]);
  }
  for (const mutate of [
    snapshot => { snapshot.game.state.cash = 'NaN'; },
    snapshot => { snapshot.game.state.cash = -1; },
    snapshot => { snapshot.game.state.positions = {}; },
    snapshot => { snapshot.game.state.loan = {}; },
    snapshot => { snapshot.game.state.loan = { amount: '100000' }; },
    snapshot => { delete snapshot.game.state.loan; },
    snapshot => { snapshot.game.state.positions[0].entryPrice = 0; },
    snapshot => { snapshot.game.state.positions[0].leverage = 100.5; },
    snapshot => { snapshot.game.state.positions[0].fee = -5; },
    snapshot => { snapshot.game.state.positions[0].direction = 'fake'; },
    snapshot => { snapshot.game.markets[stockId].price = 0; },
    snapshot => { delete snapshot.game.markets[stockId]; },
  ]) {
    const invalidPayload = payload(first);
    mutate(invalidPayload);
    const result = await db.query('select game_private.saved_player_metrics($1) as metrics', [invalidPayload]);
    equal(result.rows[0].metrics.stats_valid, false, 'malformed financial fields fail safely');
  }

  await asUser(ids[1]);
  equal(await queryValue('select public.is_game_admin()'), false, 'normal player is not admin');
  await denied('select public.admin_player_stats()');
  await denied('select * from game_private.admin_users');
  await denied(`insert into game_private.admin_users(user_id) values ('${ids[1]}')`);
  await denied("select game_private.saved_player_metrics(null)");
  equal((await db.query('select user_id from public.game_saves')).rows, [{ user_id: ids[1] }], 'normal save RLS unchanged');
  await asUser(ids[4]);
  equal(await queryValue('select public.is_game_admin()'), false, 'editable metadata cannot grant admin');
  await denied('select public.admin_player_stats()');
  await db.exec('reset role');
  await db.query("update auth.users set email='admin@players.mock.invalid' where id=$1", [ids[4]]);
  await asUser(ids[4]);
  equal(await queryValue('select public.is_game_admin()'), false, 'username admin alone cannot grant admin');
  await denied('select public.admin_player_stats()');
  await db.exec('reset role');
  await db.query("update auth.users set email='forged@players.mock.invalid' where id=$1", [ids[4]]);
  await asUser(null, 'anon');
  await denied('select public.is_game_admin()');
  await denied('select public.admin_player_stats()');
  await asUser(null);
  equal(await queryValue('select public.is_game_admin()'), false, 'missing auth uid is not admin');
  await denied('select public.admin_player_stats()');

  await asUser(ids[0]);
  equal(await queryValue('select public.is_game_admin()'), true, 'owner membership enables admin');
  equal((await db.query('select user_id from public.game_saves')).rows, [], 'admin direct access is still own-save only');
  const all = await queryValue('select public.admin_player_stats()');
  equal(all.total_count, 7, 'all registered accounts included');
  equal(all.summary.player_count, 7, 'summary member count');
  equal(all.summary.saved_count, 3, 'summary saved count');
  equal(all.summary.invalid_count, 1, 'corrupt save does not break list');
  const alice = all.players.find(row => row.username === 'alice_one');
  const bob = all.players.find(row => row.username === 'bob');
  const unsaved = all.players.find(row => row.username === 'newplayer');
  const invalid = all.players.find(row => row.username === 'broken');
  for (const [row, engine] of [[alice, first], [bob, second]]) {
    const round = n => Math.round(n * 100) / 100;
    const unrealized = engine.state.positions.reduce((sum, position) => sum + engine.positionPnl(position), 0);
    equal(row.net_equity, round(engine.netEquity()), `${row.username} engine net equity`);
    equal(row.total_pnl, round(engine.netEquity() - 100000), `${row.username} engine total P&L`);
    equal(row.unrealized_pnl, round(unrealized), `${row.username} engine unrealized P&L including fees`);
    equal(row.realized_pnl, round(engine.netEquity() - 100000 - unrealized), `${row.username} realized without history`);
  }
  equal(alice.realized_pnl, 25000, 'realized total not limited to last 200 trades');
  equal(bob.position_value, 0, 'collateral cap applied');
  equal(bob.debt, 100000, 'loan principal is a liability');
  equal(unsaved.status, 'not_started', 'unsaved account status');
  equal(unsaved.net_equity, 100000, 'unsaved account initial equity');
  equal(unsaved.total_pnl, 0, 'unsaved account no P&L');
  equal(invalid.stats_valid, false, 'invalid metrics flagged');
  equal(invalid.net_equity, null, 'invalid metrics not made up');
  equal(all.summary.profit, alice.total_pnl, 'profit positive sum');
  equal(all.summary.loss, -bob.total_pnl, 'loss positive magnitude');
  equal(all.summary.winners, 1, 'winning account count');
  equal(all.summary.losers, 1, 'losing account count');
  assert.equal(JSON.stringify(all).includes('private@example.com'), false); checked();
  assert.equal(JSON.stringify(all).includes('raw_user_meta_data'), false); checked();
  assert.equal(all.players.find(row => row.user_id === ids[0]).is_admin, true); checked();
  const filtered = await queryValue("select public.admin_player_stats('ALICE_',1,0)");
  equal(filtered.total_count, 1, 'case-insensitive literal search');
  equal(filtered.summary.total_pnl, alice.total_pnl, 'summary matches search not whole database');
  equal((await queryValue("select public.admin_player_stats('%',25,0)")).total_count, 0, 'percent not a wildcard');
  equal((await queryValue("select public.admin_player_stats('_',25,0)")).total_count, 1, 'underscore not a wildcard');
  const pageOne = await queryValue("select public.admin_player_stats('',2,0)");
  const pageTwo = await queryValue("select public.admin_player_stats('',2,2)");
  equal(pageOne.players.map(row => row.user_id), [ids[6], ids[5]], 'deterministic newest-first page');
  equal(pageTwo.players.map(row => row.user_id), [ids[4], ids[3]], 'second page does not overlap');
  equal(pageOne.total_count, 7, 'page keeps complete result count');
  equal((await queryValue("select public.admin_player_stats('',25,999)")).players, [], 'empty page retains a valid response');
  for (const args of ["'',0,0", "'',101,0", "'',25,-1", "'',null,0", "repeat('x',65),25,0"]) {
    await denied(`select public.admin_player_stats(${args})`, '22023');
  }
  await db.exec('reset role');
  await db.query('delete from game_private.admin_users where user_id=$1', [ids[0]]);
  await asUser(ids[0]);
  equal(await queryValue('select public.is_game_admin()'), false, 'revocation applies to existing session');
  await denied('select public.admin_player_stats()');
  console.log(`Admin SQL integration: ${checks} checks passed (PostgreSQL ${await queryValue('show server_version')}).`);
} finally {
  await db.close();
}
