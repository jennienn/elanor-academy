# AGENTS.md

## 프로젝트 개요

이 프로젝트는 Next.js 15 App Router, TypeScript, Supabase 기반의 댄스학원 회원 관리 시스템이다.

주요 기능:

- 회원 등록 및 수정
- 개인레슨 4회권, 8회권, 12회권 관리
- 개인레슨 회차 기록
- 단체레슨 반 및 요일 관리
- 단체레슨 출석 등록 및 취소
- 결제 및 재등록 이력 관리
- 결제 필요 회원 조회
- 알림 발송 대상 관리
- SOLAPI 알림톡 실제 발송 구현 완료
- 단체반 정원 제한 없음

## 현재 요구사항 기준 (2026-09-21 사용자 확인)

- SOLAPI 실제 발송은 구현되어 있다. 미구현 또는 더미 기능으로 판단하지 않는다.
- 단체반 정원 제한은 없다. 정원 초과를 오류로 처리하거나 제한을 복원하지 않는다.
- 이전 요구사항과 폐기된 문서는 판단 근거로 사용하지 않는다.
- 요구사항이나 정책이 불명확하면 사용자에게 질문한다. 코드만으로 사용자의 의도를 확정하거나 임의로 정책을 추가하지 않는다.
- 과거 마이그레이션은 DB 재현에 필요한 변경 이력이며 현재 요구사항 문서가 아니다. 최종 적용 결과를 확인한다.

## 기술 스택

- Next.js 15 App Router
- React
- TypeScript
- Supabase Auth
- Supabase PostgreSQL
- Supabase Row Level Security
- Vercel
- npm
- Vitest
- Playwright
- Docker 기반 로컬 Supabase

## 작업 원칙

1. 작업 전 관련 코드, 데이터베이스 스키마, API Route를 먼저 읽는다.
2. 기존 동작을 확인하지 않고 대규모 리팩터링하지 않는다.
3. 요청받지 않은 UI와 비즈니스 규칙은 변경하지 않는다.
4. TypeScript의 `any` 사용을 가능한 한 피한다.
5. 오류를 숨기기 위해 테스트 조건을 약화하거나 테스트를 삭제하지 않는다.
6. 구현 오류가 발견되면 테스트를 우회하지 말고 실제 코드를 수정한다.
7. 변경 후 반드시 typecheck와 관련 테스트를 실행한다.
8. 데이터베이스 변경이 필요하면 마이그레이션 파일로 작성한다.
9. 작업 완료 후 변경 파일, 테스트 결과, 남은 문제를 요약한다.
10. 사용자의 명시적 승인 없이 commit, push, 운영 배포를 실행하지 않는다.
11. 운영 Supabase에 SQL을 실행하거나 데이터를 변경하기 전 반드시 사용자 승인을 받는다.
12. 환경변수의 실제 값, API Key, Secret, 비밀번호를 로그나 보고서에 출력하지 않는다.

## 데이터베이스 안전 규칙

1. 운영 Supabase 데이터베이스에 테스트 데이터를 삽입하지 않는다.
2. `.env.local`의 운영 환경변수를 자동 테스트에 사용하지 않는다.
3. 기본 통합 테스트와 E2E 테스트는 Docker 기반 로컬 Supabase를 사용한다.
4. 원격 테스트 Supabase를 사용할 경우 명시적으로 허용된 테스트 프로젝트만 사용한다.
5. 테스트 실행 전에 대상 Supabase URL을 확인한다.
6. URL이 `127.0.0.1` 또는 `localhost`가 아니면서 허용된 테스트 프로젝트와 일치하지 않으면 테스트와 seed 실행을 즉시 중단한다.
7. `SUPABASE_SERVICE_ROLE_KEY`를 브라우저 코드나 `NEXT_PUBLIC_` 환경변수에 노출하지 않는다.
8. 실제 회원 이름, 전화번호, 결제 정보는 테스트 데이터에 사용하지 않는다.
9. 테스트 데이터는 이름 앞에 `테스트회원_` 또는 실행별 고유 prefix를 붙인다.
10. 테스트가 만든 행의 ID를 manifest에 기록하고 해당 행만 cleanup한다.
11. 기존 데이터를 전체 삭제하거나 테이블을 truncate하지 않는다.
12. migration 적용 전 기존 스키마, 데이터 중복, FK, 제약조건 충돌 가능성을 확인한다.

