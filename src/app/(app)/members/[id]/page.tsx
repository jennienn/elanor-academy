// src/app/(app)/members/[id]/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { CardMenu } from "@/components/CardMenu";
import { EditMemberModal } from "@/components/EditMemberModal";
import { AddEnrollmentModal } from "@/components/AddEnrollmentModal";
import { AddSessionModal } from "@/components/AddSessionModal";
import { EditGroupScheduleModal } from "@/components/EditGroupScheduleModal";
import { RenewSoloModal } from "@/components/RenewSoloModal";
import { RenewGroupModal } from "@/components/RenewGroupModal";
import { daysUntil, groupStatusText, isFixedTermCycle, soloStatusText, type CycleLike } from "@/lib/business-rules";

interface Payment {
  id: number;
  amount: number;
  method: "card" | "transfer" | "cash" | "other";
  payment_date: string;
  status: string;
}

interface CycleScheduleLink {
  schedule_id: number;
  class_schedules: { weekday: number; start_time: string | null; duration_minutes: number } | null;
}

interface AttendanceLog {
  date: string;
  attended: boolean;
}

interface Cycle {
  id: string;
  enrollment_id: string;
  plan: number | null;
  product_name: string | null;
  duration_minutes: number;
  valid_weeks: number | null;
  total_count: number;
  used_count: number;
  first_class_date: string | null;
  valid_end_date: string | null;
  next_due_date: string | null;
  payment_date: string;
  status: "active" | "completed" | "expired";
  notify_status: "pending" | "sent" | "skipped" | "failed" | "not_required";
  payments: Payment[];
  cycle_schedules: CycleScheduleLink[];
  attendance_logs: AttendanceLog[];
}

interface Enrollment {
  id: string;
  member_id: number;
  kind: "solo" | "group";
  class_id: number | null;
  package_id: string | null;
  status: "active" | "ended";
  classes: { name: string } | null;
  enrollment_cycles: Cycle[];
}

interface MemberDetail {
  id: number;
  name: string;
  phone: string;
  enrollments: Enrollment[];
}

interface SessionRow {
  session_index: number;
  status: "pending" | "done" | "auto";
  date: string | null;
}

function getActiveCycle(enrollment: Enrollment): Cycle | undefined {
  return enrollment.enrollment_cycles.find((c) => c.status === "active");
}

function toCycleLike(enrollment: Enrollment, cycle: Cycle): CycleLike {
  return {
    kind: enrollment.kind,
    enrollmentStatus: enrollment.status,
    cycleStatus: cycle.status,
    plan: cycle.plan,
    totalCount: cycle.total_count,
    usedCount: cycle.used_count,
    validEndDate: cycle.valid_end_date,
    nextDueDate: cycle.next_due_date,
    isFixedTerm: enrollment.package_id != null
  };
}

function PackageTag() {
  return <span className="badge mute" style={{ marginLeft: 6 }}>스타터 패키지</span>;
}

function NotiBadge({ status }: { status: Cycle["notify_status"] }) {
  if (status === "sent") return <span className="noti sent">✓ 발송 접수됨</span>;
  if (status === "failed") return <span className="noti failed">⚠ 발송 실패</span>;
  if (status === "pending") return <span className="noti none">발송 대기</span>;
  return <span className="noti none">-</span>;
}

