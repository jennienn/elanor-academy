import { describe, expect, it } from "vitest";
import { validateProduct } from "../../src/lib/lesson-products";
const base = { kind: "solo", name: "개인 6회권", session_count: 6, valid_weeks: 7, price: 240000, duration_minutes: 45, active: true, group_count: null };
describe("운영자 수강권 입력", () => {
  it("기존 4·8·12회 이외의 수강권과 수업 길이를 허용한다", () => expect(validateProduct(base)).toBeNull());
  it.each([{ price: -1 }, { price: 1.5 }, { session_count: 0 }, { valid_weeks: 0 }, { duration_minutes: 0 }, { active: "true" }, { name: " " }])("잘못된 구매 조건을 거절한다: %o", patch => expect(validateProduct({ ...base, ...patch })).not.toBeNull());
  it("중복 요일과 자정을 넘는 수업을 거절한다", () => {
    const group = { ...base, kind: "group", schedules: [{ weekday: 1, start_time: "20:00" }] };
    expect(validateProduct(group)).toBeNull();
    expect(validateProduct({ ...group, schedules: [...group.schedules, ...group.schedules] })).not.toBeNull();
    expect(validateProduct({ ...group, schedules: [{ weekday: 1, start_time: "23:45" }] })).not.toBeNull();
  });
  it("패키지는 단체 횟수도 필요하다", () => {
    expect(validateProduct({ ...base, kind: "package" })).not.toBeNull();
    expect(validateProduct({ ...base, kind: "package", group_count: 3 })).toBeNull();
  });
});
