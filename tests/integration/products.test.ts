import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { loadAndValidateTestEnvironment } from "../support/test-env";
import { addCalendarDays, koreaDateString } from "../../src/lib/business-rules";
const env = loadAndValidateTestEnvironment({ requireServiceRole: true });
if (!["127.0.0.1", "localhost"].includes(new URL(env.url).hostname)) throw new Error("새 수강권 테스트는 로컬 DB에서만 실행합니다.");
const prefix = `테스트회원_PRODUCTS_${Date.now()}`;
const manifest = { members: [] as number[], products: [] as number[], classes: [] as number[] };
let db: SupabaseClient;
const today = koreaDateString();
const base = { kind: "solo", name: `${prefix}_6회`, session_count: 6, group_count: null, valid_weeks: 7, price: 250000, duration_minutes: 90, active: true };
async function product(spec: Omit<typeof base, "group_count"> & { group_count: number | null } = base, schedules: { weekday: number; start_time: string }[] = []) {
  const { data, error } = await db.rpc("save_lesson_product", { p_id: null, p_version: null, p_product: spec, p_schedules: schedules });
  expect(error).toBeNull(); manifest.products.push(data);
  const row = await db.from("lesson_products").select("*").eq("id", data).single();
  if (row.data.class_id) manifest.classes.push(row.data.class_id);
  return row.data;
}
async function buy(id: number, version: number, extra: Record<string, unknown> = {}) {
  const result = await db.rpc("purchase_lesson_product", { p_product_id: id, p_version: version, p_member_id: null,
    p_name: `${prefix}_${manifest.members.length}`, p_phone: `000-PRODUCT-${prefix}-${manifest.members.length}`,
    p_enrollment_id: null, p_schedule_ids: [], p_class_id: null, p_method: "card", p_payment_date: today, ...extra }).single();
  const row = result.data as { member_id: number; cycle_id: string; enrollment_id: string; package_id: string | null } | null;
  if (row && !manifest.members.includes(row.member_id)) manifest.members.push(row.member_id);
  return { ...result, data: row };
}
beforeAll(async () => {
  db = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const { error } = await db.auth.signInWithPassword({ email: env.adminEmail!, password: env.adminPassword! });
  if (error) throw error;
});
afterAll(async () => {
  const admin = createClient(env.url, env.serviceRoleKey);
  for (const id of manifest.members) { const r = await admin.from("members").delete().eq("id", id); expect(r.error).toBeNull(); }
  for (const id of manifest.products) { const r = await admin.from("lesson_products").delete().eq("id", id); expect(r.error).toBeNull(); }
  for (const id of manifest.classes) { const r = await admin.from("classes").delete().eq("id", id); expect(r.error).toBeNull(); }
});
describe("수강권 상품과 구매 당시 조건", () => {
  it("구매하지 않은 새 수강권만 삭제하고 단체반 시간표도 함께 정리한다", async () => {
    const unused = await product({ ...base, name: `${prefix}_미판매` });
    expect((await db.rpc("delete_unsold_lesson_product", { p_id: unused.id, p_version: 1 })).error).toBeNull();
    expect((await db.from("lesson_products").select("id").eq("id", unused.id)).data).toEqual([]);

    const group = await product({ ...base, kind: "group", name: `${prefix}_미판매반` }, [{ weekday: 0, start_time: "06:00" }]);
    expect((await db.rpc("delete_unsold_lesson_product", { p_id: group.id, p_version: 1 })).error).toBeNull();
    expect((await db.from("classes").select("id").eq("id", group.class_id)).data).toEqual([]);

    const sold = await product({ ...base, name: `${prefix}_판매완료` });
    expect((await buy(sold.id, 1)).error).toBeNull();
    expect((await db.rpc("delete_unsold_lesson_product", { p_id: sold.id, p_version: 1 })).error?.message).toContain("삭제할 수 없습니다");
    const seeded = await db.from("lesson_products").select("id,version").eq("is_seeded", true).limit(1).single();
    expect((await db.rpc("delete_unsold_lesson_product", { p_id: seeded.data!.id, p_version: seeded.data!.version })).error?.message).toContain("삭제할 수 없습니다");
    const anon = createClient(env.url, env.anonKey);
    expect((await anon.rpc("delete_unsold_lesson_product", { p_id: sold.id, p_version: 1 })).error).not.toBeNull();
  });
  it("변경·판매중단 시 구매 조건을 보존하고 재등록에는 변경 조건을 적용한다", async () => {
    const p = await product(); const purchase = await buy(p.id, 1); expect(purchase.error).toBeNull();
    const c = purchase.data!;
    const record = await db.rpc("record_solo_session_atomic", { p_cycle_id: c.cycle_id, p_session_index: 1, p_date: today, p_expired: false, p_note: null }); expect(record.error).toBeNull();
    const changed = { ...base, name: `${prefix}_새이름`, session_count: 10, valid_weeks: 12, price: 350000, duration_minutes: 45 };
    expect((await db.rpc("save_lesson_product", { p_id: p.id, p_version: 1, p_product: changed, p_schedules: [] })).error).toBeNull();
    const old = await db.from("enrollment_cycles").select("*,payments(amount)").eq("id", c.cycle_id).single();
    expect(old.data).toMatchObject({ base_count: 6, duration_minutes: 90, valid_weeks: 7, product_name: base.name, valid_end_date: addCalendarDays(today, 48), payments: [{ amount: 250000 }] });
    expect((await buy(p.id, 1)).error?.message).toContain("조건이 변경");
    const renewal = await buy(p.id, 2, { p_enrollment_id: c.enrollment_id }); expect(renewal.error).toBeNull();
    const next = await db.from("enrollment_cycles").select("*").eq("id", renewal.data!.cycle_id).single();
    expect(next.data).toMatchObject({ base_count: 10, total_count: 15, duration_minutes: 45, valid_weeks: 12, product_name: changed.name });
    expect((await db.rpc("save_lesson_product", { p_id: p.id, p_version: 2, p_product: { ...changed, active: false }, p_schedules: [] })).error).toBeNull();
    expect((await buy(p.id, 3)).error?.message).toContain("판매 중");
    expect((await db.from("enrollment_cycles").select("status").eq("id", next.data.id).single()).data?.status).toBe("active");
  });
  it("단체 시간표 수정 후 이전 회원과 새 회원이 각자 구매한 시간표로 출석한다", async () => {
    const spec = { ...base, kind: "group", name: `${prefix}_단체`, duration_minutes: 60 };
    const p = await product(spec, [{ weekday: 0, start_time: "06:00" }]);
    const first = await db.from("class_schedules").select("id").eq("class_id", p.class_id).eq("active", true).single();
    const purchase = await buy(p.id, 1, { p_schedule_ids: [first.data!.id] }); expect(purchase.error).toBeNull();
    expect((await db.rpc("save_lesson_product", { p_id: p.id, p_version: 1, p_product: spec, p_schedules: [{ weekday: 0, start_time: "07:00" }] })).error).toBeNull();
    const schedules = await db.from("class_schedules").select("*").eq("class_id", p.class_id);
    expect(schedules.data).toHaveLength(2);
    expect(schedules.data!.find(s => s.id === first.data!.id)).toMatchObject({ active: false, start_time: "06:00:00" });
    const current = schedules.data!.find(s => s.active)!;
    expect((await buy(p.id, 2, { p_schedule_ids: [first.data!.id] })).error).not.toBeNull();
    const next = await buy(p.id, 2, { p_schedule_ids: [current.id] }); expect(next.error).toBeNull();
    const sunday = Array.from({ length: 7 }, (_, i) => addCalendarDays(today, i + 1)).find(d => new Date(`${d}T12:00:00+09:00`).getDay() === 0)!;
    const attendance = await db.rpc("save_attendance_atomic", { p_date: sunday, p_records: [
      { cycleId: purchase.data!.cycle_id, scheduleId: first.data!.id, attended: true }, { cycleId: next.data!.cycle_id, scheduleId: current.id, attended: true }
    ] }); expect(attendance.error).toBeNull();
  });
  it("개인 수업 길이로 중복 예약·차단 시간을 계산한다", async () => {
    const p = await product({ ...base, name: `${prefix}_예약` }); const purchase = await buy(p.id, 1); expect(purchase.error).toBeNull();
    const admin = createClient(env.url, env.serviceRoleKey);
    const date = addCalendarDays(today, 25);
    const args = { p_cycle_id: purchase.data!.cycle_id, p_date: date, p_start_minute: 900 };
    const booking = await admin.rpc("create_solo_booking_atomic", args); expect(booking.error).toBeNull();
    expect((await admin.from("solo_bookings").select("duration_minutes").eq("id", booking.data).single()).data?.duration_minutes).toBe(90);
    expect((await admin.rpc("create_solo_booking_atomic", { ...args, p_start_minute: 960 })).error?.message).toContain("CONFLICT");
    expect((await db.rpc("create_solo_booking_block_atomic", { p_date: date, p_start_minute: 960, p_end_minute: 990, p_reason: prefix })).error?.message).toContain("CONFLICT");
    expect((await admin.rpc("create_solo_booking_atomic", { ...args, p_start_minute: 990 })).error).toBeNull();
    const group = { ...base, kind: "group", name: `${prefix}_충돌`, duration_minutes: 60 };
    const conflict = await db.rpc("save_lesson_product", { p_id: null, p_version: null, p_product: group,
      p_schedules: [{ weekday: new Date(`${date}T12:00:00+09:00`).getDay(), start_time: "15:30" }] });
    expect(conflict.error?.message).toContain("기존 개인레슨 예약");
    expect((await db.from("classes").select("id").eq("name", group.name)).data).toEqual([]);
  });
  it("사용자 지정 패키지의 두 수강권을 한 번에 생성하고 공통 유효기간을 유지한다", async () => {
    const group = await product({ ...base, kind: "group", name: `${prefix}_패키지반` }, [{ weekday: 6, start_time: "06:00" }]);
    const schedule = await db.from("class_schedules").select("id").eq("class_id", group.class_id).eq("active", true).single();
    const spec = { ...base, kind: "package", name: `${prefix}_패키지`, session_count: 3, group_count: 5, valid_weeks: 4, duration_minutes: 45 };
    const pkg = await product(spec);
    const purchase = await buy(pkg.id, 1, { p_class_id: group.class_id, p_schedule_ids: [schedule.data!.id] });
    expect(purchase.error).toBeNull();
    const cycles = await db.from("enrollment_cycles").select("*,enrollments!inner(package_id,kind)").eq("enrollments.package_id", purchase.data!.package_id);
    expect(cycles.data).toHaveLength(2);
    expect(cycles.data!.map(c => c.base_count).sort()).toEqual([3, 5]);
    expect((await db.rpc("record_solo_session_atomic", { p_cycle_id: purchase.data!.cycle_id, p_session_index: 1, p_date: today, p_expired: false, p_note: null })).error).toBeNull();
    const dates = await db.from("enrollment_cycles").select("valid_end_date").in("id", cycles.data!.map(c => c.id));
    expect(dates.data!.map(c => c.valid_end_date)).toEqual([addCalendarDays(today, 27), addCalendarDays(today, 27)]);
  });
  it("익명 사용자는 상품을 변경하거나 구매할 수 없다", async () => {
    const anon = createClient(env.url, env.anonKey);
    expect((await anon.rpc("save_lesson_product", { p_id: null, p_version: null, p_product: base, p_schedules: [] })).error).not.toBeNull();
    expect((await anon.from("lesson_products").select("*")).data ?? []).toEqual([]);
  });
});
