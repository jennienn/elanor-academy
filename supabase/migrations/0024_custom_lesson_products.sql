-- 상품 변경은 다음 구매부터 적용한다. 구매 당시 조건과 시간표는 별도로 보존한다.
create table lesson_products (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('solo','group','package')),
  name text not null check (length(trim(name)) between 1 and 80),
  class_id bigint references classes(id),
  session_count integer not null check (session_count between 1 and 365),
  group_count integer check (group_count between 1 and 365),
  valid_weeks integer not null check (valid_weeks between 1 and 104),
  price integer not null check (price >= 0),
  duration_minutes integer not null default 60 check (duration_minutes between 1 and 360),
  active boolean not null default true,
  version integer not null default 1,
  constraint product_class_kind check ((kind = 'group') = (class_id is not null)),
  constraint product_package_count check ((kind = 'package') = (group_count is not null))
);
create unique index lesson_products_class on lesson_products(class_id) where class_id is not null;
alter table lesson_products enable row level security;
create policy authenticated_full_access on lesson_products for all to authenticated using (true) with check (true);
grant select, insert, update, delete on lesson_products to authenticated, service_role;
grant usage, select on sequence lesson_products_id_seq to authenticated, service_role;

alter table class_schedules add column active boolean not null default true;
alter table class_schedules add column duration_minutes integer not null default 60 check (duration_minutes between 1 and 360);
alter table class_schedules drop constraint class_schedules_class_id_weekday_key;
create unique index class_schedules_current_weekday on class_schedules(class_id, weekday) where active;
-- 기존 예약 충돌 규칙에서 사용하던 시간으로 초기화한다.
update class_schedules s set start_time = case when c.name = 'kpop반' then time '20:00' else time '11:00' end
from classes c where c.id=s.class_id and c.name in ('kpop반','다이어트 댄스반') and s.start_time is null;

insert into lesson_products(kind,name,session_count,valid_weeks,price)
values ('solo','개인 4회권',4,5,0),('solo','개인 8회권',8,9,0),('solo','개인 12회권',12,13,0);
insert into lesson_products(kind,name,class_id,session_count,valid_weeks,price,active)
select 'group',name,id,8,5,0,active from classes;
insert into lesson_products(kind,name,session_count,group_count,valid_weeks,price)
values ('package','스타터 패키지',2,4,3,0);

alter table enrollment_cycles drop constraint enrollment_cycles_plan_check;
alter table enrollment_cycles add constraint enrollment_cycles_plan_check check (plan > 0);
alter table enrollment_cycles add column product_id bigint references lesson_products(id);
alter table enrollment_cycles add column product_name text;
alter table enrollment_cycles add column duration_minutes integer not null default 60 check (duration_minutes between 1 and 360);
update enrollment_cycles ec set product_name = case
 when e.package_id is not null then '스타터 패키지' || case when e.kind='group' then ' · ' || c.name else '' end
 when e.kind='solo' then '개인 ' || coalesce(ec.plan,ec.base_count)::text || '회권' else c.name end
from enrollments e left join classes c on c.id=e.class_id where ec.enrollment_id=e.id;

alter table solo_bookings add column duration_minutes integer not null default 60 check (duration_minutes between 1 and 360);
alter table solo_bookings drop constraint solo_bookings_no_overlap;
alter table solo_bookings add constraint solo_bookings_no_overlap
 exclude using gist (booking_date with =, int4range(start_minute,start_minute+duration_minutes,'[)') with &&) where (status='confirmed');

create function group_schedule_ranges(p_date date)
returns table(start_minute integer,end_minute integer) language sql stable as $$
 select distinct extract(hour from s.start_time)::int*60+extract(minute from s.start_time)::int,
 extract(hour from s.start_time)::int*60+extract(minute from s.start_time)::int+s.duration_minutes
 from class_schedules s join classes c on c.id=s.class_id
 where s.start_time is not null and s.weekday=extract(dow from p_date) and (
  (s.active and c.active) or exists (
   select 1 from cycle_schedules cs join enrollment_cycles ec on ec.id=cs.cycle_id join enrollments e on e.id=ec.enrollment_id
   where cs.schedule_id=s.id and ec.status='active' and e.status='active' and p_date>=ec.payment_date
    and p_date<=coalesce(ec.valid_end_date,ec.next_due_date,fixed_term_valid_end(ec.payment_date,ec.valid_weeks))
  )
 ); $$;
