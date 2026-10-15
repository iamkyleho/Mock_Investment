import { AUTH_CONFIG } from './auth-config.js';
import { validateAuthConfig } from './account-utils.js';

const $ = selector => document.querySelector(selector);
const PAGE_SIZE = 25;
const numberFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
});

let client;
let adminUserId;
let authSubscription;
let requestController;
let requestNumber = 0;
let offset = 0;
let totalCount = 0;
let search = '';
let busy = false;
let authorized = false;

function money(value, signed = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const sign = signed && rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `${sign}₩${numberFormat.format(Math.abs(rounded))}`;
}

function date(value, includeTime = false) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return dateFormat.format(parsed) + (includeTime ? ` ${timeFormat.format(parsed)}` : '');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pnlClass(value) {
  return value > 0 ? 'up' : value < 0 ? 'down' : 'neutral';
}

function clearData() {
  $('#players-body').replaceChildren();
  for (const id of ['members', 'equity', 'profit', 'loss']) $(`#metric-${id}`).textContent = '—';
  $('#metric-members-note').textContent = '조회된 계정';
  $('#metric-profit-note').textContent = '초기 자금 대비 플러스 계정';
  $('#metric-loss-note').textContent = '초기 자금 대비 마이너스 계정';
  for (const id of ['equity', 'profit', 'loss']) $(`#metric-${id}`).removeAttribute('title');
  $('#players-count').textContent = '0';
  $('#admin-filter-label').textContent = '전체 회원 · 최신 가입순';
  $('#admin-page-range').textContent = '0개 계정';
  $('#admin-page-label').textContent = '1 / 1';
  $('#admin-updated-at').textContent = '데이터 확인 중';
  totalCount = 0;
}

function showGate(title, description, { retry = false, back = '로그인 화면으로' } = {}) {
  authorized = false;
  requestController?.abort();
  requestNumber += 1;
  clearData();
  $('#admin-identity').hidden = true;
  $('#admin-dashboard').hidden = true;
  $('#admin-gate').hidden = false;
  $('#admin-spinner').hidden = true;
  $('#admin-gate-title').textContent = title;
  $('#admin-gate-description').textContent = description;
  $('#admin-gate-back').textContent = back;
  $('#admin-gate-back').hidden = false;
  $('#admin-gate-retry').hidden = !retry;
  document.body.removeAttribute('aria-busy');
}

function setBusy(value) {
  busy = value;
  document.body.setAttribute('aria-busy', String(value));
  $('#admin-refresh').disabled = value;
  $('#admin-refresh').setAttribute('aria-busy', String(value));
  $('#admin-page-prev').disabled = value || offset === 0;
  $('#admin-page-next').disabled = value || offset + PAGE_SIZE >= totalCount;
  $('#admin-table-loading').hidden = !value;
  $('#players-table-wrap').hidden = value;
  if (value) $('#admin-empty').hidden = true;
}

function feedback(message) {
  $('#admin-feedback').textContent = message;
  $('#admin-feedback').hidden = !message;
}

function renderSummary(summary) {
  const members = Number(summary.player_count) || 0;
  $('#metric-members').textContent = `${numberFormat.format(members)}명`;
  $('#metric-members-note').textContent = `${search ? '검색 결과' : '전체 계정'} · 저장 기록 ${numberFormat.format(Number(summary.saved_count) || 0)}개`;
  $('#metric-equity').textContent = money(summary.net_equity);
  $('#metric-profit').textContent = money(summary.profit, true);
  $('#metric-loss').textContent = money(-summary.loss, true);
  $('#metric-profit-note').textContent = `수익 중인 계정 ${numberFormat.format(Number(summary.winners) || 0)}명`;
  $('#metric-loss-note').textContent = `손실 중인 계정 ${numberFormat.format(Number(summary.losers) || 0)}명`;
  for (const id of ['equity', 'profit', 'loss']) {
    const node = $(`#metric-${id}`);
    node.title = node.textContent;
  }
}

