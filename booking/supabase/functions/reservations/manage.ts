import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "../_shared/http.ts";
import { isValidUuid, requireNonEmptyString } from "../_shared/validation.ts";
import { assertManageLinkActive } from "../_shared/manageExpiry.ts";

const ACTIVE_STATUSES = ["tentative", "confirmed", "in_service", "awaiting_checkout"];

// GET /reservations/manage?token=...
// ログイン不要。予約完了メールに記載されたトークンだけを鍵とする、
// 「この予約1件だけ」照会できるエンドポイント(lookup.tsの電話番号版とは別ルート)。
export async function getReservationByToken(
  url: URL,
  client: SupabaseClient,
  headers: HeadersInit,
): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) throw new ApiError("VALIDATION_ERROR", "token を指定してください。");
  if (!isValidUuid(token)) throw new ApiError("NOT_FOUND", "リンクが無効です。予約が見つかりませんでした。");

  const { data, error } = await client
    .from("reservations")
    .select(
      // reservation_items: 複数メニュー選択の内訳(manage.js側でsort_order順に「カット + パーマ」と連結表示する)。
      // 内訳のない古い予約向けに menus(name)(主メニュー)も残している。
      "reservation_number, status, time_range, price_at_booking, notes, menus(name), staff(name), reservation_items(sort_order, price_is_from, menus(name))",
    )
    .eq("manage_token", token)
    .maybeSingle();

  if (error) {
    console.error("reservation manage-lookup failed:", error);
    throw new ApiError("INTERNAL_ERROR", "予約情報の取得に失敗しました。");
  }
  if (!data) {
    throw new ApiError("NOT_FOUND", "リンクが無効です。予約が見つかりませんでした。");
  }

  assertManageLinkActive(data.time_range);

  return jsonResponse({ reservation: data }, { headers });
}

// POST /reservations/manage/cancel  body: { token: string }
export async function cancelReservationByToken(
  req: Request,
  client: SupabaseClient,
  headers: HeadersInit,
): Promise<Response> {
  const body = await req.json().catch(() => {
    throw new ApiError("VALIDATION_ERROR", "リクエストボディの形式が不正です(JSONを指定してください)。");
  });
  const token = requireNonEmptyString(body?.token, "token");
  if (!isValidUuid(token)) throw new ApiError("NOT_FOUND", "リンクが無効です。予約が見つかりませんでした。");

  const { data: reservation, error } = await client
    .from("reservations")
    .select("id, status")
    .eq("manage_token", token)
    .maybeSingle();

  if (error) {
    console.error("reservation manage-cancel fetch failed:", error);
    throw new ApiError("INTERNAL_ERROR", "予約情報の取得に失敗しました。");
  }
  if (!reservation) {
    throw new ApiError("NOT_FOUND", "リンクが無効です。予約が見つかりませんでした。");
  }
  if (!ACTIVE_STATUSES.includes(reservation.status)) {
    throw new ApiError("INVALID_STATUS_TRANSITION", "この予約はすでにキャンセルまたは完了しています。");
  }

  // 上のチェックはUXのための早期判定に過ぎない。SELECTとUPDATEの間に別リクエスト
  // (例: 管理画面での会計完了)がstatusを変えている可能性があるため、UPDATE自体にも
  // status条件を付けて原子的に判定する(2026-09-17、コードレビューで発見・修正)。
  const { data: updated, error: updateErr } = await client
    .from("reservations")
    .update({ status: "cancelled_by_customer", cancel_reason: "顧客によるキャンセル(管理リンク)" })
    .eq("id", reservation.id)
    .in("status", ACTIVE_STATUSES)
    .select("id")
    .maybeSingle();

  if (updateErr) {
    console.error("reservation manage-cancel update failed:", updateErr);
    throw new ApiError("INTERNAL_ERROR", "キャンセル処理に失敗しました。");
  }
  if (!updated) {
    // 取得後に他の操作でstatusが変わっていた(競合)。
    throw new ApiError("INVALID_STATUS_TRANSITION", "この予約はすでにキャンセルまたは完了しています。");
  }

  return jsonResponse({ status: "cancelled_by_customer" }, { headers });
}
