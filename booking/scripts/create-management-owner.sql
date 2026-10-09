-- Supabase SQL Editorで実行する。先に0019マイグレーションと関連Functionsを反映すること。
-- <AUTH_USER_UUID>を対象店舗の開発者AuthユーザーIDに置き換える。
-- 既存のstylist/maintainerログイン紐付けを、非公開のowner行へ原子的に移す。
do $$
declare
  v_auth_user_id uuid := '<AUTH_USER_UUID>';
  v_current_role text;
begin
  if not exists (select 1 from auth.users where id = v_auth_user_id) then
    raise exception 'Authユーザーが見つかりません: %', v_auth_user_id;
  end if;

  if exists (
    select 1 from public.staff
    where auth_user_id = v_auth_user_id and role = 'owner' and is_management_only
  ) then
    return; -- 再実行時は何もしない
  end if;

  select role::text into v_current_role
  from public.staff where auth_user_id = v_auth_user_id for update;
  if v_current_role is null or v_current_role not in ('stylist', 'maintainer') then
    raise exception '現在の紐付けがstylist/maintainerではありません (role=%)。操作を中止します', v_current_role;
  end if;

  update public.staff set auth_user_id = null
  where auth_user_id = v_auth_user_id and role in ('stylist', 'maintainer');

  insert into public.staff (name, role, is_active, is_management_only, display_order, auth_user_id)
  values ('開発用オーナー（非公開）', 'owner', true, true, 999, v_auth_user_id);
end;
$$;

-- 実行後の確認。ownerが1件・is_management_only=trueであること。
select id, name, role, is_active, is_management_only, auth_user_id
from public.staff
where auth_user_id = '<AUTH_USER_UUID>'::uuid;
