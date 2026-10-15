import { AUTH_CONFIG } from './auth-config.js';
import { CloudSaveStore } from './cloud-save.js';
import { LEGACY_GAME_KEY, LEGACY_PREF_KEY, normalizeUsername, accountEmail,
  loginEmail, validatePassword, validateAuthConfig, makeAccountPayload, authErrorMessage } from './account-utils.js?v=20261015-admin1';

const $ = selector => document.querySelector(selector);
let client;
let store;
let hooks;
let mode = 'login';
let busy = false;
let ready;
let lastStatus = { state: 'loading' };
let booted = false;
let sessionClosed = false;
let authStorageKey;
let storage;
try { storage = window.localStorage; } catch { /* Cloud saves can work without local storage. */ }

export const accountSession = {
  payload: null,
  user: null,
  username: '',
  canPlay: false,
  save(game, preferences, { immediate = false } = {}) {
    if (!store || sessionClosed || !this.canPlay) return;
    try { store.stage(makeAccountPayload(game, preferences), { immediate }); }
    catch { updateSaveStatus({ state: 'error', message: '기록을 저장하지 못했습니다. 계정 메뉴에서 다시 시도해 주세요.' }); }
  },
  flush() { return store ? store.flush() : Promise.resolve(false); },
};

function setFeedback(message, error = false) {
  $('#auth-feedback').textContent = message;
  $('#auth-feedback').classList.toggle('is-error', error);
}

function setBusy(value) {
  busy = value;
  $('#auth-submit').disabled = value;
  $('#auth-loading').hidden = !value;
  $('#auth-form').setAttribute('aria-busy', String(value));
  for (const input of $('#auth-form').querySelectorAll('input')) input.disabled = value;
  for (const tab of document.querySelectorAll('[data-auth-mode]')) tab.disabled = value;
}

