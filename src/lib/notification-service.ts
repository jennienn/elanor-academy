import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatDisplayDate, koreaDateString, remainOf, WEEKS_BY_PLAN } from "./business-rules";
import { notificationsEnabled } from "./notification-config";
import { sendSolapiAlimtalk } from "./solapi";

export type NotificationTrigger = "auto" | "registration" | "manual_renew" | "manual_resend";
export type NotificationDeliveryResult =
  // sent는 SOLAPI 접수 성공이며 예약 건의 실제 발송 완료를 뜻하지 않는다.
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; code: string; message: string }
  | { status: "disabled"; reason: string }
  | { status: "skipped"; reason: string };

export function automaticNotificationDate(now: Date = new Date()): string | null {
  const scheduledDate = `${koreaDateString(now)}T11:30:00+09:00`;
  return Date.parse(scheduledDate) - now.getTime() > 10 * 60 * 1000 ? scheduledDate : null;
}

export interface NotificationCycleRow {
  id: string;
  status: "active" | "completed" | "expired";
  plan: number | null;
  product_name?: string | null;
  base_count: number;
  total_count: number;
  used_count: number;
  payment_date: string;
  valid_end_date: string | null;
  valid_weeks?: number | null;
  next_due_date: string | null;
  enrollments: {
    kind: "solo" | "group";
    status: "active" | "ended";
    package_id: string | null;
    members: { name: string; phone: string };
    classes: { name: string } | null;
    enrollment_packages: { valid_weeks: number } | null;
  };
}

function templateIdFor(row: NotificationCycleRow, trigger: NotificationTrigger): string {
  const kind = row.enrollments.kind === "solo" ? "SOLO" : "GROUP";
  const purpose = trigger === "auto" ? "DUE" : "COMPLETED";
  return (
    process.env[`KAKAO_${purpose}_${kind}_TEMPLATE_ID`]?.trim() ??
    process.env.KAKAO_TEMPLATE_ID?.trim() ??
    ""
  );
}

function dateOrPending(value: string | null): string {
  return value ? formatDisplayDate(value) : "첫 수업 후 확정";
}

function validWeeksFor(row: NotificationCycleRow): number {
  if (row.valid_weeks) return row.valid_weeks;
  if (row.plan) return WEEKS_BY_PLAN[row.plan as keyof typeof WEEKS_BY_PLAN] ?? 0;
  return row.enrollments.enrollment_packages?.valid_weeks ?? 0;
}

export function messageFor(row: NotificationCycleRow, trigger: NotificationTrigger): string {
  const memberName = row.enrollments.members.name;
  const className = row.product_name ?? row.enrollments.classes?.name ?? "단체레슨";
  if (trigger === "auto") {
    if (row.enrollments.kind === "solo") {
      return `[엘라노르 댄스학원] 개인레슨 잔여 횟수 안내

안녕하세요, ${memberName}님!
엘라노르 댄스학원입니다. ✨

회원님의 개인레슨 수강권 잔여 횟수를 안내해 드립니다.

• 수강 과목: 개인레슨
• 현재 잔여 횟수: ${remainOf({ totalCount: row.total_count, usedCount: row.used_count })}회 / ${row.total_count}회
• 만료 예정일: ${dateOrPending(row.valid_end_date)}

원활한 레슨 일정을 위해, 잔여 횟수가 소진되기 전 미리 재등록을 부탁드립니다.

궁금하신 점은 언제든 편하게 문의해 주세요! 오늘도 좋은 하루 보내세요. 💛`;
    }
    const endDate = row.enrollments.package_id ? row.valid_end_date : row.next_due_date;
    return `[엘라노르 댄스학원] 수강권 만료 예정 안내

안녕하세요, ${memberName}님!
엘라노르 댄스학원입니다. ✨

회원님께서 수강 중이신 ${className} 클래스 수강권이 1주일 후 만료될 예정입니다.

• 수강 클래스: ${className}
• 만료 예정일: ${dateOrPending(endDate)}
• 사용 가능 횟수: ${remainOf({ totalCount: row.total_count, usedCount: row.used_count })}회

이용에 불편함이 없으시도록 만료 예정일을 미리 확인해 주시기 바랍니다.

궁금하신 점은 언제든 편하게 문의해 주세요! 오늘도 좋은 하루 보내세요. 💛`;
  }
  if (row.enrollments.kind === "solo") {
    return `[엘라노르 댄스학원] 개인레슨 등록 완료 안내

안녕하세요, ${memberName}님!
엘라노르 댄스학원입니다. ✨

회원님의 개인레슨 수강 등록 및 결제가 정상적으로 완료되었습니다.

• 수강 과목: 개인레슨
• 등록 횟수: 총 ${row.base_count}회
• 수강 유효기간: 첫 수업일로부터 ${validWeeksFor(row)}주 이내

📌 개인레슨 수강권은 첫 수업 시작일을 기준으로 ${validWeeksFor(row)}주 이내에 사용해 주시면 됩니다.

회원님께 맞춘 알찬 레슨으로 정성껏 준비하겠습니다. 첫 레슨 날 뵙겠습니다! 💛`;
  }
  const endDate = row.enrollments.package_id ? row.valid_end_date : row.next_due_date;
  return `[엘라노르 댄스학원] 단체레슨 등록 완료 안내

안녕하세요, ${memberName}님!
엘라노르 댄스학원입니다. ✨

요청하신 클래스의 수강 등록 및 결제가 정상적으로 완료되었습니다.

• 수강 클래스: ${className}
• 수강 기간: ${formatDisplayDate(row.payment_date)} ~ ${dateOrPending(endDate)}

이번 수강 기간도 알차고 즐겁게 함께해요! 수업 날 뵙겠습니다. 💛`;
}