function renderPlayer(player) {
  const row = element('tr');
  const username = String(player.username || '이름 없음');
  const account = element('td');
  const accountWrap = element('div', 'account-cell');
  const initial = element('span', 'account-initial', username.slice(0, 1).toUpperCase());
  initial.setAttribute('aria-hidden', 'true');
  const identity = element('div');
  const name = element('div', 'account-name', username);
  if (player.is_admin) name.append(element('span', 'mini-admin', 'ADMIN'));
  identity.append(name, element('span', 'cell-secondary', date(player.created_at)));
  accountWrap.append(initial, identity);
  account.append(accountWrap);

  const state = element('td');
  const stateKey = !player.stats_valid ? 'invalid' : !player.has_save ? 'not_started' : player.status;
  const states = { playing: '진행 중', bankrupt: '자금 소진', gameover: 'GAME OVER', not_started: '시작 전', invalid: '기록 확인 필요' };
  state.append(element('span', `state-pill ${Object.hasOwn(states, stateKey) ? stateKey : 'invalid'}`, states[stateKey] || states.invalid));
  if (player.stats_valid && player.has_save) {
    state.append(element('span', 'cell-secondary', `거래 ${numberFormat.format(Number(player.trades) || 0)}회 · 보유 ${numberFormat.format(Number(player.open_positions) || 0)}`));
  }

  const equity = element('td', 'numeric');
  equity.append(element('span', null, money(player.net_equity)), element('span', 'cell-secondary', `현금 ${money(player.cash)}`));
  const pnl = element('td', 'numeric emphasis');
  pnl.append(element('span', `pnl-value ${pnlClass(player.total_pnl)}`, money(player.total_pnl, true)));
  if (typeof player.total_pnl === 'number') {
    const percent = player.total_pnl / 1000;
    pnl.append(element('span', `cell-secondary ${pnlClass(player.total_pnl)}`, `${percent > 0 ? '+' : ''}${percent.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`));
  }
  const realized = element('td', `numeric ${pnlClass(player.realized_pnl)}`, money(player.realized_pnl, true));
  const unrealized = element('td', `numeric ${pnlClass(player.unrealized_pnl)}`, money(player.unrealized_pnl, true));
  const debt = element('td', `numeric ${player.debt > 0 ? 'debt-value' : 'neutral'}`, money(player.debt));
  const saved = element('td');
  saved.append(element('span', null, player.last_saved_at ? date(player.last_saved_at, true) : '아직 저장 전'));
  saved.append(element('span', 'cell-secondary', 'KST · 마지막 클라우드 기록'));
  row.append(account, state, equity, pnl, realized, unrealized, debt, saved);
  return row;
}

function renderResult(result) {
  if (!result || !Array.isArray(result.players) || !result.summary || !Number.isFinite(Number(result.total_count))) {
    throw new Error('INVALID_RESULT');
  }
  totalCount = Math.max(0, Number(result.total_count));
  renderSummary(result.summary);
  $('#players-count').textContent = numberFormat.format(totalCount);
  $('#admin-filter-label').textContent = search ? `“${search}” 검색 결과 · 최신 가입순` : '전체 회원 · 최신 가입순';
  $('#players-body').replaceChildren(...result.players.map(renderPlayer));
  $('#admin-empty').hidden = result.players.length > 0;
  $('#admin-empty h3').textContent = search ? '일치하는 아이디가 없어요' : '표시할 계정이 없어요';
  $('#admin-empty p').textContent = search ? '다른 검색어로 다시 찾아보세요.' : '새 회원이 가입하면 이곳에서 확인할 수 있어요.';
  $('#admin-page-range').textContent = totalCount
    ? `${numberFormat.format(offset + 1)}–${numberFormat.format(offset + result.players.length)} / ${numberFormat.format(totalCount)}개 계정`
    : '0개 계정';
  $('#admin-page-label').textContent = `${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}`;
  $('#admin-updated-at').textContent = `조회 ${date(result.generated_at || new Date().toISOString(), true)} KST`;
  const invalid = Number(result.summary.invalid_count) || 0;
  feedback(invalid ? `${invalid}개 계정의 저장 기록을 계산할 수 없어 금액 합계에서 제외했습니다.` : '');
}

async function sessionToken() {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session || data.session.user.id !== adminUserId) throw new Error('SESSION_CHANGED');
  return data.session.access_token;
}