function MemberMemo({ memberId }: { memberId: number }) {
  const [memo, setMemo] = useState("");
  const [savedMemo, setSavedMemo] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    apiFetch<{ memo: string }>(`/api/members/${memberId}/memo`)
      .then((result) => { setMemo(result.memo); setSavedMemo(result.memo); })
      .catch(() => setMessage("메모를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }, [memberId]);

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const result = await apiFetch<{ memo: string }>(`/api/members/${memberId}/memo`, {
        method: "PUT",
        body: JSON.stringify({ memo })
      });
      setMemo(result.memo);
      setSavedMemo(result.memo);
      setMessage("저장했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "메모 저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="member-memo" aria-label="운영자 메모">
      <div className="member-memo-heading">
        <div><h2>운영자 메모</h2><p>회원 상담이나 수업 관련 내용을 기록하세요.</p></div>
        <span>{memo.length}/2000</span>
      </div>
      <textarea
        value={memo}
        maxLength={2000}
        disabled={loading || saving}
        placeholder={loading ? "메모를 불러오는 중..." : "예: 무릎 부상으로 점프 동작 주의"}
        onChange={(event) => { setMemo(event.target.value); setMessage(""); }}
      />
      <div className="member-memo-footer">
        <span role="status">{message}</span>
        <button type="button" disabled={loading || saving || memo === savedMemo} onClick={save}>
          {saving ? "저장 중..." : "메모 저장"}
        </button>
      </div>
    </section>
  );
}

function formatCalendarDate(value: string): string {
  return value.replaceAll("-", ".");
}

function ExpiryChip({ validEndDate }: { validEndDate: string | null }) {
  if (!validEndDate) return null;
  const remainingDays = daysUntil(validEndDate);
  if (remainingDays < 0) return <span className="expiry-chip danger">만료</span>;
  if (remainingDays === 0) return <span className="expiry-chip warning">오늘 만료</span>;
  if (remainingDays <= 7) return <span className="expiry-chip warning">D-{remainingDays}</span>;
  return null;
}

function SoloEnrollmentCard({
  enrollment,
  cycle,
  reload,
  onAddSession,
  onRenew,
  onEnd
}: {
  enrollment: Enrollment;
  cycle: Cycle;
  reload: () => void;
  onAddSession: () => void;
  onRenew: () => void;
  onEnd: () => void;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setLoadingSessions(true);
    apiFetch<{ sessions: SessionRow[] }>(`/api/cycles/${cycle.id}/sessions`)
      .then((res) => setSessions(res.sessions))
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false));
  }, [cycle.id, cycle.used_count]);

  async function handleCancel(sessionIndex: number) {
    if (!confirm(`${sessionIndex}회차 기록을 취소할까요?`)) return;
    try {
      await apiFetch(`/api/cycles/${cycle.id}/sessions/${sessionIndex}`, { method: "DELETE" });
      reload();
    } catch (e: any) {
      alert(e.message ?? "취소에 실패했습니다.");
    }
  }

  const remain = cycle.total_count - cycle.used_count;
  const recorded = sessions
    .filter((s) => s.status !== "pending")
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const visible = showAll ? recorded : recorded.slice(0, 3);

  return (
    <div className="panel enrollment-card">
      <div className="enrollment-card-header">
        <div>
          <span className={cycle.plan ? `badge plan-${cycle.plan}` : "badge mute"}>
            {cycle.product_name ?? `개인 ${cycle.plan ?? cycle.total_count}회권`}
          </span>
          {enrollment.package_id != null && <PackageTag />}
          {enrollment.status === "ended" && (
            <span className="badge mute" style={{ marginLeft: 6 }}>
              종료됨
            </span>
          )}
        </div>
        {enrollment.status === "active" && (
          <CardMenu items={[{ label: "수강 종료", danger: true, onClick: onEnd }]} />
        )}
      </div>

      <div className="enrollment-primary">
        <p className="enrollment-primary-label">유효기간</p>
        {cycle.first_class_date && cycle.valid_end_date ? (
          <div className="validity-line">
            <p className="validity-date">
              {formatCalendarDate(cycle.first_class_date)} ~ {formatCalendarDate(cycle.valid_end_date)}
            </p>
            <ExpiryChip validEndDate={cycle.valid_end_date} />
          </div>
        ) : (
          <p className="validity-pending">첫 수업 등록 후 확정</p>
        )}

        <div className="session-summary">
          <div className="session-summary-item">
            <span>남은 회차</span>
            <strong>{remain}회</strong>
          </div>
          <div className="session-summary-item">
            <span>사용 회차</span>
            <strong>{cycle.used_count}회</strong>
          </div>
          <div className="session-summary-item">
            <span>총 회차</span>
            <strong>{cycle.total_count}회</strong>
          </div>
        </div>
      </div>

      <dl className="membership-info-rows">
        <div><dt>수업 길이 · 유효기간</dt><dd>{cycle.duration_minutes}분 · {cycle.valid_weeks ?? "-"}주</dd></div>
        <div>
          <dt>첫 수업일</dt>
          <dd>{cycle.first_class_date ?? "첫 수업 전"}</dd>
        </div>
        <div>
          <dt>마지막 결제일</dt>
          <dd>{cycle.payment_date}</dd>
        </div>
      </dl>

      <div style={{ marginTop: 16 }}>
        <p style={{ fontSize: 12, color: "var(--text-sub)", margin: "0 0 6px" }}>최근 수업 기록</p>
        {loadingSessions ? (
          <p className="state-message" style={{ padding: "8px 0" }}>
            불러오는 중...
          </p>
        ) : recorded.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-mute)", margin: 0 }}>아직 기록된 수업이 없습니다.</p>
        ) : (
          <>
            <ul className="record-list">
              {visible.map((s) => (
                <li key={s.session_index} className="record-row">
                  <span>
                    {s.session_index}회차 · {s.date}
                    {s.status === "auto" && <span style={{ color: "var(--text-mute)" }}> (만료 처리)</span>}
                  </span>
                  <button
                    className="secondary"
                    style={{ width: "auto", padding: "3px 9px", fontSize: 11 }}
                    onClick={() => handleCancel(s.session_index)}
                  >
                    취소
                  </button>
                </li>
              ))}
            </ul>
            {recorded.length > 3 && (
              <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "최근 기록만 보기" : `전체 기록 보기 (${recorded.length}건)`}
              </button>
            )}
          </>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
        <button className="secondary" style={{ width: "auto", padding: "7px 12px", fontSize: 12 }} onClick={onAddSession}>
          + 수업 기록 추가
        </button>
        {enrollment.package_id != null ? (
          <span style={{ fontSize: 12, color: "var(--text-mute)" }}>패키지 재등록은 추후 지원 예정입니다</span>
        ) : (
          <button style={{ width: "auto", padding: "7px 12px", fontSize: 12 }} onClick={onRenew}>
            결제 확인
          </button>
        )}
      </div>
    </div>
  );
}

