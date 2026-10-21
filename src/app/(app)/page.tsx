// src/app/(app)/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { RenewSoloModal } from "@/components/RenewSoloModal";
import { RenewGroupModal } from "@/components/RenewGroupModal";
import { BookingActivityBell } from "@/components/BookingActivityBell";

type Tone = "danger" | "warning" | "muted";
type CardFilter = "unpaid" | "unsent";
type TypeFilter = "전체" | "개인" | "단체";

interface EnrollmentListItem {
  cycleId: string;
  enrollmentId: string;
  memberId: number;
  memberName: string;
  kind: "solo" | "group";
  className: string | null;
  classId: number | null;
  label: string;
  statusText: string;
  tone: Tone;
  remain: number;
  total: number;
  notifyStatus: "pending" | "sent" | "skipped" | "failed" | "not_required";
  notifyDate: string | null;
}

const PAGE_SIZE = 8;

function toneColor(tone: Tone) {
  if (tone === "danger") return "var(--danger)";
  if (tone === "warning") return "var(--warning)";
  return "var(--success)";
}

function NotiBadge({ status }: { status: EnrollmentListItem["notifyStatus"] }) {
  if (status === "sent") return <span className="noti sent">✓ 발송됨</span>;
  if (status === "failed") return <span className="noti failed">⚠ 발송 실패</span>;
  if (status === "pending") return <span className="noti none">발송 대기</span>;
  return <span className="noti none">-</span>;
}

async function fetchTodayGroupCount(): Promise<number> {
  try {
    const { classes } = await apiFetch<{ classes: { id: number; name: string }[] }>("/api/classes");
    const todayWeekday = new Date().getDay();
    const todayStr = new Date().toISOString().slice(0, 10);
    let count = 0;

    for (const cls of classes) {
      const { schedules } = await apiFetch<{ schedules: { id: number; weekday: number }[] }>(
        `/api/classes/${cls.id}/schedules`
      );
      const todaySchedules = schedules.filter((s) => s.weekday === todayWeekday);
      if (!todaySchedules.length) continue;

      const { items } = await apiFetch<{ items: { scheduleIds: number[] }[] }>(
        `/api/attendance?className=${encodeURIComponent(cls.name)}&date=${todayStr}`
      );
      count += items.filter((i) => todaySchedules.some(s => i.scheduleIds.includes(s.id))).length;
    }
    return count;
  } catch {
    return 0;
  }
}

