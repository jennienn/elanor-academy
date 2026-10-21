import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { validateProduct } from "@/lib/lesson-products";

export async function GET(request: NextRequest) {
  const db = await createSupabaseServerClient();
  let query = db.from("lesson_products").select("*").order("id");
  if (request.nextUrl.searchParams.get("all") !== "true") query = query.eq("active", true);
  const [{ data, error }, { data: schedules, error: scheduleError }] = await Promise.all([
    query, db.from("class_schedules").select("*").eq("active", true).order("weekday")
  ]);
  if (error || scheduleError) return NextResponse.json({ error: { message: "수강권 목록을 불러오지 못했습니다." } }, { status: 500 });
  const productIds = (data ?? []).map(p => p.id);
  const classIds = (data ?? []).flatMap(p => p.class_id == null ? [] : [p.class_id]);
  const [cycles, enrollments] = await Promise.all([
    productIds.length ? db.from("enrollment_cycles").select("product_id").in("product_id", productIds) : Promise.resolve({ data: [], error: null }),
    classIds.length ? db.from("enrollments").select("class_id").in("class_id", classIds) : Promise.resolve({ data: [], error: null })
  ]);
  if (cycles.error || enrollments.error) return NextResponse.json({ error: { message: "수강권 이력을 확인하지 못했습니다." } }, { status: 500 });
  const purchased = new Set((cycles.data ?? []).map(row => row.product_id));
  const usedClasses = new Set((enrollments.data ?? []).map(row => row.class_id));
  return NextResponse.json({ products: (data ?? []).map(p => ({
    ...p,
    schedules: (schedules ?? []).filter(s => s.class_id === p.class_id),
    can_delete: !p.is_seeded && !purchased.has(p.id) && (p.class_id == null || !usedClasses.has(p.class_id))
  })) });
}
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const message = validateProduct(body);
  if (message) return NextResponse.json({ error: { message } }, { status: 422 });
  if (body.id != null && (!Number.isSafeInteger(body.id) || body.id < 1 || !Number.isSafeInteger(body.version) || body.version < 1)) {
    return NextResponse.json({ error: { message: "수강권을 다시 선택해주세요." } }, { status: 422 });
  }
  const db = await createSupabaseServerClient();
  const { data, error } = await db.rpc("save_lesson_product", {
    p_id: body.id ?? null, p_version: body.version ?? null, p_product: body, p_schedules: body.schedules ?? []
  });
  if (error) return NextResponse.json({ error: { message: error.code === "23505" ? "같은 이름의 반 또는 중복된 요일이 있습니다." : error.message } }, { status: error.code === "22023" || error.code?.startsWith("23") ? 422 : 500 });
  return NextResponse.json({ id: data }, { status: 200 });
}

export async function DELETE(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || !Number.isSafeInteger(body.id) || body.id < 1 || !Number.isSafeInteger(body.version) || body.version < 1) {
    return NextResponse.json({ error: { message: "수강권을 다시 선택해주세요." } }, { status: 422 });
  }
  const db = await createSupabaseServerClient();
  const { error } = await db.rpc("delete_unsold_lesson_product", { p_id: body.id, p_version: body.version });
  if (error) return NextResponse.json({ error: { message: error.message } }, { status: error.code === "22023" || error.code?.startsWith("23") ? 422 : 500 });
  return NextResponse.json({ ok: true });
}
