export const LEGACY_GAME_KEY = 'mock-exchange-game-v1';
export const LEGACY_PREF_KEY = 'mock-exchange-preferences-v1';

export function normalizeUsername(value) {
  const username = String(value).trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    throw new Error('아이디는 영문, 숫자, 밑줄(_)로 3~20자 입력해 주세요.');
  }
  return username;
}

// The user enters an ID, not an email. This reserved domain never receives mail.
export function accountEmail(username) {
  return `${normalizeUsername(username)}@players.mock.invalid`;
}

// Administrators may use an owner-provisioned email account. This only selects
// the authentication identifier; administrator access is checked on the server.
export function loginEmail(value) {
  const identifier = String(value).trim().toLowerCase();
  if (!identifier.includes('@')) return accountEmail(identifier);
  if (identifier.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier)) {
    throw new Error('아이디 또는 이메일 주소를 확인해 주세요.');
  }
  return identifier;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('비밀번호는 8~128자로 입력해 주세요.');
  }
  return password;
}

export function validateAuthConfig(config) {
  if (!config?.supabaseUrl || !config?.supabasePublishableKey) return false;
  const url = new URL(config.supabaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) throw new Error('로그인 서버 주소를 확인해 주세요.');
  if (!config.supabasePublishableKey.startsWith('sb_publishable_')) {
    throw new Error('로그인 서버에는 공개용 publishable 키만 사용할 수 있습니다.');
  }
  return true;
}

// Full account state is retained. Save recent chart history for the selected
// instrument; the other fictional charts regenerate older illustrative history.
export function makeAccountPayload(game, preferences) {
  const markets = Object.fromEntries(Object.entries(game.markets).map(([id, quote]) => [id, {
    price: quote.price, previousClose: quote.previousClose,
    candles: quote.candles.slice(id === preferences.selected ? -180 : -2),
  }]));
  return { schemaVersion: 1, game: { ...game, markets }, preferences: structuredClone(preferences) };
}

export function authErrorMessage(error) {
  const code = error?.code;
  if (['invalid_credentials', 'user_not_found'].includes(code)) return '아이디 또는 비밀번호가 올바르지 않습니다.';
  if (['user_already_exists', 'email_exists'].includes(code)) return '이미 사용 중인 아이디입니다. 다른 아이디를 입력해 주세요.';
  if (['over_request_rate_limit', 'over_email_send_rate_limit'].includes(code) || error?.status === 429) return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'weak_password') return '더 강한 비밀번호를 사용해 주세요. 영문, 숫자, 기호를 함께 쓰면 좋아요.';
  if (['signup_disabled', 'email_provider_disabled'].includes(code)) return '현재 회원가입을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'email_not_confirmed') return '계정 활성화가 완료되지 않았습니다. 게임 운영자에게 문의해 주세요.';
  return '서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.';
}
