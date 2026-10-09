import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ApiError, jsonResponse } from "../_shared/http.ts";
import type { AdminContext } from "../_shared/auth.ts";

export async function getCancelPolicy(client: SupabaseClient, staff: AdminContext, headers: HeadersInit): Promise<Response> {
  const { data, error } = await client.from("reservation_policy")
    .select("cancel_cutoff_hours, updated_at").eq("id", 1).maybeSingle();
  if (error || !data) throw new ApiError("INTERNAL_ERROR", "キャンセル設定の取得に失敗しました。");
  return jsonResponse({ policy: data, can_edit: staff.role === "owner" }, { headers });
}

export async function updateCancelPolicy(
  req: Request,
  client: SupabaseClient,
  staff: AdminContext,
  headers: HeadersInit,
): Promise<Response> {
  if (staff.role !== "owner") throw new ApiError("FORBIDDEN", "キャンセル設定はオーナーのみ変更できます。");
  const body = await req.json().catch(() => {
    throw new ApiError("VALIDATION_ERROR", "リクエストボディの形式が不正です。");
  });
  const hours = body?.cancel_cutoff_hours;
  if (hours !== null && (!Number.isInteger(hours) || hours < 0 || hours > 8760)) {
    throw new ApiError("VALIDATION_ERROR", "キャンセル期限は0〜8760時間の整数、または禁止を指定してください。");
  }
  const { data, error } = await client.from("reservation_policy")
    .update({ cancel_cutoff_hours: hours, updated_at: new Date().toISOString() })
    .eq("id", 1).select("cancel_cutoff_hours, updated_at").maybeSingle();
  if (error || !data) throw new ApiError("INTERNAL_ERROR", "キャンセル設定の更新に失敗しました。");
  return jsonResponse({ policy: data, can_edit: true }, { headers });
}