export function variablesFor(
  row: NotificationCycleRow,
  trigger: NotificationTrigger
): Record<string, string> {
  const common = { "#{회원명}": row.enrollments.members.name };
  if (trigger === "auto" && row.enrollments.kind === "solo") {
    return {
      ...common,
      "#{잔여횟수}": String(remainOf({ totalCount: row.total_count, usedCount: row.used_count })),
      "#{총횟수}": String(row.total_count),
      "#{만료예정일}": dateOrPending(row.valid_end_date)
    };
  }
  if (trigger === "auto") {
    const endDate = row.enrollments.package_id ? row.valid_end_date : row.next_due_date;
    return {
      ...common,
      "#{수업명}": row.product_name ?? row.enrollments.classes?.name ?? "단체레슨",
      "#{잔여횟수}": String(remainOf({ totalCount: row.total_count, usedCount: row.used_count })),
      "#{만료예정일}": dateOrPending(endDate)
    };
  }
  if (row.enrollments.kind === "solo") {
    return {
      ...common,
      "#{등록횟수}": String(row.base_count),
      "#{유효주수}": String(validWeeksFor(row))
    };
  }
  const endDate = row.enrollments.package_id ? row.valid_end_date : row.next_due_date;
  return {
    ...common,
    "#{수업명}": row.product_name ?? row.enrollments.classes?.name ?? "단체레슨",
    "#{수강시작일}": formatDisplayDate(row.payment_date),
    "#{수강종료일}": dateOrPending(endDate)
  };
}

async function deliverCycleNotificationInternal(
  supabase: SupabaseClient,
  cycleId: string,
  trigger: NotificationTrigger
): Promise<NotificationDeliveryResult> {
  const { data: existing } = await supabase
    .from("notifications")
    .select("status, provider_message_id")
    .eq("cycle_id", cycleId)
    .eq("trigger_type", trigger)
    .maybeSingle();
  if (existing?.status === "sent") {
    return { status: "skipped", reason: "이미 접수된 알림입니다." };
  }

  const { data, error } = await supabase
    .from("enrollment_cycles")
    .select(
      "id, status, plan, base_count, total_count, used_count, payment_date, valid_end_date, valid_weeks, product_name, next_due_date, enrollments!inner(kind, status, package_id, members(name, phone), classes(name), enrollment_packages(valid_weeks))"
    )
    .eq("id", cycleId)
    .single();
  if (error || !data) {
    return { status: "failed", code: "CYCLE_NOT_FOUND", message: error?.message ?? "수강 주기를 찾을 수 없습니다." };
  }

  const row = data as unknown as NotificationCycleRow;
  const scheduledDate = trigger === "auto" ? automaticNotificationDate() : undefined;
  if (scheduledDate === null) {
    return { status: "failed", code: "INVALID_SCHEDULED_DATE", message: "오늘 11시 30분 예약 접수 시간이 지났습니다." };
  }
  const message = messageFor(row, trigger);
  const result = await sendSolapiAlimtalk({
    to: row.enrollments.members.phone,
    text: message,
    templateId: templateIdFor(row, trigger),
    variables: variablesFor(row, trigger),
    scheduledDate
  });
  const now = new Date().toISOString();

  await supabase.from("notifications").upsert(
    {
      cycle_id: cycleId,
      status: result.ok ? "sent" : "failed",
      trigger_type: trigger,
      message,
      fail_reason: result.ok ? null : result.message,
      provider: "solapi",
      provider_group_id: result.ok ? result.groupId : null,
      provider_message_id: result.ok ? result.messageId : null,
      error_code: result.ok ? null : result.code,
      sent_at: now
    },
    { onConflict: "cycle_id,trigger_type" }
  );

  return result.ok
    ? { status: "sent", providerMessageId: result.messageId }
    : { status: "failed", code: result.code, message: result.message };
}

export async function deliverCycleNotification(
  supabase: SupabaseClient,
  cycleId: string,
  trigger: NotificationTrigger
): Promise<NotificationDeliveryResult> {
  if (!notificationsEnabled()) {
    return { status: "disabled", reason: "알림톡 템플릿 검수 중으로 발송이 잠겨 있습니다." };
  }
  try {
    return await deliverCycleNotificationInternal(supabase, cycleId, trigger);
  } catch {
    return {
      status: "failed",
      code: "NOTIFICATION_INTERNAL_ERROR",
      message: "알림 처리 중 내부 오류가 발생했습니다."
    };
  }
}
