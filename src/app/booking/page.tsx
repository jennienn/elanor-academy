"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { apiFetch } from "@/lib/api-client";
import { bookingTimeSlots, isBookingDateWithinRange } from "@/lib/booking-rules";
import { formatPhoneInput } from "@/lib/phone";

type Booking = {
  id: string;
  booking_date: string;
  start_minute: number;
  duration_minutes: number;
  status: "confirmed" | "completed" | "cancelled";
  cancellation_charged: boolean;
  late_cancellation: boolean;
};
type Info = {
  member: { name: string };
  cycle: { plan: number; product_name: string | null; duration_minutes: number; payment_date: string; valid_end_date: string; first_bookable_date: string; remain: number };
  unavailable: number[];
  bookings: Booking[];
};

const times = bookingTimeSlots();
const formatTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const statusLabel = { confirmed: "수업 전", completed: "수업 완료", cancelled: "취소" };
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (value: number) => String(value).padStart(2, "0");

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(year, monthNumber - 1 + offset, 1);
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}`;
}

function calendarDates(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const lastDate = new Date(year, monthNumber, 0).getDate();
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day >= 1 && day <= lastDate ? `${year}-${pad(monthNumber)}-${pad(day)}` : null;
  });
}

function displayDate(value: string) {
  if (!value) return "날짜를 선택하세요";
  const [year, month, day] = value.split("-").map(Number);
  return `${year}년 ${month}월 ${day}일 (${weekdays[new Date(year, month - 1, day).getDay()]})`;
}

export default function BookingPage() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [info, setInfo] = useState<Info | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState("");

  async function load(selectedDate = "") {
    try {
      const result = await apiFetch<Info>(`/api/booking${selectedDate ? `?date=${selectedDate}` : ""}`);
      setInfo(result);
      setCalendarMonth((current) => current || result.cycle.first_bookable_date.slice(0, 7));
      setError("");
    } catch {
      setInfo(null);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await apiFetch("/api/booking/login", { method: "POST", body: JSON.stringify({ name, phone }) });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "로그인에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  async function reserve() {
    if (!date || time === null) return;
    if (!info || !isBookingDateWithinRange(date, info.cycle.first_bookable_date, info.cycle.valid_end_date)) {
      setDate("");
      setTime(null);
      setError("예약 가능한 기간 안의 날짜를 선택해주세요.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await apiFetch("/api/booking", { method: "POST", body: JSON.stringify({ date, startMinute: time }) });
      setTime(null);
      await load(date);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "예약에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(booking: Booking) {
    const message = booking.late_cancellation
      ? "취소 가능 시간이 지났습니다. 지금 취소하면 잔여 횟수 1회가 차감됩니다. 그래도 예약을 취소할까요?"
      : "이 예약을 취소할까요? 예약일 전날 오후 8시 전 취소이므로 잔여 횟수는 차감되지 않습니다.";
    if (!confirm(message)) return;
    setError("");
    setNotice("");
    try {
      const result = await apiFetch<{ charged: boolean }>(`/api/booking/${booking.id}`, { method: "DELETE" });
      setNotice(result.charged
        ? "예약이 취소되었으며, 취소 가능 시간이 지나 잔여 횟수 1회가 차감되었습니다."
        : "예약이 취소되었습니다. 잔여 횟수는 차감되지 않았습니다.");
      await load(date);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "예약 취소에 실패했습니다.");
    }
  }

  async function logout() {
    setSubmitting(true);
    try {
      await apiFetch("/api/booking/logout", { method: "POST" });
    } finally {
      setInfo(null);
      setDate("");
      setTime(null);
      setError("");
      setSubmitting(false);
    }
  }

  if (!info) {
    return (
      <main className="booking-shell booking-login-shell">
        <div className="booking-login-header">
          <div className="booking-login-brand">
            <Image src="/logo.png" alt="Élanor Dance Academy 로고" width={52} height={52} priority />
            <span>Élanor Dance Academy</span>
          </div>
          <h1>개인레슨 예약</h1>
          <p>이름과 전화번호로 간편하게 예약을 확인하세요.</p>
        </div>
        <form onSubmit={login}>
          <label>이름<input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>전화번호<input inputMode="tel" autoComplete="tel" required placeholder="010-0000-0000" value={phone} onChange={(event) => setPhone(formatPhoneInput(event.target.value))} /></label>
          <button disabled={submitting}>{submitting ? "로그인 중..." : "로그인"}</button>
        </form>
        {error && <p className="state-message error" role="alert">{error}</p>}
      </main>
    );
  }

  const confirmedCount = info.bookings.filter((booking) => booking.status === "confirmed").length;
  const noCapacity = confirmedCount >= info.cycle.remain;
  const sameDayBookingCount = info.bookings.filter(
    (booking) => booking.booking_date === date && booking.status !== "cancelled"
  ).length;
  const sameDayLimitReached = sameDayBookingCount >= 2;
  const month = calendarMonth || info.cycle.first_bookable_date.slice(0, 7);
  const firstMonth = info.cycle.first_bookable_date.slice(0, 7);
  const lastMonth = info.cycle.valid_end_date.slice(0, 7);
  const upcomingBookings = info.bookings.filter((booking) => booking.status === "confirmed");
  const pastBookings = info.bookings.filter((booking) => booking.status !== "confirmed").slice().reverse();
  const morningTimes = times.filter((slot) => slot < 720);
  const afternoonTimes = times.filter((slot) => slot >= 720);

  async function selectDate(selectedDate: string) {
    if (!isBookingDateWithinRange(selectedDate, info!.cycle.first_bookable_date, info!.cycle.valid_end_date)) return;
    setDate(selectedDate);
    setTime(null);
    setError("");
    await load(selectedDate);
  }

  function renderTimeGroup(label: string, slots: number[]) {
    return (
      <div className="reservation-time-group">
        <p>{label}</p>
        <div className="reservation-times">
          {slots.map((slot) => (
            <button
              key={slot}
              type="button"
              className={time === slot ? "selected" : ""}
              disabled={!date || noCapacity || sameDayLimitReached || info!.unavailable.includes(slot)}
              aria-pressed={time === slot}
              onClick={() => setTime(slot)}
            >
              {formatTime(slot)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderBookingList(bookings: Booking[], emptyMessage: string) {
    if (bookings.length === 0) return <p className="reservation-empty">{emptyMessage}</p>;
    return (
      <ul className="reservation-list">
        {bookings.map((booking) => (
          <li key={booking.id}>
            <div>
              <strong>{displayDate(booking.booking_date)}</strong>
              <span>{formatTime(booking.start_minute)} ~ {formatTime(booking.start_minute + booking.duration_minutes)} · {statusLabel[booking.status]}{booking.cancellation_charged ? " · 횟수 차감" : ""}</span>
            </div>
            {booking.status === "confirmed" && (
              <button type="button" onClick={() => cancel(booking)}>취소</button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <main className="reservation-page">
      <header className="reservation-header">
        <div className="reservation-brand"><Image src="/logo.png" alt="Élanor Dance Academy 로고" width={38} height={38} /><span>Élanor Dance Academy</span></div>
        <button type="button" disabled={submitting} onClick={logout}>로그아웃</button>
      </header>

      <section className="reservation-member">
        <div><h1>{info.member.name}님, 안녕하세요</h1><p>{info.cycle.product_name ?? `개인레슨 ${info.cycle.plan}회권`} 이용 중 · {info.cycle.duration_minutes}분</p></div>
        <div className="reservation-balance"><span>남은 횟수</span><strong>{info.cycle.remain}회</strong></div>
        <dl><div><dt>결제일</dt><dd>{info.cycle.payment_date}</dd></div><div><dt>이용기간</dt><dd>~ {info.cycle.valid_end_date}</dd></div></dl>
      </section>

      <section className="reservation-booker">
        <div className="reservation-section-title"><span>1</span><div><h2>날짜 선택</h2><p>{displayDate(date)}</p></div></div>
        <div className="reservation-calendar">
          <div className="reservation-calendar-nav">
            <button type="button" aria-label="이전 달" disabled={month <= firstMonth} onClick={() => setCalendarMonth(shiftMonth(month, -1))}>‹</button>
            <strong>{month.replace("-", "년 ")}월</strong>
            <button type="button" aria-label="다음 달" disabled={month >= lastMonth} onClick={() => setCalendarMonth(shiftMonth(month, 1))}>›</button>
          </div>
          <div className="reservation-weekdays">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="reservation-days">
            {calendarDates(month).map((calendarDate, index) => calendarDate ? (
              <button
                key={calendarDate}
                type="button"
                aria-label={calendarDate}
                aria-pressed={date === calendarDate}
                className={date === calendarDate ? "selected" : ""}
                disabled={!isBookingDateWithinRange(calendarDate, info.cycle.first_bookable_date, info.cycle.valid_end_date)}
                onClick={() => selectDate(calendarDate)}
              >{Number(calendarDate.slice(-2))}</button>
            ) : <span key={`empty-${index}`} />)}
          </div>
        </div>

        <div className="reservation-divider" />
        <div className="reservation-section-title"><span>2</span><div><h2>시간 선택</h2><p>{date ? "가능한 시간을 선택하세요" : "날짜를 먼저 선택하세요"}</p></div></div>
        <div className="reservation-time-area" aria-label="예약 시간">
          {renderTimeGroup("오전", morningTimes)}
          {renderTimeGroup("오후", afternoonTimes)}
        </div>
        <p className="reservation-help">회색 시간은 예약할 수 없습니다. 당일 예약은 수업 시작 2시간 전까지 가능합니다.</p>

        <div className="reservation-submit">
          <div><span>선택한 수업</span><strong>{date ? displayDate(date) : "날짜 미선택"}{time === null ? "" : ` · ${formatTime(time)}`}</strong></div>
          <button disabled={time === null || submitting || noCapacity || sameDayLimitReached} onClick={reserve}>{submitting ? "예약 중..." : "예약 완료"}</button>
        </div>
        {noCapacity && <p className="state-message">남은 횟수만큼 예약되어 추가 예약할 수 없습니다.</p>}
        {sameDayLimitReached && <p className="state-message">같은 날에는 최대 2회까지만 수강할 수 있습니다.</p>}
        {error && <p className="state-message error" role="alert">{error}</p>}
      </section>

      <section className="reservation-bookings">
        <h2>예약 내역</h2>
        {notice && <p className="state-message" role="status">{notice}</p>}
        <div className="reservation-booking-group"><h3>예정된 예약</h3>{renderBookingList(upcomingBookings, "예정된 예약이 없습니다.")}</div>
        {pastBookings.length > 0 && <div className="reservation-booking-group past"><h3>지난 내역</h3>{renderBookingList(pastBookings, "")}</div>}
        <p className="reservation-policy">예약일 전날 오후 8시 전까지 취소하면 횟수가 차감되지 않습니다. 이후 취소 시 잔여 횟수 1회가 차감됩니다.</p>
      </section>
    </main>
  );
}
