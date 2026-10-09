import { ApiError } from "./http.ts";
import { parseTstzRange } from "./range.ts";

export interface CancellationAvailability {
  can_cancel: boolean;
  reason: string | null;
}

export function cancellationAvailability(
  status: string,
  timeRange: string,
  cutoffHours: number | null,
  now: Date = new Date(),
): CancellationAvailability {
  let start: Date;
  try {
    start = parseTstzRange(timeRange).start;
  } catch {
    throw new ApiError("INTERNAL_ERROR", "予約時間の確認に失敗しました。");
  }
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(now.getTime())) {
    throw new ApiError("INTERNAL_ERROR", "予約時間の確認に失敗しました。");
  }
  if (status !== "tentative" && status !== "confirmed") {
    return { can_cancel: false, reason: "この予約は現在の状態ではお客様からキャンセルできません。" };
  }
  if (cutoffHours === null) {
    return { can_cancel: false, reason: "この店舗ではお客様からのキャンセルを受け付けていません。" };
  }
  if (!Number.isInteger(cutoffHours) || cutoffHours < 0 || cutoffHours > 8760) {
    throw new ApiError("INTERNAL_ERROR", "キャンセル設定の確認に失敗しました。");
  }
  if (now.getTime() >= start.getTime() - cutoffHours * 60 * 60 * 1000) {
    return { can_cancel: false, reason: "お客様からのキャンセル受付期限を過ぎています。" };
  }
  return { can_cancel: true, reason: null };
}