revoke all on function group_schedule_ranges(date) from public,anon;
grant execute on function group_schedule_ranges(date) to authenticated,service_role;

create function save_lesson_product(p_id bigint, p_version integer, p_product jsonb, p_schedules jsonb)
returns bigint language plpgsql as $$
declare v_id bigint; v_class bigint; v_old lesson_products%rowtype; v_kind text := p_product->>'kind'; v_new_schedules jsonb; v_old_schedules jsonb;
begin
  perform pg_advisory_xact_lock(824001);
  if p_id is not null then
    select * into v_old from lesson_products where id=p_id for update;
    if not found or v_old.version is distinct from p_version then
      raise exception 'VALIDATION_ERROR: 다른 작업에서 변경된 수강권입니다. 새로고침 후 다시 시도해주세요' using errcode='22023';
    end if;
    if v_old.kind is distinct from v_kind then raise exception 'VALIDATION_ERROR: 수강 종류는 변경할 수 없습니다' using errcode='22023'; end if;
    v_class := v_old.class_id;
  end if;
  if v_kind='group' then
    if jsonb_typeof(p_schedules) is distinct from 'array' or jsonb_array_length(p_schedules)=0 then
      raise exception 'VALIDATION_ERROR: 단체반 시간표를 입력해주세요' using errcode='22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_schedules) x where (x->>'weekday')::int not between 0 and 6
      or (x->>'start_time') is null or extract(epoch from (x->>'start_time')::time)/60 + (p_product->>'duration_minutes')::int > 1440) then
      raise exception 'VALIDATION_ERROR: 시간표를 확인해주세요' using errcode='22023';
    end if;
    if v_class is null then
      insert into classes(name) values (trim(p_product->>'name')) returning id into v_class;
    else
      update classes set name=trim(p_product->>'name') where id=v_class;
    end if;
  end if;
  if p_id is null then
    insert into lesson_products(kind,name,class_id,session_count,group_count,valid_weeks,price,duration_minutes,active)
    values (v_kind,trim(p_product->>'name'),v_class,(p_product->>'session_count')::int,(p_product->>'group_count')::int,
      (p_product->>'valid_weeks')::int,(p_product->>'price')::int,(p_product->>'duration_minutes')::int,(p_product->>'active')::boolean)
    returning id into v_id;
  else
    update lesson_products set name=trim(p_product->>'name'),session_count=(p_product->>'session_count')::int,
      group_count=(p_product->>'group_count')::int,valid_weeks=(p_product->>'valid_weeks')::int,price=(p_product->>'price')::int,
      duration_minutes=(p_product->>'duration_minutes')::int,active=(p_product->>'active')::boolean,version=version+1
    where id=p_id returning id into v_id;
  end if;
  if v_kind='group' then
    select jsonb_agg(jsonb_build_object('weekday',weekday,'start_time',to_char(start_time,'HH24:MI'),'duration_minutes',duration_minutes) order by weekday)
      into v_old_schedules from class_schedules where class_id=v_class and active;
    select jsonb_agg(jsonb_build_object('weekday',(x->>'weekday')::int,'start_time',to_char((x->>'start_time')::time,'HH24:MI'),
      'duration_minutes',(p_product->>'duration_minutes')::int) order by (x->>'weekday')::int)
      into v_new_schedules from jsonb_array_elements(p_schedules) x;
    if v_old_schedules is distinct from v_new_schedules then
      -- 사용 중인 시간표는 수정/삭제하지 않아 기존 출석과 구매 조건을 유지한다.
      update class_schedules set active=false where class_id=v_class and active;
      insert into class_schedules(class_id,weekday,start_time,duration_minutes,curriculum_group)
      select v_class,(x->>'weekday')::int,(x->>'start_time')::time,(p_product->>'duration_minutes')::int,
        (select curriculum_group from class_schedules old where old.class_id=v_class and old.weekday=(x->>'weekday')::int order by old.id desc limit 1)
      from jsonb_array_elements(p_schedules) x;
    end if;
    update classes set active=(p_product->>'active')::boolean where id=v_class;
  end if;
  if v_kind='group' and exists (
    select 1 from solo_bookings b cross join lateral group_schedule_ranges(b.booking_date) r
    where b.status='confirmed' and b.booking_date >= (now() at time zone 'Asia/Seoul')::date
    and int4range(b.start_minute,b.start_minute+b.duration_minutes,'[)') && int4range(r.start_minute,r.end_minute,'[)')
  ) then raise exception 'VALIDATION_ERROR: 기존 개인레슨 예약과 겹치는 시간표입니다. 예약 시간을 먼저 조정해주세요' using errcode='22023'; end if;
  return v_id;
