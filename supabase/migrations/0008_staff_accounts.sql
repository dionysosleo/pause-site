-- 관리자 전용 계정 분리
--  관리자 계정은 서버가 Supabase Auth에 직접 만들고 app_metadata.role = 'staff' 로 표시 (사용자가 바꿀 수 없는 값)
--  관리자 계정은 회원(profiles)을 만들지 않음 → 사이트 회원·통계에 섞이지 않음
alter table public.admins add column if not exists staff boolean not null default false;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.raw_app_meta_data->>'role', '') = 'staff' then return new; end if;   -- 관리자 전용 계정은 회원 아님
  insert into public.profiles (id, email, name, login_method)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'nickname', ''),
    case coalesce(new.raw_app_meta_data->>'provider','email') when 'kakao' then 'kakao' when 'google' then 'google' else 'email' end
  );
  return new;
end $$;