function setMode(nextMode) {
  if (busy) return;
  mode = nextMode === 'signup' ? 'signup' : 'login';
  const signup = mode === 'signup';
  for (const tab of document.querySelectorAll('[data-auth-mode]')) {
    const selected = tab.dataset.authMode === mode;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  $('#auth-title').textContent = signup ? '당신의 계좌를 만들어보세요.' : '다시, 당신의 시장으로.';
  $('#auth-description').textContent = signup
    ? '아이디 하나로 시작하는 나만의 투자. 첫 자금 10만 원을 준비했어요.'
    : '로그인하면 마지막 투자 기록에서 이어서 시작합니다.';
  $('#auth-confirm-field').hidden = !signup;
  $('#auth-confirm').required = signup;
  $('#auth-confirm').value = '';
  $('#auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#auth-username-label').textContent = signup ? '아이디' : '아이디 또는 관리자 이메일';
  $('#auth-username').maxLength = signup ? 20 : 254;
  $('#auth-username').placeholder = signup ? '나만의 아이디' : '아이디 또는 관리자 이메일';
  $('#auth-username').title = signup ? '영문, 숫자, 밑줄(_)을 사용해 3~20자로 입력하세요.' : '가입한 아이디 또는 관리자 이메일을 입력하세요.';
  if (signup) $('#auth-username').pattern = '[A-Za-z0-9_]{3,20}';
  else $('#auth-username').removeAttribute('pattern');
  $('#auth-username-hint').textContent = signup ? '영문, 숫자, 밑줄(_) · 3–20자' : '일반 회원은 아이디, 관리자는 지정된 계정으로 로그인하세요.';
  $('#auth-submit').textContent = signup ? '계정 만들고 시작하기 →' : '로그인하고 이어 하기 →';
  setFeedback('');
}

function statusText(status) {
  if (status.state === 'offline' && status.localAvailable === false) return '저장 연결 끊김 · 이 창을 닫지 마세요';
  return ({ loading: '계정 기록 불러오는 중', saved: '클라우드 저장 완료', pending: '변경 사항 저장 대기',
    saving: '클라우드에 저장 중', offline: '연결 끊김 · 저장 재시도 필요',
    conflict: '다른 기기의 최신 기록 확인 필요', error: '저장 확인 필요' })[status.state] || '저장 확인 중';
}

function updateSaveStatus(status) {
  if (sessionClosed) return;
  lastStatus = status;
  const message = statusText(status);
  $('#save-status').textContent = message;
  $('#save-status').dataset.state = status.state;
  $('#save-status').title = status.message || message;
  const savedTime = status.updatedAt ? new Date(status.updatedAt) : null;
  $('#account-save-status').textContent = message + (savedTime && !Number.isNaN(savedTime.getTime())
    ? ` · ${savedTime.toLocaleTimeString('ko-KR')}` : '');
  if (status.state === 'conflict') {
    accountSession.canPlay = false;
    if (hooks) showConflict();
  }
}

function closeDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

function showConflict() {
  closeDialogs();
  $('#save-conflict-dialog').showModal();
}

export function showStartupError(message) {
  accountSession.canPlay = false;
  store?.dispose();
  closeDialogs();
  document.body.classList.add('auth-locked');
  $('#auth-screen').hidden = false;
  setBusy(false);
  for (const input of $('#auth-form').querySelectorAll('input')) { input.value = ''; input.disabled = true; }
  for (const tab of document.querySelectorAll('[data-auth-mode]')) tab.disabled = true;
  $('#auth-retry-save').hidden = true;
  $('#auth-form').noValidate = true;
  $('#auth-form').removeEventListener('submit', submitAccount);
  $('#auth-form').addEventListener('submit', event => { event.preventDefault(); location.reload(); });
  $('#auth-submit').textContent = '다시 불러오기';
  setFeedback(message, true);
}

async function chooseExistingSave() {
  let legacy;
  try {
    const game = JSON.parse(storage?.getItem(LEGACY_GAME_KEY) || 'null');
    if (game?.version !== 1 || !game.state || !game.markets) return null;
    const preferences = JSON.parse(storage?.getItem(LEGACY_PREF_KEY) || '{}');
    legacy = makeAccountPayload(game, preferences || {});
  } catch { return null; }
  const dialog = $('#import-save-dialog');
  dialog.showModal();
  return new Promise(resolve => {
    const finish = payload => {
      $('#import-existing-save').removeEventListener('click', useExisting);
      $('#start-new-account-game').removeEventListener('click', useNew);
      dialog.close();
      resolve(payload);
    };
    const useExisting = () => finish(legacy);
    const useNew = () => finish(null);
    $('#import-existing-save').addEventListener('click', useExisting);
    $('#start-new-account-game').addEventListener('click', useNew);
  });
}

async function openPlayer(user) {
  if (booted) return;
  if (!user?.id || typeof user.email !== 'string') {
    throw new Error('INVALID_ACCOUNT');
  }
  setBusy(true);
  setFeedback('계정 권한과 저장된 기록을 확인하고 있습니다.');
  accountSession.user = user;
  // The server owns administrator membership. A name or editable user metadata
  // must never grant access to other players' records.
  const role = await client.rpc('is_game_admin');
  if (role.error || typeof role.data !== 'boolean') throw new Error('ACCOUNT_ROLE_UNAVAILABLE');
  if (sessionClosed || accountSession.user?.id !== user.id) throw new Error('SESSION_CHANGED');
  if (role.data) {
    booted = true;
    $('#auth-password').value = '';
    $('#auth-confirm').value = '';
    location.replace('./admin.html');
    return;
  }
  if (!user.email.endsWith('@players.mock.invalid')) throw new Error('INVALID_ACCOUNT');
  accountSession.username = normalizeUsername(user.email.split('@')[0]);
  store?.dispose();
  store = new CloudSaveStore({ client, userId: user.id, storage,
    onStatus: updateSaveStatus, delayMs: 30_000 });
  let payload;
  try { payload = await store.load(); }
  catch (error) { if (!sessionClosed) $('#auth-retry-save').hidden = false; throw error; }
  await finishPlayer(payload, user.id);
}

async function finishPlayer(payload, userId) {
  if (sessionClosed || accountSession.user?.id !== userId) throw new Error('SESSION_CHANGED');
  accountSession.payload = payload ?? await chooseExistingSave();
  if (sessionClosed || accountSession.user?.id !== userId) throw new Error('SESSION_CHANGED');
  const username = accountSession.username;
  $('#avatar-initial').textContent = username.charAt(0).toUpperCase();
  $('#account-button').title = `${username} · 내 계정`;
  $('#account-button').setAttribute('aria-label', `${username} 계정 및 저장 상태`);
  $('#account-name').textContent = username;
  $('#auth-password').value = '';
  $('#auth-confirm').value = '';
  $('#auth-retry-save').hidden = true;
  booted = true;
  ready();
}

async function submitAccount(event) {
  event.preventDefault();
  if (busy || !client) return;
  let username, email, password;
  try {
    if (mode === 'signup') {
      username = normalizeUsername($('#auth-username').value);
      email = accountEmail(username);
    } else email = loginEmail($('#auth-username').value);
    password = validatePassword($('#auth-password').value);
    if (mode === 'signup' && password !== $('#auth-confirm').value) {
      throw new Error('비밀번호가 일치하지 않습니다. 다시 확인해 주세요.');
    }
  } catch (error) { setFeedback(error.message, true); return; }
  setBusy(true);
  setFeedback(mode === 'signup' ? '계정을 만드는 중입니다…' : '로그인 중입니다…');
  try {
    const credentials = { email, password };
    const result = mode === 'signup'
      ? await client.auth.signUp({ ...credentials, options: { data: { username } } })
      : await client.auth.signInWithPassword(credentials);
    password = '';
    if (result.error) {
      setFeedback(authErrorMessage(result.error), true);
      return;
    }
    if (!result.data.session) {
      setFeedback('계정 활성화가 완료되지 않았습니다. 게임 운영자에게 문의해 주세요.', true);
      return;
    }
    $('#auth-password').value = '';
    $('#auth-confirm').value = '';
    await openPlayer(result.data.user);
  } catch {
    setFeedback('로그인 또는 저장 기록을 불러오지 못했습니다. 잠시 후 다시 로그인해 주세요.', true);
  } finally { password = ''; setBusy(false); }
}

export async function initializeAccount() {
  $('#auth-form').addEventListener('submit', submitAccount);
  for (const tab of document.querySelectorAll('[data-auth-mode]')) tab.addEventListener('click', () => setMode(tab.dataset.authMode));
  $('#auth-toggle-password').addEventListener('click', () => {
    const visible = $('#auth-password').type === 'password';
    $('#auth-password').type = visible ? 'text' : 'password';
    $('#auth-toggle-password').textContent = visible ? '숨기기' : '보기';
    $('#auth-toggle-password').setAttribute('aria-pressed', String(visible));
    $('#auth-toggle-password').setAttribute('aria-label', visible ? '비밀번호 숨기기' : '비밀번호 표시');
  });
  $('#auth-retry-save').addEventListener('click', async () => {
    if (!store || busy || sessionClosed || booted) return;
    setBusy(true);
    try {
      const userId = accountSession.user.id;
      const payload = await store.reload();
      await finishPlayer(payload, userId);
    } catch { setFeedback('클라우드 기록을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.', true); }
    finally { setBusy(false); }
  });
  for (const id of ['import-save-dialog', 'save-conflict-dialog']) {
    $(`#${id}`).addEventListener('cancel', event => event.preventDefault());
  }
  setMode('login');
  let configured = false;
  try { configured = validateAuthConfig(AUTH_CONFIG); }
  catch { setFeedback('로그인 서버 설정을 확인 중입니다. 잠시 후 다시 방문해 주세요.', true); }
  if (!configured) {
    $('#auth-setup').hidden = false;
    $('#auth-submit').disabled = true;
    return new Promise(() => {});
  }
  const { createClient } = await import('./vendor/supabase.js');
  authStorageKey = `mock-account-${new URL(AUTH_CONFIG.supabaseUrl).hostname}`;
  client = createClient(AUTH_CONFIG.supabaseUrl, AUTH_CONFIG.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce',
      storageKey: authStorageKey },
  });
  const started = new Promise(resolve => { ready = resolve; });
  client.auth.onAuthStateChange((_event, session) => {
    // Never await Supabase methods from this callback (the SDK holds its auth lock).
    if (accountSession.user && (!session || session.user.id !== accountSession.user.id)) {
      sessionClosed = true;
      accountSession.canPlay = false;
      store?.dispose();
      queueMicrotask(() => location.reload());
    }
  });
  setBusy(true);
  try {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (data.session) {
      const verified = await client.auth.getUser();
      if (verified.error) throw verified.error;
      await openPlayer(verified.data.user);
    }
  } catch { setFeedback('저장된 로그인 상태를 확인하지 못했습니다. 다시 로그인해 주세요.', true); }
  finally { setBusy(false); }
  return started;
}

