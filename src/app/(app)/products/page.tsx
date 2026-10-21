"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Modal } from "@/components/Modal";
import { LessonProduct, ProductKind, validateProduct, WEEKDAYS } from "@/lib/lesson-products";

type Draft = Omit<LessonProduct, "id" | "version"> & { id?: number; version?: number };
const initial: Draft = { kind: "solo", name: "", class_id: null, session_count: 4, group_count: null, valid_weeks: 5, price: 0, duration_minutes: 60, active: true, schedules: [] };
export default function ProductsPage() {
  const [products, setProducts] = useState<LessonProduct[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"active" | "inactive">("active");
  const closeEditor = useCallback(() => { if (!busy) setDraft(null); }, [busy]);
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await apiFetch<{ products: LessonProduct[] }>("/api/products?all=true"); setProducts(r.products); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "수강권을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  function edit(product?: LessonProduct) {
    setDraft(product ? { ...product, schedules: product.schedules.map(s => ({ ...s, start_time: s.start_time?.slice(0, 5) ?? "" })) } : { ...initial });
    setFormError(""); setNotice("");
  }
  async function save() {
    const validation = validateProduct(draft);
    if (validation) return setFormError(validation);
    setBusy(true); setFormError("");
    try {
      await apiFetch("/api/products", { method: "POST", body: JSON.stringify(draft) });
      setView(draft!.active ? "active" : "inactive");
      setDraft(null); setNotice("저장했습니다. 변경한 조건은 다음 구매부터 적용됩니다."); await load();
    } catch (e) { setFormError(e instanceof Error ? e.message : "저장에 실패했습니다."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!draft?.id || !draft.can_delete || !window.confirm(`「${draft.name}」 수강권을 삭제할까요?`)) return;
    setBusy(true); setFormError("");
    try {
      await apiFetch("/api/products", { method: "DELETE", body: JSON.stringify({ id: draft.id, version: draft.version }) });
      setDraft(null); setNotice("수강권을 삭제했습니다."); await load();
    } catch (e) { setFormError(e instanceof Error ? e.message : "삭제에 실패했습니다."); }
    finally { setBusy(false); }
  }
  const kinds: Record<ProductKind, string> = { solo: "개인레슨", group: "단체레슨", package: "패키지" };
  const visibleProducts = products.filter(p => p.active === (view === "active"));
  return <div className="app-page">
    <header className="app-page-header"><div><h1>수강권 관리</h1><p>상품과 수업 시간표를 직접 관리하세요.</p></div><button onClick={() => edit()}>수강권 추가</button></header>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="state-message error">{error}<button className="secondary" onClick={() => void load()}>다시 시도</button></p>}
    <div className="product-view-tabs" aria-label="수강권 판매 상태">
      <button type="button" aria-pressed={view === "active"} onClick={() => setView("active")}>판매 중 <span>{products.filter(p => p.active).length}</span></button>
      <button type="button" aria-pressed={view === "inactive"} onClick={() => setView("inactive")}>판매 중단 <span>{products.filter(p => !p.active).length}</span></button>
    </div>
    {loading ? <p>불러오는 중…</p> : visibleProducts.length === 0 ? <p className="product-empty">{view === "active" ? "판매 중인 수강권이 없습니다." : "판매 중단한 수강권이 없습니다."}</p> : <div className="product-groups">{(Object.keys(kinds) as ProductKind[]).map(kind => {
      const items = visibleProducts.filter(p => p.kind === kind);
      if (items.length === 0) return null;
      return <section className="product-group" key={kind} aria-labelledby={`product-group-${kind}`}>
        <h2 id={`product-group-${kind}`}>{kinds[kind]} <span>{items.length}</span></h2>
        {items.length === 0 ? <p className="product-empty">등록된 수강권이 없습니다.</p> : items.map(p => <article className="product-row" key={p.id}>
          <div className="product-identity"><h3>{p.name}</h3><p>{p.kind === "group" ? p.schedules.map(s => `${WEEKDAYS[s.weekday]} ${s.start_time?.slice(0, 5) ?? "시간 미설정"}`).join(" · ") + " · 1회 수업 " : p.kind === "package" ? "개인 수업 " : "1회 수업 "}{p.duration_minutes}분</p></div>
          <div className="product-terms"><span>{p.kind === "package" ? `개인 ${p.session_count}회 + 단체 ${p.group_count}회` : `${p.session_count}회`}</span><span>{p.valid_weeks}주</span></div>
          <span className={`product-sale-status${p.active ? "" : " inactive"}`}>{p.active ? "판매 중" : "판매 중단"}</span>
          <button className="secondary product-edit" onClick={() => edit(p)} aria-label={`${p.name} 수정`}>수정</button>
        </article>)}
      </section>;
    })}</div>}
    <Modal open={draft !== null} onClose={closeEditor} title={draft?.id ? "수강권 수정" : "수강권 추가"}>
      {draft && <form className="product-form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={busy}>
          <label>수강 종류<span className="product-select"><select value={draft.kind} disabled={!!draft.id} onChange={e => { const kind = e.target.value as ProductKind; setDraft({ ...draft, kind, group_count: kind === "package" ? 4 : null, schedules: [] }); }}>{Object.entries(kinds).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></span></label>
          <label>수강권 이름<input required maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>가격 (원)<input type="number" min={0} max={2147483647} step={1} required value={draft.price} onChange={e => setDraft({ ...draft, price: Number(e.target.value) })} /></label>
          <label>{draft.kind === "package" ? "개인 수업 횟수" : "수업 횟수"}<input type="number" min={1} max={365} required value={draft.session_count} onChange={e => setDraft({ ...draft, session_count: Number(e.target.value) })} /></label>
          {draft.kind === "package" && <label>단체 수업 횟수<input type="number" min={1} max={365} required value={draft.group_count ?? 4} onChange={e => setDraft({ ...draft, group_count: Number(e.target.value) })} /></label>}
          <label>유효기간 (주)<input type="number" min={1} max={104} required value={draft.valid_weeks} onChange={e => setDraft({ ...draft, valid_weeks: Number(e.target.value) })} /></label>
          <label>{draft.kind === "package" ? "개인 수업 길이 (분)" : "1회 수업 길이 (분)"}<input type="number" min={1} max={360} required value={draft.duration_minutes} onChange={e => setDraft({ ...draft, duration_minutes: Number(e.target.value) })} /></label>
          {draft.kind === "group" && <fieldset><legend>요일 · 시작시간</legend>{WEEKDAYS.map((day, weekday) => {
            const schedule = draft.schedules.find(s => s.weekday === weekday);
            return <div className="product-schedule" key={day}><label className="product-checkbox"><input type="checkbox" checked={!!schedule} onChange={e => setDraft({ ...draft, schedules: e.target.checked ? [...draft.schedules, { weekday, start_time: "19:00" }] : draft.schedules.filter(s => s.weekday !== weekday) })} />{day}</label>
              {schedule && <input type="time" aria-label={`${day} 시작시간`} required value={schedule.start_time} onChange={e => setDraft({ ...draft, schedules: draft.schedules.map(s => s.weekday === weekday ? { ...s, start_time: e.target.value } : s) })} />}</div>;
          })}</fieldset>}
          <label>판매 상태<span className="product-select"><select value={String(draft.active)} onChange={e => setDraft({ ...draft, active: e.target.value === "true" })}><option value="true">판매 중</option><option value="false">판매 중단</option></select></span></label>
        </fieldset>
        <p className="product-policy">기존 구매 조건은 변경되지 않습니다.{draft.kind === "group" && " 기존 회원의 이전 시간표는 수강 기간 동안 유지됩니다."}</p>
        {formError && <p className="state-message error" role="alert">{formError}</p>}
        <div className="product-options">{draft.can_delete && <button type="button" className="secondary product-delete" disabled={busy} onClick={() => void remove()}>삭제</button>}<button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}>취소</button><button disabled={busy}>{busy ? "저장 중…" : "저장"}</button></div>
      </form>}
    </Modal>
  </div>;
}
