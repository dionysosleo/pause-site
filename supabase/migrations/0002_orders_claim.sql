-- 결제 → 수강권 연결
--  1) 주문에 "어떤 강의 수강권을 주는지"(grants_course)와 테스트 결제 여부(is_test)를 남긴다.
--  2) 강의 4개를 courses에 등록 (아직 영상 전이라 is_open=false, 열면 true + opened_at).
--  3) claim_orders(): 비회원으로 결제한 주문을, 같은 이메일로 가입·인증한 회원 계정에 붙이고 수강권을 만든다.
--     이메일 인증이 끝난 계정만 가져갈 수 있다 (남의 주문을 가로채지 못하게).

alter table public.orders add column if not exists grants_course text references public.courses(id);
alter table public.orders add column if not exists is_test boolean not null default false;

insert into public.courses (id, title, is_open) values
  ('ai-onboard', 'AI 입사식 키트: 클로드 세팅 + 나의 AI 파트너', false),
  ('vibe-web',   '바이브코딩으로 내 웹 만들기', false),
  ('agent-team', '혼자서 팀처럼 일하기: AI 에이전트 팀 세팅', false),
  ('tea-brand',  '하루 한 잔 홈티, 그리고 나만의 차 브랜드', false)
on conflict (id) do update set title = excluded.title;

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
   where user_id is null and lower(buyer_email) = lower(em) and status in ('paid','partial_refunded');
  insert into enrollments (user_id, course_id, source, order_id)
  select uid, o.grants_course, 'purchase', o.id
    from orders o
   where o.user_id = uid and o.grants_course is not null and o.status in ('paid','partial_refunded')
  on conflict (user_id, course_id, source) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.claim_orders() from public, anon;
grant execute on function public.claim_orders() to authenticated;
