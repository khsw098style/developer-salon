import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "../_shared/http.ts";
import { aggregateRevenueByStaff } from "../_shared/revenue.ts";
import { NON_BOOKABLE_ROLES } from "../_shared/staffRoles.ts";

// GET /admin-reservations/revenue-summary?year=YYYY&month=MM
// スタイリストごとの月次売上(見込み・実績)を返す。定義は_shared/revenue.tsのコメント参照。
// 集計の中核ロジック(aggregateRevenueByStaff)はSupabaseに依存しない純粋関数として
// 切り出してあり、ここはデータ取得のみを担う薄いI/Oラッパー(availability.tsと同じ方針)。
export async function getRevenueSummary(url: URL, client: SupabaseClient, headers: HeadersInit) {
  const yearRaw = url.searchParams.get("year");
  const monthRaw = url.searchParams.get("month");
  if (!yearRaw || !monthRaw) {
    throw new ApiError("VALIDATION_ERROR", "year と month は必須です。");
  }
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError("VALIDATION_ERROR", "year/month の形式が不正です。");
  }

  // JSTの月初〜翌月月初(排他的上限)をUTC瞬間として求める。
  const monthStart = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+09:00`);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const monthEnd = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+09:00`);

  // 指名可能なスタイリストのみを対象にする(アシスタントは単独で予約を受け付けない運用のため、
  // GET /staffや_shared/availability.tsのfetchStaff()と同じ絞り込み)。
  const { data: staffList, error: staffErr } = await client
    .from("staff")
    .select("id, name")
    .eq("is_active", true)
    .eq("is_management_only", false)
    .not("role", "in", NON_BOOKABLE_ROLES)
    .order("display_order", { ascending: true });
  if (staffErr) throw new ApiError("INTERNAL_ERROR", "スタッフ情報の取得に失敗しました。");

  const { data: reservations, error: resErr } = await client
    .from("reservations")
    .select("staff_id, status, price_at_booking, final_price, reservation_items(price_is_from)")
    .filter("time_range", "ov", `[${monthStart.toISOString()},${monthEnd.toISOString()})`);
  if (resErr) throw new ApiError("INTERNAL_ERROR", "予約情報の取得に失敗しました。");

  const summary = aggregateRevenueByStaff(
    staffList ?? [],
    (reservations ?? []).map((r) => ({
      staff_id: r.staff_id as string,
      status: r.status as string,
      price_at_booking: r.price_at_booking as number,
      final_price: r.final_price as number | null,
      has_estimated_price: ((r.reservation_items ?? []) as { price_is_from: boolean }[]).some((i) => i.price_is_from),
    })),
  );

  return jsonResponse({ year, month, staff: summary }, { headers });
}
