// src/app/api/members/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  DUPLICATE_PHONE_MESSAGE,
  isValidMemberPhone,
  PHONE_FORMAT_MESSAGE
} from "@/lib/phone";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("members")
    .select(
      "id, name, phone, enrollments(*, classes(name), enrollment_cycles(*, payments(*), cycle_schedules(schedule_id, class_schedules(weekday,start_time,duration_minutes)), attendance_logs(date, attended)))"
    )
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "회원을 찾을 수 없습니다." } }, { status: 404 });
  }
  return NextResponse.json(data);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const body = await request.json();
  const { name, phone } = body ?? {};

  if (!name || !phone) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "이름과 연락처를 입력해주세요." } },
      { status: 422 }
    );
  }
  if (!isValidMemberPhone(phone)) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: PHONE_FORMAT_MESSAGE } },
      { status: 422 }
    );
  }

  const { data: existingMember, error: duplicateCheckError } = await supabase
    .from("members")
    .select("id")
    .eq("phone", phone)
    .neq("id", id)
    .limit(1)
    .maybeSingle();
  if (duplicateCheckError) {
    return NextResponse.json(
      { error: { code: "DB_ERROR", message: duplicateCheckError.message } },
      { status: 500 }
    );
  }
  if (existingMember) {
    return NextResponse.json(
      { error: { code: "DUPLICATE_PHONE", message: DUPLICATE_PHONE_MESSAGE } },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("members").update({ name, phone }).eq("id", id);
  if (error) {
    if (
      error.code === "23505" &&
      (error.message.includes("members_phone") || error.message.includes("members_phone_digits"))
    ) {
      return NextResponse.json(
        { error: { code: "DUPLICATE_PHONE", message: DUPLICATE_PHONE_MESSAGE } },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: { code: "DB_ERROR", message: error.message } }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const memberId = Number(id);

  if (!Number.isSafeInteger(memberId) || memberId <= 0) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "올바른 회원 ID가 아닙니다." } },
      { status: 422 }
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("members").delete().eq("id", memberId).select("id").maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: { code: "DB_ERROR", message: "회원 삭제에 실패했습니다." } },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "회원을 찾을 수 없습니다." } },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
