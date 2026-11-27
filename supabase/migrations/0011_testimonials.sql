-- 후기·레퍼런스: 관리자 화면에서 넣고 '공개'한 것만 사이트에 보여요 (하나도 없으면 사이트에 칸이 안 생김)
create table if not exists public.testimonials (
  id         bigint generated always as identity primary key,
  quote      text not null,                 -- 한두 문장 후기
  name       text,                          -- 이름 또는 이니셜 (예: 김OO)
  role       text,                          -- 직함·부서
  company    text,                          -- 회사·기관
  program    text,                          -- 참여 프로그램 (예: 차를 우리고, AI를 키우다)
  photo_url  text,                          -- 현장 사진 (공개 저장소 media)
  published  boolean not null default false,
  sort       int not null default 0,
  consent    boolean not null default false, -- 본인(회사) 게시 동의 받음
  created_at timestamptz not null default now()
);
alter table public.testimonials enable row level security;
drop policy if exists "testimonials public" on public.testimonials;
create policy "testimonials public" on public.testimonials for select using (published and consent);
insert into storage.buckets (id, name, public, file_size_limit) values ('media', 'media', true, 10485760) on conflict (id) do nothing;   -- 사이트에 보일 사진 (공개, 10MB)
