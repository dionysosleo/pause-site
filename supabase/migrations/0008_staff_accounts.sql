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

-- Auth 관리 API는 계정을 먼저 만든 뒤 app_metadata 를 채우는 경우가 있어, 'staff' 가 붙는 순간 회원 정보를 지움
create or replace function public.staff_no_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.raw_app_meta_data->>'role', '') = 'staff' then delete from public.profiles where id = new.id; end if;
  return new;
end $$;
drop trigger if exists on_auth_user_staff on auth.users;
create trigger on_auth_user_staff after insert or update of raw_app_meta_data on auth.users
  for each row execute function public.staff_no_profile();
delete from public.profiles p using auth.users u where u.id = p.id and u.raw_app_meta_data->>'role' = 'staff';