async function loadPlayers() {
  if (!authorized) return;
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  const request = ++requestNumber;
  setBusy(true);
  feedback('');
  try {
    const token = await sessionToken();
    const { data, error } = await client.rpc('admin_player_stats', {
      p_search: search, p_limit: PAGE_SIZE, p_offset: offset,
    }).setHeader('Authorization', `Bearer ${token}`).abortSignal(controller.signal);
    if (request !== requestNumber || !authorized) return;
    if (error) throw error;
    if (offset > 0 && Number(data?.total_count) <= offset) {
      offset = Math.max(0, Math.ceil(Number(data?.total_count) / PAGE_SIZE) - 1) * PAGE_SIZE;
      await loadPlayers();
      return;
    }
    renderResult(data);
  } catch (error) {
    if (request !== requestNumber || controller.signal.aborted) return;
    if (error?.message === 'SESSION_CHANGED') {
      showGate('다시 로그인해 주세요', '로그인한 계정이 변경되었거나 세션이 만료되었습니다.');
    } else if (['42501', 'PGRST301', 'PGRST302'].includes(error?.code)) {
      showGate('관리자 권한을 확인할 수 없어요', '이 페이지는 관리자 계정으로만 이용할 수 있습니다.', { back: '게임으로 돌아가기' });
    } else {
      clearData();
      $('#admin-page-range').textContent = '조회 실패';
      $('#admin-page-label').textContent = '—';
      $('#admin-updated-at').textContent = '마지막 조회 실패';
      feedback('회원 기록을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요.');
    }
  } finally {
    if (request === requestNumber) setBusy(false);
  }
}

async function initialize() {
  try {
    if (!validateAuthConfig(AUTH_CONFIG)) throw new Error('NO_CONFIG');
    const { createClient } = await import('./vendor/supabase.js');
    client = createClient(AUTH_CONFIG.supabaseUrl, AUTH_CONFIG.supabasePublishableKey, {
      auth: {
        persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
        storageKey: `mock-account-${new URL(AUTH_CONFIG.supabaseUrl).hostname}`,
      },
    });
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) { location.replace('./'); return; }
    const { data: userData, error: userError } = await client.auth.getUser(sessionData.session.access_token);
    if (userError || !userData.user) {
      showGate('다시 로그인해 주세요', '계정 정보를 확인하지 못했습니다. 로그인 후 다시 접속해 주세요.');
      return;
    }
    adminUserId = userData.user.id;
    const { data: isAdmin, error: roleError } = await client.rpc('is_game_admin')
      .setHeader('Authorization', `Bearer ${await sessionToken()}`);
    if (roleError) throw roleError;
    if (isAdmin !== true) {
      showGate('관리자 전용 페이지예요', '일반 계정에서는 다른 회원의 기록을 볼 수 없습니다.', { back: '게임으로 돌아가기' });
      return;
    }
    // Only a verified server-side role opens the console; IDs or user metadata never grant access.
    authorized = true;
    $('#admin-username').textContent = userData.user.email?.split('@')[0] || '관리자';
    $('#admin-identity').hidden = false;
    $('#admin-gate').hidden = true;
    $('#admin-dashboard').hidden = false;
    authSubscription = client.auth.onAuthStateChange((_event, session) => {
      if (!session || session.user.id !== adminUserId) {
        queueMicrotask(() => showGate('다시 로그인해 주세요', '로그인한 계정이 변경되었거나 로그아웃되었습니다.'));
      }
    }).data.subscription;
    await loadPlayers();
  } catch {
    showGate('관리자 페이지에 연결하지 못했어요', '인터넷 연결을 확인하고 다시 시도해 주세요.', { retry: true });
  }
}

$('#admin-refresh').addEventListener('click', () => { if (!busy) loadPlayers(); });
$('#admin-search-form').addEventListener('submit', event => {
  event.preventDefault();
  search = $('#admin-search').value.trim().slice(0, 64).toLowerCase();
  offset = 0;
  loadPlayers();
});
$('#admin-search').addEventListener('search', () => {
  if ($('#admin-search').value === '' && search) {
    search = ''; offset = 0; loadPlayers();
  }
});
$('#admin-page-prev').addEventListener('click', () => {
  if (!busy && offset > 0) { offset = Math.max(0, offset - PAGE_SIZE); loadPlayers(); }
});
$('#admin-page-next').addEventListener('click', () => {
  if (!busy && offset + PAGE_SIZE < totalCount) { offset += PAGE_SIZE; loadPlayers(); }
});
$('#admin-gate-retry').addEventListener('click', () => location.reload());
$('#admin-logout').addEventListener('click', async () => {
  $('#admin-logout').disabled = true;
  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
    location.replace('./');
  } catch {
    feedback('로그아웃하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.');
    $('#admin-logout').disabled = false;
  }
});
window.addEventListener('pagehide', () => {
  requestController?.abort();
  authSubscription?.unsubscribe();
  clearData();
  $('#admin-dashboard').hidden = true;
});
window.addEventListener('pageshow', event => {
  // A restored browser-history page must recheck identity before showing cached member data.
  if (event.persisted) {
    showGate('관리자 권한 확인 중', '계정 정보를 다시 확인하고 있어요.');
    location.reload();
  }
});

await initialize();
