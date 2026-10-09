import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ApiError } from "./http.ts";
import { cancellationAvailability } from "./customerCancellation.ts";

const range = '["2026-10-09 10:00:00+09","2026-10-09 11:30:00+09")';
const at = (iso: string) => new Date(iso);

Deno.test("0時間前: 開始直前は許可、開始ちょうどから拒否", () => {
  assertEquals(cancellationAvailability("confirmed", range, 0, at("2026-10-09T00:59:59.999Z")).can_cancel, true);
  assertEquals(cancellationAvailability("confirmed", range, 0, at("2026-10-09T01:00:00.000Z")).can_cancel, false);
});

Deno.test("24時間前: 境界の直前だけ許可し、時差を正しく比較", () => {
  assertEquals(cancellationAvailability("tentative", range, 24, at("2026-10-08T00:59:59.999Z")).can_cancel, true);
  assertEquals(cancellationAvailability("tentative", range, 24, at("2026-10-08T01:00:00.000Z")).can_cancel, false);
  assertEquals(cancellationAvailability("tentative", range, 24, at("2026-10-08T01:00:00.001Z")).can_cancel, false);
});

Deno.test("設定変更は既存予約の判定にも即時反映される", () => {
  const now = at("2026-10-08T12:00:00Z");
  assertEquals(cancellationAvailability("confirmed", range, 0, now).can_cancel, true);
  assertEquals(cancellationAvailability("confirmed", range, 24, now).can_cancel, false);
  assertEquals(cancellationAvailability("confirmed", range, null, now).can_cancel, false);
});

Deno.test("施術中・会計待ち・完了・キャンセル済みは拒否", () => {
  for (const status of ["in_service", "awaiting_checkout", "completed", "cancelled_by_customer"]) {
    assertEquals(cancellationAvailability(status, range, 0, at("2026-10-09T00:00:00Z")).can_cancel, false);
  }
});

Deno.test("不正な設定・予約時間帯は許可しない", () => {
  assertEquals(assertThrows(() => cancellationAvailability("confirmed", range, -1), ApiError).code, "INTERNAL_ERROR");
  assertEquals(assertThrows(() => cancellationAvailability("confirmed", "invalid", 0), ApiError).code, "INTERNAL_ERROR");
});
