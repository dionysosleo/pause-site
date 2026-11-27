-- 결제 확장: 가상계좌(입금 대기)·웹훅 동기화·직접 등록 매출(계좌이체·세금계산서)
--  status: waiting(가상계좌 입금 대기) · expired(입금 기한 지남) 추가
--  source: pg(결제창) | manual(운영자가 직접 등록한 계좌이체·세금계산서 거래)
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('ready','waiting','paid','partial_refunded','refunded','canceled','expired'));
alter table public.orders add column if not exists source    text not null default 'pg' check (source in ('pg','manual'));
alter table public.orders add column if not exists pg_secret text;   -- 가상계좌 입금 알림 확인용 (토스가 준 값)
alter table public.orders add column if not exists vbank     jsonb;  -- 은행·계좌·예금주·입금 기한
alter table public.orders add column if not exists due_at    timestamptz;
alter table public.orders add column if not exists memo      text;   -- 운영 메모 (회사명, 계약 건 등)
alter table public.orders add column if not exists tax_doc   text check (tax_doc in ('none','tax_invoice','cash_receipt','card'));
alter table public.orders add column if not exists pg_synced_at timestamptz;
create index if not exists orders_paid_at on public.orders (paid_at desc);
create index if not exists orders_payment_key on public.orders (payment_key);
