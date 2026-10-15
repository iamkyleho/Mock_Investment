import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSaveStore } from '../src/cloud-save.js';
import { TradingEngine } from '../src/engine.js';

const NOW = 1_790_000_000_000;
const copy = value => value == null ? value : structuredClone(value);
const initialGame = new TradingEngine({ now: () => NOW, random: () => 0.5 }).serialize();
for (const quote of Object.values(initialGame.markets)) quote.candles = quote.candles.slice(-2);
function payload(cash = 100_000) {
  const game = copy(initialGame);
  game.state.cash = cash;
  return { schemaVersion: 1, game, preferences: { selected: 'nvidia', favorites: ['samsung'] } };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class MemoryStorage {
  entries = new Map();
  writes = [];
  getItem(key) { return this.entries.get(key) ?? null; }
  setItem(key, value) { this.writes.push(key); this.entries.set(key, value); }
}
class Database {
  rows = new Map();
  writes = [];
  readFailure = null;
  writeFailure = null;
  beforeRead = null;
  beforeWrite = null;
  responseTransform = value => value;
  seed(userId, value, revision = 1) {
    this.rows.set(userId, { payload: copy(value), revision, updated_at: new Date(NOW + revision).toISOString() });
  }
  client(userId) {
    return {
      from: table => {
        assert.equal(table, 'game_saves');
        return { select: fields => {
          assert.equal(fields, 'payload, revision, updated_at');
          return { eq: (field, id) => {
            assert.equal(field, 'user_id');
            assert.equal(id, userId);
            return { maybeSingle: async () => {
              if (this.beforeRead) await this.beforeRead();
              if (this.readFailure) return { data: null, error: this.readFailure };
              return { data: copy(this.rows.get(id) ?? null), error: null };
            } };
          } };
        } };
      },
      rpc: async (name, args) => {
        assert.equal(name, 'save_game');
        this.writes.push({ userId, ...copy(args) });
        if (this.beforeWrite) await this.beforeWrite();
        if (this.writeFailure) return { data: null, error: this.writeFailure };
        const revision = this.rows.get(userId)?.revision ?? 0;
        if (args.p_expected_revision !== revision) {
          return { data: null, error: { code: 'P0001', message: 'SAVE_CONFLICT' } };
        }
        this.seed(userId, args.p_payload, revision + 1);
        return { data: this.responseTransform([copy(this.rows.get(userId))]), error: null };
      },
    };
  }
}
function make(db, userId = 'alice', storage = new MemoryStorage(), extra = {}) {
  const events = [];
  const store = new CloudSaveStore({ client: db.client(userId), userId, storage,
    onStatus: event => events.push(event), now: () => NOW, delayMs: 60_000, ...extra });
  return { store, events, storage };
}

// Like PostgREST builders, these queries execute only when awaited. The fake
// server chooses the account from the pinned bearer token, not from the store.
function authenticatedClient(db) {
  const sessionFor = id => ({ user: { id }, access_token: `token-${id}` });
  const control = { session: sessionFor('alice'), beforeDispatch: null, requests: [], rpcCalls: 0 };
  const query = (kind, execute) => {
    const headers = new Map();
    return {
      setHeader(name, value) { headers.set(name.toLowerCase(), value); return this; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          control.beforeDispatch?.();
          const authorization = headers.get('authorization') || `Bearer ${control.session?.access_token}`;
          control.requests.push({ kind, authorization });
          const userId = /^Bearer token-(alice|bob)$/.exec(authorization)?.[1];
          if (!userId) return { data: null, error: { code: '42501', message: 'Invalid identity' } };
          return execute(userId);
        }).then(resolve, reject);
      },
    };
  };
  return { control, sessionFor, client: {
    auth: { getSession: async () => ({ data: { session: copy(control.session) }, error: null }) },
    from: table => ({ select: fields => ({ eq: (field, id) => ({
      maybeSingle: () => query('read', userId => userId === id
        ? db.client(userId).from(table).select(fields).eq(field, id).maybeSingle()
        : { data: null, error: null }),
    }) }) }),
    rpc: (name, args) => {
      control.rpcCalls++;
      return query('write', userId => db.client(userId).rpc(name, args));
    },
  } };
}

