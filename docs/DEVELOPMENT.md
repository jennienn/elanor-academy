# Development Guide

[프로젝트 소개로 돌아가기](../README.md)

## 테스트 데이터 안전 원칙

- 기본 대상은 Docker 기반 로컬 Supabase입니다. 운영 DB에는 테스트·seed를 실행하지 않습니다.
- 테스트 설정은 `.env.test.local`에 분리합니다. E2E 앱에도 로컬 DB 값이 전달되는지 확인합니다.
- 로컬 URL과 `TEST_MODE=true`, `TEST_SUPABASE_PROJECT_REF=local`을 사용합니다.
- 원격 테스트는 명시적으로 허용한 별도 프로젝트만 사용합니다. ref 일치 검사는 운영 DB가 아니라는 증명 자체는 아닙니다.
- 실제 회원 정보를 사용하지 않습니다. seed 생성 ID는 manifest에 기록하고 해당 실행 데이터만 정리합니다.

근거: [테스트 환경 검증](../tests/support/test-env.ts), [Playwright 설정](../playwright.config.ts), [seed manifest](../tests/support/seed-manifest.ts).

통합 테스트는 테스트 DB 설정이 없으면 DB 시나리오를 건너뛸 수 있습니다. 종료 코드뿐 아니라 실제 실행된 항목과 skip 여부를 확인합니다.

## 로컬 실행

### 1. 의존성과 로컬 DB 준비

Node.js는 `package.json`의 범위(`>=20 <23`)에 맞춰 사용합니다. DB 통합 테스트에는 Docker가 필요합니다.

```bash
npm ci
npx supabase start
cp .env.example .env.local
```

로컬 Supabase의 URL·키를 `.env.local`에 설정합니다. 운영 환경변수를 복사하지 않습니다. 개발용 운영자 계정은 로컬 Supabase Studio의 Authentication에서 생성합니다.

기존 로컬 DB를 새로 구성해야 한다면, 데이터를 버려도 되는 **로컬 인스턴스임을 확인한 뒤** `npx supabase db reset`으로 마이그레이션을 적용합니다. 운영 DB에 초기 마이그레이션을 재실행하지 않습니다.

### 2. 환경변수

실제 값은 커밋하지 않습니다. 변수 목록은 [.env.example](../.env.example)을 기준으로 합니다.

| 용도 | 변수 |
| --- | --- |
| Supabase 클라이언트 | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| 서버 전용 DB 접근 | `SUPABASE_SERVICE_ROLE_KEY` |
| 예약 쿠키 서명 | `BOOKING_SESSION_SECRET` |
| Cron 인증 | `CRON_SECRET` |
| SOLAPI 인증 | `SOLAPI_API_KEY`, `SOLAPI_API_SECRET` |
| 카카오 발신 정보 | `KAKAO_CHANNEL_ID`, `KAKAO_SENDER_PHONE` |
| 알림 템플릿 | `KAKAO_DUE_SOLO_TEMPLATE_ID`, `KAKAO_DUE_GROUP_TEMPLATE_ID`, `KAKAO_COMPLETED_SOLO_TEMPLATE_ID`, `KAKAO_COMPLETED_GROUP_TEMPLATE_ID` |
| 발송 활성화 | `NEXT_PUBLIC_NOTIFICATIONS_ENABLED` |

SOLAPI 실제 발송은 구현되어 있습니다. 로컬 기본 설정은 오발송 방지를 위해 발송을 비활성화합니다. 서버 전용 키에는 `NEXT_PUBLIC_` 접두사를 붙이지 않습니다.

```bash
npm run dev
```

운영자 화면은 `http://localhost:3000/login`, 회원 예약 화면은 `/booking`에서 시작합니다.

### 3. 로컬 DB 테스트

[.env.test.local.example](../.env.test.local.example)을 복사하고 로컬 DB 값과 테스트 전용 계정을 설정합니다. 다음 계정 생성 명령도 대상이 localhost인지 확인한 뒤 실행합니다.

```bash
cp .env.test.local.example .env.test.local
# 로컬 URL·키, TEST_MODE=true, TEST_SUPABASE_PROJECT_REF=local,
# 테스트 전용 이메일·비밀번호 설정 후 실행
TEST_MODE=true npx tsx scripts/create-test-admin.ts
npx playwright install chromium
npm run test:integration
npm run test:e2e
```

별도 seed가 필요할 때는 `npm run test:seed`를 사용합니다. `npm run test:cleanup -- <runId>`는 해당 실행의 manifest에 기록된 데이터만 정리합니다.

## 배포와 운영

- 애플리케이션은 Vercel, 인증·DB는 Supabase, 알림은 SOLAPI를 사용합니다.
- [vercel.json](../vercel.json)의 Cron은 UTC `20:00`, 한국 시간 기준 다음 날 `05:00`에 실행하도록 설정되어 있습니다.
- 운영 배포 전 타입 검사·린트·테스트·빌드와 마이그레이션 적용 상태를 확인합니다. 운영자 로그인·회원 조회·수강·출석·재등록·로그아웃을 배포 후 점검합니다.
- `npm run notifications:check`는 알림 환경변수의 누락·예시 값·템플릿 구성을 검사합니다. 실제 값을 출력하거나 발송 요청을 보내지 않습니다.
- 운영 환경에는 테스트 계정·로컬 DB URL을 등록하지 않습니다.
- 저장소에 CI 파이프라인, 운영 지표·경보, 복구 절차의 자동화가 모두 갖춰진 상태는 아닙니다.
