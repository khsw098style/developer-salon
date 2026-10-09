import { ApiError } from "./http.ts";
import { parseTstzRange } from "./range.ts";

export function assertManageLinkActive(timeRange: string, now: Date = new Date()): void {
  let end: Date;
  try {
    end = parseTstzRange(timeRange).end;
  } catch {
    throw new ApiError("INTERNAL_ERROR", "予約時間の確認に失敗しました。");
  }
  if (!Number.isFinite(end.getTime())) {
    throw new ApiError("INTERNAL_ERROR", "予約時間の確認に失敗しました。");
  }
  if (now.getTime() >= end.getTime()) {
    throw new ApiError("LINK_EXPIRED", "この予約確認リンクの有効期限が切れました。予約終了時刻以降はご利用いただけません。");
  }
}