test('accounts on the same browser load and save only their own progress', async t => {
  const db = new Database();
  const storage = new MemoryStorage();
  db.seed('alice', payload(60_000));
  db.seed('bob', payload(90_000), 4);
  const alice = make(db, 'alice', storage);
  const bob = make(db, 'bob', storage);
  t.after(() => { alice.store.dispose(); bob.store.dispose(); });
  assert.equal((await alice.store.load()).game.state.cash, 60_000);
  assert.equal((await bob.store.load()).game.state.cash, 90_000);
  alice.store.stage(payload(50_000));
  bob.store.stage(payload(80_000));
  assert.equal(await alice.store.flush(), true);
  assert.equal(await bob.store.flush(), true);
  assert.equal(db.rows.get('alice').payload.game.state.cash, 50_000);
  assert.equal(db.rows.get('bob').payload.game.state.cash, 80_000);
  assert.notEqual(alice.store.cacheKey, bob.store.cacheKey);
  assert.equal(storage.entries.size, 2);
  assert.equal(alice.events.at(-1).state, 'saved');
});

test('offline changes survive a session and resume only against the same remote revision', async t => {
  const db = new Database();
  const storage = new MemoryStorage();
  db.seed('alice', payload(100_000), 3);
  const first = make(db, 'alice', storage);
  await first.store.load();
  first.store.stage(payload(70_000));
  db.writeFailure = new TypeError('Failed to fetch');
  assert.equal(await first.store.flush(), false);
  assert.equal(first.events.at(-1).state, 'offline');
  assert.equal(first.store.hasPending, true);
  first.store.dispose();
  db.writeFailure = null;
  const restored = make(db, 'alice', storage);
  t.after(() => restored.store.dispose());
  assert.equal((await restored.store.load()).game.state.cash, 70_000);
  assert.equal(restored.events.at(-1).state, 'pending');
  assert.equal(await restored.store.flush(), true);
  assert.equal(db.rows.get('alice').revision, 4);
  assert.equal(db.rows.get('alice').payload.game.state.cash, 70_000);
  assert.equal(JSON.parse(storage.getItem(restored.store.cacheKey)).pending, false);
});

test('a stale local outbox cannot overwrite another device and survives a failed reload', async t => {
  const db = new Database();
  const storage = new MemoryStorage();
  db.seed('alice', payload(100_000), 2);
  const first = make(db, 'alice', storage);
  await first.store.load();
  first.store.stage(payload(80_000));
  first.store.dispose();
  db.seed('alice', payload(150_000), 3);
  const second = make(db, 'alice', storage);
  t.after(() => second.store.dispose());
  assert.equal((await second.store.load()).game.state.cash, 80_000);
  assert.equal(second.events.at(-1).state, 'conflict');
  const cached = storage.getItem(second.store.cacheKey);
  assert.equal(second.store.stage(payload(20_000)), false);
  assert.equal(await second.store.flush(), false);
  assert.equal(db.writes.length, 0);
  assert.equal(storage.getItem(second.store.cacheKey), cached);
  db.readFailure = new TypeError('Network offline');
  await assert.rejects(second.store.reload(), /Network offline/);
  assert.equal(storage.getItem(second.store.cacheKey), cached);
  assert.equal(second.store.hasPending, true);
  db.readFailure = null;
  assert.equal((await second.store.reload()).game.state.cash, 150_000);
  assert.equal(second.store.hasPending, false);
  assert.equal(second.store.conflicted, false);
  second.store.stage(payload(140_000));
  assert.equal(await second.store.flush(), true);
  assert.equal(db.writes[0].p_expected_revision, 3);
});

test('a second device winning the CAS race leaves the first device in conflict', async t => {
  const db = new Database();
  db.seed('alice', payload());
  const first = make(db);
  const second = make(db);
  t.after(() => { first.store.dispose(); second.store.dispose(); });
  await Promise.all([first.store.load(), second.store.load()]);
  first.store.stage(payload(10_000));
  second.store.stage(payload(90_000));
  assert.equal(await second.store.flush(), true);
  assert.equal(await first.store.flush(), false);
  assert.equal(first.events.at(-1).state, 'conflict');
  assert.equal(db.rows.get('alice').payload.game.state.cash, 90_000);
  assert.equal(first.store.hasPending, true);
});

test('edits made during an in-flight save are snapshotted and saved serially', async t => {
  const db = new Database();
  const { store } = make(db);
  t.after(() => store.dispose());
  await store.load();
  const gate = deferred();
  const started = deferred();
  db.beforeWrite = () => { started.resolve(); return gate.promise; };
  const firstValue = payload(80_000);
  store.stage(firstValue);
  firstValue.game.state.cash = 1;
  const saving = store.flush();
  await started.promise;
  const newerValue = payload(120_000);
  store.stage(newerValue);
  newerValue.game.state.cash = 2;
  const alsoSaving = store.flush();
  assert.equal(db.writes.length, 1);
  gate.resolve();
  assert.equal(await saving, true);
  assert.equal(await alsoSaving, true);
  assert.deepEqual(db.writes.map(write => write.p_expected_revision), [0, 1]);
  assert.deepEqual(db.writes.map(write => write.p_payload.game.state.cash), [80_000, 120_000]);
  assert.equal(db.rows.get('alice').payload.game.state.cash, 120_000);
  assert.equal(store.hasPending, false);
});

