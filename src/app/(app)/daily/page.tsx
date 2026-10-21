"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { koreaDateString } from "@/lib/business-rules";
import { Modal } from "@/components/Modal";

interface SessionRow { session_index: number; status: "pending" | "done" | "auto" }
interface ReservedLesson {
  id: string; cycleId: string; bookingDate: string; startMinute: number; durationMinutes: number;
  status: "confirmed" | "completed"; plan: number | null; productName: string | null; remain: number; name: string; phone: string;
}
interface CalendarCell { date: string; day: number }
interface BookingBlock {
  id: string; blockDate: string; startMinute: number; durationMinutes: number; endMinute: number;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const formatTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
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

export default function DailyPage() {
  const today = koreaDateString();
  const [visibleMonth, setVisibleMonth] = useState(monthOf(today));
  const currentMonth = useRef(visibleMonth);
  currentMonth.current = visibleMonth;
  const [selectedDate, setSelectedDate] = useState(today);
  const [search, setSearch] = useState("");
  const [bookings, setBookings] = useState<ReservedLesson[]>([]);
  const [blocks, setBlocks] = useState<BookingBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingCompletion, setPendingCompletion] = useState<ReservedLesson | null>(null);
  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const [blockStart, setBlockStart] = useState(600);
  const [blockEnd, setBlockEnd] = useState(660);
  const [blockSubmitting, setBlockSubmitting] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  const loadMonth = useCallback(async () => {
    const month = visibleMonth;
    setLoading(true);
    setError(null);
    try {
      const [bookingResult, blockResult] = await Promise.all([
        apiFetch<{ bookings: ReservedLesson[] }>(`/api/bookings?month=${month}`),
        apiFetch<{ blocks: BookingBlock[] }>(`/api/booking-blocks?month=${month}`)
      ]);
      if (currentMonth.current !== month) return;
      setBookings(bookingResult.bookings);
      setBlocks(blockResult.blocks);
    } catch (caught) {
      if (currentMonth.current !== month) return;
      setBookings([]);
      setBlocks([]);
      setError(caught instanceof Error ? caught.message : "예약 일정을 불러오지 못했습니다.");
    } finally {
      if (currentMonth.current === month) setLoading(false);
    }
  }, [visibleMonth]);

