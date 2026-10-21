import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { readBookingToken } from "@/lib/booking-session";
import { advanceNoticeUnavailableSlots, lateCancellationCharges, soloBookingValidEnd } from "@/lib/booking-rules";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

async function getSession() {
  return readBookingToken((await cookies()).get("booking_session")?.value);
}

function todayInKorea() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

function koreaMinutesNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

export async function GET(request: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: { message: "다시 로그인해주세요." } }, { status: 401 });

  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from("enrollment_cycles")
    .select("id,plan,total_count,used_count,payment_date,valid_end_date,valid_weeks,duration_minutes,product_name,status,enrollments!inner(member_id,status,members!inner(name))")
    .eq("id", auth.cycleId)
    .eq("status", "active")
    .single();
  if (error || !data) return NextResponse.json({ error: { message: "수강권을 찾을 수 없습니다." } }, { status: 404 });

  const enrollment = data.enrollments as unknown as { member_id: number; status: string; members: { name: string } };
  if (enrollment.member_id !== auth.memberId || enrollment.status !== "active") {
    return NextResponse.json({ error: { message: "수강권 접근 권한이 없습니다." } }, { status: 403 });
  }

  const plan = data.plan as number | null;
  const validEndDate = data.valid_end_date ?? soloBookingValidEnd(data.payment_date, plan, data.valid_weeks ?? undefined);
  const firstBookableDate = [todayInKorea(), data.payment_date].sort().at(-1)!;
  const date = request.nextUrl.searchParams.get("date");
  let unavailable: number[] = [];

  if (date) {
    const [{ data: rows, error: rowsError }, { data: blocks, error: blocksError }, { data: groups, error: groupsError }] = await Promise.all([
      db.from("solo_bookings").select("start_minute,duration_minutes").eq("booking_date", date).eq("status", "confirmed"),
      db.from("solo_booking_blocks").select("start_minute,end_minute").eq("block_date", date),
      db.rpc("group_schedule_ranges", { p_date: date })
    ]);
    if (rowsError || blocksError || groupsError) return NextResponse.json({ error: { message: "예약 가능 시간을 불러오지 못했습니다." } }, { status: 500 });
    const ranges = [
      ...(rows ?? []).map(row => ({ start_minute: row.start_minute, end_minute: row.start_minute + row.duration_minutes })),
      ...(blocks ?? []), ...(groups ?? []) as { start_minute: number; end_minute: number }[]
    ];
    for (let slot = 600; slot <= 1320; slot += 30) {
      if (slot + data.duration_minutes > 1380 || ranges.some(range => slot < range.end_minute && slot + data.duration_minutes > range.start_minute)) unavailable.push(slot);
    }
    unavailable.push(...advanceNoticeUnavailableSlots(date, todayInKorea(), koreaMinutesNow()));
  }

  const { data: bookings } = await db
    .from("solo_bookings")
    .select("id,booking_date,start_minute,duration_minutes,status,cancellation_charged")
    .eq("cycle_id", auth.cycleId)
    .order("booking_date")
    .order("start_minute");

  return NextResponse.json({
    member: { name: enrollment.members.name },
    cycle: {
      plan: data.plan,
      product_name: data.product_name,
      duration_minutes: data.duration_minutes,
      payment_date: data.payment_date,
      valid_end_date: validEndDate,
      first_bookable_date: firstBookableDate,
      remain: data.total_count - data.used_count
    },
    unavailable: [...new Set(unavailable)],
    bookings: (bookings ?? []).map((booking) => ({
      ...booking,
      late_cancellation: booking.status === "confirmed"
        ? lateCancellationCharges(booking.booking_date, todayInKorea(), koreaMinutesNow())
        : false
    }))
  });
}

export async function POST(request: NextRequest) {
  const auth = await getSession();
  if (!auth) return NextResponse.json({ error: { message: "다시 로그인해주세요." } }, { status: 401 });
  const { date, startMinute } = await request.json().catch(() => ({}));
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(startMinute)) {
    return NextResponse.json({ error: { message: "예약 날짜와 시간을 확인해주세요." } }, { status: 422 });
  }

  const db = createSupabaseAdminClient();
  const { data, error } = await db.rpc("create_solo_booking_atomic", {
    p_cycle_id: auth.cycleId,
    p_date: date,
    p_start_minute: startMinute
  });
  if (error) {
    const conflict = error.message.includes("CONFLICT") || error.message.includes("OVERLAP") || error.code === "23P01";
    const sameDayLimit = error.message.includes("SAME_DAY_BOOKING_LIMIT");
    const advanceNotice = error.message.includes("BOOKING_ADVANCE_NOTICE_REQUIRED");
    const invalidDate = error.message.includes("BOOKING_DATE_INVALID");
    const blocked = error.message.includes("BOOKING_BLOCKED");
    return NextResponse.json(
      {
        error: {
          message: sameDayLimit
            ? "같은 날에는 최대 2회까지만 수강할 수 있습니다."
            : invalidDate
              ? "예약 가능한 기간 안의 날짜를 선택해주세요."
            : blocked
              ? "운영자가 예약을 막아둔 시간입니다. 다른 시간을 선택해주세요."
            : conflict
            ? "이미 예약된 시간이거나 단체수업과 겹칩니다."
            : advanceNotice
              ? "수업 시작 2시간 전까지만 예약할 수 있습니다."
              : error.message
        }
      },
      { status: conflict ? 409 : 422 }
    );
  }
  return NextResponse.json({ id: data }, { status: 201 });
}