function GroupEnrollmentCard({
  enrollment,
  cycle,
  onRenew,
  onEditSchedule,
  onEnd
}: {
  enrollment: Enrollment;
  cycle: Cycle;
  onRenew: () => void;
  onEditSchedule: () => void;
  onEnd: () => void;
}) {
  const [showAllAttendance, setShowAllAttendance] = useState(false);
  const isPackage = enrollment.package_id != null;
  const like = toCycleLike(enrollment, cycle);
  const status = isFixedTermCycle(like) ? soloStatusText(like) : groupStatusText(like);
  const toneColor =
    status.tone === "danger" ? "var(--danger)" : status.tone === "warning" ? "var(--warning)" : "var(--success)";
  const attendedDates = cycle.attendance_logs
    .filter((a) => a.attended)
    .map((a) => a.date)
    .sort((a, b) => b.localeCompare(a));
  const lastAttendance = attendedDates[0] ?? null;
  const visibleAttendanceDates = showAllAttendance ? attendedDates : attendedDates.slice(0, 3);
  const remain = cycle.total_count - cycle.used_count;

  return (
    <div className="panel enrollment-card">
      <div className="enrollment-card-header">
        <div>
          <span className="badge type-group">단체 {cycle.product_name ?? enrollment.classes?.name ?? "-"}</span>
          {isPackage && <PackageTag />}
          {enrollment.status === "ended" && (
            <span className="badge mute" style={{ marginLeft: 6 }}>
              종료됨
            </span>
          )}
        </div>
        {enrollment.status === "active" && (
          <CardMenu
            items={[
              { label: "요일 변경", onClick: onEditSchedule },
              { label: "수강 종료", danger: true, onClick: onEnd }
            ]}
          />
        )}
      </div>

      {isPackage ? (
        <div className="enrollment-primary">
          <p className="enrollment-primary-label">유효기간</p>
          {cycle.first_class_date && cycle.valid_end_date ? (
            <div className="validity-line">
              <p className="validity-date">
                {formatCalendarDate(cycle.first_class_date)} ~ {formatCalendarDate(cycle.valid_end_date)}
              </p>
              <ExpiryChip validEndDate={cycle.valid_end_date} />
            </div>
          ) : (
            <p className="validity-pending">첫 수업 등록 후 확정</p>
          )}
          <div className="session-summary">
            <div className="session-summary-item">
              <span>남은 회차</span>
              <strong>{remain}회</strong>
            </div>
            <div className="session-summary-item">
              <span>사용 회차</span>
              <strong>{cycle.used_count}회</strong>
            </div>
            <div className="session-summary-item">
              <span>총 회차</span>
              <strong>{cycle.total_count}회</strong>
            </div>
          </div>
        </div>
      ) : (
        <div className="group-billing-summary">
          <div>
            <p className="enrollment-primary-label">결제일</p>
            <p className="group-billing-date">{formatCalendarDate(cycle.payment_date)}</p>
          </div>
          <div>
            <p className="enrollment-primary-label">다음 결제 예정일</p>
            <p className="group-billing-date" style={{ color: toneColor }}>
              {cycle.next_due_date ? formatCalendarDate(cycle.next_due_date) : "-"}
              <span className="group-billing-status">{status.text}</span>
            </p>
          </div>
        </div>
      )}

      <p className="group-secondary-info">구매한 시간표: {cycle.cycle_schedules.map(link => {
        const s = link.class_schedules;
        return s ? `${["일", "월", "화", "수", "목", "금", "토"][s.weekday]} ${s.start_time?.slice(0, 5) ?? "시간 미설정"} · ${s.duration_minutes}분` : "";
      }).join(" / ")}</p>
      <p className="group-secondary-info">
        최근 출석일 <span>{lastAttendance ? formatCalendarDate(lastAttendance) : "-"}</span>
        <span className="group-info-divider">·</span>
        알림톡 <NotiBadge status={cycle.notify_status} />
      </p>

      <div style={{ marginTop: 16 }}>
        <p style={{ fontSize: 12, color: "var(--text-sub)", margin: "0 0 6px" }}>최근 출석 기록</p>
        {attendedDates.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-mute)", margin: 0 }}>아직 기록된 출석이 없습니다.</p>
        ) : (
          <>
            <ul className="record-list">
              {visibleAttendanceDates.map((attendanceDate) => (
                <li key={attendanceDate} className="record-row">
                  <span>출석 · {attendanceDate}</span>
                </li>
              ))}
            </ul>
            {attendedDates.length > 3 && (
              <button type="button" className="link-btn" onClick={() => setShowAllAttendance((current) => !current)}>
                {showAllAttendance ? "최근 기록만 보기" : `전체 기록 보기 (${attendedDates.length}건)`}
              </button>
            )}
          </>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
        {isPackage ? (
          <span style={{ fontSize: 12, color: "var(--text-mute)" }}>패키지 재등록은 추후 지원 예정입니다</span>
        ) : (
          <button style={{ width: "auto", padding: "7px 12px", fontSize: 12 }} onClick={onRenew}>
            결제 확인
          </button>
        )}
      </div>
    </div>
  );
}

