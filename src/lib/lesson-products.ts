export type ProductKind = "solo" | "group" | "package";
export interface ProductSchedule { id?: number; weekday: number; start_time: string; duration_minutes?: number; active?: boolean }
export interface LessonProduct {
  id: number; version: number; kind: ProductKind; name: string; class_id: number | null;
  session_count: number; group_count: number | null; valid_weeks: number;
  price: number; duration_minutes: number; active: boolean; schedules: ProductSchedule[]; can_delete?: boolean;
}
export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
export function validateProduct(value: unknown): string | null {
  if (!value || typeof value !== "object") return "수강권 정보를 입력해주세요.";
  const p = value as Record<string, unknown>;
  if (!["solo", "group", "package"].includes(String(p.kind))) return "수강 종류를 확인해주세요.";
  if (typeof p.name !== "string" || !p.name.trim() || p.name.trim().length > 80) return "이름은 1~80자로 입력해주세요.";
  for (const [key, max, label] of [["session_count", 365, "수업 횟수"], ["valid_weeks", 104, "유효기간"], ["duration_minutes", 360, "수업 길이"]] as const) {
    if (!Number.isInteger(p[key]) || Number(p[key]) < 1 || Number(p[key]) > max) return `${label}는 1~${max} 사이의 정수로 입력해주세요.`;
  }
  if (!Number.isInteger(p.price) || Number(p.price) < 0 || Number(p.price) > 2147483647) return "가격을 올바르게 입력해주세요.";
  if (typeof p.active !== "boolean") return "판매 상태를 확인해주세요.";
  if (p.kind === "package" && (!Number.isInteger(p.group_count) || Number(p.group_count) < 1 || Number(p.group_count) > 365)) return "패키지 단체 수업 횟수를 확인해주세요.";
  if (p.kind !== "package" && p.group_count != null) return "단체 횟수는 패키지에서만 설정할 수 있습니다.";
  if (p.kind === "group") {
    if (!Array.isArray(p.schedules) || !p.schedules.length) return "요일과 시작시간을 하나 이상 입력해주세요.";
    const weekdays = new Set<number>();
    for (const s of p.schedules) {
      if (!s || !Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6 || weekdays.has(s.weekday)) return "요일은 중복 없이 선택해주세요.";
      if (typeof s.start_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start_time)) return "시작시간을 확인해주세요.";
      const [h, m] = s.start_time.split(":").map(Number);
      if (h * 60 + m + Number(p.duration_minutes) > 1440) return "수업은 자정 이전에 끝나야 합니다.";
      weekdays.add(s.weekday);
    }
  }
  return null;
}