end; $$;
revoke all on function save_lesson_product(bigint,integer,jsonb,jsonb) from public,anon;
grant execute on function save_lesson_product(bigint,integer,jsonb,jsonb) to authenticated,service_role;

create function purchase_lesson_product(
 p_product_id bigint, p_version integer, p_member_id bigint, p_name text, p_phone text,
 p_enrollment_id uuid, p_schedule_ids bigint[], p_class_id bigint, p_method text, p_payment_date date
) returns table(member_id bigint,enrollment_id uuid,cycle_id uuid,total_count integer,package_id uuid)
language plpgsql as $$
declare v_product lesson_products%rowtype; v_enrollment enrollments%rowtype; v_current enrollment_cycles%rowtype;
 v_member bigint := p_member_id; v_enrollment_id uuid; v_cycle uuid; v_group_enrollment uuid; v_group_cycle uuid;
 v_package uuid; v_carry integer := 0; v_class bigint; v_schedules bigint[] := p_schedule_ids;
begin
 select * into v_product from lesson_products where id=p_product_id for share;
 if not found or not v_product.active then raise exception 'VALIDATION_ERROR: 판매 중인 수강권을 선택해주세요' using errcode='22023'; end if;
 if v_product.version is distinct from p_version then raise exception 'VALIDATION_ERROR: 수강권 조건이 변경되었습니다. 다시 선택해주세요' using errcode='22023'; end if;
 if p_payment_date is null or p_method is null or p_method not in ('card','cash','transfer') then
  raise exception 'VALIDATION_ERROR: 결제 정보를 확인해주세요' using errcode='22023'; end if;
 v_class := case when v_product.kind='group' then v_product.class_id when v_product.kind='package' then p_class_id end;
 if p_enrollment_id is not null then
  select * into v_enrollment from enrollments where id=p_enrollment_id for update;
  if not found or v_enrollment.kind<>v_product.kind or v_enrollment.package_id is not null or v_product.kind='package'
   or v_enrollment.class_id is distinct from v_class then
   raise exception 'VALIDATION_ERROR: 같은 종류와 반의 수강권으로 재등록해주세요' using errcode='22023'; end if;
  v_member := v_enrollment.member_id; v_enrollment_id := v_enrollment.id;
  select * into v_current from enrollment_cycles where enrollment_cycles.enrollment_id=v_enrollment_id and status='active' for update;
  if not found then raise exception 'VALIDATION_ERROR: 활성 수강권을 찾을 수 없습니다' using errcode='22023'; end if;
  if v_product.kind='solo' then v_carry:=greatest(0,v_current.total_count-v_current.used_count); end if;
 end if;
 if v_product.kind in ('group','package') then
  perform 1 from classes where id=v_class and active;
  if not found or coalesce(cardinality(v_schedules),0)=0 then raise exception 'VALIDATION_ERROR: 반과 요일을 선택해주세요' using errcode='22023'; end if;
  if exists(select 1 from unnest(v_schedules) sid left join class_schedules cs on cs.id=sid and cs.class_id=v_class and cs.active where cs.id is null) then
   raise exception 'VALIDATION_ERROR: 현재 판매 중인 시간표를 다시 선택해주세요' using errcode='22023'; end if;
 end if;
 if v_member is null then
  if nullif(trim(p_name),'') is null or nullif(trim(p_phone),'') is null then raise exception 'VALIDATION_ERROR: 이름과 연락처를 입력해주세요' using errcode='22023'; end if;
  insert into members(name,phone) values(trim(p_name),trim(p_phone)) returning id into v_member;
 end if;
 if v_product.kind='package' then
  insert into enrollment_packages(member_id,valid_weeks,amount,method,payment_date)
  values(v_member,v_product.valid_weeks,v_product.price,p_method,p_payment_date) returning id into v_package;
 end if;
 if v_enrollment_id is null then
  insert into enrollments(member_id,kind,class_id,package_id)
  values(v_member,case when v_product.kind='package' then 'solo' else v_product.kind end,
   case when v_product.kind='group' then v_class end,v_package) returning id into v_enrollment_id;
 else
  update enrollment_cycles set status='completed' where id=v_current.id;
  update enrollments set status='active',ended_date=null,end_reason=null where id=v_enrollment_id;
 end if;
 insert into enrollment_cycles(enrollment_id,plan,base_count,carry_over_count,total_count,used_count,payment_date,
  next_due_date,valid_weeks,product_id,product_name,duration_minutes)
 values(v_enrollment_id,case when v_product.kind='solo' then v_product.session_count end,v_product.session_count,v_carry,
  v_product.session_count+v_carry,0,p_payment_date,case when v_product.kind='group' then p_payment_date+v_product.valid_weeks*7 end,
  v_product.valid_weeks,v_product.id,v_product.name,v_product.duration_minutes) returning id into v_cycle;
 if v_product.kind in ('solo','package') then
  insert into sessions(cycle_id,session_index,status) select v_cycle,n,'pending' from generate_series(1,v_product.session_count+v_carry)n;
 else
  insert into cycle_schedules(cycle_id,schedule_id) select v_cycle,sid from unnest(v_schedules)sid;
 end if;
 if v_product.kind='package' then
  insert into enrollments(member_id,kind,class_id,package_id) values(v_member,'group',v_class,v_package) returning id into v_group_enrollment;
  insert into enrollment_cycles(enrollment_id,base_count,total_count,used_count,payment_date,valid_weeks,product_id,product_name,duration_minutes)
  values(v_group_enrollment,v_product.group_count,v_product.group_count,0,p_payment_date,v_product.valid_weeks,v_product.id,v_product.name || ' · ' || (select name from classes where id=v_class),v_product.duration_minutes)
  returning id into v_group_cycle;
  insert into cycle_schedules(cycle_id,schedule_id) select v_group_cycle,sid from unnest(v_schedules)sid;
 else
  insert into payments(cycle_id,amount,method,payment_date,status,purchased_count)
  values(v_cycle,v_product.price,p_method,p_payment_date,'completed',v_product.session_count);
 end if;
 member_id:=v_member; enrollment_id:=v_enrollment_id; cycle_id:=v_cycle; total_count:=v_product.session_count+v_carry; package_id:=v_package;
 return next;
