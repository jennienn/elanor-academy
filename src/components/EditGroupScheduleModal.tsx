// src/components/EditGroupScheduleModal.tsx
"use client";

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { apiFetch } from "@/lib/api-client";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

interface ClassSchedule {
  id: number;
  active: boolean;
  weekday: number;
  start_time: string | null;
  curriculum_group: string | null;
}

export function EditGroupScheduleModal({
  open,
  onClose,
  onSuccess,
  cycleId,
  classId,
  className,
  currentScheduleIds
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  cycleId: string;
  classId: number;
  className: string;
  currentScheduleIds: number[];
}) {
  const [schedules, setSchedules] = useState<ClassSchedule[]>([]);
  const [scheduleIds, setScheduleIds] = useState<number[]>(currentScheduleIds);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiFetch<{ schedules: ClassSchedule[] }>(`/api/classes/${classId}/schedules`)
      .then((res) => setSchedules(res.schedules.filter(s => s.active || currentScheduleIds.includes(s.id))))
      .catch(() => setError("요일 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }, [classId, currentScheduleIds]);

  function toggle(id: number) {
    setScheduleIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  async function handleSubmit() {
    if (scheduleIds.length === 0) {
      setError("요일을 하나 이상 선택해주세요.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/cycles/${cycleId}/schedules`, {
        method: "POST",
        body: JSON.stringify({ scheduleIds })
      });
      onSuccess();
      onClose();
    } catch (e: any) {
      setError(e.message ?? "변경에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="요일 변경">
      <p style={{ fontSize: 13, color: "var(--text-sub)", margin: 0 }}>{className}</p>

      {loading ? (
        <p className="state-message">불러오는 중...</p>
      ) : (
        <>
          <label style={labelStyle}>요일</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {schedules.map((s) => (
              <button
                key={s.id}
                type="button"
                className={scheduleIds.includes(s.id) ? "" : "secondary"}
                style={{ padding: "6px 12px" }}
                onClick={() => toggle(s.id)}
              >
                {WEEKDAY_LABELS[s.weekday]} {s.start_time?.slice(0, 5)}{!s.active ? " (기존)" : ""}
              </button>
            ))}
            {schedules.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--text-mute)", margin: 0 }}>등록된 요일이 없습니다.</p>
            )}
          </div>
        </>
      )}

      {error && <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button className="secondary" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
          취소
        </button>
        <button style={{ flex: 1 }} onClick={handleSubmit} disabled={submitting || loading}>
          {submitting ? "저장 중..." : "저장"}
        </button>
      </div>
    </Modal>
  );
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--text-sub)", margin: "12px 0 4px" };
