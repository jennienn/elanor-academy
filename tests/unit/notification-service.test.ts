import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/solapi", () => ({ sendSolapiAlimtalk: vi.fn() }));
import { sendSolapiAlimtalk } from "@/lib/solapi";

import {
  messageFor,
  automaticNotificationDate,
  deliverCycleNotification,
  variablesFor,
  type NotificationCycleRow
} from "@/lib/notification-service";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function cycle(
  overrides: Partial<NotificationCycleRow> = {}
): NotificationCycleRow {
  return {
    id: "cycle-1",
    status: "active",
    plan: 8,
    base_count: 8,
    total_count: 10,
    used_count: 7,
    payment_date: "2026-07-27",
    valid_end_date: "2026-09-28",
    next_due_date: null,
    enrollments: {
      kind: "solo",
      status: "active",
      package_id: null,
      members: { name: "테스트회원_알림", phone: "010-0000-0000" },
      classes: null,
      enrollment_packages: null
    },
    ...overrides
  };
}

describe("회원별 알림톡 템플릿", () => {
  it("개인레슨 잔여 횟수와 만료일을 회원 cycle 값으로 치환한다", () => {
    const row = cycle();

    expect(messageFor(row, "auto")).toContain("현재 잔여 횟수: 3회 / 10회");
    expect(messageFor(row, "auto")).toContain("만료 예정일: 2026.09.28");
    expect(variablesFor(row, "auto")).toEqual({
      "#{회원명}": "테스트회원_알림",
      "#{잔여횟수}": "3",
      "#{총횟수}": "10",
      "#{만료예정일}": "2026.09.28"
    });
  });

  it("개인레슨 등록 횟수는 이월을 제외한 결제 횟수, 유효기간은 plan 주수로 안내한다", () => {
    const row = cycle();

    expect(messageFor(row, "registration")).toContain("등록 횟수: 총 8회");
    expect(messageFor(row, "registration")).toContain("첫 수업일로부터 9주 이내");
    expect(variablesFor(row, "registration")).toEqual({
      "#{회원명}": "테스트회원_알림",
      "#{등록횟수}": "8",
      "#{유효주수}": "9"
    });
  });

  it.each([6, 5, 8])("단체레슨 안내에 회원별 잔여 횟수를 넣는다 (사용 %i회)", (usedCount) => {
    const row = cycle({
      plan: null,
      base_count: 8,
      total_count: 8,
      used_count: usedCount,
      valid_end_date: null,
      next_due_date: "2026-08-31",
      enrollments: {
        kind: "group",
        status: "active",
        package_id: null,
        members: { name: "테스트회원_단체", phone: "010-0000-0001" },
        classes: { name: "K-POP" },
        enrollment_packages: null
      }
    });

    expect(messageFor(row, "auto")).toContain("K-POP 클래스 수강권이 1주일 후 만료");
    expect(messageFor(row, "auto")).toContain("만료 예정일: 2026.08.31");
    expect(messageFor(row, "auto")).toContain(`사용 가능 횟수: ${8 - usedCount}회`);
    expect(variablesFor(row, "auto")).toEqual({
      "#{회원명}": "테스트회원_단체",
      "#{수업명}": "K-POP",
      "#{잔여횟수}": String(8 - usedCount),
      "#{만료예정일}": "2026.08.31"
    });
  });

  it("단체레슨 등록 완료 안내에 결제일부터 다음 결제 예정일까지의 기간을 넣는다", () => {
    const row = cycle({
      plan: null,
      base_count: 8,
      total_count: 8,
      payment_date: "2026-07-27",
      valid_end_date: null,
      next_due_date: "2026-08-31",
      enrollments: {
        kind: "group",
        status: "active",
        package_id: null,
        members: { name: "테스트회원_단체", phone: "010-0000-0001" },
        classes: { name: "다이어트댄스" },
        enrollment_packages: null
      }
    });

    expect(messageFor(row, "registration")).toContain("수강 기간: 2026.07.27 ~ 2026.08.31");
    expect(variablesFor(row, "registration")).toEqual({
      "#{회원명}": "테스트회원_단체",
      "#{수업명}": "다이어트댄스",
      "#{수강시작일}": "2026.07.27",
      "#{수강종료일}": "2026.08.31"
    });
  });
});

describe("SOLAPI 자동 알림 예약", () => {
  it.each(["2026-10-01T15:00:00Z", "2026-10-02T01:00:00Z", "2026-10-02T01:59:59Z"])(
    "한국 날짜의 오전 11:30으로 예약한다 (%s)", (now) => {
      expect(automaticNotificationDate(new Date(now))).toBe("2026-10-02T11:30:00+09:00");
    }
  );

  it.each(["2026-10-02T11:20:00+09:00", "2026-10-02T11:30:00+09:00", "2026-10-02T23:59:00+09:00"])(
    "예약 시간이 임박하거나 지난 날은 접수를 보류한다 (%s)", (now) => {
      expect(automaticNotificationDate(new Date(now))).toBeNull();
    }
  );

  function database(existing: { status: string } | null = null) {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: existing }),
      single: vi.fn().mockResolvedValue({ data: cycle(), error: null }),
      upsert: vi.fn().mockResolvedValue({ error: null })
    };
    return { query, client: { from: vi.fn(() => query) } as unknown as SupabaseClient };
  }

  it.each(["auto", "registration", "manual_renew"] as const)(
    "자동 알림에만 예약 날짜를 전달하고 기존 등록 알림은 즉시 접수한다 (%s)", async (trigger) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-02T10:35:00+09:00"));
      vi.stubEnv("NEXT_PUBLIC_NOTIFICATIONS_ENABLED", "true");
      vi.mocked(sendSolapiAlimtalk).mockResolvedValue({ ok: true, groupId: "group-1", messageId: "message-1" });
      const { client, query } = database();
      expect(await deliverCycleNotification(client, "cycle-1", trigger)).toMatchObject({ status: "sent" });
      expect(sendSolapiAlimtalk).toHaveBeenCalledWith(expect.objectContaining({
        scheduledDate: trigger === "auto" ? "2026-10-02T11:30:00+09:00" : undefined
      }));
      expect(query.upsert).toHaveBeenCalledWith(expect.objectContaining({
        status: "sent", provider_group_id: "group-1", provider_message_id: "message-1"
      }), { onConflict: "cycle_id,trigger_type" });
    }
  );

  it("이미 예약 접수된 알림은 중복 접수하지 않는다", async () => {
    vi.stubEnv("NEXT_PUBLIC_NOTIFICATIONS_ENABLED", "true");
    const { client } = database({ status: "sent" });
    expect(await deliverCycleNotification(client, "cycle-1", "auto")).toMatchObject({ status: "skipped" });
    expect(sendSolapiAlimtalk).not.toHaveBeenCalled();
  });

  it("처리 중 예약 시간이 지나면 즉시 발송으로 전환하지 않는다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T11:30:00+09:00"));
    vi.stubEnv("NEXT_PUBLIC_NOTIFICATIONS_ENABLED", "true");
    const { client } = database();
    expect(await deliverCycleNotification(client, "cycle-1", "auto")).toMatchObject({
      status: "failed", code: "INVALID_SCHEDULED_DATE"
    });
    expect(sendSolapiAlimtalk).not.toHaveBeenCalled();
  });
});
