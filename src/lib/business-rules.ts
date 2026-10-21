// src/lib/business-rules.ts
//
// 결제 필요 여부 / 알림톡 발송 대상 여부를 판정하는 단일 기준.
// v2: "수강권(enrollment)"이 아니라 "주기(enrollment_cycle)" 단위로 판정한다.
// 재등록/재결제할 때마다 새 cycle이 생기고, 판정은 항상 해당 enrollment의
// status='active'인 cycle 하나를 대상으로 한다.
// 이 파일의 함수 결과만을 신뢰해야 하며, 프론트엔드는 이 로직을 다시 구현하지 않는다.

export type EnrollmentKind = "solo" | "group";

export interface CycleLike {
  kind: EnrollmentKind;
  enrollmentStatus: "active" | "ended"; // 부모 enrollment의 상태
  cycleStatus: "active" | "completed" | "expired";
  // solo
  plan?: number | null;
  totalCount: number;
  usedCount: number;
  validEndDate?: string | null; // ISO date, 첫 수업 전이면 null
  // group
  nextDueDate?: string | null; // ISO date
  // true면 kind와 무관하게 validEndDate+잔여 기준(개인레슨과 동일한 규칙)으로 판정한다.
  // 스타터 패키지의 단체 절반(kind='group'이지만 반복결제가 아니라 고정 회차+공통 유효기간)에 사용.
  isFixedTerm?: boolean;
}

/** kind==='solo'이거나 패키지 소속 단체 cycle이면 validEndDate+잔여 기준("고정 기간형")으로 판정한다. */
export function isFixedTermCycle(c: CycleLike): boolean {
  return c.kind === "solo" || c.isFixedTerm === true;
}

export const WEEKS_BY_PLAN: Record<4 | 8 | 12, number> = {
  4: 5,
  8: 9,
  12: 13
};

export const GROUP_RENEWAL_WEEKS = 5;
export const GROUP_FIXED_COUNT = 8;

// 스타터 패키지(개인+단체 세트 상품) 고정 구성 — SQL(create_starter_package_atomic)에도 리터럴로 중복 유지.
export const PACKAGE_SOLO_COUNT = 2;
export const PACKAGE_GROUP_COUNT = 4;
export const PACKAGE_VALID_WEEKS = 3;

const KOREA_TIME_ZONE = "Asia/Seoul";

