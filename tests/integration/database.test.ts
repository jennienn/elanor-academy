import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { hasTestEnvironmentFile, loadAndValidateTestEnvironment, type TestEnvironment } from "../support/test-env";
import { addCalendarDays, koreaDateString } from "../../src/lib/business-rules";

let env: TestEnvironment | null = null;
if (hasTestEnvironmentFile()) {
  try {
    env = loadAndValidateTestEnvironment({ requireServiceRole: true });
  } catch (error) {
    console.warn(`[integration] ${error instanceof Error ? error.message : String(error)}`);
  }
}

describe("통합 테스트 환경", () => {
  it("테스트 DB가 없으면 운영 DB에 연결하지 않는다", () => {
    if (!env) {
      console.info("[integration] .env.test.local의 전용 테스트 DB 값이 없어 DB 시나리오를 실행하지 않습니다.");
    }
    expect(env === null || env.projectRef.length > 0).toBe(true);
  });
});

describe.runIf(env !== null)("Supabase 통합 시나리오", () => {
  let authenticated: SupabaseClient;
  let admin: SupabaseClient;
  const createdMembers: number[] = [];
  const createdClasses: number[] = [];
  const prefix = `테스트회원_INTEGRATION_${Date.now()}_${randomBytes(2).toString("hex")}`;
  let classId: number;
  let mondayId: number;
  let wednesdayId: number;

  function futureWeekday(weekday: number, minimumDays = 7) {
    const today = koreaDateString();
    for (let offset = minimumDays; offset < minimumDays + 7; offset += 1) {
      const candidate = addCalendarDays(today, offset);
      if (new Date(`${candidate}T12:00:00+09:00`).getDay() === weekday) return candidate;
    }
    throw new Error("테스트 날짜를 계산하지 못했습니다.");
  }

  async function createMember(suffix: string) {
    const { data, error } = await authenticated
      .from("members")
      .insert({ name: `${prefix}_${suffix}`, phone: `000-INT-${String(createdMembers.length + 1).padStart(3, "0")}` })
      .select("id")
      .single();
    expect(error).toBeNull();
    createdMembers.push(data!.id);
    return data!.id as number;
  }

  beforeAll(async () => {
    const readyEnv = env!;
    if (!readyEnv.adminEmail || !readyEnv.adminPassword) {
      throw new Error("TEST_ADMIN_EMAIL과 TEST_ADMIN_PASSWORD가 필요합니다.");
    }
    authenticated = createClient(readyEnv.url, readyEnv.anonKey, { auth: { persistSession: false } });
    admin = createClient(readyEnv.url, readyEnv.serviceRoleKey, { auth: { persistSession: false } });
    const { error: loginError } = await authenticated.auth.signInWithPassword({
      email: readyEnv.adminEmail,
      password: readyEnv.adminPassword
    });
    if (loginError) throw loginError;

    const { data: cls, error: classError } = await authenticated
      .from("classes")
      .insert({ name: `${prefix}_반`, capacity: 10, active: true })
      .select("id")
      .single();
    if (classError || !cls) throw classError ?? new Error("class 생성 실패");
    classId = cls.id;
    createdClasses.push(classId);
    const { data: schedules, error: scheduleError } = await authenticated
      .from("class_schedules")
      .insert([
        { class_id: classId, weekday: 1, curriculum_group: "A" },
        { class_id: classId, weekday: 3, curriculum_group: "B" }
      ])
      .select("id, weekday");
    if (scheduleError || !schedules) throw scheduleError ?? new Error("schedule 생성 실패");
    mondayId = schedules.find((row) => row.weekday === 1)!.id;
    wednesdayId = schedules.find((row) => row.weekday === 3)!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    for (const memberId of createdMembers.reverse()) await admin.from("members").delete().eq("id", memberId);
    for (const id of createdClasses.reverse()) await admin.from("classes").delete().eq("id", id);
  });

  it("회원 등록과 수정을 수행한다", async () => {
    const memberId = await createMember("수정");
    const { error } = await authenticated.from("members").update({ phone: "000-INT-EDIT" }).eq("id", memberId);
    expect(error).toBeNull();
    const { data } = await authenticated.from("members").select("phone").eq("id", memberId).single();
    expect(data?.phone).toBe("000-INT-EDIT");
  });

  it("개인 수강권, enrollment, cycle, payment, sessions를 원자적으로 생성한다", async () => {
    const memberId = await createMember("개인생성");
    const { data, error } = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 8,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 400000,
        p_method: "card",
        p_payment_date: "2026-07-14"
      })
      .single();
    expect(error).toBeNull();
    const createdRow = data as { cycle_id: string; enrollment_id: string };
    const { count: sessionCount } = await authenticated
      .from("sessions")
      .select("*", { count: "exact", head: true })
      .eq("cycle_id", createdRow.cycle_id);
    const { count: paymentCount } = await authenticated
      .from("payments")
      .select("*", { count: "exact", head: true })
      .eq("cycle_id", createdRow.cycle_id);
    expect(sessionCount).toBe(8);
    expect(paymentCount).toBe(1);
  });

  it("결제 금액을 입력하지 않은 수강권은 0원으로 생성한다", async () => {
    const memberId = await createMember("금액미입력");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 0,
        p_method: "card",
        p_payment_date: "2026-08-02"
      })
      .single();
    expect(created.error).toBeNull();
    const cycleId = (created.data as { cycle_id: string }).cycle_id;
    const { data: payment } = await authenticated.from("payments").select("amount").eq("cycle_id", cycleId).single();
    expect(payment?.amount).toBe(0);
  });

  it("cycle 또는 payment 단계 오류 시 enrollment를 남기지 않는다", async () => {
    const memberId = await createMember("원자실패");
    const before = await authenticated
      .from("enrollments")
      .select("*", { count: "exact", head: true })
      .eq("member_id", memberId);
    const invalidPlan = await authenticated.rpc("create_enrollment_with_cycle_atomic", {
      p_member_id: memberId,
      p_kind: "solo",
      p_plan: 6,
      p_class_name: null,
      p_schedule_ids: [],
      p_amount: 300000,
      p_method: "card",
      p_payment_date: "2026-07-14"
    });
    const invalidPayment = await authenticated.rpc("create_enrollment_with_cycle_atomic", {
      p_member_id: memberId,
      p_kind: "solo",
      p_plan: 4,
      p_class_name: null,
      p_schedule_ids: [],
      p_amount: -1,
      p_method: "card",
      p_payment_date: "2026-07-14"
    });
    expect(invalidPlan.error).not.toBeNull();
    expect(invalidPayment.error).not.toBeNull();
    const after = await authenticated
      .from("enrollments")
      .select("*", { count: "exact", head: true })
      .eq("member_id", memberId);
    expect(after.count).toBe(before.count);
  });

  it("개인레슨 재등록 시 이전 기록을 보존하고 새 cycle에 새 이용권과 잔여 횟수만 이월한다", async () => {
    const memberId = await createMember("회차재등록");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "cash",
        p_payment_date: "2026-07-14"
      })
      .single();
    const createdRow = created.data as { cycle_id: string; enrollment_id: string };
    const cycleId = createdRow.cycle_id;
    expect((await authenticated.rpc("record_solo_session_atomic", {
      p_cycle_id: cycleId,
      p_session_index: 1,
      p_date: "2026-07-15",
      p_expired: false,
      p_note: "기존 기록 유지 검증"
    })).error).toBeNull();
    const renewed = await authenticated.rpc("renew_enrollment_atomic", {
      p_enrollment_id: createdRow.enrollment_id,
      p_plan: 8,
      p_schedule_ids: [],
      p_amount: 400000,
      p_method: "transfer",
      p_payment_date: "2026-07-20"
    });
    expect(renewed.error).toBeNull();
    const { data: cycles } = await authenticated
      .from("enrollment_cycles")
      .select("id, status, total_count, used_count, first_class_date, valid_end_date, valid_weeks")
      .eq("enrollment_id", createdRow.enrollment_id);
    expect(cycles).toHaveLength(2);
    expect(cycles?.find((cycle) => cycle.id === cycleId)).toEqual(expect.objectContaining({
      status: "completed",
      total_count: 4,
      used_count: 1,
      first_class_date: "2026-07-15",
      valid_end_date: "2026-08-18",
      valid_weeks: 5
    }));
    expect(cycles?.find((cycle) => cycle.status === "active")).toEqual(expect.objectContaining({
      total_count: 11,
      used_count: 0,
      first_class_date: null,
      valid_end_date: null,
      valid_weeks: 9
    }));
    expect(cycles?.filter((cycle) => cycle.status === "completed")).toHaveLength(1);
    expect(cycles?.filter((cycle) => cycle.status === "active")).toHaveLength(1);
    const activeCycleId = cycles?.find((cycle) => cycle.status === "active")?.id;
    const [{ count: oldSessionCount }, { count: newSessionCount }, { count: oldPaymentCount }, { count: newPaymentCount }, { data: firstSession }] = await Promise.all([
      authenticated.from("sessions").select("*", { count: "exact", head: true }).eq("cycle_id", cycleId),
      authenticated.from("sessions").select("*", { count: "exact", head: true }).eq("cycle_id", activeCycleId),
      authenticated.from("payments").select("*", { count: "exact", head: true }).eq("cycle_id", cycleId),
      authenticated.from("payments").select("*", { count: "exact", head: true }).eq("cycle_id", activeCycleId),
      authenticated.from("sessions").select("date, status, note").eq("cycle_id", cycleId).eq("session_index", 1).single()
    ]);
    expect(oldSessionCount).toBe(4);
    expect(newSessionCount).toBe(11);
    expect(oldPaymentCount).toBe(1);
    expect(newPaymentCount).toBe(1);
    expect(firstSession).toEqual({ date: "2026-07-15", status: "done", note: "기존 기록 유지 검증" });
  });

  it("사용 완료한 8회권을 8회로 재등록하면 16회가 아닌 새 8회·9주 cycle을 만든다", async () => {
    const memberId = await createMember("8회재등록회귀");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 8,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 400000,
        p_method: "cash",
        p_payment_date: "2026-07-20"
      })
      .single();
    const createdRow = created.data as { cycle_id: string; enrollment_id: string };

    for (let sessionIndex = 1; sessionIndex <= 8; sessionIndex += 1) {
      const recorded = await authenticated.rpc("record_solo_session_atomic", {
        p_cycle_id: createdRow.cycle_id,
        p_session_index: sessionIndex,
        p_date: `2026-07-${String(21 + sessionIndex).padStart(2, "0")}`,
        p_expired: false,
        p_note: null
      });
      expect(recorded.error).toBeNull();
    }

    const renewed = await authenticated
      .rpc("renew_enrollment_atomic", {
        p_enrollment_id: createdRow.enrollment_id,
        p_plan: 8,
        p_schedule_ids: [],
        p_amount: 400000,
        p_method: "transfer",
        p_payment_date: "2026-08-31"
      })
      .single();
    expect(renewed.error).toBeNull();
    expect(renewed.data).toEqual(expect.objectContaining({ total_count: 8 }));

    const { data: activeCycle } = await authenticated
      .from("enrollment_cycles")
      .select("plan, base_count, carry_over_count, total_count, used_count, first_class_date, valid_end_date, valid_weeks")
      .eq("enrollment_id", createdRow.enrollment_id)
      .eq("status", "active")
      .single();
    expect(activeCycle).toEqual({
      plan: 8,
      base_count: 8,
      carry_over_count: 0,
      total_count: 8,
      used_count: 0,
      first_class_date: null,
      valid_end_date: null,
      valid_weeks: 9
    });
  });

  it("복수 요일을 저장하고 잘못된 요일이 포함되면 전부 롤백한다", async () => {
    const memberId = await createMember("복수요일");
    const created = await authenticated.rpc("create_enrollment_with_cycle_atomic", {
      p_member_id: memberId,
      p_kind: "group",
      p_plan: null,
      p_class_name: `${prefix}_반`,
      p_schedule_ids: [mondayId, wednesdayId],
      p_amount: 160000,
      p_method: "card",
      p_payment_date: "2026-07-14"
    });
    expect(created.error).toBeNull();
    const invalidMember = await createMember("요일실패");
    const failed = await authenticated.rpc("create_enrollment_with_cycle_atomic", {
      p_member_id: invalidMember,
      p_kind: "group",
      p_plan: null,
      p_class_name: `${prefix}_반`,
      p_schedule_ids: [mondayId, 999999999],
      p_amount: 160000,
      p_method: "card",
      p_payment_date: "2026-07-14"
    });
    expect(failed.error).not.toBeNull();
    const { count } = await authenticated
      .from("enrollments")
      .select("*", { count: "exact", head: true })
      .eq("member_id", invalidMember);
    expect(count).toBe(0);
  });

  it("반의 capacity 값을 넘어도 단체 수강 등록을 허용한다", async () => {
    const capacityName = `${prefix}_정원반`;
    const { data: capacityClass } = await authenticated
      .from("classes")
      .insert({ name: capacityName, capacity: 10, active: true })
      .select("id")
      .single();
    createdClasses.push(capacityClass!.id);
    const { data: capacitySchedule } = await authenticated
      .from("class_schedules")
      .insert({ class_id: capacityClass!.id, weekday: 1, curriculum_group: "A" })
      .select("id")
      .single();
    for (let index = 0; index < 10; index += 1) {
      const memberId = await createMember(`정원${index + 1}`);
      const result = await authenticated.rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "group",
        p_plan: null,
        p_class_name: capacityName,
        p_schedule_ids: [capacitySchedule!.id],
        p_amount: 160000,
        p_method: "card",
        p_payment_date: "2026-07-14"
      });
      expect(result.error).toBeNull();
    }
    const candidateId = await createMember("정원11번째");
    const created = await authenticated.rpc("create_enrollment_with_cycle_atomic", {
      p_member_id: candidateId,
      p_kind: "group",
      p_plan: null,
      p_class_name: capacityName,
      p_schedule_ids: [capacitySchedule!.id],
      p_amount: 160000,
      p_method: "card",
      p_payment_date: "2026-07-14"
    });
    expect(created.error).toBeNull();
    const { count } = await authenticated
      .from("enrollments")
      .select("*", { count: "exact", head: true })
      .eq("member_id", candidateId);
    expect(count).toBe(1);
  });

  it("출석 등록·취소, 환불, 수강 종료를 보존형 상태 변경으로 처리한다", async () => {
    const memberId = await createMember("출석환불종료");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "group",
        p_plan: null,
        p_class_name: `${prefix}_반`,
        p_schedule_ids: [mondayId],
        p_amount: 160000,
        p_method: "card",
        p_payment_date: "2026-07-14"
      })
      .single();
    const row = created.data as { cycle_id: string; enrollment_id: string };
    const saved = await authenticated.rpc("save_attendance_atomic", {
      p_date: "2026-07-20",
      p_records: [{ cycleId: row.cycle_id, scheduleId: mondayId, attended: true }]
    });
    expect(saved.error).toBeNull();
    const cancelled = await authenticated.rpc("save_attendance_atomic", {
      p_date: "2026-07-20",
      p_records: [{ cycleId: row.cycle_id, scheduleId: mondayId, attended: false }]
    });
    expect(cancelled.error).toBeNull();
    const { data: payment } = await authenticated.from("payments").select("id").eq("cycle_id", row.cycle_id).single();
    expect(
      (await authenticated.from("payments").update({ status: "partially_refunded", refunded_amount: 50000 }).eq("id", payment!.id)).error
    ).toBeNull();
    expect(
      (await authenticated.from("enrollments").update({ status: "ended", ended_date: "2026-07-21" }).eq("id", row.enrollment_id)).error
    ).toBeNull();
  });

  it("스타터 패키지는 개인 2회와 단체 4회를 한 결제 원장으로 원자 생성한다", async () => {
    const memberId = await createMember("스타터패키지");
    const created = await authenticated
      .rpc("create_starter_package_atomic", {
        p_member_id: memberId,
        p_class_name: `${prefix}_반`,
        p_schedule_ids: [mondayId, wednesdayId],
        p_amount: 250000,
        p_method: "card",
        p_payment_date: "2026-07-14"
      })
      .single();

    expect(created.error).toBeNull();
    const row = created.data as {
      package_id: string;
      solo_enrollment_id: string;
      solo_cycle_id: string;
      group_enrollment_id: string;
      group_cycle_id: string;
    };
    const { data: packageRow } = await authenticated
      .from("enrollment_packages")
      .select("member_id, valid_weeks, amount, status")
      .eq("id", row.package_id)
      .single();
    expect(packageRow).toEqual({ member_id: memberId, valid_weeks: 3, amount: 250000, status: "active" });

    const { data: enrollments } = await authenticated
      .from("enrollments")
      .select("id, kind, package_id")
      .eq("package_id", row.package_id)
      .order("kind");
    expect(enrollments).toEqual([
      { id: row.group_enrollment_id, kind: "group", package_id: row.package_id },
      { id: row.solo_enrollment_id, kind: "solo", package_id: row.package_id }
    ]);

    const { data: cycles } = await authenticated
      .from("enrollment_cycles")
      .select("id, total_count, used_count, first_class_date, valid_end_date")
      .in("id", [row.solo_cycle_id, row.group_cycle_id])
      .order("total_count");
    expect(cycles).toEqual([
      {
        id: row.solo_cycle_id,
        total_count: 2,
        used_count: 0,
        first_class_date: null,
        valid_end_date: null
      },
      {
        id: row.group_cycle_id,
        total_count: 4,
        used_count: 0,
        first_class_date: null,
        valid_end_date: null
      }
    ]);

    const { count: paymentCount } = await authenticated
      .from("payments")
      .select("*", { count: "exact", head: true })
      .in("cycle_id", [row.solo_cycle_id, row.group_cycle_id]);
    expect(paymentCount).toBe(0);
  });

  it("스타터 패키지의 개인 2회도 booking 페이지용 예약을 생성한다", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    const bookingDate = addCalendarDays(today, 10);
    const memberId = await createMember("스타터예약");
    const created = await authenticated
      .rpc("create_starter_package_atomic", {
        p_member_id: memberId,
        p_class_name: `${prefix}_반`,
        p_schedule_ids: [mondayId],
        p_amount: 250000,
        p_method: "card",
        p_payment_date: today
      })
      .single();
    expect(created.error).toBeNull();

    const booking = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: (created.data as { solo_cycle_id: string }).solo_cycle_id,
      p_date: bookingDate,
      p_start_minute: 1290
    });

    expect(booking.error).toBeNull();
  });

  it("신규 회원과 스타터 패키지를 한 트랜잭션으로 생성하고 실패 시 회원도 롤백한다", async () => {
    const memberName = `${prefix}_신규패키지`;
    const created = await authenticated
      .rpc("create_member_with_starter_package_atomic", {
        p_name: memberName,
        p_phone: "070-9000-1001",
        p_class_name: `${prefix}_반`,
        p_schedule_ids: [mondayId],
        p_amount: 250000,
        p_method: "card",
        p_payment_date: "2026-07-14"
      })
      .single();
    expect(created.error).toBeNull();
    const row = created.data as {
      member_id: number;
      package_id: string;
      solo_enrollment_id: string;
      group_enrollment_id: string;
    };
    createdMembers.push(row.member_id);
    expect(row.package_id).toBeTruthy();

    const { data: enrollments } = await authenticated
      .from("enrollments")
      .select("id, kind, package_id")
      .eq("member_id", row.member_id)
      .order("kind");
    expect(enrollments).toEqual([
      { id: row.group_enrollment_id, kind: "group", package_id: row.package_id },
      { id: row.solo_enrollment_id, kind: "solo", package_id: row.package_id }
    ]);

    const failedName = `${prefix}_신규패키지실패`;
    const failed = await authenticated.rpc("create_member_with_starter_package_atomic", {
      p_name: failedName,
      p_phone: "070-9000-1002",
      p_class_name: `${prefix}_반`,
      p_schedule_ids: [999999999],
      p_amount: 250000,
      p_method: "card",
      p_payment_date: "2026-07-14"
    });
    expect(failed.error).not.toBeNull();
    const { count } = await authenticated
      .from("members")
      .select("*", { count: "exact", head: true })
      .eq("name", failedName);
    expect(count).toBe(0);
  });

  it("스타터 패키지는 개인·단체 중 가장 이른 수업일부터 공통 3주 유효기간을 다시 계산한다", async () => {
    const memberId = await createMember("패키지유효기간");
    const created = await authenticated
      .rpc("create_starter_package_atomic", {
        p_member_id: memberId,
        p_class_name: `${prefix}_반`,
        p_schedule_ids: [mondayId],
        p_amount: 250000,
        p_method: "transfer",
        p_payment_date: "2026-07-14"
      })
      .single();
    expect(created.error).toBeNull();
    const row = created.data as { solo_cycle_id: string; group_cycle_id: string };

    expect(
      (
        await authenticated.rpc("save_attendance_atomic", {
          p_date: "2026-07-20",
          p_records: [{ cycleId: row.group_cycle_id, scheduleId: mondayId, attended: true }]
        })
      ).error
    ).toBeNull();
    expect(
      (
        await authenticated.rpc("record_solo_session_atomic", {
          p_cycle_id: row.solo_cycle_id,
          p_session_index: 1,
          p_date: "2026-07-18",
          p_expired: false,
          p_note: "테스트"
        })
      ).error
    ).toBeNull();

    const readValidity = () =>
      authenticated
        .from("enrollment_cycles")
        .select("id, first_class_date, valid_end_date")
        .in("id", [row.solo_cycle_id, row.group_cycle_id])
        .order("id");
    expect((await readValidity()).data).toEqual([
      expect.objectContaining({ first_class_date: "2026-07-18", valid_end_date: "2026-08-07" }),
      expect.objectContaining({ first_class_date: "2026-07-18", valid_end_date: "2026-08-07" })
    ]);

    expect(
      (
        await authenticated.rpc("delete_solo_session_atomic", {
          p_cycle_id: row.solo_cycle_id,
          p_session_index: 1
        })
      ).error
    ).toBeNull();
    expect((await readValidity()).data).toEqual([
      expect.objectContaining({ first_class_date: "2026-07-20", valid_end_date: "2026-08-09" }),
      expect.objectContaining({ first_class_date: "2026-07-20", valid_end_date: "2026-08-09" })
    ]);
  });

  it("스타터 패키지도 반의 capacity 값과 무관하게 등록한다", async () => {
    const capacityName = `${prefix}_패키지정원반`;
    const { data: capacityClass } = await authenticated
      .from("classes")
      .insert({ name: capacityName, capacity: 1, active: true })
      .select("id")
      .single();
    createdClasses.push(capacityClass!.id);
    const { data: capacitySchedule } = await authenticated
      .from("class_schedules")
      .insert({ class_id: capacityClass!.id, weekday: 2, curriculum_group: "A" })
      .select("id")
      .single();

    const existingMemberId = await createMember("패키지정원기존");
    expect(
      (
        await authenticated.rpc("create_enrollment_with_cycle_atomic", {
          p_member_id: existingMemberId,
          p_kind: "group",
          p_plan: null,
          p_class_name: capacityName,
          p_schedule_ids: [capacitySchedule!.id],
          p_amount: 160000,
          p_method: "card",
          p_payment_date: "2026-07-14"
        })
      ).error
    ).toBeNull();

    const additionalMemberId = await createMember("패키지정원초과");
    const created = await authenticated.rpc("create_starter_package_atomic", {
      p_member_id: additionalMemberId,
      p_class_name: capacityName,
      p_schedule_ids: [capacitySchedule!.id],
      p_amount: 250000,
      p_method: "card",
      p_payment_date: "2026-07-14"
    });
    expect(created.error).toBeNull();

    const [{ count: packageCount }, { count: enrollmentCount }] = await Promise.all([
      authenticated
        .from("enrollment_packages")
        .select("*", { count: "exact", head: true })
        .eq("member_id", additionalMemberId),
      authenticated.from("enrollments").select("*", { count: "exact", head: true }).eq("member_id", additionalMemberId)
    ]);
    expect(packageCount).toBe(1);
    expect(enrollmentCount).toBe(2);
  });

  it("재등록 도중 결제 검증 실패 시 기존 active cycle을 그대로 보존한다", async () => {
    const memberId = await createMember("재등록실패");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "card",
        p_payment_date: "2026-07-14"
      })
      .single();
    const row = created.data as { enrollment_id: string };
    const failed = await authenticated.rpc("renew_enrollment_atomic", {
      p_enrollment_id: row.enrollment_id,
      p_plan: 8,
      p_schedule_ids: [],
      p_amount: -1,
      p_method: "card",
      p_payment_date: "2026-07-20"
    });
    expect(failed.error).not.toBeNull();
    const { data: cycles } = await authenticated.from("enrollment_cycles").select("status").eq("enrollment_id", row.enrollment_id);
    expect(cycles).toEqual([{ status: "active" }]);
  });

  it("동일 cycle과 알림 종류는 한 이력만 유지하고 실패 이력을 재시도로 갱신한다", async () => {
    const memberId = await createMember("알림멱등성");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "card",
        p_payment_date: "2026-07-14"
      })
      .single();
    const row = created.data as { cycle_id: string };

    expect(
      (
        await authenticated.from("notifications").insert({
          cycle_id: row.cycle_id,
          status: "failed",
          trigger_type: "auto",
          error_code: "TEST_FAILURE",
          fail_reason: "테스트 실패"
        })
      ).error
    ).toBeNull();
    expect(
      (
        await authenticated.from("notifications").upsert(
          {
            cycle_id: row.cycle_id,
            status: "sent",
            trigger_type: "auto",
            provider: "solapi",
            provider_message_id: "테스트메시지_ID",
            error_code: null,
            fail_reason: null
          },
          { onConflict: "cycle_id,trigger_type" }
        )
      ).error
    ).toBeNull();

    const { data: notifications } = await authenticated
      .from("notifications")
      .select("status, provider, provider_message_id, error_code")
      .eq("cycle_id", row.cycle_id)
      .eq("trigger_type", "auto");
    expect(notifications).toEqual([
      {
        status: "sent",
        provider: "solapi",
        provider_message_id: "테스트메시지_ID",
        error_code: null
      }
    ]);
  });

  it("개인 예약은 동시 중복, 1시간 겹침, 고정 단체수업 겹침을 DB에서 차단한다", async () => {
    const paymentDate = koreaDateString();
    const bookingDate = futureWeekday(3);
    const groupClassDate = futureWeekday(4);
    const firstMember = await createMember("예약A");
    const secondMember = await createMember("예약B");
    const createCycle = async (memberId: number) => {
      const result = await authenticated
        .rpc("create_enrollment_with_cycle_atomic", {
          p_member_id: memberId,
          p_kind: "solo",
          p_plan: 4,
          p_class_name: null,
          p_schedule_ids: [],
          p_amount: 200000,
          p_method: "card",
          p_payment_date: paymentDate
        })
        .single();
      expect(result.error).toBeNull();
      return (result.data as { cycle_id: string }).cycle_id;
    };
    const firstCycle = await createCycle(firstMember);
    const secondCycle = await createCycle(secondMember);

    const first = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: firstCycle,
      p_date: bookingDate,
      p_start_minute: 630
    });
    expect(first.error).toBeNull();

    const overlapBefore = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: secondCycle,
      p_date: bookingDate,
      p_start_minute: 600
    });
    const overlapAfter = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: secondCycle,
      p_date: bookingDate,
      p_start_minute: 660
    });
    const availableAfter = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: secondCycle,
      p_date: bookingDate,
      p_start_minute: 690
    });
    expect(overlapBefore.error?.message).toContain("BOOKING_CONFLICT");
    expect(overlapAfter.error?.message).toContain("BOOKING_CONFLICT");
    expect(availableAfter.error).toBeNull();

    const groupOverlap = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: firstCycle,
      p_date: groupClassDate,
      p_start_minute: 1170
    });
    const morningGroupOverlap = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: firstCycle,
      p_date: groupClassDate,
      p_start_minute: 630
    });
    expect(groupOverlap.error?.message).toContain("GROUP_CLASS_OVERLAP");
    expect(morningGroupOverlap.error?.message).toContain("GROUP_CLASS_OVERLAP");
  });

  it("운영자 차단 시간은 겹치는 예약을 막고 해제 후 다시 허용한다", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    const bookingDate = addCalendarDays(today, 10);
    const memberId = await createMember("예약차단");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 8,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 400000,
        p_method: "card",
        p_payment_date: today
      })
      .single();
    const cycleId = (created.data as { cycle_id: string }).cycle_id;

    const block = await authenticated.rpc("create_solo_booking_block_atomic", {
      p_date: bookingDate,
      p_start_minute: 840,
      p_end_minute: 960,
      p_reason: `${prefix}_외부일정`
    });
    expect(block.error).toBeNull();

    const overlappingBlock = await authenticated.rpc("create_solo_booking_block_atomic", {
      p_date: bookingDate,
      p_start_minute: 900,
      p_end_minute: 1020,
      p_reason: null
    });
    expect(overlappingBlock.error?.message).toContain("BLOCK_OVERLAP");

    const blockedBooking = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: bookingDate,
      p_start_minute: 810
    });
    expect(blockedBooking.error?.message).toContain("BOOKING_BLOCKED");

    const availableBooking = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: bookingDate,
      p_start_minute: 960
    });
    expect(availableBooking.error).toBeNull();

    const conflictsWithBooking = await authenticated.rpc("create_solo_booking_block_atomic", {
      p_date: bookingDate,
      p_start_minute: 930,
      p_end_minute: 990,
      p_reason: null
    });
    expect(conflictsWithBooking.error?.message).toContain("BLOCK_BOOKING_CONFLICT");

    expect((await authenticated.from("solo_booking_blocks").delete().eq("id", block.data)).error).toBeNull();
    const afterDelete = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: bookingDate,
      p_start_minute: 840
    });
    expect(afterDelete.error).toBeNull();
  });

  it("예약 완료 처리는 예약 상태와 기존 개인레슨 회차를 함께 갱신한다", async () => {
    const paymentDate = koreaDateString();
    const bookingDate = addCalendarDays(paymentDate, 14);
    const memberId = await createMember("예약완료");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "card",
        p_payment_date: paymentDate
      })
      .single();
    const cycleId = (created.data as { cycle_id: string }).cycle_id;
    const reserved = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: bookingDate,
      p_start_minute: 600
    });
    expect(reserved.error).toBeNull();

    const completed = await authenticated.rpc("complete_solo_booking_atomic", {
      p_booking_id: reserved.data,
      p_session_index: 1
    });
    expect(completed.error).toBeNull();
    const [{ data: booking }, { data: session }] = await Promise.all([
      authenticated.from("solo_bookings").select("status").eq("id", reserved.data).single(),
      authenticated.from("sessions").select("status,date").eq("cycle_id", cycleId).eq("session_index", 1).single()
    ]);
    expect(booking?.status).toBe("completed");
    expect(session).toEqual({ status: "done", date: bookingDate });
  });

  it("취소 마감 이후 예약 취소는 가능하되 잔여 횟수를 1회 차감한다", async () => {
    const memberId = await createMember("늦은예약취소");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "card",
        p_payment_date: today
      })
      .single();
    expect(created.error).toBeNull();
    const cycleId = (created.data as { cycle_id: string }).cycle_id;
    const { data: booking, error: bookingError } = await admin
      .from("solo_bookings")
      .insert({ cycle_id: cycleId, member_id: memberId, booking_date: today, start_minute: 600 })
      .select("id")
      .single();
    expect(bookingError).toBeNull();

    const cancelled = await admin.rpc("cancel_solo_booking_atomic", {
      p_booking_id: booking!.id,
      p_member_id: memberId
    });
    expect(cancelled.error).toBeNull();
    expect(cancelled.data).toBe(true);

    const [{ data: cancelledBooking }, { data: cycle }, { data: session }] = await Promise.all([
      admin.from("solo_bookings").select("status,cancellation_charged").eq("id", booking!.id).single(),
      admin.from("enrollment_cycles").select("used_count").eq("id", cycleId).single(),
      admin.from("sessions").select("date,status,note").eq("cycle_id", cycleId).eq("session_index", 1).single()
    ]);
    expect(cancelledBooking).toEqual({ status: "cancelled", cancellation_charged: true });
    expect(cycle?.used_count).toBe(1);
    expect(session).toEqual({
      date: today,
      status: "done",
      note: "예약 취소 가능 시간 이후 취소 (횟수 차감)"
    });
  });

  it("취소 마감 전 예약 취소는 잔여 횟수를 차감하지 않는다", async () => {
    const memberId = await createMember("정상예약취소");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    const bookingDate = addCalendarDays(today, 21);
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "card",
        p_payment_date: today
      })
      .single();
    expect(created.error).toBeNull();
    const cycleId = (created.data as { cycle_id: string }).cycle_id;
    const { data: booking, error: bookingError } = await admin
      .from("solo_bookings")
      .insert({ cycle_id: cycleId, member_id: memberId, booking_date: bookingDate, start_minute: 600 })
      .select("id")
      .single();
    expect(bookingError).toBeNull();

    const cancelled = await admin.rpc("cancel_solo_booking_atomic", {
      p_booking_id: booking!.id,
      p_member_id: memberId
    });
    expect(cancelled.error).toBeNull();
    expect(cancelled.data).toBe(false);

    const [{ data: cancelledBooking }, { data: cycle }] = await Promise.all([
      admin.from("solo_bookings").select("status,cancellation_charged").eq("id", booking!.id).single(),
      admin.from("enrollment_cycles").select("used_count").eq("id", cycleId).single()
    ]);
    expect(cancelledBooking).toEqual({ status: "cancelled", cancellation_charged: false });
    expect(cycle?.used_count).toBe(0);
  });

  it("운영자는 같은 날 개인레슨 수업 기록을 최대 2회까지 추가할 수 있다", async () => {
    const memberId = await createMember("당일2회기록");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "card",
        p_payment_date: "2026-08-01"
      })
      .single();
    expect(created.error).toBeNull();
    const cycleId = (created.data as { cycle_id: string }).cycle_id;

    const first = await authenticated.rpc("record_solo_session_atomic", {
      p_cycle_id: cycleId,
      p_session_index: 1,
      p_date: "2026-08-08",
      p_expired: false,
      p_note: null
    });
    const second = await authenticated.rpc("record_solo_session_atomic", {
      p_cycle_id: cycleId,
      p_session_index: 2,
      p_date: "2026-08-08",
      p_expired: false,
      p_note: null
    });
    const third = await authenticated.rpc("record_solo_session_atomic", {
      p_cycle_id: cycleId,
      p_session_index: 3,
      p_date: "2026-08-08",
      p_expired: false,
      p_note: null
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(third.error?.message).toContain("SAME_DAY_SESSION_LIMIT");
  });

  it("한 회원은 같은 날 개인레슨을 최대 2회까지 예약할 수 있다", async () => {
    const paymentDate = koreaDateString();
    const bookingDate = futureWeekday(6);
    const memberId = await createMember("당일2회예약");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "card",
        p_payment_date: paymentDate
      })
      .single();
    expect(created.error).toBeNull();
    const cycleId = (created.data as { cycle_id: string }).cycle_id;

    const first = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: bookingDate,
      p_start_minute: 600
    });
    const second = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: bookingDate,
      p_start_minute: 660
    });
    const third = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: bookingDate,
      p_start_minute: 720
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(third.error?.message).toContain("SAME_DAY_BOOKING_LIMIT");
  });

  it("22:00 개인레슨 예약을 허용한다", async () => {
    const paymentDate = koreaDateString();
    const bookingDate = futureWeekday(6, 14);
    const memberId = await createMember("22시예약");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 4,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 200000,
        p_method: "card",
        p_payment_date: paymentDate
      })
      .single();
    expect(created.error).toBeNull();

    const booking = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: (created.data as { cycle_id: string }).cycle_id,
      p_date: bookingDate,
      p_start_minute: 1320
    });
    expect(booking.error).toBeNull();
  });

  it("첫 수업 전 12회권은 결제일부터 13주째 날까지 예약할 수 있다", async () => {
    const memberId = await createMember("12회예약유효기간");
    const created = await authenticated
      .rpc("create_enrollment_with_cycle_atomic", {
        p_member_id: memberId,
        p_kind: "solo",
        p_plan: 12,
        p_class_name: null,
        p_schedule_ids: [],
        p_amount: 500000,
        p_method: "card",
        p_payment_date: "2026-08-01"
      })
      .single();
    expect(created.error).toBeNull();
    const cycleId = (created.data as { cycle_id: string }).cycle_id;

    const lastValidDay = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: "2026-10-30",
      p_start_minute: 600
    });
    const dayAfterExpiry = await admin.rpc("create_solo_booking_atomic", {
      p_cycle_id: cycleId,
      p_date: "2026-10-31",
      p_start_minute: 600
    });

    expect(lastValidDay.error).toBeNull();
    expect(dayAfterExpiry.error?.message).toContain("BOOKING_DATE_INVALID");
  });

  it("비로그인 클라이언트의 DB 쓰기를 RLS가 차단한다", async () => {
    const anonymous = createClient(env!.url, env!.anonKey, { auth: { persistSession: false } });
    const { error } = await anonymous.from("members").insert({ name: `${prefix}_차단`, phone: "000-BLOCKED" });
    expect(error).not.toBeNull();
  });
});