export default function HomePage() {
  const [cardFilter, setCardFilter] = useState<CardFilter>("unpaid");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("전체");
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<EnrollmentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unpaidCount, setUnpaidCount] = useState<number | null>(null);
  const [unsentCount, setUnsentCount] = useState<number | null>(null);
  const [todayGroupCount, setTodayGroupCount] = useState<number | null>(null);
  const [totalMembers, setTotalMembers] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [renewSolo, setRenewSolo] = useState<EnrollmentListItem | null>(null);
  const [renewGroup, setRenewGroup] = useState<EnrollmentListItem | null>(null);

  const typeParam = typeFilter === "전체" ? "" : typeFilter === "개인" ? "solo" : "group";

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: cardFilter,
        page: String(page),
        pageSize: String(PAGE_SIZE)
      });
      if (typeParam) params.set("type", typeParam);

      const res = await apiFetch<{ items: EnrollmentListItem[]; total: number }>(
        `/api/enrollments?${params.toString()}`
      );
      setItems(res.items);
      setTotal(res.total);
    } catch (e: any) {
      setError(e.message ?? "목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [cardFilter, typeParam, page]);

  const loadMetrics = useCallback(async () => {
    try {
      const [unpaid, unsent, todayCount, members] = await Promise.all([
        apiFetch<{ total: number }>("/api/enrollments?status=unpaid&pageSize=1"),
        apiFetch<{ total: number }>("/api/enrollments?status=unsent&pageSize=1"),
        fetchTodayGroupCount(),
        apiFetch<{ total: number }>("/api/members?pageSize=1")
      ]);
      setUnpaidCount(unpaid.total);
      setUnsentCount(unsent.total);
      setTodayGroupCount(todayCount);
      setTotalMembers(members.total);
    } catch {
      // 메트릭 실패는 화면 전체를 막지 않는다 — 카드에 '-'만 남는다
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  function refreshAll() {
    loadList();
    loadMetrics();
  }

  async function handleEnd(item: EnrollmentListItem) {
    if (!confirm(`${item.memberName}님의 "${item.label}" 수강을 종료 처리할까요?`)) return;
    try {
      await apiFetch(`/api/enrollments/${item.enrollmentId}/end`, { method: "POST", body: JSON.stringify({}) });
      refreshAll();
    } catch (e: any) {
      alert(e.message ?? "처리에 실패했습니다.");
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="app-page home-page">
      <div className="app-toolbar"><BookingActivityBell /></div>
      <header className="app-page-header">
        <div>
          <h1>결제 확인</h1>
          <p>결제가 필요한 회원을 확인하고 관리하세요.</p>
        </div>
        <div className="page-header-stat" aria-label={`결제 확인 필요 회원 ${unpaidCount ?? "-"}명`}>
          <strong>{unpaidCount ?? "-"}</strong>
          <span>확인 필요</span>
        </div>
      </header>

      <div className="filter-tabs page-filter-tabs">
        {(["전체", "개인", "단체"] as TypeFilter[]).map((t) => (
          <button
            key={t}
            className={`filter-tab${typeFilter === t ? " active" : ""}`}
            onClick={() => {
              setTypeFilter(t);
              setPage(1);
            }}
          >
            {t === "전체" ? "전체" : t === "개인" ? "개인레슨" : "단체레슨"}
          </button>
        ))}
      </div>

      <div className="due-table-wrap">
        {loading ? (
          <p className="state-message">불러오는 중...</p>
        ) : error ? (
          <p className="state-message error">{error}</p>
        ) : items.length === 0 ? (
          <p className="state-message">해당하는 항목이 없습니다.</p>
        ) : (
          <>
            <div className="due-table-head">
              <div>회원명</div>
              <div>수강권</div>
              <div>상태</div>
              <div>알림톡</div>
              <div style={{ textAlign: "right" }}>처리</div>
            </div>
            {items.map((item) => (
              <div className="due-table-row" key={item.cycleId}>
                <div className="due-cell">
                  <span className="due-cell-name">{item.memberName}</span>
                  <span className="due-sub">{item.kind === "solo" ? "개인" : "단체"}</span>
                </div>
                <div className="due-cell">
                  <span>{item.label}</span>
                  <span className="due-sub" style={{ color: toneColor(item.tone) }}>
                    {item.statusText}
                  </span>
                </div>
                <div>
                  <span className="badge danger">
                    <span className="badge-dot" />
                    결제 필요
                  </span>
                </div>
                <div>
                  <NotiBadge status={item.notifyStatus} />
                </div>
                <div className="due-actions">
                  <button onClick={() => (item.kind === "solo" ? setRenewSolo(item) : setRenewGroup(item))}>
                    결제 확인
                  </button>
                  <button className="secondary" style={{ color: "var(--danger)" }} onClick={() => handleEnd(item)}>
                    종료
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="list-footer">
        <p>
          총 {total}건 · {page}/{totalPages}페이지
        </p>
        <div className="btns">
          <button className="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            이전
          </button>
          <button className="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            다음
          </button>
        </div>
      </div>

      {renewSolo && (
        <RenewSoloModal
          open
          onClose={() => setRenewSolo(null)}
          onSuccess={refreshAll}
          enrollmentId={renewSolo.enrollmentId}
          memberName={renewSolo.memberName}
          currentRemain={renewSolo.remain}
        />
      )}
      {renewGroup && (
        <RenewGroupModal
          open
          onClose={() => setRenewGroup(null)}
          onSuccess={refreshAll}
          enrollmentId={renewGroup.enrollmentId}
          memberName={renewGroup.memberName}
          className={renewGroup.className ?? ""}
          classId={renewGroup.classId!}
        />
      )}
    </div>
  );
}