/** Date를 한국 달력 날짜(YYYY-MM-DD)로 변환한다. UTC ISO 문자열의 날짜 절단을 사용하지 않는다. */
export function koreaDateString(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KOREA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function parseCalendarDate(value: string | Date): { year: number; month: number; day: number } {
  if (typeof value !== "string") {
    const [year, month, day] = koreaDateString(value).split("-").map(Number);
    return { year, month, day };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) throw new Error(`올바르지 않은 날짜: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** 시간대/DST와 무관한 달력 날짜 덧셈. */
export function addCalendarDays(value: string | Date, days: number): string {
  const { year, month, day } = parseCalendarDate(value);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

export function daysUntil(target: string | Date, today: Date = new Date()): number {
  const t = parseCalendarDate(target);
  const a = parseCalendarDate(today);
  const msPerDay = 1000 * 60 * 60 * 24;
  const aTime = Date.UTC(a.year, a.month - 1, a.day);
  const bTime = Date.UTC(t.year, t.month - 1, t.day);
  return Math.round((bTime - aTime) / msPerDay);
}

export function remainOf(c: Pick<CycleLike, "totalCount" | "usedCount">): number {
  return c.totalCount - c.usedCount;
}

export type StatusResult = "danger" | null;

/**
 * "결제 필요" 판정.
 * - enrollment가 이미 종료(ended)됐거나 cycle이 active가 아니면 항상 제외
 * - 개인레슨: 첫 수업 전(validEndDate가 아직 null)이면 유효기간 판단을 보류 — 잔여 1회 이하 조건만 본다
 *   (요구사항명세서 v1.1: "첫 수업일이 정해지지 않은 경우 유효기간 종료일도 미정으로 둔다")
 * - 개인레슨(첫 수업 이후): 유효기간이 지났거나, 잔여 1회 이하
 * - 단체레슨: 재결제 예정일까지 7일 이하로 남음(이미 지난 경우 포함)
 */
export function cycleStatus(c: CycleLike, today: Date = new Date()): StatusResult {
  if (c.enrollmentStatus === "ended" || c.cycleStatus !== "active") return null;

  if (isFixedTermCycle(c)) {
    if (c.validEndDate && daysUntil(c.validEndDate, today) <= 7) return "danger";
    return remainOf(c) <= 1 ? "danger" : null;
  }

  if (!c.nextDueDate) return null;
  return daysUntil(c.nextDueDate, today) <= 7 ? "danger" : null;
}

/**
 * 알림톡 자동발송 대상 여부. 반드시 cycleStatus와 동일한 기준을 사용한다.
 */
export function isNotificationEligible(c: CycleLike, today: Date = new Date()): boolean {
  return cycleStatus(c, today) === "danger";
}

export interface StatusText {
  text: string;
  tone: "danger" | "warning" | "muted";
}

/** ISO 날짜("YYYY-MM-DD..." 또는 그 앞부분)를 화면 표기용 "YYYY.MM.DD"로 변환. */
export function formatDisplayDate(value: string): string {
  return value.slice(0, 10).replaceAll("-", ".");
}

/**
 * "고정 기간형"(개인레슨, 패키지 단체) 상태 문구.
 * 기본: 잔여 [N]회 · 유효기간 [YYYY.MM.DD]. 결제 임박(cycleStatus==='danger')이면 강조 문구로 전환.
 */
export function soloStatusText(c: CycleLike, today: Date = new Date()): StatusText {
  if (!c.validEndDate) {
    return { text: "첫 수업 전", tone: "muted" };
  }
  const remain = remainOf(c);
  if (daysUntil(c.validEndDate, today) < 0) {
    return { text: `이용기간 만료 · 유효기간 ${formatDisplayDate(c.validEndDate)}`, tone: "danger" };
  }
  if (cycleStatus(c, today) === "danger") {
    const d = daysUntil(c.validEndDate, today);
    return {
      text: d <= 7 ? `결제 임박 · 잔여 ${remain}회 · D-${d}` : `결제 임박 · 잔여 ${remain}회`,
      tone: "danger"
    };
  }
  return { text: `잔여 ${remain}회 · 유효기간 ${formatDisplayDate(c.validEndDate)}`, tone: "muted" };
}

/** "반복 결제형"(일반 단체) 상태 문구. 기본: 잔여 [N]회 · 유효기간 [YYYY.MM.DD]. 7일 이내면 결제 임박 강조. */
export function groupStatusText(c: CycleLike, today: Date = new Date()): StatusText {
  if (!c.nextDueDate) return { text: "-", tone: "muted" };
  const remain = remainOf(c);
  const d = daysUntil(c.nextDueDate, today);
  if (d < 0) return { text: `결제 지연 · 잔여 ${remain}회 · ${-d}일 지남`, tone: "danger" };
  if (d === 0) return { text: `결제 임박 · 잔여 ${remain}회 · 오늘 결제 예정`, tone: "danger" };
  if (d <= 7) return { text: `결제 임박 · 잔여 ${remain}회 · D-${d}`, tone: "warning" };
  return { text: `잔여 ${remain}회 · 유효기간 ${formatDisplayDate(c.nextDueDate)}`, tone: "muted" };
}

/**
 * 개인레슨 "첫 수업 기록" 시점에 유효기간을 확정한다.
 * 등록/재등록 시점이 아니라, 실제 1회차 수업 날짜가 기록되는 순간 호출해야 한다.
 */
export function calcSoloValidEnd(firstClassDate: Date, plan: 4 | 8 | 12): Date {
  return new Date(`${addCalendarDays(firstClassDate, WEEKS_BY_PLAN[plan] * 7 - 1)}T00:00:00.000Z`);
}

/** 단체레슨 결제 시 다음 결제 예정일 계산 */
export function calcGroupNextDue(paymentDate: Date): Date {
  return new Date(`${addCalendarDays(paymentDate, GROUP_RENEWAL_WEEKS * 7)}T00:00:00.000Z`);
}

/** 알림톡 문구 템플릿 — 카카오 템플릿 심사 등록 시 이 문구를 그대로 사용할 것 */
export function buildNotificationMessage(c: CycleLike & { className?: string | null }): string {
  if (c.kind === "solo") {
    return `현재 ${c.totalCount}회 중 1회 남았습니다. 재등록 원하시면 재결제 부탁드립니다.`;
  }
  return `${c.className ?? "수업"} 수강 기간이 1주일 남았습니다. 재등록 원하시면 1주일 이내에 결제 부탁드립니다.`;
}
