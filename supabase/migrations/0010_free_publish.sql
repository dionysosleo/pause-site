-- 무료 강의 수강권 + 편별 공개 켜기·끄기(예약 공개)
alter table public.enrollments drop constraint if exists enrollments_source_check;
alter table public.enrollments add constraint enrollments_source_check check (source in ('purchase','company','grant','free'));
alter table public.lessons add column if not exists published boolean not null default true;   -- 끄면 '곧 공개'로만 보임
alter table public.lessons add column if not exists publish_at timestamptz;                     -- 이 시각부터 자동 공개 (비우면 published 그대로)
