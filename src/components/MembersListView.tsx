// src/components/MembersListView.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { NewMemberModal } from "@/components/NewMemberModal";
import { soloStatusText, groupStatusText, isFixedTermCycle, type CycleLike } from "@/lib/business-rules";

type KindFilter = "전체" | "개인" | "단체";

interface MemberCycle {
  id: string;
  status: "active" | "completed" | "expired";
  plan: number | null;
  product_name: string | null;
  duration_minutes: number;
  valid_weeks: number | null;
  total_count: number;
  used_count: number;
  valid_end_date: string | null;
  next_due_date: string | null;
}

interface MemberEnrollment {
  id: string;
  kind: "solo" | "group";
  status: "active" | "ended";
  class_id: number | null;
  package_id: string | null;
  classes: { name: string } | null;
  enrollment_cycles: MemberCycle[];
}

interface MemberItem {
  id: number;
  name: string;
  phone: string;
  enrollments: MemberEnrollment[];
}

const PAGE_SIZE = 10;

function getActiveEnrollments(member: MemberItem): MemberEnrollment[] {
  return member.enrollments.filter((e) => e.status === "active");
}

function getActiveCycle(enrollment: MemberEnrollment): MemberCycle | null {
  return enrollment.enrollment_cycles.find((c) => c.status === "active") ?? null;
}

function toCycleLike(enrollment: MemberEnrollment, cycle: MemberCycle): CycleLike {
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

function CurrentEnrollmentCell({ member }: { member: MemberItem }) {
  const enrollments = getActiveEnrollments(member);
  if (enrollments.length === 0) return <span style={{ color: "var(--text-mute)" }}>-</span>;

  return (
    <div className="badge-stack">
      {enrollments.map((enrollment) => {
        const cycle = getActiveCycle(enrollment);
        return (
          <span key={enrollment.id}>
            {enrollment.kind === "solo" ? (
              <span className={cycle?.plan ? `badge plan-${cycle.plan}` : "badge mute"}>
                {cycle?.product_name ?? `개인 ${cycle?.plan ?? cycle?.total_count ?? "-"}회권`}
              </span>
            ) : (
              <span className="badge type-group">단체 {cycle?.product_name ?? enrollment.classes?.name ?? "-"}</span>
            )}
            {enrollment.package_id != null && (
              <span className="badge mute" style={{ marginLeft: 6 }}>
                스타터 패키지
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function StatusCell({ member }: { member: MemberItem }) {
  const enrollments = getActiveEnrollments(member);
  const withCycle = enrollments
    .map((enrollment) => ({ enrollment, cycle: getActiveCycle(enrollment) }))
    .filter((x): x is { enrollment: MemberEnrollment; cycle: MemberCycle } => x.cycle !== null);

  if (withCycle.length === 0) return <span style={{ color: "var(--text-mute)" }}>수강 없음</span>;

  return (
    <div className="badge-stack">
      {withCycle.map(({ enrollment, cycle }) => {
        const like = toCycleLike(enrollment, cycle);
        const status = isFixedTermCycle(like) ? soloStatusText(like) : groupStatusText(like);
        return (
          <span key={enrollment.id} className="member-status-text">
            {status.text}
          </span>
        );
      })}
    </div>
  );
}

interface MembersListViewProps {
  title: string;
  /** 서버 API의 status 쿼리 파라미터. 'active'=활성 수강권 보유, 'withdrawn'=활성 수강권 없음 */
  statusFilter: "active" | "withdrawn";
  /** 탈퇴 회원 화면은 조회 전용이라 신규 등록 버튼을 숨긴다 */
  showAddButton?: boolean;
  emptyMessage: string;
}

export function MembersListView({ title, statusFilter, showAddButton = false, emptyMessage }: MembersListViewProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("전체");
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<MemberItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const kindParam = kindFilter === "전체" ? "" : kindFilter === "개인" ? "solo" : "group";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status: statusFilter, page: String(page), pageSize: String(PAGE_SIZE) });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (kindParam) params.set("kind", kindParam);

      const res = await apiFetch<{ items: MemberItem[]; total: number }>(`/api/members?${params.toString()}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (e: any) {
      setError(e.message ?? "회원 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, debouncedSearch, kindParam, page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="app-page">
      <header className="app-page-header">
        <div>
          <h1>{title}</h1>
          <p>{statusFilter === "active" ? "수강 중인 회원을 조회하고 관리하세요." : "수강이 종료된 회원 이력을 확인하세요."}</p>
        </div>
      </header>

      <div className="member-directory">
        <div className="member-list-toolbar">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="이름 또는 연락처로 검색"
            className="member-list-search"
          />

          <div className="filter-tabs">
            {(["전체", "개인", "단체"] as KindFilter[]).map((k) => (
              <button
                key={k}
                className={`filter-tab${kindFilter === k ? " active" : ""}`}
                onClick={() => {
                  setKindFilter(k);
                  setPage(1);
                }}
              >
                {k === "전체" ? "전체" : k === "개인" ? "개인레슨" : "단체레슨"}
              </button>
            ))}
          </div>

          {showAddButton && (
            <button className="member-add-button" onClick={() => setShowAddModal(true)}>
              + 회원 등록
            </button>
          )}
        </div>

        <div className="member-table-shell">
          {loading ? (
            <p className="state-message">불러오는 중...</p>
          ) : error ? (
            <p className="state-message error">{error}</p>
          ) : items.length === 0 ? (
            <p className="state-message">{emptyMessage}</p>
          ) : (
          <table>
            <thead>
              <tr>
                <th>회원</th>
                <th>현재수강</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {items.map((member) => (
                <tr
                  key={member.id}
                  data-clickable="true"
                  tabIndex={0}
                  aria-label={`${member.name} 회원 상세 보기`}
                  onClick={() => router.push(`/members/${member.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(`/members/${member.id}`);
                    }
                  }}
                >
                  <td>
                    <div className="member-identity-cell">
                      <span><strong>{member.name}</strong><small>{member.phone}</small></span>
                    </div>
                  </td>
                  <td>
                    <CurrentEnrollmentCell member={member} />
                  </td>
                  <td>
                    <StatusCell member={member} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>

        <div className="list-footer">
          <p>
            총 {total}명 · {page}/{totalPages}페이지
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
      </div>

      {showAddButton && showAddModal && (
        <NewMemberModal
          open
          onClose={() => setShowAddModal(false)}
          onSuccess={(memberId) => router.push(`/members/${memberId}`)}
        />
      )}
    </div>
  );
}
