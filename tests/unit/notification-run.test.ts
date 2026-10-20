import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/lib/notification-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/notification-service")>(),
  deliverCycleNotification: vi.fn()
}));

import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { deliverCycleNotification } from "@/lib/notification-service";
import { GET } from "@/app/api/internal/notifications/run/route";

describe("자동 알림 예약 접수 경로", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T10:45:00+09:00"));
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
    vi.stubEnv("NEXT_PUBLIC_NOTIFICATIONS_ENABLED", "true");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  function request() {
    return new NextRequest("http://localhost/api/internal/notifications/run", {
      headers: { Authorization: "Bearer test-only-cron-secret" }
    });
  }

  it("접수 마감 이후에는 대상 상태를 바꾸거나 즉시 발송하지 않는다", async () => {
    vi.setSystemTime(new Date("2026-10-02T11:20:00+09:00"));
    expect((await GET(request())).status).toBe(503);
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(deliverCycleNotification).not.toHaveBeenCalled();
  });

  it.each([false, true])("접수 성공을 기록하고 시간 초과만 다음 실행으로 보류한다 (%s)", async (late) => {
    const candidates = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: [{
        id: "cycle-1", status: "active", total_count: 8, used_count: 5,
        next_due_date: "2026-10-09", valid_end_date: null, plan: null,
        enrollments: { kind: "group", status: "active", package_id: null }
      }], error: null })
    };
    const claim = {
      update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "cycle-1" } })
    };
    const final = { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValueOnce(candidates).mockReturnValueOnce(claim).mockReturnValueOnce(final);
    vi.mocked(createSupabaseAdminClient).mockReturnValue({ from } as unknown as ReturnType<typeof createSupabaseAdminClient>);
    vi.mocked(deliverCycleNotification).mockResolvedValue(late
      ? { status: "failed", code: "INVALID_SCHEDULED_DATE", message: "시간 초과" }
      : { status: "sent", providerMessageId: "message-1" });

    expect((await GET(request())).status).toBe(200);
    expect(claim.in).toHaveBeenCalledWith("notify_status", ["not_required", "pending"]);
    expect(deliverCycleNotification).toHaveBeenCalledWith(expect.anything(), "cycle-1", "auto");
    expect(final.update).toHaveBeenCalledWith(expect.objectContaining({ notify_status: late ? "pending" : "sent" }));
  });
});
