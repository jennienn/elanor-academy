import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { deliverCycleNotification } from "@/lib/notification-service";
import { mapEnrollmentRpcError } from "@/lib/enrollment-service";
import { isValidMemberPhone, PHONE_FORMAT_MESSAGE } from "@/lib/phone";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || !Number.isSafeInteger(body.productId) || !Number.isInteger(body.version) ||
    !Array.isArray(body.scheduleIds) || body.scheduleIds.some((id: unknown) => !Number.isSafeInteger(id)) ||
    (body.memberId != null && !Number.isSafeInteger(body.memberId)) ||
    (body.classId != null && !Number.isSafeInteger(body.classId)) ||
    (body.enrollmentId != null && (typeof body.enrollmentId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.enrollmentId))) ||
    !["card", "transfer", "cash"].includes(body.method) || typeof body.paymentDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.paymentDate)) {
    return NextResponse.json({ error: { message: "수강권과 결제 정보를 확인해주세요." } }, { status: 422 });
  }
  if (!body.memberId && !body.enrollmentId) {
    if (typeof body.name !== "string" || !body.name.trim()) return NextResponse.json({ error: { message: "이름을 입력해주세요." } }, { status: 422 });
    if (typeof body.phone !== "string" || !isValidMemberPhone(body.phone)) return NextResponse.json({ error: { message: PHONE_FORMAT_MESSAGE } }, { status: 422 });
  }
  const db = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_lesson_product", {
    p_product_id: body.productId, p_version: body.version, p_member_id: body.memberId ?? null,
    p_name: body.name ?? null, p_phone: body.phone ?? null, p_enrollment_id: body.enrollmentId ?? null,
    p_schedule_ids: body.scheduleIds, p_class_id: body.classId ?? null, p_method: body.method, p_payment_date: body.paymentDate
  }).single();
  if (error || !data) {
    const failure = mapEnrollmentRpcError(error ?? { message: "등록 결과를 확인할 수 없습니다." });
    return NextResponse.json({ error: { message: failure.message } }, { status: failure.status });
  }
  const row = data as { member_id: number; cycle_id: string; enrollment_id: string; package_id: string | null };
  let notification = "none";
  if (body.sendNotification && !row.package_id) {
    const result = await deliverCycleNotification(db, row.cycle_id, body.enrollmentId ? "manual_renew" : "registration");
    notification = result.status;
  }
  return NextResponse.json({ memberId: row.member_id, cycleId: row.cycle_id, enrollmentId: row.enrollment_id, notification }, { status: 201 });
}
