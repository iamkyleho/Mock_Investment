import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, accountEmail, validatePassword, validateAuthConfig, makeAccountPayload } from '../src/account-utils.js';
import { TradingEngine } from '../src/engine.js';

test('IDs are case insensitive and cannot change the internal authentication domain', () => {
  assert.equal(normalizeUsername(' Kyle_01 '), 'kyle_01');
  assert.equal(accountEmail('KYLE_01'), 'kyle_01@players.mock.invalid');
  for (const name of ['ab', 'a'.repeat(21), 'a@b.com', '한글아이디', 'with space', 'a/b', 'x\ny']) {
    assert.throws(() => accountEmail(name));
  }
});

test('password validation does not trim, normalize or silently truncate secrets', () => {
  assert.equal(validatePassword(' Abc123! '), ' Abc123! ');
  assert.throws(() => validatePassword('1234567'));
  assert.throws(() => validatePassword('a'.repeat(129)));
  assert.equal(validatePassword('a'.repeat(128)).length, 128);
});

test('browser auth settings require HTTPS and a publishable key', () => {
  assert.equal(validateAuthConfig({}), false);
  assert.equal(validateAuthConfig({supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'sb_publishable_example'}), true);
  for (const key of ['sb_secret_do-not-publish', 'eyJservice_role', 'eyJanon']) {
    assert.throws(() => validateAuthConfig({supabaseUrl:'https://example.supabase.co',supabasePublishableKey:key}));
  }
  assert.throws(() => validateAuthConfig({supabaseUrl:'http://example.supabase.co',supabasePublishableKey:'sb_publishable_example'}));
});

test('compact cloud snapshots restore account obligations and all held asset prices without large uploads', () => {
  const engine = new TradingEngine({now:()=>1_800_000_000_000});
  engine.openPosition({stockId:'samsung',direction:'low',amount:10000,leverage:10});
  engine.openPosition({stockId:'nvidia',direction:'high',amount:10000,leverage:5});
  const original = engine.serialize();
  const preferences = {selected:'nvidia',favorites:['samsung'],interval:3};
  const compact = makeAccountPayload(original,preferences);
  const restored = new TradingEngine({saved:compact.game,now:()=>1_800_000_000_001});
  assert.equal(restored.restoreWarning,null);
  assert.deepEqual(restored.state.positions,engine.state.positions);
  assert.equal(restored.state.cash,engine.state.cash);
  for (const id of Object.keys(engine.markets)) assert.equal(restored.markets[id].price,engine.markets[id].price);
  assert.equal(compact.game.markets.nvidia.candles.length,180);
  assert.equal(compact.game.markets.samsung.candles.length,2);
  assert.equal(original.markets.samsung.candles.length,180);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(original).length / 5);
  preferences.favorites.push('apple');
  assert.deepEqual(compact.preferences.favorites,['samsung']);
});