  useEffect(() => { loadMonth(); }, [loadMonth]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const bookingsByDate = useMemo(() => {
    const grouped: Record<string, ReservedLesson[]> = {};
    for (const booking of bookings) (grouped[booking.bookingDate] ??= []).push(booking);
    return grouped;
  }, [bookings]);

  const selectedBookings = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const rows = bookingsByDate[selectedDate] ?? [];
    if (!keyword) return rows;
    return rows.filter((booking) => booking.name.toLowerCase().includes(keyword) || booking.phone.includes(keyword));
  }, [bookingsByDate, search, selectedDate]);
  const selectedBlocks = useMemo(
    () => blocks.filter((block) => block.blockDate === selectedDate),
    [blocks, selectedDate]
  );

  function moveMonth(amount: number) {
    const nextMonth = shiftMonth(visibleMonth, amount);
    setVisibleMonth(nextMonth);
    setSelectedDate(`${nextMonth}-01`);
  }

  function moveToToday() {
    setVisibleMonth(monthOf(today));
    setSelectedDate(today);
  }

  async function completeReservation(booking: ReservedLesson) {
    setSubmittingId(booking.id);
    setError(null);
    try {
      const { sessions } = await apiFetch<{ sessions: SessionRow[] }>(`/api/cycles/${booking.cycleId}/sessions`);
      const nextPending = sessions.filter((session) => session.status === "pending").sort((a, b) => a.session_index - b.session_index)[0];
      if (!nextPending) throw new Error("남은 회차가 없습니다.");
      await apiFetch(`/api/bookings/${booking.id}/complete`, {
        method: "POST", body: JSON.stringify({ sessionIndex: nextPending.session_index })
      });
      setBookings((current) => current.map((item) =>
        item.id === booking.id ? { ...item, status: "completed", remain: Math.max(0, item.remain - 1) } : item
      ));
      setToast(`${booking.name}님의 수업을 완료 처리했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "예약 처리에 실패했습니다.");
      await loadMonth();
    } finally {
      setSubmittingId(null);
    }
  }

  async function confirmCompletion() {
    if (!pendingCompletion) return;
    const booking = pendingCompletion;
    setPendingCompletion(null);
    await completeReservation(booking);
  }

  async function createBlock() {
    setBlockSubmitting(true);
    setBlockError(null);
    try {
      await apiFetch("/api/booking-blocks", {
        method: "POST",
        body: JSON.stringify({ date: selectedDate, startMinute: blockStart, endMinute: blockEnd })
      });
      setBlockModalOpen(false);
      setToast("예약 차단 시간을 저장했습니다.");
      await loadMonth();
    } catch (caught) {
      setBlockError(caught instanceof Error ? caught.message : "예약 차단에 실패했습니다.");
    } finally {
      setBlockSubmitting(false);
    }
  }

  async function deleteBlock(block: BookingBlock) {
    if (!confirm(`${formatTime(block.startMinute)}~${formatTime(block.endMinute)} 차단을 해제할까요?`)) return;
    try {
      await apiFetch(`/api/booking-blocks/${block.id}`, { method: "DELETE" });
      setBlocks((current) => current.filter((item) => item.id !== block.id));
      setToast("예약 차단을 해제했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "예약 차단 해제에 실패했습니다.");
    }
  }

  function openBlockModal() {
    setBlockStart(600);
    setBlockEnd(660);
    setBlockError(null);
    setBlockModalOpen(true);
  }

  const cells = calendarCells(visibleMonth);
  const [year, month] = visibleMonth.split("-").map(Number);
  const selectedCount = (bookingsByDate[selectedDate] ?? []).length;

  return (
    <div className="app-page schedule-page">
      <header className="app-page-header schedule-page-header">
        <div><h1>수업 일정</h1>
        <p>월별 예약과 수업 진행 상태를 확인하고 관리하세요.</p>
        </div>
      </header>

      <section className="schedule-calendar-card" aria-label={`${year}년 ${month}월 수업 일정`}>
        <div className="schedule-calendar-toolbar">
          <div className="schedule-month-nav">
            <button type="button" className="secondary calendar-nav-button" onClick={() => moveMonth(-1)} aria-label="이전 달">‹</button>
            <h2>{year}년 {month}월</h2>
            <button type="button" className="secondary calendar-nav-button" onClick={() => moveMonth(1)} aria-label="다음 달">›</button>
          </div>
          <button type="button" className="secondary today-button" onClick={moveToToday}>오늘</button>
        </div>

        <div className="schedule-weekdays" aria-hidden="true">
          {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
        </div>
        <div className="schedule-calendar-grid">
          {cells.map((cell, index) => {
            if (!cell) return <span className="schedule-calendar-empty" key={`empty-${index}`} />;
            const dayBookings = bookingsByDate[cell.date] ?? [];
            const dayBlockCount = blocks.filter((block) => block.blockDate === cell.date).length;
            const selected = cell.date === selectedDate;
            const isToday = cell.date === today;
            return (
              <button type="button" key={cell.date}
                className={`schedule-day${selected ? " selected" : ""}${isToday ? " today" : ""}`}
                onClick={() => setSelectedDate(cell.date)} aria-pressed={selected}
                aria-label={`${cell.date}, 예약 ${dayBookings.length}건`}>
                <span className="schedule-day-number">{cell.day}</span>
                {dayBookings.length > 0 && (
                  <span className="schedule-day-bookings">
                    {dayBookings.slice(0, 2).map((booking) => (
                      <span className="schedule-day-preview" key={booking.id}>{formatTime(booking.startMinute)} {booking.name}</span>
                    ))}
                    <span className="schedule-day-count">{dayBookings.length > 2 ? `+${dayBookings.length - 2}` : `${dayBookings.length}건`}</span>
                  </span>
                )}
                {dayBlockCount > 0 && <span className="schedule-day-block-count">차단 {dayBlockCount}건</span>}
              </button>
            );
          })}
        </div>
        {loading && <div className="schedule-calendar-loading">일정을 불러오는 중...</div>}
      </section>

      <section className="schedule-list-card">
        <div className="schedule-list-header">
          <div><h2>{selectedDateLabel(selectedDate)}</h2><p>{selectedCount}개의 예약</p></div>
          <div className="schedule-list-tools">
            <input value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder="예약자 이름 또는 전화번호 검색" aria-label="선택한 날짜 예약 검색" />
            <button type="button" onClick={openBlockModal} disabled={selectedDate < today}>예약 시간 차단</button>
          </div>
        </div>

        {selectedBlocks.length > 0 && (
          <div className="schedule-blocks">
            <h3>차단 시간</h3>
            {selectedBlocks.map((block) => (
              <div className="schedule-block-row" key={block.id}>
                <div>
                  <strong>{formatTime(block.startMinute)} ~ {formatTime(block.endMinute)}</strong>
                  <span>{Math.round((block.endMinute - block.startMinute) / 30) / 2}시간 차단</span>
                </div>
                <button type="button" className="secondary" onClick={() => deleteBlock(block)}>해제</button>
              </div>
            ))}
          </div>
        )}

        {error ? <p className="state-message error">{error}</p>
          : !loading && selectedBookings.length === 0
            ? <p className="state-message">{search.trim() && selectedCount > 0 ? "검색 결과가 없습니다." : "예약된 수업이 없습니다."}</p>
            : (
              <ul className="schedule-booking-list">
                {selectedBookings.map((booking) => (
                  <li key={booking.id} className="schedule-booking-row">
                    <div className="schedule-booking-time">{formatTime(booking.startMinute)} ~ {formatTime(booking.startMinute + booking.durationMinutes)}</div>
                    <div className="schedule-booking-person"><strong>{booking.name}</strong><span>{booking.phone} · {booking.productName ?? `${booking.plan ?? ""}회권`} · 잔여 {booking.remain}회</span></div>
                    <div className="schedule-booking-action">
                      {booking.status === "completed" ? <span className="booking-completed-status">✓ 완료</span> : (
                        <button type="button" className="secondary" disabled={submittingId === booking.id}
                          onClick={() => setPendingCompletion(booking)}>
                          {submittingId === booking.id ? "처리 중..." : "수업 완료 처리"}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
      </section>

      <Modal open={pendingCompletion !== null} onClose={() => setPendingCompletion(null)} title="수업 완료 확인">
        {pendingCompletion && <>
          <p style={{ margin: "4px 0 6px" }}><strong>{formatTime(pendingCompletion.startMinute)} · {pendingCompletion.name}</strong></p>
          <p style={{ color: "var(--text-sub)", fontSize: 13, margin: "0 0 20px" }}>이 예약을 수업 완료로 처리하고 1회 차감할까요?</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="secondary" style={{ flex: 1 }} onClick={() => setPendingCompletion(null)}>취소</button>
            <button type="button" style={{ flex: 1 }} onClick={confirmCompletion}>완료 처리</button>
          </div>
        </>}
      </Modal>
      <Modal open={blockModalOpen} onClose={() => setBlockModalOpen(false)} title="예약 시간 차단">
        <p className="block-modal-date">{selectedDateLabel(selectedDate)}</p>
        <div className="block-time-grid">
          <label>시작 시간
            <select value={blockStart} onChange={(event) => {
              const nextStart = Number(event.target.value);
              setBlockStart(nextStart);
              if (blockEnd <= nextStart) setBlockEnd(Math.min(1380, nextStart + 60));
            }}>
              {Array.from({ length: 26 }, (_, index) => 600 + index * 30).map((minute) =>
                <option value={minute} key={minute}>{formatTime(minute)}</option>)}
            </select>
          </label>
          <label>종료 시간
            <select value={blockEnd} onChange={(event) => setBlockEnd(Number(event.target.value))}>
              {Array.from({ length: 26 }, (_, index) => 630 + index * 30).filter((minute) => minute > blockStart).map((minute) =>
                <option value={minute} key={minute}>{formatTime(minute)}</option>)}
            </select>
          </label>
        </div>
        <div className="block-range-summary">
          <span>차단할 시간</span>
          <strong>{formatTime(blockStart)} ~ {formatTime(blockEnd)}</strong>
        </div>
        <p className="block-modal-help">이 시간과 겹치는 수업은 회원이 예약할 수 없습니다. 기존 예약이 있으면 저장되지 않습니다.</p>
        {blockError && <p className="block-modal-error" role="alert">{blockError}</p>}
        <div className="block-modal-actions">
          <button type="button" className="secondary" onClick={() => setBlockModalOpen(false)} disabled={blockSubmitting}>취소</button>
          <button type="button" onClick={createBlock} disabled={blockSubmitting || blockEnd <= blockStart}>{blockSubmitting ? "저장 중..." : "차단하기"}</button>
        </div>
      </Modal>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