export default function MemberDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const memberId = Number(params.id);

  const [member, setMember] = useState<MemberDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editMemberOpen, setEditMemberOpen] = useState(false);
  const [deletingMember, setDeletingMember] = useState(false);
  const [addEnrollmentOpen, setAddEnrollmentOpen] = useState(false);
  const [addSessionCycleId, setAddSessionCycleId] = useState<string | null>(null);
  const [editScheduleTarget, setEditScheduleTarget] = useState<{ enrollment: Enrollment; cycle: Cycle } | null>(null);
  const [renewTarget, setRenewTarget] = useState<{ enrollment: Enrollment; cycle: Cycle } | null>(null);

  const loadMember = useCallback(async () => {
    try {
      const data = await apiFetch<MemberDetail>(`/api/members/${memberId}`);
      setMember(data);
    } catch (e: any) {
      setError(e.message ?? "회원 정보를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [memberId]);

  useEffect(() => {
    loadMember();
  }, [loadMember]);

  async function handleEnd(enrollment: Enrollment) {
    if (!confirm("이 수강을 종료 처리할까요?")) return;
    try {
      await apiFetch(`/api/enrollments/${enrollment.id}/end`, { method: "POST", body: JSON.stringify({}) });
      loadMember();
    } catch (e: any) {
      alert(e.message ?? "처리에 실패했습니다.");
    }
  }

  if (loading) return <p className="state-message">불러오는 중...</p>;
  if (error || !member) return <p className="state-message error">{error ?? "회원을 찾을 수 없습니다."}</p>;

  async function handleDeleteMember() {
    const confirmed = confirm(
      `${member!.name} 회원을 삭제할까요?\n\n수강권, 결제, 수업, 출석, 알림 이력이 모두 삭제되며 복구할 수 없습니다.`
    );
    if (!confirmed) return;

    setDeletingMember(true);
    try {
      await apiFetch(`/api/members/${member!.id}`, { method: "DELETE" });
      router.replace("/members");
      router.refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "회원 삭제에 실패했습니다.");
      setDeletingMember(false);
    }
  }

  return (
    <div className="app-page member-detail-page">
      <button
        className="member-back-button"
        onClick={() => router.push("/members")}
      >
        ← 회원 목록
      </button>

      <header className="app-page-header member-detail-header">
        <div className="member-detail-identity">
          <div>
            <h1>{member.name}</h1>
            <p>{member.phone}</p>
          </div>
        </div>
        <div className="member-detail-actions">
          <button
            className="secondary"
            onClick={() => setEditMemberOpen(true)}
            disabled={deletingMember}
          >
            회원정보 수정
          </button>
          <button
            className="secondary member-delete-button"
            onClick={handleDeleteMember}
            disabled={deletingMember}
          >
            {deletingMember ? "삭제 중..." : "회원 삭제"}
          </button>
        </div>
      </header>

      <MemberMemo memberId={member.id} />

      {member.enrollments.length === 0 ? (
        <p className="state-message">등록된 수강권이 없습니다.</p>
      ) : (
        member.enrollments.map((enrollment) => {
          const cycle = getActiveCycle(enrollment);
          if (!cycle) return null;
          return enrollment.kind === "solo" ? (
            <SoloEnrollmentCard
              key={enrollment.id}
              enrollment={enrollment}
              cycle={cycle}
              reload={loadMember}
              onAddSession={() => setAddSessionCycleId(cycle.id)}
              onRenew={() => setRenewTarget({ enrollment, cycle })}
              onEnd={() => handleEnd(enrollment)}
            />
          ) : (
            <GroupEnrollmentCard
              key={enrollment.id}
              enrollment={enrollment}
              cycle={cycle}
              onRenew={() => setRenewTarget({ enrollment, cycle })}
              onEditSchedule={() => setEditScheduleTarget({ enrollment, cycle })}
              onEnd={() => handleEnd(enrollment)}
            />
          );
        })
      )}

      <button className="add-enrollment-button" onClick={() => setAddEnrollmentOpen(true)}>
        + 수강권/반 추가
      </button>

      {editMemberOpen && (
        <EditMemberModal
          open
          onClose={() => setEditMemberOpen(false)}
          onSuccess={loadMember}
          memberId={member.id}
          initialName={member.name}
          initialPhone={member.phone}
        />
      )}

      {addEnrollmentOpen && (
        <AddEnrollmentModal open onClose={() => setAddEnrollmentOpen(false)} onSuccess={loadMember} memberId={member.id} />
      )}

      {addSessionCycleId && (
        <AddSessionModal
          open
          onClose={() => setAddSessionCycleId(null)}
          onSuccess={loadMember}
          cycleId={addSessionCycleId}
        />
      )}

      {editScheduleTarget && (
        <EditGroupScheduleModal
          open
          onClose={() => setEditScheduleTarget(null)}
          onSuccess={loadMember}
          cycleId={editScheduleTarget.cycle.id}
          classId={editScheduleTarget.enrollment.class_id!}
          className={editScheduleTarget.enrollment.classes?.name ?? ""}
          currentScheduleIds={editScheduleTarget.cycle.cycle_schedules.map((cs) => cs.schedule_id)}
        />
      )}

      {renewTarget && renewTarget.enrollment.kind === "solo" && (
        <RenewSoloModal
          open
          onClose={() => setRenewTarget(null)}
          onSuccess={loadMember}
          enrollmentId={renewTarget.enrollment.id}
          memberName={member.name}
          currentRemain={renewTarget.cycle.total_count - renewTarget.cycle.used_count}
        />
      )}
      {renewTarget && renewTarget.enrollment.kind === "group" && (
        <RenewGroupModal
          open
          onClose={() => setRenewTarget(null)}
          onSuccess={loadMember}
          enrollmentId={renewTarget.enrollment.id}
          memberName={member.name}
          className={renewTarget.enrollment.classes?.name ?? ""}
          classId={renewTarget.enrollment.class_id!}
        />
      )}
    </div>
  );
}
