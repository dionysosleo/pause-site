-- 관리자 작업 기록 + 재생 화면 보조
--  admin_logs: 운영자가 한 쓰기(환불·수강권·기업·강의·발송)를 남김. 서버만 쓰고 읽음.
--  lesson_media.status / length: Bunny 인코딩 상태와 길이(초)를 저장(관리자 화면 표시용).

create table if not exists public.admin_logs (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  email      text,
  action     text not null,
  target     text,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_logs_created on public.admin_logs (created_at desc);
alter table public.admin_logs enable row level security;   -- 정책 없음 = 서버만

alter table public.lesson_media add column if not exists status int;
alter table public.lesson_media add column if not exists length_s int;

-- 기기 등록·갱신은 서버(/api/video)가 함. 회원이 직접 지우는 것은 그대로 허용(내 정보 → 기기)

-- 진도 저장은 upsert(insert … on conflict update)라 키 칸도 update 권한이 필요함
grant update (user_id, lesson_id, watched_s, position_s, completed_at, updated_at) on public.progress to authenticated;
