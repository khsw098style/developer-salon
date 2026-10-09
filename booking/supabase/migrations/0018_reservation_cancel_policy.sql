-- 1店舗1プロジェクト。NULLはお客様のキャンセル全面禁止、0は予約開始前まで。
create table public.reservation_policy (
  id smallint primary key default 1 check (id = 1),
  cancel_cutoff_hours integer check (cancel_cutoff_hours between 0 and 8760),
  updated_at timestamptz not null default now()
);

alter table public.reservation_policy enable row level security;
insert into public.reservation_policy (id, cancel_cutoff_hours) values (1, 0);

-- 顧客APIのみがservice_role経由で呼ぶ。予約行と方針行をロックした後のDB時刻で判定する。
-- 画面を開いてからの期限到達・状態変更・方針変更も、この1トランザクションで再確認する。
create function public.cancel_reservation_by_manage_token(p_token uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_cutoff integer;
  v_now timestamptz;
begin
  select * into v_reservation from public.reservations
    where manage_token = p_token for update;
  if not found then return 'not_found'; end if;

  select cancel_cutoff_hours into v_cutoff from public.reservation_policy
    where id = 1 for share;
  if not found then return 'policy_missing'; end if;

  v_now := clock_timestamp();
  if v_now >= upper(v_reservation.time_range) then return 'link_expired'; end if;
  if v_reservation.status not in ('tentative', 'confirmed') then return 'invalid_status'; end if;
  if v_cutoff is null then return 'disabled'; end if;
  if v_now >= lower(v_reservation.time_range) - v_cutoff * interval '1 hour' then
    return 'deadline_passed';
  end if;

  update public.reservations
    set status = 'cancelled_by_customer',
        cancel_reason = '顧客によるキャンセル(管理リンク)',
        updated_at = v_now
    where id = v_reservation.id;
  return 'cancelled';
end;
$$;

revoke all on function public.cancel_reservation_by_manage_token(uuid) from public, anon, authenticated;
grant execute on function public.cancel_reservation_by_manage_token(uuid) to service_role;
