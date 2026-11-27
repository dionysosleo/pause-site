-- 관리자(환불 처리)와 회원 탈퇴
--  1) admins: 환불 버튼을 쓸 수 있는 운영자. 행은 SQL Editor에서 직접 넣는다 (사이트에서 못 바꿈).
--  2) orders.detached_at: 탈퇴로 계정에서 떨어진 주문. 같은 이메일로 다시 가입해도 수강권을 되살리지 않는다(약관 제8조).
--  3) claim_orders(): 떨어진 주문은 다시 붙이지 않게 고침.

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;   -- 정책 없음 = 서버(secret key)만 읽음

alter table public.orders add column if not exists detached_at timestamptz;
alter table public.orders add column if not exists refund_reason text;
alter table public.orders add column if not exists refunded_at timestamptz;

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
  update orders set user_id = uid
   where user_id is null and detached_at is null and lower(buyer_email) = lower(em) and status in ('paid','partial_refunded');
  insert into enrollments (user_id, course_id, source, order_id)
  select uid, o.grants_course, 'purchase', o.id
    from orders o
   where o.user_id = uid and o.grants_course is not null and o.status = 'paid'
  on conflict (user_id, course_id, source) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.claim_orders() from public, anon;
grant execute on function public.claim_orders() to authenticated;
