import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "../_shared/http.ts";
import { parseTstzRange } from "../_shared/range.ts";
import { loadReservationMenuLabels } from "../_shared/menuSelection.ts";
import { MAINTAINER_ROLE } from "../_shared/staffRoles.ts";

const JST_OFFSET = "+09:00";

// GET /admin/reservations/schedule?date=YYYY-MM-DD
// 日付×スタッフのスケジュール表示(SALON BOARDの「スケジュール」画面相当)。
export async function getSchedule(url: URL, client: SupabaseClient, headers: HeadersInit) {
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError("VALIDATION_ERROR", "date は YYYY-MM-DD 形式で指定してください。");
  }

  const { data: businessDay, error: bdErr } = await client
    .from("business_days")
    .select("is_open, open_time, close_time, last_reception_time, note")
    .eq("date", date)
    .maybeSingle();
  if (bdErr) throw new ApiError("INTERNAL_ERROR", "営業日情報の取得に失敗しました。");

  const { data: staffList, error: staffErr } = await client
    .from("staff")
    .select("id, name, role")
    .eq("is_active", true)
    .eq("is_management_only", false)
    .neq("role", MAINTAINER_ROLE)
    .order("display_order", { ascending: true });
  if (staffErr) throw new ApiError("INTERNAL_ERROR", "スタッフ情報の取得に失敗しました。");

  const staffIds = (staffList ?? []).map((s) => s.id);
  const noMatchId = "00000000-0000-0000-0000-000000000000"; // staffIdsが空でも.in()が壊れないためのダミー

  const { data: shifts, error: shiftErr } = await client
    .from("staff_shifts")
    .select("staff_id, is_working, start_time, end_time, break_start_time, break_end_time, note")
    .eq("date", date)
    .in("staff_id", staffIds.length > 0 ? staffIds : [noMatchId]);
  if (shiftErr) throw new ApiError("INTERNAL_ERROR", "シフト情報の取得に失敗しました。");
  const shiftByStaff = new Map((shifts ?? []).map((s) => [s.staff_id as string, s]));

  const dayStart = `${date}T00:00:00${JST_OFFSET}`;
  const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();

  const { data: reservations, error: resErr } = await client
    .from("reservations")
    .select("id, reservation_number, staff_id, status, source, time_range, price_at_booking, final_price, notes, customer_id, menu_id")
    .in("staff_id", staffIds.length > 0 ? staffIds : [noMatchId])
    .filter("time_range", "ov", `[${dayStart},${dayEnd})`)
    .order("time_range", { ascending: true });
  if (resErr) throw new ApiError("INTERNAL_ERROR", "予約情報の取得に失敗しました。");

  const customerIds = [...new Set((reservations ?? []).map((r) => r.customer_id as string))];
  const menuIds = [...new Set((reservations ?? []).map((r) => r.menu_id as string))];

  const [{ data: customers, error: custErr }, { data: menus, error: menuErr }] = await Promise.all([
    customerIds.length > 0
      ? client.from("customers").select("id, name, phone, no_show_count, is_blocked").in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
    menuIds.length > 0
      ? client.from("menus").select("id, name").in("id", menuIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (custErr) throw new ApiError("INTERNAL_ERROR", "顧客情報の取得に失敗しました。");
  if (menuErr) throw new ApiError("INTERNAL_ERROR", "メニュー情報の取得に失敗しました。");

  const customerById = new Map((customers ?? []).map((c) => [c.id as string, c]));
  const menuNameById = new Map((menus ?? []).map((m) => [m.id as string, m.name as string]));
  const menuLabels = await loadReservationMenuLabels(client, (reservations ?? []).map((r) => r.id as string));

  const reservationsByStaff = new Map<string, unknown[]>();
  for (const r of reservations ?? []) {
    const staffId = r.staff_id as string;
    const list = reservationsByStaff.get(staffId) ?? [];
    const range = parseTstzRange(r.time_range as unknown as string);
    const customer = customerById.get(r.customer_id as string);

    list.push({
      id: r.id,
      reservation_number: r.reservation_number,
      status: r.status,
      source: r.source,
      start_at: range.start.toISOString(),
      end_at: range.end.toISOString(),
      price: r.price_at_booking,
      final_price: r.final_price,
      menu_id: r.menu_id,
      notes: r.notes,
      // 複数メニュー選択の予約は連結名(「カット + パーマ」)。内訳のない古い予約は主メニュー名にフォールバック。
      menu_name: menuLabels.get(r.id as string)?.name ?? menuNameById.get(r.menu_id as string) ?? null,
      price_is_from: menuLabels.get(r.id as string)?.priceIsFrom ?? false,
      customer: customer
        ? { id: customer.id, name: customer.name, phone: customer.phone, no_show_count: customer.no_show_count, is_blocked: customer.is_blocked }
        : null,
    });
    reservationsByStaff.set(staffId, list);
  }

  const staffResult = (staffList ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    shift: shiftByStaff.get(s.id) ?? null,
    reservations: reservationsByStaff.get(s.id) ?? [],
  }));

  return jsonResponse({ date, business_day: businessDay, staff: staffResult }, { headers });
}
