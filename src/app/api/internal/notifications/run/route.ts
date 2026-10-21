// src/app/api/internal/notifications/run/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { cycleStatus, type CycleLike } from "@/lib/business-rules";
import { automaticNotificationDate, deliverCycleNotification } from "@/lib/notification-service";
import { notificationsEnabled } from "@/lib/notification-config";

// Vercel Cron이 매일 호출. CRON_SECRET 환경변수를 설정해두면 Vercel이 자동으로
// `Authorization: Bearer {CRON_SECRET}` 헤더를 붙여 GET 요청을 보낸다 (Vercel 공식 규약).
// 오전 10시대에 접수하고 실제 오전 11:30 발송은 SOLAPI 예약 기능에 맡긴다.
export const dynamic = "force-dynamic";

interface NotificationCandidate {
  id: string;
  status: "active" | "completed" | "expired";
  plan: number | null;
  total_count: number;
  used_count: number;
  valid_end_date: string | null;
  next_due_date: string | null;
  enrollments: {
    kind: "solo" | "group";
    status: "active" | "ended";
    package_id: string | null;
  };
}

function toCycleLike(row: NotificationCandidate): CycleLike {
  return {
    kind: row.enrollments.kind,
    enrollmentStatus: row.enrollments.status,
    cycleStatus: row.status,
    plan: row.plan,
    totalCount: row.total_count,
    usedCount: row.used_count,
    validEndDate: row.valid_end_date,
    nextDueDate: row.next_due_date,
    isFixedTerm: row.enrollments.package_id != null
  };
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "인증 실패" } }, { status: 401 });
  }
  if (!notificationsEnabled()) {
    return NextResponse.json({ disabled: true, checked: 0, sent: 0, failed: 0, skipped: 0 });
  }

  if (!automaticNotificationDate()) {
    return NextResponse.json(
      { error: { code: "INVALID_SCHEDULED_DATE", message: "오늘 11시 30분 예약 접수 시간이 지났습니다." } },
      { status: 503 }
    );
  }

  const supabase = createSupabaseAdminClient();

  // notify_status가 'pending' 또는 아직 판정 전인 'not_required'인 active cycle들을 훑는다.
  // (cycleStatus()가 'danger'로 새로 바뀐 건들을 찾아 발송 대상으로 전환)
  const { data, error } = await supabase
    .from("enrollment_cycles")
    .select("*, enrollments!inner(kind, status, class_id, package_id, classes(name), members(phone))")
    .eq("status", "active")
    .in("notify_status", ["not_required", "pending"]);

  if (error) {
    return NextResponse.json({ error: { code: "DB_ERROR", message: error.message } }, { status: 500 });
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of data ?? []) {
    const row = candidate as unknown as NotificationCandidate;
    const like = toCycleLike(row);
    const eligible = cycleStatus(like) === "danger";

    if (!eligible) continue; // 아직 대상 아님 — not_required 유지

    // 같은 cycle을 여러 cron 인스턴스가 동시에 잡아도 조건부 update에 성공한 한 건만 발송한다.
    const { data: claimed } = await supabase
      .from("enrollment_cycles")
      .update({ notify_status: "processing", notify_date: new Date().toISOString() })
      .eq("id", row.id)
      .in("notify_status", ["not_required", "pending"])
      .select("id")
      .maybeSingle();
    if (!claimed) {
      skipped++;
      continue;
    }

    const result = await deliverCycleNotification(supabase, row.id, "auto");
    // 시간 초과 건은 다음 실행에서 최신 대상/횟수로 다시 판정한다. 즉시 발송하지 않는다.
    const finalStatus = result.status === "failed" && result.code === "INVALID_SCHEDULED_DATE"
      ? "pending"
      : result.status === "skipped" ? "sent" : result.status;
    if (finalStatus === "sent") sent++;
    else failed++;

    await supabase
      .from("enrollment_cycles")
      .update({ notify_status: finalStatus, notify_date: new Date().toISOString() })
      .eq("id", row.id)
      .eq("notify_status", "processing");
  }

  return NextResponse.json({ checked: data?.length ?? 0, sent, failed, skipped });
}
