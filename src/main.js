import { initializeAccount, showStartupError } from './auth.js';

try {
  await initializeAccount();
  await import('./app.js');
} catch {
  showStartupError('게임 기록을 안전하게 불러오지 못했습니다. 잠시 후 다시 접속해 주세요.');
}
