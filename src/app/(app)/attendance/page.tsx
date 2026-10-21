// src/app/(app)/attendance/page.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { koreaDateString } from "@/lib/business-rules";

interface ClassItem {
  id: number;
  name: string;
  member_count: number;
}

interface CalendarCell { date: string; day: number }

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const monthOf = (date: string) => date.slice(0, 7);

function shiftMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(year, monthNumber - 1 + amount, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
}

function calendarCells(month: string): Array<CalendarCell | null> {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const cells: Array<CalendarCell | null> = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= lastDay; day += 1) {
    cells.push({ date: `${month}-${String(day).padStart(2, "0")}`, day });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function selectedDateLabel(date: string) {
  const [, month, day] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00+09:00`).getDay()];
  return `${month}월 ${day}일 ${weekday}요일`;
}

interface ClassSchedule {
  id: number;
  weekday: number;
  start_time: string | null;
  curriculum_group: string | null;
}

interface AttendanceItem {
  cycleId: string;
  memberId: number;
  memberName: string;
  remain: number;
  total: number;
  scheduleIds: number[];
  selectedScheduleId?: number;
  attendanceLogId: number | null;
  attended: boolean;
  needsPayment: boolean;
}

export default function AttendancePage() {
  const today = koreaDateString();
  const loadRequestId = useRef(0);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [className, setClassName] = useState("");
  const [date, setDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(monthOf(today));
  const [dateCounts, setDateCounts] = useState<Record<string, number>>({});

  const [todaySchedule, setTodaySchedule] = useState<ClassSchedule | null>(null);
  const [items, setItems] = useState<AttendanceItem[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ classes: ClassItem[] }>("/api/classes")
      .then((res) => {
        setClasses(res.classes);
        if (res.classes.length > 0) setClassName((current) => current || res.classes[0].name);
      })
      .catch(() => setClasses([]));
  }, []);

  useEffect(() => {
    if (!className) return;
    apiFetch<{ dateCounts: Record<string, number> }>(
      `/api/attendance?className=${encodeURIComponent(className)}&month=${visibleMonth}`
    )
      .then((result) => setDateCounts(result.dateCounts))
      .catch(() => setDateCounts({}));
  }, [className, visibleMonth]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    if (!className) return;
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const cls = classes.find((c) => c.name === className);
      const weekday = new Date(date).getDay();

      const schedulesRes = cls
        ? await apiFetch<{ schedules: ClassSchedule[] }>(`/api/classes/${cls.id}/schedules`)
        : { schedules: [] };
      if (requestId !== loadRequestId.current) return;
      const matching = schedulesRes.schedules.filter((s) => s.weekday === weekday);
      const matched = matching[0] ?? null;
      setTodaySchedule(matched);

      if (!matched) {
        setItems([]);
        setChecked(new Set());
        return;
      }

      const res = await apiFetch<{ items: AttendanceItem[] }>(
        `/api/attendance?className=${encodeURIComponent(className)}&date=${date}`
      );
      if (requestId !== loadRequestId.current) return;
      const filtered = res.items.map(i => ({ ...i, selectedScheduleId: matching.find(s => i.scheduleIds.includes(s.id))?.id })).filter(i => i.selectedScheduleId != null);
      setItems(filtered);
      setChecked(new Set(filtered.filter((i) => i.attended).map((i) => i.cycleId)));
    } catch (e: unknown) {
      if (requestId !== loadRequestId.current) return;
      setError(e instanceof Error ? e.message : "목록을 불러오지 못했습니다.");
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  }, [className, date, classes]);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(cycleId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(cycleId)) next.delete(cycleId);
      else next.add(cycleId);
      return next;
    });
  }

  function toggleAll() {
    const allChecked = items.length > 0 && items.every((i) => checked.has(i.cycleId));
    setChecked(allChecked ? new Set() : new Set(items.map((i) => i.cycleId)));
  }

  async function handleSubmit() {
    if (!todaySchedule || items.length === 0) return;
    setSubmitting(true);
    try {
      const records = items.map((i) => ({
        cycleId: i.cycleId,
        scheduleId: i.selectedScheduleId!,
        attended: checked.has(i.cycleId)
      }));
      await apiFetch("/api/attendance", { method: "PUT", body: JSON.stringify({ date, records }) });
      const count = checked.size;
      await load();
      setToast(`${count}명의 출석이 저장되었습니다.`);
    } catch (e: any) {
      alert(e.message ?? "저장에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  const allChecked = items.length > 0 && items.every((i) => checked.has(i.cycleId));
  const selectedClass = classes.find((classItem) => classItem.name === className);
  const [calendarYear, calendarMonth] = visibleMonth.split("-").map(Number);
  const cells = calendarCells(visibleMonth);

  function moveMonth(amount: number) {
    const nextMonth = shiftMonth(visibleMonth, amount);
    setVisibleMonth(nextMonth);
    setDate(`${nextMonth}-01`);
  }

  return (
    <div className="app-page">
      <header className="app-page-header">
        <div>
          <h1>단체 출석</h1>
          <p>반별 수업 일정과 회원 출석을 확인하고 관리하세요.</p>
        </div>
      </header>

      <section className="schedule-calendar-card attendance-calendar" aria-label={`${calendarYear}년 ${calendarMonth}월 단체 출석`}>
        <div className="schedule-calendar-toolbar attendance-calendar-toolbar">
          <div className="class-segmented-control" aria-label="반 선택">
            {classes.map((classItem) => (
              <button
                key={classItem.id}
                type="button"
                className={`class-segment-option${className === classItem.name ? " selected" : ""}`}
                aria-pressed={className === classItem.name}
                onClick={() => setClassName(classItem.name)}
              >
                {classItem.name}
              </button>
            ))}
          </div>
          <div className="schedule-month-nav">
            <button type="button" className="secondary calendar-nav-button" onClick={() => moveMonth(-1)} aria-label="이전 달">‹</button>
            <h2>{calendarYear}년 {calendarMonth}월</h2>
            <button type="button" className="secondary calendar-nav-button" onClick={() => moveMonth(1)} aria-label="다음 달">›</button>
          </div>
          <button type="button" className="secondary today-button" onClick={() => { setVisibleMonth(monthOf(today)); setDate(today); }}>오늘</button>
        </div>
        <div className="schedule-weekdays" aria-hidden="true">
          {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
        </div>
        <div className="schedule-calendar-grid">
          {cells.map((cell, index) => cell ? (
            <button
              type="button"
              key={cell.date}
              aria-label={cell.date}
              className={`schedule-day${date === cell.date ? " selected" : ""}${today === cell.date ? " today" : ""}`}
              aria-pressed={date === cell.date}
              onClick={() => setDate(cell.date)}
            >
              <span className="schedule-day-number">{cell.day}</span>
              {(dateCounts[cell.date] ?? 0) > 0 && <span className="attendance-day-count">{dateCounts[cell.date]}명</span>}
            </button>
          ) : <span className="schedule-calendar-empty" key={`empty-${index}`} />)}
        </div>
      </section>

      <div className="panel attendance-list-panel">
        <div className="attendance-list-heading">
          <div>
            <h2>{selectedDateLabel(date)}</h2>
            <p>{className || "반 미선택"} · 수강 대상 {todaySchedule ? items.length : 0}명</p>
          </div>
          <span>전체 수강 회원 {selectedClass?.member_count ?? 0}명</span>
          {items.length > 0 && (
            <label className="checkbox-inline">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} />
              전체 선택
            </label>
          )}
        </div>
        {loading ? (
          <p className="state-message">불러오는 중...</p>
        ) : error ? (
          <p className="state-message error">{error}</p>
        ) : !todaySchedule ? (
          <p className="state-message">선택한 날짜에는 예정된 수업이 없습니다.</p>
        ) : items.length === 0 ? (
          <p className="state-message">해당 요일 수강 회원이 없습니다.</p>
        ) : (
          <ul className="daily-list">
            {items.map((item) => (
              <li key={item.cycleId} className="daily-row">
                <label className="checkbox-inline">
                  <input type="checkbox" checked={checked.has(item.cycleId)} onChange={() => toggle(item.cycleId)} />
                  {item.memberName}
                </label>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {item.needsPayment && (
                    <span className="badge danger" style={{ fontSize: 11, padding: "2px 8px" }}>
                      결제 필요
                    </span>
                  )}
                  <span style={{ color: "var(--text-sub)" }}>잔여 {item.remain}회</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="attendance-list-footer">
          <button onClick={handleSubmit} disabled={items.length === 0 || submitting}>
            {submitting ? "처리 중..." : `선택한 ${checked.size}명 출석 처리`}
          </button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