## 핵심 데이터 구조

대략적인 관계는 다음과 같다.

```text
members
└── enrollments
    └── enrollment_cycles
        ├── payments
        ├── sessions
        ├── cycle_schedules
        ├── attendance_logs
        └── notifications

classes
└── class_schedules
```

정확한 컬럼과 관계는 Supabase 마이그레이션 및 실제 코드를 기준으로 판단한다.

## 데이터베이스 마이그레이션

### `0001_init.sql`

- 기본 테이블
- 제약조건 및 인덱스
- RLS 정책
- 초기 반 및 요일 데이터

### `0002_atomic_testable_operations.sql`

- 회원 및 수강권 생성 원자적 RPC
- 개인·단체 재등록 원자적 RPC
- 개인레슨 회차 저장·삭제 원자적 RPC
- 단체 출석 저장·삭제 원자적 RPC

### `0003_api_grants.sql`

- Data API에서 필요한 테이블·시퀀스 권한
- 인증 사용자용 RPC 실행 권한
- anon 권한 차단
- service role 권한 설정

운영 DB에 기존 데이터가 있다면 `0001_init.sql`을 무조건 재실행하지 않는다. 현재 스키마와 migration 차이를 먼저 확인하고, 필요한 경우 별도 보정 migration을 작성한다.

## 반드시 검증할 비즈니스 규칙

### 개인레슨

- 4회권, 8회권, 12회권 생성
- 첫 수업 등록 전후 유효기간 계산
- 개인레슨 회차 등록, 수정, 삭제
- 잔여 회차 계산
- 잔여 1회 이하 상태
- 기간 만료 상태
- 재등록 후 이전 cycle 이력 보존
- 중간 실패 시 불완전한 cycle 또는 payment가 남지 않는지 검증

### 단체레슨

- 출석 등록 및 취소
- 요일별 회원 조회
- 한 회원의 복수 요일 등록
- 반 인원수와 관계없이 수강 등록이 가능한지 검증
- 재등록 후 출석 및 결제 주기 보존
- 재등록 시 기존 요일이 새 cycle에 유지되는지 검증
- 출석 저장 실패 시 일부 데이터만 남지 않는지 검증

### 인증 및 권한

- 비로그인 사용자의 보호 페이지 접근 차단
- 비로그인 사용자의 API 접근 차단
- API 미인증 요청에 HTML redirect가 아닌 적절한 JSON 401 반환
- 서비스 역할 키의 클라이언트 노출 방지
- 현재는 단일 운영자 사용을 전제로 한다.
- 다중 운영자 지원 시 `owner_id` 또는 `studio_id` 기반 데이터 격리를 추가해야 한다.
- 현재 RLS는 인증된 운영자 간 데이터 격리를 제공하지 않으므로 다중 운영자 환경에 그대로 사용하지 않는다.

### 결제

- 개인레슨 결제 이력
- 단체레슨 결제 이력
- 재등록 결제
- 결제 예정 회원 조회
- 환불 및 수강 종료 처리
- 재등록 실패 시 기존 cycle 상태가 잘못 변경되지 않는지 검증

### 날짜

- 한국 시간 기준 오늘 날짜 계산
- UTC 변환 때문에 날짜가 전날로 바뀌지 않는지 검증
- 자정부터 오전 9시 사이 날짜 처리 검증

### 알림

- SOLAPI 알림톡 실제 발송이 구현되어 있다.
- API Key와 Secret은 서버 전용 환경변수로만 사용한다.
- 재등록 완료 이후에만 알림을 발송한다.
- 알림 실패가 재등록 transaction을 롤백시키지 않도록 한다.
- 동일 cycle에 동일 알림이 중복 발송되지 않도록 idempotency를 구현한다.
- 발송 성공·실패 상태는 `notifications` 테이블에 기록한다.

