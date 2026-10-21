// src/app/api/enrollments/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { cycleStatus, groupStatusText, isFixedTermCycle, soloStatusText, type CycleLike } from "@/lib/business-rules";
import { createEnrollmentWithCycle } from "@/lib/enrollment-service";
import { deliverCycleNotification } from "@/lib/notification-service";

function toCycleLike(cycleRow: any, enrollmentStatus: "active" | "ended"): CycleLike {
  return {
    kind: cycleRow.kind,
    enrollmentStatus,
    cycleStatus: cycleRow.status,
    plan: cycleRow.plan,
    totalCount: cycleRow.total_count,
    usedCount: cycleRow.used_count,
    validEndDate: cycleRow.valid_end_date,
    nextDueDate: cycleRow.next_due_date,
    isFixedTerm: cycleRow.package_id != null
  };
}

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status"); // 'unpaid' | 'unsent'
  const typeFilter = searchParams.get("type"); // 'solo' | 'group'
  const page = Number(searchParams.get("page") ?? "1");
  const pageSize = Number(searchParams.get("pageSize") ?? "8");

  let query = supabase
    .from("enrollment_cycles")
    .select(
      "*, enrollments!inner(id, kind, status, member_id, class_id, package_id, members(id, name), classes(name))"
    )
    .eq("status", "active")
    .eq("enrollments.status", "active");

  if (typeFilter === "solo" || typeFilter === "group") {
    query = query.eq("enrollments.kind", typeFilter);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: { code: "DB_ERROR", message: error.message } }, { status: 500 });
  }

  let items = (data ?? [])
    .map((row: any) => ({
      row,
      like: toCycleLike({ ...row, kind: row.enrollments.kind, package_id: row.enrollments.package_id }, row.enrollments.status)
    }))
    .filter(({ like }) => cycleStatus(like) === "danger");

  if (statusFilter === "unsent") {
    items = items.filter(({ row }) => row.notify_status !== "sent");
  }

  items.sort((a, b) => {
    const aKey = isFixedTermCycle(a.like) ? a.row.total_count - a.row.used_count : a.row.next_due_date;
    const bKey = isFixedTermCycle(b.like) ? b.row.total_count - b.row.used_count : b.row.next_due_date;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  const total = items.length;
  const start = (page - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);

  const result = paged.map(({ row, like }) => {
    const statusText = isFixedTermCycle(like) ? soloStatusText(like) : groupStatusText(like);
    return {
      cycleId: row.id,
      enrollmentId: row.enrollments.id,
      memberId: row.enrollments.members.id,
      memberName: row.enrollments.members.name,
      classId: row.enrollments.class_id,
      kind: row.enrollments.kind,
      className: row.enrollments.kind === "group" ? row.enrollments.classes.name : null,
      label: row.product_name ?? (
        row.enrollments.kind === "solo"
          ? `개인 ${row.plan ?? row.total_count}회권${row.enrollments.package_id ? " (패키지)" : ""}`
          : `단체 ${row.enrollments.classes.name}${row.enrollments.package_id ? " (패키지)" : ""}`),
      statusText: statusText.text,
      tone: statusText.tone,
      remain: row.total_count - row.used_count,
      total: row.total_count,
      notifyStatus: row.notify_status,
      notifyDate: row.notify_date
    };
  });

  return NextResponse.json({ items: result, total });
}

/**
 * 기존 회원에게 새 수강권(enrollment)을 추가한다.
 * 신규 회원가입(POST /api/members)의 enrollment 생성 절차와 동일하므로
 * createEnrollmentWithCycle을 그대로 재사용한다.
 */
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const body = await request.json();
  const { memberId, ...enrollment } = body ?? {};

  if (!memberId || !enrollment.kind) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "회원과 수강 종류를 확인해주세요." } },
      { status: 422 }
    );
  }
  if (!enrollment.payment) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "결제 정보(금액/수단/결제일)를 입력해주세요." } },
      { status: 422 }
    );
  }

  const result = await createEnrollmentWithCycle(supabase, memberId, enrollment);
  if (!result.ok) {
    return NextResponse.json({ error: { code: result.code, message: result.message } }, { status: result.status });
  }

  let notification: "sent" | "failed" | "none" = "none";
  if (enrollment.sendNotification) {
    const delivery = await deliverCycleNotification(supabase, result.cycleId, "registration");
    notification =
      delivery.status === "sent" || delivery.status === "skipped"
        ? "sent"
        : delivery.status === "disabled"
          ? "none"
          : "failed";
  }
  return NextResponse.json(
    { enrollmentId: result.enrollmentId, cycleId: result.cycleId, notification },
    { status: 201 }
  );
}
