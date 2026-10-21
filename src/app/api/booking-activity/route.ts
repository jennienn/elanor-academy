import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const PAGE_SIZE = 20;

export async function GET(request: NextRequest) {
  const offset = Number(request.nextUrl.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return NextResponse.json({ error: { message: "조회 범위를 확인해주세요." } }, { status: 422 });
  }

  const db = await createSupabaseServerClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: { message: "로그인이 필요합니다." } }, { status: 401 });

  const [events, unread] = await Promise.all([
    db.from("booking_activity")
      .select("id,member_id,member_name,action,booking_date,start_minute,duration_minutes,cancellation_charged,created_at,read_at", { count: "exact" })
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1),
    db.from("booking_activity").select("id", { count: "exact", head: true }).is("read_at", null)
  ]);
  if (events.error || unread.error) {
    return NextResponse.json({ error: { message: "예약 알림을 불러오지 못했습니다." } }, { status: 500 });
  }
  return NextResponse.json({ items: events.data ?? [], total: events.count ?? 0, unread: unread.count ?? 0 });
}

export async function PATCH(request: NextRequest) {
  const db = await createSupabaseServerClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: { message: "로그인이 필요합니다." } }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (body?.all !== true && (!Number.isSafeInteger(body?.id) || body.id <= 0)) {
    return NextResponse.json({ error: { message: "알림을 선택해주세요." } }, { status: 422 });
  }
  let query = db.from("booking_activity").update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (body.all !== true) query = query.eq("id", body.id);
  const { error } = await query;
  if (error) return NextResponse.json({ error: { message: "알림을 확인 처리하지 못했습니다." } }, { status: 500 });
  return NextResponse.json({ ok: true });
}
