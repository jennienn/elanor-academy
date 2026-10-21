create table booking_activity (
  id bigint generated always as identity primary key,
  booking_id uuid not null references solo_bookings(id) on delete cascade,
  member_id bigint not null references members(id) on delete cascade,
  member_name text not null,
  action text not null check (action in ('created', 'cancelled')),
  booking_date date not null,
  start_minute integer not null,
  duration_minutes integer not null,
  cancellation_charged boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (booking_id, action)
);

create index booking_activity_recent on booking_activity(created_at desc, id desc);
create index booking_activity_unread on booking_activity(id) where read_at is null;
alter table booking_activity enable row level security;
create policy booking_activity_operator_read on booking_activity for select to authenticated using (true);
create policy booking_activity_operator_ack on booking_activity for update to authenticated using (true) with check (true);
grant select, update(read_at) on booking_activity to authenticated;
grant all on booking_activity to service_role;
grant usage, select on sequence booking_activity_id_seq to service_role;

create function record_booking_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'created';
  elsif old.status = 'confirmed' and new.status = 'cancelled' then
    v_action := 'cancelled';
  else
    return new;
  end if;

  insert into booking_activity (
    booking_id, member_id, member_name, action, booking_date,
    start_minute, duration_minutes, cancellation_charged
  )
  select new.id, new.member_id, m.name, v_action, new.booking_date,
    new.start_minute, new.duration_minutes, new.cancellation_charged
  from members m where m.id = new.member_id;
  return new;
end;
$$;

create trigger solo_booking_activity
after insert or update of status on solo_bookings
for each row execute function record_booking_activity();

revoke all on function record_booking_activity() from public, anon, authenticated;
