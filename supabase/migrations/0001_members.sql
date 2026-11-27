-- CHA&I 회원·온라인 강의 DB (Supabase, 서울 리전)
-- 원칙
--  1) 회원은 자기 행만 본다 (RLS). 주문·수강권 발급·환불은 서버(service_role)만 쓴다.
--  2) 영상 번호(video_id)는 일반 회원이 읽지 못한다. 재생은 서버가 수강 여부를 확인하고 Bunny 서명 주소를 내준다.
--  3) 영상 업체는 provider + video_id로 나눠 저장한다 (업체를 바꿔도 두 칸만 고침).
--  4) 기업 담당자는 멤버의 강의별 진도율·수료 여부만 본다 (함수로만 제공).

-- ───────── 회원 ─────────
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  name          text not null default '',
  login_method  text not null default 'email' check (login_method in ('email','kakao','google')),
  marketing_ok  boolean not null default false,     -- 광고성 정보 수신 (선택)
  marketing_at  timestamptz,                        -- 동의·철회한 시각 (2년마다 재확인)
  created_at    timestamptz not null default now()
);

-- 동의 기록 (언제 무엇에, 어느 버전에)
create table public.consents (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('terms','privacy','age14','marketing','refund_notice')),
  version     text not null,
  agreed      boolean not null,
  created_at  timestamptz not null default now()
);

-- 가입 때 profiles 자동 생성
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, login_method)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'nickname', ''),
    case coalesce(new.raw_app_meta_data->>'provider','email') when 'kakao' then 'kakao' when 'google' then 'google' else 'email' end
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────── 강의 ─────────
create table public.courses (
  id          text primary key,                     -- shop/catalog.json 의 id (예: ai-onboard)
  title       text not null,
  is_open     boolean not null default false,       -- 사전 예약이면 false, 연 날 true
  opened_at   timestamptz,                          -- 사전 예약 상품의 수강 시작 기준일
  created_at  timestamptz not null default now()
);

create table public.lessons (
  id          bigint generated always as identity primary key,
  course_id   text not null references public.courses(id) on delete cascade,
  part        text not null default '',             -- 단계 이름
  sort        int  not null,
  title       text not null,
  is_free     boolean not null default false,       -- 맛보기 (환불 계산에서 세지 않음)
  duration_s  int  not null default 0,
  unique (course_id, sort)
);

-- 영상 위치: 회원은 읽지 못함 (서버만)
create table public.lesson_media (
  lesson_id   bigint primary key references public.lessons(id) on delete cascade,
  provider    text not null default 'bunny' check (provider in ('bunny','cloudflare')),
  video_id    text not null,
  library_id  text                                   -- Bunny 라이브러리 번호 등 업체별 보조값
);

-- 키트 파일 (내려받기 기록이 환불 계산에 쓰임)
create table public.kit_files (
  id          bigint generated always as identity primary key,
  course_id   text not null references public.courses(id) on delete cascade,
  title       text not null,
  storage_path text not null                         -- Supabase Storage 비공개 버킷 경로
);

-- ───────── 기업 ─────────
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  biz_no      text,                                  -- 사업자등록번호 (세금계산서용)
  created_at  timestamptz not null default now()
);

create table public.company_admins (
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  primary key (company_id, user_id)
);

-- 회사가 산 수강권 묶음
create table public.company_seats (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  course_id   text not null references public.courses(id),
  total       int  not null check (total > 0),
  order_id    text,
  expires_at  timestamptz,                           -- 계약에 이용 기간이 있으면
  created_at  timestamptz not null default now()
);

create table public.company_members (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  email       text not null,
  name        text not null default '',
  dept        text not null default '',
  user_id     uuid references public.profiles(id) on delete set null,  -- 초대를 받아들이면 연결
  status      text not null default 'invited' check (status in ('invited','active','removed')),
  invited_at  timestamptz not null default now(),
  joined_at   timestamptz,
  unique (company_id, email)
);