export function bindAccountGame(gameHooks) {
  if (sessionClosed) throw new Error('SESSION_CHANGED');
  hooks = gameHooks;
  accountSession.canPlay = lastStatus.state !== 'conflict';
  document.body.classList.remove('auth-locked');
  $('#auth-screen').hidden = true;
  $('#account-button').addEventListener('click', () => $('#account-dialog').showModal());
  $('#gameover-account-button').addEventListener('click', () => $('#account-dialog').showModal());
  const localLogout = document.createElement('button');
  localLogout.type = 'button';
  localLogout.className = 'text-button account-local-logout';
  localLogout.id = 'account-local-logout';
  localLogout.textContent = '이 기기에 미저장 기록을 남기고 로그아웃';
  localLogout.hidden = true;
  $('#account-dialog').append(localLogout);
  localLogout.addEventListener('click', async () => {
    const snapshot = hooks.snapshot();
    accountSession.save(snapshot.game, snapshot.preferences);
    if (!store.canPersistLocal) {
      $('#account-save-status').textContent = '기기에 기록을 보관하지 못했습니다. 인터넷 연결 후 저장해 주세요.';
      return;
    }
    accountSession.canPlay = false;
    localLogout.disabled = true;
    try {
      // Offline exit explicitly removes only this app's persisted login. Its
      // account-scoped game outbox remains available after the next login.
      await client.auth.stopAutoRefresh();
      storage.removeItem(authStorageKey);
      storage.removeItem(`${authStorageKey}-code-verifier`);
      sessionClosed = true;
      store.dispose();
      location.reload();
    } catch {
      $('#account-save-status').textContent = '로그인 정보를 지우지 못했습니다. 연결 후 다시 로그아웃해 주세요.';
      accountSession.canPlay = !store.conflicted;
      localLogout.disabled = false;
    }
  });
  $('#account-save-button').addEventListener('click', async () => {
    const snapshot = hooks.snapshot();
    accountSession.save(snapshot.game, snapshot.preferences);
    $('#account-save-button').disabled = true;
    try { await store.flush(); }
    finally { $('#account-save-button').disabled = false; }
  });
  $('#account-logout-button').addEventListener('click', async () => {
    $('#account-logout-button').disabled = true;
    const snapshot = hooks.snapshot();
    accountSession.save(snapshot.game, snapshot.preferences);
    accountSession.canPlay = false;
    try {
      if (!await store.flush()) {
        $('#account-save-status').textContent = store.canPersistLocal
          ? '서버 저장 전입니다. 이 기기에 기록을 남기고 나가면, 다음에 이 기기에서 로그인해야 복구됩니다.'
          : '저장을 완료하지 못했습니다. 연결을 확인하고 다시 로그아웃해 주세요.';
        localLogout.hidden = !store.canPersistLocal;
        accountSession.canPlay = lastStatus.state !== 'conflict';
        return;
      }
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      sessionClosed = true;
      store.dispose();
      location.reload();
    } catch {
      $('#account-save-status').textContent = '로그아웃하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      accountSession.canPlay = lastStatus.state !== 'conflict';
    } finally { $('#account-logout-button').disabled = false; }
  });
  $('#load-cloud-save').addEventListener('click', async () => {
    $('#load-cloud-save').disabled = true;
    try {
      const payload = await store.reload();
      hooks.restore(payload);
      $('#save-conflict-dialog').close();
      accountSession.canPlay = true;
      hooks.resume();
    } catch { $('#load-cloud-save').textContent = '불러오지 못했어요. 다시 시도'; }
    finally { $('#load-cloud-save').disabled = false; }
  });
  window.addEventListener('online', () => { if (!sessionClosed) void store.flush(); });
  if (lastStatus.state === 'conflict') showConflict();
  else {
    const snapshot = hooks.snapshot();
    accountSession.save(snapshot.game, snapshot.preferences, { immediate: true });
  }
}
