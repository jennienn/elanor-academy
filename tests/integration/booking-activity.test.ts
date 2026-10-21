import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { addCalendarDays, koreaDateString } from "../../src/lib/business-rules";
import { loadAndValidateTestEnvironment } from "../support/test-env";

const env = loadAndValidateTestEnvironment({ requireServiceRole: true });
if (!["127.0.0.1", "localhost"].includes(new URL(env.url).hostname)) throw new Error("예약 알림 테스트는 로컬 DB에서만 실행합니다.");
const admin = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false } });
const operator = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
let memberId: number | null = null;

beforeAll(async () => {
  const { error } = await operator.auth.signInWithPassword({ email: env.adminEmail!, password: env.adminPassword! });
  if (error) throw error;
});

afterAll(async () => {
  if (memberId !== null) {
    const { error } = await admin.from("members").delete().eq("id", memberId);
    expect(error).toBeNull();
  }
});

test("회원 예약·취소만 원자적으로 운영자 알림에 기록되고 확인 처리된다", async () => {
  const name = `테스트회원_BOOKING_ACTIVITY_${Date.now()}`;
  const member = await admin.from("members").insert({ name, phone: `000-ACTIVITY-${Date.now()}` }).select("id").single();
  expect(member.error).toBeNull();
  memberId = member.data!.id;
  const enrollment = await admin.from("enrollments").insert({ member_id: memberId, kind: "solo" }).select("id").single();
  expect(enrollment.error).toBeNull();
  const cycle = await admin.from("enrollment_cycles").insert({ enrollment_id: enrollment.data!.id, plan: 4, base_count: 4, total_count: 4, payment_date: koreaDateString(), valid_weeks: 20 }).select("id").single();
  expect(cycle.error).toBeNull();

  const bookingDate = addCalendarDays(koreaDateString(), 28);
  const booking = await admin.rpc("create_solo_booking_atomic", { p_cycle_id: cycle.data!.id, p_date: bookingDate, p_start_minute: 810 });
  expect(booking.error).toBeNull();
  const created = await operator.from("booking_activity").select("*").eq("booking_id", booking.data).single();
  expect(created.data).toMatchObject({ member_id: memberId, member_name: name, action: "created", booking_date: bookingDate, start_minute: 810, read_at: null });
  const anonymousRead = await anon.from("booking_activity").select("id").eq("booking_id", booking.data);
  expect(anonymousRead.error).not.toBeNull();

  const conflict = await admin.rpc("create_solo_booking_atomic", { p_cycle_id: cycle.data!.id, p_date: bookingDate, p_start_minute: 810 });
  expect(conflict.error).not.toBeNull();
  expect((await admin.from("booking_activity").select("id").eq("booking_id", booking.data)).data).toHaveLength(1);

  const cancelled = await admin.rpc("cancel_solo_booking_atomic", { p_booking_id: booking.data, p_member_id: memberId });
  expect(cancelled.error).toBeNull();
  const events = await operator.from("booking_activity").select("id,action,cancellation_charged,read_at").eq("booking_id", booking.data);
  expect(events.data).toHaveLength(2);
  expect(events.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "created", read_at: null }),
    expect.objectContaining({ action: "cancelled", cancellation_charged: false, read_at: null })
  ]));
  expect((await admin.rpc("cancel_solo_booking_atomic", { p_booking_id: booking.data, p_member_id: memberId })).error).not.toBeNull();
  expect((await admin.from("booking_activity").select("id").eq("booking_id", booking.data)).data).toHaveLength(2);

  const eventId = events.data!.find(event => event.action === "created")!.id;
  expect((await operator.from("booking_activity").update({ read_at: new Date().toISOString() }).eq("id", eventId)).error).toBeNull();
  expect((await operator.from("booking_activity").select("read_at").eq("id", eventId).single()).data?.read_at).not.toBeNull();
  expect((await anon.from("booking_activity").update({ read_at: new Date().toISOString() }).eq("id", eventId)).error).not.toBeNull();
});
