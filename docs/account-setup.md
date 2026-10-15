# 아이디 로그인과 계정 저장 연결

GitHub Pages는 게임 화면을 제공하고, Supabase는 아이디·비밀번호 인증과 계정별 저장을 담당합니다. Supabase **Free** 프로젝트 하나로 시작할 수 있습니다. 유료 플랜이나 추가 서비스를 활성화할 필요는 없습니다. [무료 플랜과 사용량 한도](https://supabase.com/pricing)

연결 설정이 비어 있으면 게임은 **계정 서버 연결 준비 중** 화면에서 대기합니다. 설정 이후에는 로그인해야 플레이할 수 있습니다.

## 1. 무료 프로젝트 준비

[Supabase 대시보드](https://supabase.com/dashboard)에서 Free 조직의 새 프로젝트를 만들거나 기존 무료 프로젝트를 선택합니다. 프로젝트 생성 시 설정하는 데이터베이스 비밀번호는 사이트 코드에 입력하지 않습니다.

SQL Editor에서 [`supabase/migrations/001_account_saves.sql`](../supabase/migrations/001_account_saves.sql) 전체를 실행합니다. `game_saves` 테이블과 `save_game` 함수, 계정별 읽기 정책이 생성됩니다.

## 2. 아이디·비밀번호 인증 설정

Authentication → Sign In / Providers의 Email 설정에서 다음 값을 적용합니다.

- Email 로그인 및 신규 가입: 활성화
- **Confirm email: 비활성화**
- 최소 비밀번호 길이: **8자 이상**
- Anonymous Sign-Ins: 비활성화 유지

Authentication → URL Configuration의 Site URL은 `https://iamkyleho.github.io/Mock_Investment/`로 설정합니다. 이 로그인 방식에는 GitHub OAuth 앱이나 OAuth callback 등록이 필요하지 않습니다. [Supabase 비밀번호 인증 안내](https://supabase.com/docs/guides/auth/passwords), [비밀번호 정책 안내](https://supabase.com/docs/guides/auth/password-security)

게임 아이디는 영문·숫자·밑줄 3~20자이며 소문자로 정규화합니다. 내부 인증 식별자는 `아이디@players.mock.invalid` 형태입니다. 예를 들어 `Kyle_01`과 `kyle_01`은 같은 계정이고 내부 식별자는 `kyle_01@players.mock.invalid`입니다. 이 주소는 이메일을 받지 않으므로 **이메일 확인을 켜면 회원가입이 완료되지 않습니다.**

실제 이메일을 수집하지 않아 이메일로 비밀번호를 복구하는 기능은 없습니다. 사용자는 아이디와 비밀번호를 기억하거나 비밀번호 관리자에 보관해야 합니다. 내부 식별자 규칙을 배포 후 변경하면 기존 계정으로 로그인할 수 없으므로 그대로 유지하세요.

## 3. 공개 연결 정보 입력

프로젝트의 Connect 창 또는 Settings에서 **Project URL**과 **Publishable key**를 확인한 뒤 `src/auth-config.js`에 입력합니다.

```js
export const AUTH_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  supabasePublishableKey: 'sb_publishable_YOUR_PUBLIC_KEY',
};
```

이 두 값은 브라우저에 공개되는 연결 정보입니다. **Secret key, service_role 키, 데이터베이스 비밀번호를 이 파일이나 GitHub 저장소에 넣지 마세요.** 계정 데이터 접근은 로그인 세션과 SQL의 Row Level Security 정책으로 제한됩니다. [Supabase API 키 안내](https://supabase.com/docs/guides/getting-started/api-keys)

변경 파일을 기존 GitHub 저장소의 `main` 브랜치에 올리고 Pages 배포가 완료되면 [게임 주소](https://iamkyleho.github.io/Mock_Investment/)에서 가입·로그인할 수 있습니다. 로컬 서버에서도 동일한 프로젝트 연결 정보를 사용합니다.

## 저장 동작과 확인

- 같은 아이디로 다시 로그인하면 그 계정의 자산, 포지션, 거래 기록, 빚과 설정을 불러옵니다.
- 다른 사람의 계정 데이터는 읽거나 수정할 수 없습니다. 비밀번호는 `game_saves`에 저장하지 않습니다.
- 기존 브라우저 기록은 새 계정으로 자동 귀속하지 않습니다. 계정에 저장 기록이 없을 때만 기록 가져오기 또는 새 게임을 선택합니다.
- 두 기기에서 동시에 플레이해 저장 버전이 달라지면 오래된 기기의 저장을 중지합니다. 최신 기록을 다시 불러온 뒤 이어서 플레이합니다. 오래된 기록으로 서버 데이터를 강제 덮어쓰지 않습니다.
- 연결이 끊겼을 때는 화면의 저장 상태를 확인하세요. 다른 기기에서 이어 하기 전 **클라우드 저장 완료** 상태인지 확인합니다.

배포 확인은 서로 다른 두 아이디로 진행합니다. 첫 번째 아이디에서 거래 후 저장을 확인하고 다른 브라우저에서 같은 아이디로 이어지는지 확인합니다. 두 번째 아이디에는 첫 번째 계정의 자산·거래가 보이지 않아야 합니다.

## 저장 API 계약

`game_saves`의 키는 Supabase 인증 사용자 ID인 `user_id`입니다. 로그인한 사용자는 자신의 행만 `SELECT`할 수 있고, 직접 `INSERT`, `UPDATE`, `DELETE`할 권한은 없습니다. 쓰기는 아래 RPC로만 수행합니다.

```js
await supabase.rpc('save_game', {
  p_payload: {
    schemaVersion: 1,
    game: { version: 1, state: { /* 게임 상태 */ }, markets: { /* 가상 시세 */ } },
    preferences: { /* 화면 설정 */ },
  },
  p_expected_revision: 0, // 최초 저장. 이후에는 마지막으로 읽은 revision 사용.
});
```

응답 행은 `payload`, `revision`, `updated_at`을 포함합니다. 최초 저장은 버전 1이고 성공할 때마다 1씩 증가합니다. 충돌은 오류 코드 `P0001`, 메시지 `SAVE_CONFLICT`를 반환하며 저장된 내용을 변경하지 않습니다. JSON 저장 자료는 최대 2 MiB이고 버전 및 기본 구조를 검사합니다. 이는 가상 자금 게임의 저장 기능이며 서버가 모든 거래 결과를 검증하는 경쟁용 순위 시스템은 아닙니다.
