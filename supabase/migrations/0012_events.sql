-- 0012: 전환 이벤트 (익명 집계 — 개인정보 없음: 이름·이메일·IP·쿠키 저장 안 함)
create table if not exists public.events (
  id bigserial primary key,
  at timestamptz not null default now(),
  name text not null check (char_length(name) <= 40),
  path text check (char_length(path) <= 200),
  item text check (char_length(item) <= 60)
);
create index if not exists events_at_idx on public.events (at desc);
create index if not exists events_name_at_idx on public.events (name, at desc);
alter table public.events enable row level security;
-- 정책 없음: 서버(secret key)만 쓰고 읽음
