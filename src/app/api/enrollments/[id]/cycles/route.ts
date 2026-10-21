import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mapEnrollmentRpcError } from "@/lib/enrollment-service";
import { deliverCycleNotification } from "@/lib/notification-service";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("enrollment_cycles")
    .select("*, payments(*), cycle_schedules(schedule_id, class_schedules(weekday))")
    .eq("enrollment_id", id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: { code: "DB_ERROR", message: error.message } }, { status: 500 });
  return NextResponse.json({ cycles: data });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const body = await request.json();
  if (!body?.payment) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "결제 정보를 입력해주세요." } },
      { status: 422 }
    );
  }

  const { data, error } = await supabase
    .rpc("renew_enrollment_atomic", {
      p_enrollment_id: id,
      p_plan: body.plan ?? null,
      p_schedule_ids: Array.isArray(body.scheduleIds) ? body.scheduleIds : [],
      p_amount: body.payment.amount,
      p_method: body.payment.method,
      p_payment_date: body.payment.paymentDate
    })
    .single();
  if (error || !data) {
    const failure = mapEnrollmentRpcError(error ?? { message: "DB_ERROR: 재등록 결과가 없습니다." });
    const status = error?.code === "P0002" ? 404 : failure.status;
    return NextResponse.json({ error: { code: status === 404 ? "NOT_FOUND" : failure.code, message: failure.message } }, { status });
  }

  const row = data as { cycle_id: string; total_count: number };
  let notification: "sent" | "failed" | "none" = "none";
  if (body.sendNotification) {
    const delivery = await deliverCycleNotification(supabase, row.cycle_id, "manual_renew");
    notification =
      delivery.status === "sent" || delivery.status === "skipped"
        ? "sent"
        : delivery.status === "disabled"
          ? "none"
          : "failed";
  }
  return NextResponse.json({ cycleId: row.cycle_id, totalCount: row.total_count, notification }, { status: 201 });
}