end; $$;
revoke all on function purchase_lesson_product(bigint,integer,bigint,text,text,uuid,bigint[],bigint,text,date) from public,anon;
grant execute on function purchase_lesson_product(bigint,integer,bigint,text,text,uuid,bigint[],bigint,text,date) to authenticated,service_role;

create or replace function create_solo_booking_block_atomic(
  p_date date, p_start_minute integer, p_end_minute integer, p_reason text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_korea_today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if p_date is null or p_date < v_korea_today
    or p_start_minute < 600 or p_end_minute > 1380
    or p_start_minute % 30 <> 0 or p_end_minute % 30 <> 0
    or p_start_minute >= p_end_minute then
    raise exception 'BLOCK_VALIDATION_ERROR' using errcode = '22023';
  end if;

  -- 같은 날짜의 예약 생성과 차단 생성을 직렬화해 동시 요청 경합을 막는다.
  perform pg_advisory_xact_lock(hashtext('solo_booking:' || p_date::text));

  if exists (
    select 1 from solo_bookings
    where booking_date = p_date and status = 'confirmed'
      and int4range(start_minute, start_minute + duration_minutes, '[)')
        && int4range(p_start_minute, p_end_minute, '[)')
  ) then
    raise exception 'BLOCK_BOOKING_CONFLICT' using errcode = '22023';
  end if;

  insert into solo_booking_blocks(block_date, start_minute, end_minute, reason)
  values(p_date, p_start_minute, p_end_minute, nullif(trim(p_reason), ''))
  returning id into v_id;
  return v_id;
exception when exclusion_violation then
  raise exception 'BLOCK_OVERLAP' using errcode = '23P01';
end;
$$;

revoke all on function create_solo_booking_block_atomic(date,integer,integer,text) from public, anon;
grant execute on function create_solo_booking_block_atomic(date,integer,integer,text) to authenticated, service_role;


create or replace function create_solo_booking_atomic(p_cycle_id uuid, p_date date, p_start_minute integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_cycle enrollment_cycles%rowtype; v_member bigint; v_end date; v_id uuid; v_weekday integer;
  v_korea_now timestamp := now() at time zone 'Asia/Seoul'; v_minimum_start integer;
begin
  perform pg_advisory_xact_lock_shared(824001);
  select ec.* into v_cycle from enrollment_cycles ec join enrollments e on e.id=ec.enrollment_id
  where ec.id=p_cycle_id and ec.status='active' and e.status='active' and e.kind='solo' for update of ec;
  if not found then raise exception 'NOT_FOUND: 활성 개인레슨 수강권이 없습니다' using errcode='P0002'; end if;
  select e.member_id into v_member from enrollments e where e.id=v_cycle.enrollment_id;
  v_end := coalesce(v_cycle.valid_end_date, fixed_term_valid_end(v_cycle.payment_date, v_cycle.valid_weeks));
  if p_date < greatest(v_korea_now::date, v_cycle.payment_date) or p_date > v_end then
    raise exception 'BOOKING_DATE_INVALID' using errcode='22023';
  end if;
  if p_start_minute < 600 or p_start_minute > 1320 or p_start_minute + v_cycle.duration_minutes > 1380 or p_start_minute % 30 <> 0 then
    raise exception 'BOOKING_TIME_INVALID' using errcode='22023';
  end if;
  -- 같은 날짜의 차단 생성과 예약 생성을 직렬화해 검사 직후 삽입되는 경합을 막는다.
  perform pg_advisory_xact_lock(hashtext('solo_booking:' || p_date::text));
  if p_date = v_korea_now::date then
    v_minimum_start := extract(hour from v_korea_now)::integer * 60 + extract(minute from v_korea_now)::integer + 120;
    if p_start_minute < v_minimum_start then raise exception 'BOOKING_ADVANCE_NOTICE_REQUIRED' using errcode='22023'; end if;
  end if;
  if exists (
    select 1 from solo_booking_blocks
    where block_date = p_date
      and int4range(start_minute, end_minute, '[)') && int4range(p_start_minute, p_start_minute + v_cycle.duration_minutes, '[)')
  ) then
    raise exception 'BOOKING_BLOCKED' using errcode='22023';
  end if;
  if exists (select 1 from group_schedule_ranges(p_date) r
    where int4range(p_start_minute,p_start_minute+v_cycle.duration_minutes,'[)') && int4range(r.start_minute,r.end_minute,'[)')) then
    raise exception 'GROUP_CLASS_OVERLAP' using errcode='22023';
  end if;
  if (select count(*) from solo_bookings where cycle_id=p_cycle_id and booking_date=p_date and status in ('confirmed','completed')) >= 2 then
    raise exception 'SAME_DAY_BOOKING_LIMIT' using errcode='22023';
  end if;
  if (select count(*) from solo_bookings where cycle_id=p_cycle_id and status='confirmed') >= v_cycle.total_count-v_cycle.used_count then
    raise exception 'NO_REMAINING_BOOKINGS' using errcode='22023';
  end if;
  insert into solo_bookings(cycle_id,member_id,booking_date,start_minute,duration_minutes)
  values(p_cycle_id,v_member,p_date,p_start_minute,v_cycle.duration_minutes) returning id into v_id;
  return v_id;
exception when exclusion_violation then raise exception 'BOOKING_CONFLICT' using errcode='23P01';
end;
$$;

revoke all on function create_solo_booking_atomic(uuid,date,integer) from public, anon;
grant execute on function create_solo_booking_atomic(uuid,date,integer) to service_role;

-- 기존 회원의 요일 변경도 현재 판매 시간표 또는 본인의 기존 시간표 안에서만 허용한다.
create or replace function replace_cycle_schedules_atomic(p_cycle_id uuid,p_schedule_ids bigint[])
returns void language plpgsql as $$
declare v_class bigint;
begin
 select e.class_id into v_class from enrollment_cycles ec join enrollments e on e.id=ec.enrollment_id
 where ec.id=p_cycle_id and ec.status='active' for update of ec;
 if v_class is null or coalesce(cardinality(p_schedule_ids),0)=0 then
  raise exception 'VALIDATION_ERROR: 활성 단체 수강권과 요일을 확인해주세요' using errcode='22023'; end if;
 if exists(select 1 from unnest(p_schedule_ids) sid left join class_schedules s on s.id=sid and s.class_id=v_class
  and (s.active or exists(select 1 from cycle_schedules cs where cs.cycle_id=p_cycle_id and cs.schedule_id=s.id)) where s.id is null)
  or (select count(distinct weekday) from class_schedules where id=any(p_schedule_ids)) <> cardinality(p_schedule_ids) then
  raise exception 'VALIDATION_ERROR: 요일마다 하나의 유효한 시간표를 선택해주세요' using errcode='22023'; end if;
 delete from cycle_schedules where cycle_id=p_cycle_id;
 insert into cycle_schedules(cycle_id,schedule_id) select p_cycle_id,sid from unnest(p_schedule_ids)sid;
end; $$;