## 테스트 구성

### 단위 테스트

Vitest를 사용한다.

대상:

- 날짜 계산
- 만료일 계산
- 잔여 회차 계산
- 결제 예정일 계산
- 입력 검증
- 한국 시간 기준 날짜 처리

### 통합 테스트

Docker 기반 로컬 Supabase를 사용한다.

대상:

- 회원 등록
- 수강권 생성
- 결제 주기 생성
- 개인레슨 회차 저장
- 단체 출석 저장
- 재등록
- 환불
- 권한 검증
- 원자적 RPC 롤백
- 중복 데이터 방지

### E2E 테스트

Playwright를 사용한다.

대상:

- 로그인
- 회원 등록
- 개인레슨 등록
- 단체 출석 처리
- 재등록
- 회원 정보 수정
- 로그아웃 후 보호 페이지 접근 차단
- 반 인원수와 관계없는 수강 등록

## 테스트 데이터

Seed 데이터에는 최소 다음 사례를 포함한다.

- 개인레슨 4회권 회원 3명
- 개인레슨 8회권 회원 3명
- 개인레슨 12회권 회원 3명
- 단체레슨 월요일 회원 5명
- 단체레슨 수요일 회원 5명
- 복수 요일 회원 3명
- 결제 예정 회원
- 기간 만료 회원
- 잔여 1회 회원
- 재등록 이력이 있는 회원
- 반 인원 제한 없이 등록 가능한지 검증할 회원

전화번호와 이메일은 실제 개인정보처럼 보이지 않는 명확한 테스트 값을 사용한다.

## 환경변수

### 운영 환경변수

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET`

SOLAPI 실제 발송용:

- `SOLAPI_API_KEY`
- `SOLAPI_API_SECRET`
- `KAKAO_CHANNEL_ID`
- `KAKAO_TEMPLATE_ID`
- `KAKAO_SENDER_PHONE`

### 테스트 전용 환경변수

- `TEST_MODE`
- `TEST_SUPABASE_PROJECT_REF`
- `TEST_ADMIN_EMAIL`
- `TEST_ADMIN_PASSWORD`

테스트 전용 환경변수와 localhost Supabase 값은 운영 Vercel에 등록하지 않는다.

## 명령어

작업 시작 시 `package.json`을 확인하고 실제 명령을 기준으로 실행한다.

### 기본 확인 명령

```bash
npm install
npm run typecheck
npm run lint
npm run test
npm run build
```

### 통합 및 E2E 테스트

```bash
npm run test:integration
npm run test:e2e
npm run test:seed
npm run test:cleanup
```

### 로컬 Supabase

```bash
npx supabase start
npx supabase status
npx supabase db reset
npx supabase stop
```

## 배포 규칙

1. Vercel Production 배포 전 `lint`, `typecheck`, `test`, `build`가 모두 통과해야 한다.
2. Vercel 런타임은 Node.js 20 이상을 사용한다.
3. 운영 환경변수 등록 여부를 확인한다.
4. 운영 migration 적용 여부를 확인한다.
5. 테스트용 환경변수와 localhost URL을 운영에 등록하지 않는다.
6. Preview 배포에서 로그인 화면과 Supabase 연결을 먼저 확인한다.
7. 사용자 승인 없이 Production 배포하지 않는다.
8. 배포 후 로그인, 회원 조회, 수강 등록, 출석, 재등록, 로그아웃을 smoke test한다.

## 완료 조건

작업 완료 전 다음을 확인한다.

- TypeScript 검사 통과
- ESLint 통과
- 관련 단위 테스트 통과
- 관련 통합 테스트 통과
- 필요한 E2E 테스트 통과
- Production build 통과
- 운영 DB를 테스트에 사용하지 않았는지 확인
- 테스트 데이터 정리 여부 확인
- 변경 사항 diff 확인
- 환경변수 실제 값이 노출되지 않았는지 확인
- 실패한 테스트와 미해결 문제를 숨김없이 보고
- 커밋, push, 배포 실행 여부를 명확히 보고
