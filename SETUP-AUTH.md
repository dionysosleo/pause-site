# 소셜 로그인(구글 · 카카오) 설정 방법

PAUSE 사이트는 **Supabase Auth**로 로그인을 처리합니다. 아래 순서대로 설정한 뒤
`index.html`의 `AUTH_CONFIG` 두 값만 채우면 구글·카카오·이메일 로그인이 작동합니다.

사이트 주소: `https://pause-site-seven.vercel.app` (도메인을 바꾸면 아래 주소도 함께 바꿔 주세요)

---

## 1. Supabase 프로젝트 만들기

1. https://supabase.com 가입 → **New project** (지역: Northeast Asia (Seoul))
2. **Project Settings → API**에서 두 값을 복사
   - `Project URL` → `AUTH_CONFIG.supabaseUrl`
   - `anon public` 키 → `AUTH_CONFIG.supabaseAnonKey` (공개용 키라 사이트 코드에 넣어도 됩니다. `service_role` 키는 절대 넣지 마세요)
3. **Authentication → URL Configuration**
   - Site URL: `https://pause-site-seven.vercel.app`
   - Redirect URLs에 `https://pause-site-seven.vercel.app/**` 추가

Supabase 콜백 주소(아래 구글·카카오 설정에 씁니다):
`https://<프로젝트ID>.supabase.co/auth/v1/callback`

## 2. 카카오 로그인

1. https://developers.kakao.com → 내 애플리케이션 → **애플리케이션 추가하기** (앱 이름: PAUSE)
2. **앱 키**에서 `REST API 키` 복사
3. **카카오 로그인 → 활성화 ON**, Redirect URI에 Supabase 콜백 주소 등록
4. **카카오 로그인 → 보안 → Client Secret** 생성 후 활성화, 코드 복사
5. **동의항목**: 닉네임(필수), 카카오계정(이메일) 설정
   - 이메일을 받으려면 비즈 앱 전환이 필요할 수 있습니다
6. **플랫폼 → Web**에 사이트 도메인 등록
7. Supabase **Authentication → Providers → Kakao** 활성화
   - Client ID = REST API 키, Client Secret = 4번 코드

## 3. 구글 로그인

1. https://console.cloud.google.com → 새 프로젝트 → **APIs & Services → OAuth consent screen** 설정 (앱 이름 PAUSE, 외부 사용자)
2. **Credentials → Create Credentials → OAuth client ID** → 웹 애플리케이션
   - Authorized JavaScript origins: `https://pause-site-seven.vercel.app`
   - Authorized redirect URIs: Supabase 콜백 주소
3. 생성된 Client ID / Client Secret을 Supabase **Authentication → Providers → Google**에 입력

## 4. 사이트에 반영

`index.html`에서 아래 부분을 채우고 GitHub `main`에 올리면 Vercel이 자동 배포합니다.

```js
var AUTH_CONFIG = {
  supabaseUrl: 'https://<프로젝트ID>.supabase.co',
  supabaseAnonKey: '<anon public key>'
};
```

## 동작 방식

- 값이 비어 있으면: 소셜 버튼을 누르면 "준비 중" 안내, 이메일 가입은 브라우저에만 저장되는 미리보기
- 값이 있으면: 구글·카카오 버튼 → 각 로그인 화면 → 사이트로 돌아와 마이페이지 이동, 이메일 가입 시 인증 메일 발송
