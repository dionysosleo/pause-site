-- 출시 전 기본 갖추기
--  1) admins.perms   : 관리자 역할별 권한 (기존 운영자는 전체 권한)
--  2) leads          : 문의·제안서·오픈 알림·사전 진단 접수함 (구글 시트와 같이 저장, 1년 뒤 자동 삭제)
--  3) access_logs    : 회원 접속 기록(IP·일시) 1년 보관 — 개인정보처리방침
--  4) admin_logs.ip  : 관리자 접속·작업 기록에 IP (개인정보 안전성 확보조치)
--  5) 파일 키트       : 비공개 저장소 'kits', kit_files 보강, 키트만 파는 상품 연결
--  6) ops_alerts     : 운영자 알림 중복 방지·기록

-- 1) 권한
alter table public.admins add column if not exists perms text[] not null default '{}';
alter table public.admins add column if not exists label text;          -- 표시 이름 (예: 기업강의 담당)
alter table public.admins add column if not exists added_by text;
update public.admins set perms = '{all}' where perms = '{}';

-- 2) 접수함
create table if not exists public.leads (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  kind        text not null,                 -- 워크샵 문의 · 제안서 요청 · 강의 문의 · 오픈 알림 · 사전 진단 …
  company     text,
  name        text,
  email       text not null,
  phone       text,
  page        text,
  detail      jsonb,
  status      text not null default 'new' check (status in ('new','talking','proposal','won','lost','done','spam')),
  memo        text,
  owner_email text,                           -- 담당 운영자
  updated_at  timestamptz not null default now(),
  sheet_ok    boolean not null default false  -- 구글 시트에도 들어갔는지
);
create index if not exists leads_created on public.leads (created_at desc);
create index if not exists leads_kind on public.leads (kind);
alter table public.leads enable row level security;   -- 정책 없음 = 서버만

-- 3) 회원 접속 기록
create table if not exists public.access_logs (
  id      bigint generated always as identity primary key,
  user_id uuid,
  ip      text,
  ua      text,
  kind    text not null,                     -- visit(내 학습 열기) · play(강의 재생) · kit(키트 받기)
  at      timestamptz not null default now()
);
create index if not exists access_logs_at on public.access_logs (at);
create index if not exists access_logs_user on public.access_logs (user_id, at desc);
alter table public.access_logs enable row level security;

-- 4) 관리자 기록 IP
alter table public.admin_logs add column if not exists ip text;

-- 5) 파일 키트
insert into storage.buckets (id, name, public, file_size_limit)
values ('kits', 'kits', false, 524288000) on conflict (id) do nothing;   -- 비공개, 파일당 500MB까지
alter table public.kit_files add column if not exists file_name text;
alter table public.kit_files add column if not exists size_b bigint;
alter table public.kit_files add column if not exists sort int not null default 0;
alter table public.kit_files add column if not exists created_at timestamptz not null default now();

-- 6) 운영 알림 기록
create table if not exists public.ops_alerts (
  id     bigint generated always as identity primary key,
  kind   text not null,
  ref    text,
  sent   boolean not null default false,
  at     timestamptz not null default now(),
  unique (kind, ref)
);
alter table public.ops_alerts enable row level security;

-- 7) 할인 코드·자동 할인
create table if not exists public.coupons (
  code        text primary key,                -- 대문자. 자동 할인은 AUTO-로 시작하는 내부 이름
  title       text not null,                   -- 화면에 보이는 이름 (예: 얼리버드 연장, OO전자 단체 할인)
  kind        text not null check (kind in ('percent','amount')),
  value       int  not null check (value > 0),
  auto        boolean not null default false,  -- 코드 없이 기간 안에 자동 적용
  items       text[],                          -- 적용 상품 (비우면 전체)
  cats        text[],                          -- 적용 분야 biz·salon·cohort·vod (비우면 전체)
  min_amount  int not null default 0,
  max_discount int,                            -- 정률 할인의 최대 할인 금액
  starts_at   timestamptz,
  ends_at     timestamptz,
  max_uses    int,                             -- 전체 사용 한도 (비우면 무제한)
  per_email   int,                             -- 이메일당 사용 한도
  used        int not null default 0,
  active      boolean not null default true,
  memo        text,
  created_at  timestamptz not null default now()
);
alter table public.coupons enable row level security;   -- 서버만
alter table public.orders add column if not exists list_amount int;     -- 할인 전 금액
alter table public.orders add column if not exists discount int not null default 0;
alter table public.orders add column if not exists coupon_code text;

-- 사용 횟수 올리기 (한도 넘으면 false)
create or replace function public.use_coupon(p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update coupons set used = used + 1
   where code = p_code and active and (max_uses is null or used < max_uses)
  returning used into n;
  return n is not null;
end $$;
revoke all on function public.use_coupon(text) from public, anon, authenticated;

-- 8) 주간 백업 보관용 비공개 저장소 (최근 8주만 보관)
insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict (id) do nothing;
