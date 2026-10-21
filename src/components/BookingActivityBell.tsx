"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface BookingActivity {
  id: number;
  member_name: string;
  action: "created" | "cancelled";
  booking_date: string;
  start_minute: number;
  cancellation_charged: boolean;
  read_at: string | null;
}

interface ActivityPage { items: BookingActivity[]; total: number; unread: number }

const startTimeLabel = (minutes: number) => {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour < 12 ? "오전" : "오후"} ${hour % 12 || 12}시${minute ? ` ${minute}분` : ""}`;
};
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
const bookingDateLabel = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")} (${weekdays[new Date(year, month - 1, day).getDay()]})`;
};
export function BookingActivityBell() {
  const root = useRef<HTMLDivElement>(null);
  const markingRead = useRef(false);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BookingActivity[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await apiFetch<ActivityPage>("/api/booking-activity");
      if (markingRead.current) return;
      setItems(result.items);
      setTotal(result.total);
      setUnread(result.unread);
      setError("");
    } catch {
      setError("예약 알림을 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  async function openPanel() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (markingRead.current) return;
    markingRead.current = true;
    const readAt = new Date().toISOString();
    setUnread(0);
    setItems(current => current.map(item => ({ ...item, read_at: item.read_at ?? readAt })));
    setBusy(true);
    let failed = false;
    try {
      await apiFetch("/api/booking-activity", { method: "PATCH", body: JSON.stringify({ all: true }) });
    } catch {
      failed = true;
    } finally {
      markingRead.current = false;
      await refresh();
      if (failed) setError("확인 처리에 실패했습니다. 다시 시도해주세요.");
      setBusy(false);
    }
  }

  async function loadMore() {
    setBusy(true);
    try {
      const result = await apiFetch<ActivityPage>(`/api/booking-activity?offset=${items.length}`);
      setItems(current => [...current, ...result.items]);
      setTotal(result.total);
      setUnread(result.unread);
      setError("");
    } catch {
      setError("이전 알림을 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="booking-activity" ref={root}>
    <button type="button" className="booking-activity-trigger" aria-label={`예약 알림, 미확인 ${unread}건`} aria-expanded={open} aria-controls="booking-activity-panel" onClick={() => void openPanel()}>
      <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" />
      </svg>
      {unread > 0 && <span className="booking-activity-count">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && <section id="booking-activity-panel" className="booking-activity-panel" aria-label="예약 알림">
      <header><strong>예약 알림</strong></header>
      {error && <p role="alert" className="booking-activity-error">{error}</p>}
      {items.length === 0 ? <p className="booking-activity-empty">예약 알림이 없습니다.</p> : <div className="booking-activity-list">
        {items.map(item => <article key={item.id} className={`booking-activity-item${item.read_at ? "" : " unread"}`}>
          <span className={`booking-activity-icon ${item.action}`} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="5.5" width="17" height="15" rx="2" /><path d="M7.5 3.5v4M16.5 3.5v4M3.5 9.5h17" />
              {item.action === "created" ? <path d="m8.5 15 2 2 4.5-4.5" /> : <path d="m9 13 5 5m0-5-5 5" />}
            </svg>
          </span>
          <div className="booking-activity-item-content">
            <div className="booking-activity-item-title"><strong>{item.member_name}</strong>님이 예약{item.action === "created" ? "했어요" : "을 취소했어요"}</div>
            <p className="booking-activity-item-detail">{bookingDateLabel(item.booking_date)} · {startTimeLabel(item.start_minute)}{item.action === "cancelled" && item.cancellation_charged && <span className="booking-activity-charge">횟수 차감</span>}</p>
          </div>
        </article>)}
      </div>}
      {items.length < total && <button type="button" className="booking-activity-more" disabled={busy} onClick={() => void loadMore()}>이전 알림 더 보기</button>}
    </section>}
  </div>;
}
