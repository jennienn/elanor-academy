import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  const month = request.nextUrl.searchParams.get("month");
  const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const validMonth = month && /^\d{4}-\d{2}$/.test(month);
  if (!validDate && !validMonth) {
    return NextResponse.json({ error: { message: "조회 날짜를 확인해주세요." } }, { status: 422 });
  }

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("solo_bookings")
    .select("id,booking_date,start_minute,duration_minutes,status,cycle_id,enrollment_cycles!inner(plan,product_name,total_count,used_count,enrollments!inner(members!inner(name,phone)))")
    .in("status", ["confirmed", "completed"]);

  if (validDate) {
    query = query.eq("booking_date", date);
  } else {
    const [year, monthNumber] = month!.split("-").map(Number);
    const nextMonth = monthNumber === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
    query = query.gte("booking_date", `${month}-01`).lt("booking_date", nextMonth);
  }

  const { data, error } = await query
    .order("booking_date")
    .order("start_minute");
  if (error) return NextResponse.json({ error: { message: error.message } }, { status: 500 });

  const bookings = (data ?? []).map((row) => {
    const cycle = row.enrollment_cycles as unknown as {
      plan: number | null;
      product_name: string | null;
      total_count: number;
      used_count: number;
      enrollments: { members: { name: string; phone: string } };
    };
    return {
      id: row.id,
      bookingDate: row.booking_date,
      cycleId: row.cycle_id,
      startMinute: row.start_minute,
      durationMinutes: row.duration_minutes,
      status: row.status,
      plan: cycle.plan,
      productName: cycle.product_name,
      remain: cycle.total_count - cycle.used_count,
      name: cycle.enrollments.members.name,
      phone: cycle.enrollments.members.phone
    };
  });
  return NextResponse.json({ bookings });
}
