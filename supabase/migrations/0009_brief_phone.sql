-- 데일리 브리핑 저장 + 주문자 휴대폰 번호(검색용, 숫자만)
create table if not exists public.briefings (
  day        date primary key,          -- 한국 날짜 (그날 하루 요약)
  data       jsonb not null,
  made_at    timestamptz not null default now()
);
alter table public.briefings enable row level security;   -- 서버만
alter table public.orders add column if not exists buyer_phone text;   -- 숫자만 (예: 01012345678)
create index if not exists orders_buyer_phone on public.orders (buyer_phone);
create index if not exists leads_phone on public.leads (phone);