-- ───────── 주문 ─────────
create table public.orders (
  id            text primary key,                    -- 토스 orderId
  user_id       uuid references public.profiles(id) on delete set null,  -- 비회원 결제는 null
  buyer_email   text not null,
  buyer_name    text not null default '',
  item_id       text not null,                       -- catalog id
  qty           int  not null default 1,
  amount        int  not null,                       -- 원, VAT 포함
  payment_key   text,
  method        text,
  status        text not null default 'ready' check (status in ('ready','paid','partial_refunded','refunded','canceled')),
  paid_at       timestamptz,
  refund_amount int  not null default 0,
  company_id    uuid references public.companies(id),
  ship_name     text, ship_phone text, ship_addr text, ship_memo text,   -- 실물 키트 (배송 후 3개월 뒤 지움)
  shipped_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index on public.orders (buyer_email);

-- ───────── 수강권·진도 ─────────
create table public.enrollments (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  course_id   text not null references public.courses(id),
  source      text not null check (source in ('purchase','company','grant')),
  order_id    text references public.orders(id),
  seat_id     bigint references public.company_seats(id),
  started_at  timestamptz not null default now(),    -- 수강 시작일 (사전 예약은 강의를 연 날로 갱신)
  ends_at     timestamptz,                           -- null = 무제한
  revoked_at  timestamptz,                           -- 환불·회사 회수
  unique (user_id, course_id, source)
);

create table public.progress (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  lesson_id     bigint not null references public.lessons(id) on delete cascade,
  watched_s     int not null default 0,              -- 누적 재생 초 (60초 넘으면 시청으로 셈)
  position_s    int not null default 0,              -- 이어 보기 위치
  completed_at  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

create table public.kit_downloads (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kit_id      bigint not null references public.kit_files(id) on delete cascade,
  first_at    timestamptz not null default now(),
  primary key (user_id, kit_id)
);

-- 재생 기기: 4대까지
create table public.devices (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  device_id   text not null,                         -- 브라우저에 만든 무작위 값
  label       text not null default '',
  last_seen   timestamptz not null default now(),
  primary key (user_id, device_id)
);
create function public.limit_devices() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.devices where user_id = new.user_id) >= 4 then
    raise exception 'DEVICE_LIMIT' using hint = '기기는 4대까지 등록할 수 있어요. 내 정보에서 기기를 지워 주세요.';
  end if;
  return new;
end $$;
create trigger devices_limit before insert on public.devices
  for each row execute function public.limit_devices();

-- ───────── 수강평·질문 ─────────
create table public.reviews (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles(id) on delete set null,   -- 탈퇴해도 글은 익명으로 남음
  course_id   text not null references public.courses(id),
  rating      int  not null check (rating between 1 and 5),
  body        text not null,
  watched_pct int  not null default 0,
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.questions (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles(id) on delete set null,
  course_id   text not null references public.courses(id),
  lesson_id   bigint references public.lessons(id),
  body        text not null,
  answer      text,
  answered_at timestamptz,
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ───────── 도우미 함수 ─────────
create function public.has_access(p_course text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from enrollments e join courses c on c.id = e.course_id
    where e.user_id = auth.uid() and e.course_id = p_course
      and e.revoked_at is null and (e.ends_at is null or e.ends_at > now()) and c.is_open
  );
$$;

create function public.is_company_admin(p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from company_admins where company_id = p_company and user_id = auth.uid());
$$;

-- 기업 담당자용: 멤버별 강의 진도율·수료 여부만
create function public.company_progress(p_company uuid)
returns table (member_name text, member_email text, course_id text, progress_pct int, completed boolean)
language sql stable security definer set search_path = public as $$
  select m.name, m.email, e.course_id,
         coalesce(round(100.0 * count(p.lesson_id) filter (where p.completed_at is not null) / nullif(count(l.id),0))::int, 0),
         count(l.id) > 0 and count(l.id) = count(p.lesson_id) filter (where p.completed_at is not null)
  from company_members m
  join enrollments e on e.user_id = m.user_id and e.source = 'company' and e.revoked_at is null
  join company_seats s on s.id = e.seat_id and s.company_id = m.company_id
  join lessons l on l.course_id = e.course_id and not l.is_free
  left join progress p on p.user_id = m.user_id and p.lesson_id = l.id
  where m.company_id = p_company and m.status = 'active' and public.is_company_admin(p_company)
  group by m.name, m.email, e.course_id;
$$;

-- ───────── 행 단위 보안 (RLS) ─────────
alter table public.profiles        enable row level security;
alter table public.consents        enable row level security;
alter table public.courses         enable row level security;
alter table public.lessons         enable row level security;
alter table public.lesson_media    enable row level security;   -- 정책 없음 = 회원은 못 읽음
alter table public.kit_files       enable row level security;
alter table public.companies       enable row level security;
alter table public.company_admins  enable row level security;
alter table public.company_seats   enable row level security;
alter table public.company_members enable row level security;
alter table public.orders          enable row level security;
alter table public.enrollments     enable row level security;
alter table public.progress        enable row level security;
alter table public.kit_downloads   enable row level security;
alter table public.devices         enable row level security;
alter table public.reviews         enable row level security;
alter table public.questions       enable row level security;

-- 내 정보
create policy "me read"   on public.profiles for select using (id = auth.uid());
create policy "me update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy "my consents read" on public.consents for select using (user_id = auth.uid());
create policy "my consents add"  on public.consents for insert with check (user_id = auth.uid());

-- 강의 목록·커리큘럼은 누구나 (영상 위치는 lesson_media에 따로)
create policy "courses public" on public.courses for select using (true);
create policy "lessons public" on public.lessons for select using (true);
create policy "kits for students" on public.kit_files for select using (public.has_access(course_id));

-- 주문·수강권: 읽기만 (쓰기는 서버)
create policy "my orders"      on public.orders for select using (user_id = auth.uid());
create policy "my enrollments" on public.enrollments for select using (user_id = auth.uid());

-- 진도·기기·키트 기록: 본인 것만
create policy "my progress read"  on public.progress for select using (user_id = auth.uid());
create policy "my progress write" on public.progress for insert with check (user_id = auth.uid() and exists (select 1 from public.lessons l where l.id = lesson_id and (l.is_free or public.has_access(l.course_id))));
create policy "my progress upd"   on public.progress for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "my devices"        on public.devices for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "my kit downloads"  on public.kit_downloads for select using (user_id = auth.uid());

-- 수강평·질문
create policy "reviews public"  on public.reviews for select using (not hidden or user_id = auth.uid());
create policy "review write"    on public.reviews for insert with check (user_id = auth.uid() and public.has_access(course_id));
create policy "review edit"     on public.reviews for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "review delete"   on public.reviews for delete using (user_id = auth.uid());
create policy "questions read"  on public.questions for select using (not hidden or user_id = auth.uid());
create policy "question write"  on public.questions for insert with check (user_id = auth.uid() and public.has_access(course_id));
create policy "question delete" on public.questions for delete using (user_id = auth.uid());

-- 기업: 담당자는 자기 회사만, 멤버는 자기 초대만
create policy "company admin reads company" on public.companies for select using (public.is_company_admin(id));
create policy "company admin reads admins"  on public.company_admins for select using (user_id = auth.uid() or public.is_company_admin(company_id));
create policy "company admin reads seats"   on public.company_seats for select using (public.is_company_admin(company_id));
create policy "company admin reads members" on public.company_members for select using (public.is_company_admin(company_id) or user_id = auth.uid());
create policy "company admin invites"       on public.company_members for insert with check (public.is_company_admin(company_id));
create policy "company admin updates"       on public.company_members for update using (public.is_company_admin(company_id)) with check (public.is_company_admin(company_id));

-- 회원이 고칠 수 있는 칸 제한 (역할·로그인 방식은 못 바꿈)
revoke update on public.profiles from authenticated;
grant update (name, marketing_ok, marketing_at) on public.profiles to authenticated;
revoke update on public.progress from authenticated;
grant update (watched_s, position_s, completed_at, updated_at) on public.progress to authenticated;
revoke execute on function public.company_progress(uuid) from anon;
