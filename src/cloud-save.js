const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const CACHE_PREFIX = 'mock-exchange-account-save-v1:';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function failure(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

// The engine performs detailed game validation; reject incomplete envelopes here
// before they can replace either a local outbox or the account's cloud save.
function snapshot(payload) {
  let json;
  try { json = JSON.stringify(payload); }
  catch (cause) { throw failure('저장 데이터 형식이 올바르지 않습니다.', 'PAYLOAD_INVALID', cause); }
  if (typeof json !== 'string') throw failure('저장 데이터가 없습니다.', 'PAYLOAD_INVALID');
  if (new TextEncoder().encode(json).byteLength > MAX_PAYLOAD_BYTES) {
    throw failure('저장 데이터가 2MB 제한을 초과했습니다.', 'PAYLOAD_TOO_LARGE');
  }
  const value = JSON.parse(json);
  const game = value?.game;
  const state = game?.state;
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(game) || game.version !== 1
    || !isObject(state) || !Number.isFinite(state.cash) || state.cash < 0
    || !Array.isArray(state.positions) || state.positions.length > 200
    || !Array.isArray(state.history) || state.history.length > 500
    || !['playing', 'bankrupt', 'gameover'].includes(state.status)
    || !isObject(game.markets) || !isObject(value.preferences)) {
    throw failure('저장 데이터 형식이 올바르지 않습니다.', 'PAYLOAD_INVALID');
  }
  return value;
}

