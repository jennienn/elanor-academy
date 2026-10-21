// src/app/api/classes/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const [{ data: classes, error: classesError }, { data: enrollments, error: enrollmentsError }] = await Promise.all([
    supabase.from("classes").select("*").order("id"),
    supabase.from("enrollments").select("class_id,member_id").eq("kind", "group").eq("status", "active")
  ]);
  if (classesError || enrollmentsError) {
    return NextResponse.json(
      { error: { code: "DB_ERROR", message: classesError?.message ?? enrollmentsError?.message } },
      { status: 500 }
    );
  }
  const memberIdsByClass = new Map<number, Set<number>>();
  for (const enrollment of enrollments ?? []) {
    if (enrollment.class_id === null) continue;
    const memberIds = memberIdsByClass.get(enrollment.class_id) ?? new Set<number>();
    memberIds.add(enrollment.member_id);
    memberIdsByClass.set(enrollment.class_id, memberIds);
  }
  return NextResponse.json({
    classes: (classes ?? []).filter(c => c.active || memberIdsByClass.has(c.id)).map((classItem) => ({
      ...classItem,
      member_count: memberIdsByClass.get(classItem.id)?.size ?? 0
    }))
  });
}
