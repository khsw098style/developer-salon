import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "../_shared/http.ts";
import { isValidUuid, requireNonEmptyString } from "../_shared/validation.ts";
import { assertManageLinkActive } from "../_shared/manageExpiry.ts";
import { cancellationAvailability } from "../_shared/customerCancellation.ts";

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

  const { data: policy, error: policyError } = await client
    .from("reservation_policy")
    .select("cancel_cutoff_hours")
    .eq("id", 1)
    .maybeSingle();
  if (policyError || !policy) {
    console.error("reservation policy lookup failed:", policyError);
    throw new ApiError("INTERNAL_ERROR", "キャンセル設定の取得に失敗しました。");
  }

  return jsonResponse({
    reservation: data,
    cancellation: cancellationAvailability(data.status, data.time_range, policy.cancel_cutoff_hours),
  }, { headers });
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

  // DB関数が予約行と方針行をロックし、時刻・状態を判定してから同じトランザクションで更新する。
  const { data: result, error } = await client.rpc("cancel_reservation_by_manage_token", { p_token: token });
  if (error) {
    console.error("reservation manage-cancel failed:", error);
    throw new ApiError("INTERNAL_ERROR", "キャンセル処理に失敗しました。");
  }
  if (result === "not_found") throw new ApiError("NOT_FOUND", "リンクが無効です。予約が見つかりませんでした。");
  if (result === "link_expired") throw new ApiError("LINK_EXPIRED", "この予約確認リンクの有効期限が切れました。");
  if (result === "invalid_status") {
    throw new ApiError("INVALID_STATUS_TRANSITION", "この予約は現在の状態ではお客様からキャンセルできません。");
  }
  if (result === "disabled") throw new ApiError("CANCELLATION_CLOSED", "この店舗ではお客様からのキャンセルを受け付けていません。");
  if (result === "deadline_passed") throw new ApiError("CANCELLATION_CLOSED", "お客様からのキャンセル受付期限を過ぎています。");
  if (result !== "cancelled") throw new ApiError("INTERNAL_ERROR", "キャンセル設定の確認に失敗しました。");

  return jsonResponse({ status: "cancelled_by_customer" }, { headers });
}
