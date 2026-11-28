-- 0013: 문의 파이프라인 — 예상 금액(부가세 포함)과 진행일
alter table public.leads add column if not exists amount bigint check (amount is null or amount >= 0);
alter table public.leads add column if not exists event_date date;
create index if not exists leads_event_date on public.leads (event_date);
-- 후기: 사이트 후기 폼으로 들어온 것 구분 (관리자가 확인하고 공개)
alter table public.testimonials add column if not exists source text not null default 'admin' check (source in ('admin','form'));