test('logging out during a save prevents late status and local cache updates', async () => {
  const db = new Database();
  const { store, events, storage } = make(db);
  await store.load();
  const gate = deferred();
  const started = deferred();
  db.beforeWrite = () => { started.resolve(); return gate.promise; };
  store.stage(payload(80_000));
  const saving = store.flush();
  await started.promise;
  store.dispose();
  const eventCount = events.length;
  const cached = storage.getItem(store.cacheKey);
  const cacheWrites = storage.writes.length;
  gate.resolve();
  assert.equal(await saving, false);
  assert.equal(events.length, eventCount);
  assert.equal(storage.writes.length, cacheWrites);
  assert.equal(storage.getItem(store.cacheKey), cached);
  assert.throws(() => store.stage(payload()), { code: 'DISPOSED' });
});

test('logging out during a load cannot publish or cache the previous account', async () => {
  const db = new Database();
  db.seed('alice', payload());
  const gate = deferred();
  db.beforeRead = () => gate.promise;
  const { store, events, storage } = make(db);
  const loading = store.load();
  store.dispose();
  const eventCount = events.length;
  gate.resolve();
  await assert.rejects(loading, { code: 'DISPOSED' });
  assert.equal(events.length, eventCount);
  assert.equal(storage.entries.size, 0);
});

test('failed initial cloud reads do not manufacture a fresh account or discard an outbox', async t => {
  const db = new Database();
  const first = make(db);
  await first.store.load();
  first.store.stage(payload(75_000));
  first.store.dispose();
  const original = first.storage.getItem(first.store.cacheKey);
  db.readFailure = new TypeError('Failed to fetch');
  const next = make(db, 'alice', first.storage);
  t.after(() => next.store.dispose());
  await assert.rejects(next.store.load(), /Failed to fetch/);
  assert.equal(next.events.at(-1).state, 'offline');
  assert.equal(first.storage.getItem(first.store.cacheKey), original);
  assert.throws(() => next.store.stage(payload()), { code: 'NOT_LOADED' });
  assert.equal(db.writes.length, 0);
});

test('permission errors retain pending data without claiming it was saved', async t => {
  const db = new Database();
  const { store, events } = make(db);
  t.after(() => store.dispose());
  await store.load();
  store.stage(payload(50_000));
  db.writeFailure = { code: '42501', message: 'permission denied' };
  assert.equal(await store.flush(), false);
  assert.equal(events.at(-1).state, 'error');
  assert.equal(store.hasPending, true);
  assert.equal(store.revision, 0);
  db.writeFailure = null;
  assert.equal(await store.flush(), true);
  assert.equal(store.revision, 1);
});