function validRevision(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function isConflict(error) {
  return error?.code === 'SAVE_CONFLICT'
    || (error?.code === 'P0001' && /SAVE_CONFLICT/.test(error.message || ''));
}

function isOffline(error) {
  return error instanceof TypeError || !error?.code
    || /fetch|network|offline|timeout|connection/i.test(error.message || '');
}

/** Account-scoped outbox plus optimistic concurrency for Supabase game_saves. */
export class CloudSaveStore {
  constructor({ client, userId, storage, onStatus = () => {}, now = () => Date.now(), delayMs = 15_000 }) {
    if (!client || typeof client.from !== 'function' || typeof client.rpc !== 'function') {
      throw new TypeError('A Supabase client is required.');
    }
    if (typeof userId !== 'string' || !userId.trim()) throw new TypeError('A user ID is required.');
    this.client = client;
    this.userId = userId;
    this.storage = storage;
    this.onStatus = onStatus;
    this.now = now;
    this.delayMs = Math.max(0, Number.isFinite(delayMs) ? delayMs : 15_000);
    this.cacheKey = `${CACHE_PREFIX}${encodeURIComponent(userId)}`;
    this._revision = 0;
    this._pending = null;
    this._sequence = 0;
    this._loaded = false;
    this._conflict = false;
    this._disposed = false;
    this._reloading = false;
    this._loading = false;
    this._timer = null;
    this._running = null;
    this._updatedAt = null;
    this._cacheWarning = !storage;
  }

  get revision() { return this._revision; }
  get hasPending() { return this._pending !== null; }
  get conflicted() { return this._conflict; }
  get canPersistLocal() { return Boolean(this.storage) && !this._cacheWarning; }

  _assertActive() {
    if (this._disposed) throw failure('이미 종료된 저장 세션입니다.', 'DISPOSED');
  }

  _status(state, message) {
    if (this._disposed) return;
    const event = { state, localAvailable: this.canPersistLocal };
    if (this._updatedAt) event.updatedAt = this._updatedAt;
    if (state === 'offline' && !this.canPersistLocal) {
      event.message = '연결이 끊겼고 기기 저장도 사용할 수 없습니다. 이 창을 닫으면 최근 진행 기록이 사라질 수 있습니다.';
    } else if (message) event.message = message;
    // A rendering failure must never turn a successful database write into a retry.
    try { this.onStatus(event); } catch { /* Consumer controls its own rendering. */ }
  }

  _clearTimer() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule() {
    if (this._timer !== null || this._disposed || this._conflict || this._running || !this._pending) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, this.delayMs);
    this._timer.unref?.();
  }

  _writeCache(payload, pending) {
    if (this._disposed || !this.storage) return;
    const record = { version: 1, userId: this.userId, revision: this._revision,
      pending, payload, updatedAt: this._updatedAt };
    try {
      this.storage.setItem(this.cacheKey, JSON.stringify(record));
      this._cacheWarning = false;
    } catch { this._cacheWarning = true; }
  }

  _readCache() {
    if (!this.storage) return null;
    let raw;
    try { raw = this.storage.getItem(this.cacheKey); }
    catch { this._cacheWarning = true; return null; }
    if (!raw) return null;
    let value;
    try { value = JSON.parse(raw); }
    catch (cause) { throw failure('기기에 남은 저장 기록을 확인할 수 없습니다. 클라우드 기록을 다시 불러오세요.', 'CACHE_INVALID', cause); }
    if (!isObject(value) || value.version !== 1 || value.userId !== this.userId
      || !validRevision(value.revision) || typeof value.pending !== 'boolean') {
      throw failure('기기에 남은 저장 기록을 확인할 수 없습니다. 클라우드 기록을 다시 불러오세요.', 'CACHE_INVALID');
    }
    // A completed cache is only a convenience; the server remains authoritative.
    if (!value.pending) return null;
    value.payload = snapshot(value.payload);
    return value;
  }

  async _accessToken() {
    this._assertActive();
    // Dependency-free test clients may omit auth; real Supabase clients do not.
    if (typeof this.client.auth?.getSession !== 'function') return null;
    const { data, error } = await this.client.auth.getSession();
    this._assertActive();
    if (error) throw error;
    const session = data?.session;
    if (session?.user?.id !== this.userId || typeof session.access_token !== 'string'
      || !session.access_token.trim()) {
      throw failure('로그인 계정이 변경되었습니다. 다시 로그인해 주세요.', 'AUTH_SESSION_CHANGED');
    }
    return session.access_token;
  }

  _pinAccount(query, accessToken) {
    if (accessToken === null) return query;
    if (typeof query?.setHeader !== 'function') {
      throw failure('계정별 저장 요청을 준비하지 못했습니다.', 'AUTH_HEADER_UNAVAILABLE');
    }
    // The SDK may observe a different session before fetch begins. An explicit
    // header keeps this request bound to the identity that was just checked.
    return query.setHeader('Authorization', `Bearer ${accessToken}`);
  }

  async _readRemote() {
    const accessToken = await this._accessToken();
    this._assertActive();
    const query = this.client.from('game_saves')
      .select('payload, revision, updated_at').eq('user_id', this.userId).maybeSingle();
    const { data, error } = await this._pinAccount(query, accessToken);
    this._assertActive();
    if (error) throw error;
    if (data === null) return { payload: null, revision: 0, updatedAt: null };
    if (!isObject(data) || !validRevision(data.revision, 1)) {
      throw failure('클라우드 저장 응답을 확인할 수 없습니다.', 'INVALID_RESPONSE');
    }
    return { payload: snapshot(data.payload), revision: data.revision, updatedAt: data.updated_at || null };
  }

  /** Never substitutes a fresh game when the cloud cannot be read. */
  async load() {
    this._assertActive();
    if (this._loaded || this._loading || this._reloading) {
      throw failure('저장 세션이 이미 시작되었습니다.', 'ALREADY_LOADED');
    }
    this._loading = true;
    this._status('loading');
    try {
      const remote = await this._readRemote();
      this._assertActive();
      const cache = this._readCache();
      this._revision = remote.revision;
      this._updatedAt = remote.updatedAt;
      this._loaded = true;
      if (cache) {
        this._pending = { payload: cache.payload, sequence: ++this._sequence };
        if (cache.revision !== remote.revision) {
          this._conflict = true;
          this._status('conflict', '다른 기기에서 진행한 기록이 있습니다. 클라우드 기록을 불러와 주세요.');
        } else {
          // The app must validate the restored engine before it authorizes any
          // automatic write by staging a fresh snapshot or explicitly flushing.
          this._status('pending', '이 기기에 남은 진행 기록을 확인하고 있습니다.');
        }
        return clone(cache.payload);
      }
      this._writeCache(remote.payload, false);
      this._status('saved');
      return clone(remote.payload);
    } catch (error) {
      if (!this._disposed) this._status(isOffline(error) ? 'offline' : 'error', error.message);
      throw error;
    } finally { this._loading = false; }
  }

  /** Capture by value before returning; later engine mutations cannot alter it. */
  stage(payload, { immediate = false } = {}) {
    this._assertActive();
    if (!this._loaded || this._reloading) throw failure('저장 기록을 먼저 불러와 주세요.', 'NOT_LOADED');
    const value = snapshot(payload);
    // A conflicted local record must retain its old base revision for the next login.
    if (this._conflict) {
      this._status('conflict', '다른 기기의 기록을 불러온 뒤 계속해 주세요.');
      return false;
    }
    this._pending = { payload: value, sequence: ++this._sequence };
    this._writeCache(value, true);
    this._status('pending', this._cacheWarning ? '기기 저장 공간을 사용할 수 없어 클라우드 저장을 기다리고 있습니다.' : undefined);
    if (immediate) void this.flush();
    else this._schedule();
    return true;
  }

  /** Serialize CAS writes and include any newer snapshot staged during a request. */
  async flush() {
    this._clearTimer();
    if (this._disposed || !this._loaded || this._conflict || this._reloading) return false;
    if (this._running) return this._running;
    if (!this._pending) return true;
    this._running = Promise.resolve().then(() => this._flushLoop()).finally(() => { this._running = null; });
    return this._running;
  }

  async _flushLoop() {
    while (this._pending && !this._disposed && !this._conflict) {
      const pending = this._pending;
      const expectedRevision = this._revision;
      this._status('saving');
      try {
        const accessToken = await this._accessToken();
        this._assertActive();
        const query = this.client.rpc('save_game', {
          p_payload: clone(pending.payload), p_expected_revision: expectedRevision,
        });
        const { data, error } = await this._pinAccount(query, accessToken);
        if (this._disposed) return false;
        if (error) throw error;
        const row = Array.isArray(data) && data.length === 1 ? data[0] : data;
        if (!isObject(row) || !validRevision(row.revision, 1) || row.revision !== expectedRevision + 1) {
          // The server may have committed; a fresh read is required before retrying.
          this._conflict = true;
          throw failure('클라우드 저장 결과를 확인할 수 없습니다. 기록을 다시 불러와 주세요.', 'INVALID_RESPONSE');
        }
        this._revision = row.revision;
        this._updatedAt = row.updated_at || new Date(this.now()).toISOString();
        if (this._pending.sequence === pending.sequence) {
          this._pending = null;
          this._writeCache(pending.payload, false);
        } else {
          // The newer snapshot now builds on the just-acknowledged server revision.
          this._writeCache(this._pending.payload, true);
          this._status('pending');
        }
      } catch (error) {
        if (this._disposed) return false;
        if (this._conflict || isConflict(error)) {
          this._conflict = true;
          this._status('conflict', isConflict(error)
            ? '다른 기기에서 저장했습니다. 클라우드 기록을 불러와 주세요.'
            : error.message);
        } else this._status(isOffline(error) ? 'offline' : 'error', error.message);
        return false;
      }
    }
    if (this._disposed) return false;
    this._status('saved');
    return true;
  }

  /** Discard an outbox only after successfully fetching its cloud replacement. */
  async reload() {
    this._assertActive();
    if (this._loading || this._reloading) throw failure('이미 저장 기록을 불러오는 중입니다.', 'LOAD_IN_PROGRESS');
    this._reloading = true;
    this._clearTimer();
    this._status('loading');
    try {
      if (this._running) await this._running;
      this._assertActive();
      const remote = await this._readRemote();
      this._assertActive();
      this._revision = remote.revision;
      this._updatedAt = remote.updatedAt;
      this._pending = null;
      this._conflict = false;
      this._loaded = true;
      this._writeCache(remote.payload, false);
      this._status('saved');
      return clone(remote.payload);
    } catch (error) {
      if (!this._disposed) this._status(isOffline(error) ? 'offline' : 'error', error.message);
      throw error;
    } finally { this._reloading = false; }
  }

  dispose() {
    this._disposed = true;
    this._clearTimer();
  }
}
