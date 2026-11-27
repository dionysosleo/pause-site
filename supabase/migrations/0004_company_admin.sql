-- 기업 계정 배정 + 가입 시 자동 연결
--  company_assignments: 기업 멤버에게 배정한 수강권(초대만 하고 아직 가입 전이어도 미리 배정 가능).
--  claim_orders(): 비회원 주문 연결 + 기업 초대 연결(같은 이메일·인증 완료) + 배정된 강의 수강권 생성.
--  모든 쓰기는 서버(/api/admin/data, /api/company)만. 회원 화면에서는 직접 못 바꿈.

create table if not exists public.company_assignments (
  id          bigint generated always as identity primary key,
  member_id   bigint not null references public.company_members(id) on delete cascade,
  seat_id     bigint not null references public.company_seats(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (member_id, seat_id)
);
alter table public.company_assignments enable row level security;

-- 회사 배정 수강권은 묶음(seat)마다 하나씩
alter table public.enrollments drop constraint if exists enrollments_user_id_course_id_source_key;
create unique index if not exists enrollments_one_per_source on public.enrollments (user_id, course_id, source, coalesce(seat_id, 0));

create or replace function public.claim_orders() returns int
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  em  text;
  n   int := 0;
begin
  if uid is null then return 0; end if;
  select u.email into em from auth.users u where u.id = uid and u.email_confirmed_at is not null;
  if em is null then return 0; end if;
  -- 비회원 주문
  update orders set user_id = uid
   where user_id is null and detached_at is null and lower(buyer_email) = lower(em) and status in ('paid','partial_refunded');
  insert into enrollments (user_id, course_id, source, order_id)
  select uid, o.grants_course, 'purchase', o.id from orders o
   where o.user_id = uid and o.grants_course is not null and o.status = 'paid'
     and not exists (select 1 from enrollments e where e.user_id = uid and e.course_id = o.grants_course and e.source = 'purchase');
  -- 기업 초대
  update company_members set user_id = uid, status = 'active', joined_at = coalesce(joined_at, now())
   where user_id is null and status = 'invited' and lower(email) = lower(em);
  insert into enrollments (user_id, course_id, source, seat_id)
  select uid, s.course_id, 'company', s.id
    from company_assignments a join company_members m on m.id = a.member_id join company_seats s on s.id = a.seat_id
   where m.user_id = uid and m.status = 'active' and a.revoked_at is null and (s.expires_at is null or s.expires_at > now())
     and not exists (select 1 from enrollments e where e.user_id = uid and e.seat_id = s.id and e.revoked_at is null);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.claim_orders() from public, anon;
grant execute on function public.claim_orders() to authenticated;

-- 키트 발송 기록
alter table public.orders add column if not exists ship_tracking text;