test('malformed and oversized snapshots cannot replace valid pending progress', async t => {
  const db = new Database();
  const { store, storage } = make(db);
  t.after(() => store.dispose());
  await store.load();
  store.stage(payload(77_000));
  const original = storage.getItem(store.cacheKey);
  assert.throws(() => store.stage({ schemaVersion: 1, game: {} }), { code: 'PAYLOAD_INVALID' });
  const oversized = payload();
  oversized.preferences.extra = '가'.repeat(750_000);
  assert.throws(() => store.stage(oversized), { code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(storage.getItem(store.cacheKey), original);
  assert.equal(await store.flush(), true);
  assert.equal(db.rows.get('alice').payload.game.state.cash, 77_000);
});

test('malformed cloud data is rejected instead of being overwritten by a new game', async t => {
  const db = new Database();
  db.seed('alice', { schemaVersion: 1, game: null });
  const { store, events } = make(db);
  t.after(() => store.dispose());
  await assert.rejects(store.load(), { code: 'PAYLOAD_INVALID' });
  assert.equal(events.at(-1).state, 'error');
  assert.equal(await store.flush(), false);
  assert.equal(db.writes.length, 0);
});

test('an unrecognized save acknowledgement requires a fresh cloud read before another write', async t => {
  const db = new Database();
  db.responseTransform = () => ({ unexpected: true });
  const { store, events } = make(db);
  t.after(() => store.dispose());
  await store.load();
  store.stage(payload(60_000));
  assert.equal(await store.flush(), false);
  assert.equal(events.at(-1).state, 'conflict');
  assert.equal(store.conflicted, true);
  assert.equal(await store.flush(), false);
  assert.equal(db.writes.length, 1);
  assert.equal((await store.reload()).game.state.cash, 60_000);
  assert.equal(store.hasPending, false);
});

test('unavailable browser storage does not prevent cloud persistence', async t => {
  const db = new Database();
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  const { store, events } = make(db, 'alice', unavailable);
  t.after(() => store.dispose());
  assert.equal(await store.load(), null);
  assert.equal(store.stage(payload(40_000)), true);
  assert.ok(events.at(-1).message);
  assert.equal(store.canPersistLocal, false);
  assert.equal(events.at(-1).localAvailable, false);
  assert.equal(await store.flush(), true);
  assert.equal(db.rows.get('alice').payload.game.state.cash, 40_000);
});

test('missing browser storage reports an unsaved in-memory session while offline', async t => {
  const db = new Database();
  const { store, events } = make(db, 'alice', undefined, { storage: undefined });
  t.after(() => store.dispose());
  await store.load();
  store.stage(payload(30_000));
  assert.equal(store.canPersistLocal, false);
  assert.equal(events.at(-1).localAvailable, false);
  assert.match(events.at(-1).message, /기기 저장 공간/);
  db.writeFailure = new TypeError('Failed to fetch');
  assert.equal(await store.flush(), false);
  assert.equal(events.at(-1).state, 'offline');
  assert.equal(events.at(-1).localAvailable, false);
  assert.match(events.at(-1).message, /기기 저장도 사용할 수 없습니다/);
  assert.equal(store.hasPending, true);
});

test('restored pending progress is not uploaded until the app validates and stages it', async t => {
  const db = new Database();
  db.seed('alice', payload());
  const first = make(db);
  await first.store.load();
  const invalidGame = payload(10_000);
  invalidGame.game.state.positions = [{ id: 'invalid-position' }];
  first.store.stage(invalidGame);
  first.store.dispose();
  const next = make(db, 'alice', first.storage, { delayMs: 0 });
  t.after(() => next.store.dispose());
  const recovered = await next.store.load();
  assert.ok(new TradingEngine({ saved: recovered.game, now: () => NOW }).restoreWarning);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(db.writes.length, 0);
  assert.equal(db.rows.get('alice').payload.game.state.cash, 100_000);
  assert.equal(next.store.hasPending, true);
});

test('a different authenticated account cannot read or submit the previous account save', async t => {
  const db = new Database();
  const { client, control, sessionFor } = authenticatedClient(db);
  const { store, events } = make(db, 'alice', undefined, { client });
  t.after(() => store.dispose());
  control.session = sessionFor('bob');
  await assert.rejects(store.load(), { code: 'AUTH_SESSION_CHANGED' });
  assert.equal(control.requests.length, 0);
  control.session = sessionFor('alice');
  await store.load();
  store.stage(payload(70_000));
  control.session = sessionFor('bob');
  assert.equal(await store.flush(), false);
  assert.equal(control.rpcCalls, 0);
  assert.equal(db.writes.length, 0);
  assert.equal(store.hasPending, true);
  assert.equal(events.at(-1).state, 'error');
});

test('read and save requests stay pinned to their checked account if the SDK session changes before fetch', async t => {
  const db = new Database();
  db.seed('alice', payload(80_000));
  db.seed('bob', payload(90_000));
  const { client, control, sessionFor } = authenticatedClient(db);
  const { store } = make(db, 'alice', undefined, { client });
  t.after(() => store.dispose());
  control.beforeDispatch = () => { control.session = sessionFor('bob'); };
  assert.equal((await store.load()).game.state.cash, 80_000);
  assert.equal(control.session.user.id, 'bob');
  control.session = sessionFor('alice');
  store.stage(payload(60_000));
  assert.equal(await store.flush(), true);
  assert.deepEqual(control.requests, [
    { kind: 'read', authorization: 'Bearer token-alice' },
    { kind: 'write', authorization: 'Bearer token-alice' },
  ]);
  assert.equal(db.rows.get('alice').payload.game.state.cash, 60_000);
  assert.equal(db.rows.get('bob').payload.game.state.cash, 90_000);
});

test('an authenticated session without a bearer token is never allowed to submit progress', async t => {
  const db = new Database();
  const { client, control } = authenticatedClient(db);
  const { store } = make(db, 'alice', undefined, { client });
  t.after(() => store.dispose());
  await store.load();
  store.stage(payload(60_000));
  delete control.session.access_token;
  assert.equal(await store.flush(), false);
  assert.equal(control.rpcCalls, 0);
  assert.equal(db.writes.length, 0);
});
