-- 기존 기본 수강권은 이전 구매 이력이 상품 ID 없이 저장되어 있으므로 삭제하지 않는다.
alter table lesson_products add column is_seeded boolean not null default false;
update lesson_products set is_seeded = true;

create function delete_unsold_lesson_product(p_id bigint, p_version integer)
returns void language plpgsql as $$
declare v_product lesson_products%rowtype;
begin
  perform pg_advisory_xact_lock(824001);
  select * into v_product from lesson_products where id = p_id for update;
  if not found or v_product.version is distinct from p_version then
    raise exception 'VALIDATION_ERROR: 수강권이 변경되었습니다. 새로고침 후 다시 시도해주세요' using errcode = '22023';
  end if;
  if v_product.is_seeded
    or exists (select 1 from enrollment_cycles where product_id = p_id)
    or (v_product.class_id is not null and exists (select 1 from enrollments where class_id = v_product.class_id)) then
    raise exception 'VALIDATION_ERROR: 구매 이력이 있거나 기본 수강권은 삭제할 수 없습니다' using errcode = '22023';
  end if;
  delete from lesson_products where id = p_id;
  if v_product.class_id is not null then
    delete from classes where id = v_product.class_id;
  end if;
end;
$$;
revoke all on function delete_unsold_lesson_product(bigint,integer) from public,anon;
grant execute on function delete_unsold_lesson_product(bigint,integer) to authenticated,service_role;
