-- 開発中の管理専用ownerなど、ログインできるが店舗スタッフとして公開しない行。
-- is_activeはログイン可否を兼ねるため、公開可否を別カラムで管理する。
alter table public.staff
  add column is_management_only boolean not null default false;

alter table public.staff
  add constraint staff_management_only_owner check (not is_management_only or role = 'owner');
