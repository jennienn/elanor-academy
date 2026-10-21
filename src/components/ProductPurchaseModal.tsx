"use client";
import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { apiFetch } from "@/lib/api-client";
import { koreaDateString, addCalendarDays } from "@/lib/business-rules";
import { formatPhoneInput, isValidMemberPhone, PHONE_FORMAT_MESSAGE } from "@/lib/phone";
import { notificationsEnabled } from "@/lib/notification-config";
import { LessonProduct, ProductKind, WEEKDAYS } from "@/lib/lesson-products";

interface Props {
  open: boolean; onClose: () => void; onSuccess: (memberId: number) => void; title: string;
  memberId?: number; enrollmentId?: string; initialKind?: "solo" | "group"; classId?: number; currentRemain?: number;
}
export function ProductPurchaseModal(props: Props) {
  const [products, setProducts] = useState<LessonProduct[]>([]);
  const [kind, setKind] = useState<ProductKind>(props.initialKind ?? "solo");
  const [productId, setProductId] = useState<number | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [scheduleIds, setScheduleIds] = useState<number[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState("card");
  const [paymentDate, setPaymentDate] = useState(koreaDateString());
  const [sendNotification, setSendNotification] = useState(notificationsEnabled());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const newMember = !props.memberId && !props.enrollmentId;
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<{ products: LessonProduct[] }>("/api/products").then(async r => {
      if (cancelled) return;
      setProducts(r.products); setError("");
      if (props.enrollmentId && props.initialKind === "group") {
        const current = r.products.find(p => p.kind === "group" && p.class_id === props.classId);
        if (!current) return;
        const history = await apiFetch<{ cycles: { status: string; cycle_schedules: { class_schedules: { weekday: number } }[] }[] }>(`/api/enrollments/${props.enrollmentId}/cycles`);
        if (cancelled) return;
        const weekdays = history.cycles.find(c => c.status === "active")?.cycle_schedules.map(s => s.class_schedules.weekday) ?? [];
        setProductId(current.id);
        setScheduleIds(current.schedules.filter(s => weekdays.includes(s.weekday)).map(s => s.id!));
      }
    }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.open, props.enrollmentId, props.initialKind, props.classId]);
  const options = products.filter(p => p.kind === kind && (props.classId == null || p.class_id === props.classId));
  const selected = options.find(p => p.id === productId);
  const group = kind === "group" ? selected : products.find(p => p.id === groupId && p.kind === "group");
  const schedules = group?.schedules ?? [];
  async function submit() {
    if (newMember && !name.trim()) return setError("이름을 입력해주세요.");
    if (newMember && !isValidMemberPhone(phone)) return setError(PHONE_FORMAT_MESSAGE);
    if (!selected) return setError("수강권을 선택해주세요.");
    if (kind !== "solo" && (!group || !scheduleIds.length)) return setError("반과 요일을 선택해주세요.");
    setBusy(true); setError("");
    try {
      const result = await apiFetch<{ memberId: number }>("/api/products/purchase", { method: "POST", body: JSON.stringify({
        productId: selected.id, version: selected.version, memberId: props.memberId, enrollmentId: props.enrollmentId,
        name: name.trim(), phone, classId: group?.class_id, scheduleIds, method, paymentDate, sendNotification
      }) });
      props.onSuccess(result.memberId); props.onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "등록에 실패했습니다."); }
    finally { setBusy(false); }
  }
  return <Modal open={props.open} onClose={busy ? () => {} : props.onClose} title={props.title}>
    <form noValidate className="product-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {newMember && <><label>이름<input placeholder="홍길동" value={name} onChange={e => setName(e.target.value)} required /></label>
        <label>연락처<input value={phone} onChange={e => setPhone(formatPhoneInput(e.target.value))} required placeholder="010-0000-0000" /></label></>}
      {!props.enrollmentId && <div className="product-options">{(["solo", "group", "package"] as const).map(k => <button type="button" key={k} className={kind === k ? "" : "secondary"}
        onClick={() => { setKind(k); setProductId(null); setScheduleIds([]); }}>{k === "solo" ? "개인레슨" : k === "group" ? "단체레슨" : "패키지"}</button>)}</div>}
      <fieldset disabled={loading || busy}><legend>수강권 선택</legend><div className="product-options">
        {options.map(p => <button type="button" key={p.id} className={selected?.id === p.id ? "" : "secondary"} onClick={() => { setProductId(p.id); setScheduleIds([]); }}>{p.name}</button>)}
      </div></fieldset>
      {loading ? <p>불러오는 중…</p> : !options.length && <p>판매 중인 수강권이 없습니다. 수강권 관리에서 추가해주세요.</p>}
      {selected && <div className="product-summary">
        <strong>{selected.price.toLocaleString()}원</strong><p>{kind === "package" ? `개인 ${selected.session_count}회 + 단체 ${selected.group_count}회` : `${selected.session_count}회`} · {selected.valid_weeks}주 · {kind === "package" ? "개인 수업 " : "1회 "}{selected.duration_minutes}분</p>
        <small>{kind === "group" ? "결제일부터 적용" : "첫 수업일부터 유효기간 적용"}</small>
        {props.enrollmentId && kind === "solo" && <p>기존 잔여 {props.currentRemain ?? 0}회 이월 → 등록 후 잔여 {selected.session_count + (props.currentRemain ?? 0)}회</p>}
        {kind === "group" && paymentDate && <p>다음 결제 예정일 {addCalendarDays(paymentDate, selected.valid_weeks * 7)}</p>}
      </div>}
      {kind === "package" && <label>단체반<select value={groupId ?? ""} onChange={e => { setGroupId(Number(e.target.value) || null); setScheduleIds([]); }} required>
        <option value="">반 선택</option>{products.filter(p => p.kind === "group").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>}
      {kind !== "solo" && group && <fieldset><legend>수강 요일</legend><div className="product-options">{schedules.map(s => <button type="button" key={s.id}
        className={scheduleIds.includes(s.id!) ? "" : "secondary"} onClick={() => setScheduleIds(ids => ids.includes(s.id!) ? ids.filter(id => id !== s.id) : [...ids, s.id!])}>
        {WEEKDAYS[s.weekday]} {s.start_time?.slice(0, 5)}
      </button>)}</div></fieldset>}
      <label>결제 수단<select value={method} onChange={e => setMethod(e.target.value)}><option value="card">카드</option><option value="transfer">계좌이체</option><option value="cash">현금</option></select></label>
      <label>결제일<input type="date" required value={paymentDate} onChange={e => setPaymentDate(e.target.value)} /></label>
      {kind !== "package" && <label className="product-checkbox"><input type="checkbox" checked={sendNotification} disabled={!notificationsEnabled()} onChange={e => setSendNotification(e.target.checked)} />{props.enrollmentId ? "재등록" : "등록"} 완료 알림톡 발송</label>}
      {error && <p role="alert" className="state-message error">{error}</p>}
      <div className="product-options"><button type="button" className="secondary" onClick={props.onClose} disabled={busy}>취소</button><button disabled={loading || busy}>{busy ? "처리 중…" : props.enrollmentId ? "결제 확인 완료" : "등록 완료"}</button></div>
    </form>
  </Modal>;
}
