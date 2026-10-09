import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ApiError } from "./http.ts";
import { assertManageLinkActive } from "./manageExpiry.ts";
import { getReservationByToken } from "../reservations/manage.ts";

const range = '["2026-10-09 10:00:00+09","2026-10-09 11:30:00+09")';

Deno.test("予約終了直前は確認リンクを利用できる", () => {
  assertManageLinkActive(range, new Date("2026-10-09T02:29:59.999Z"));
});

Deno.test("予約終了時刻ちょうどから確認リンクは期限切れ", () => {
  const error = assertThrows(
    () => assertManageLinkActive(range, new Date("2026-10-09T02:30:00.000Z")),
    ApiError,
  );
  assertEquals(error.code, "LINK_EXPIRED");
});

Deno.test("予約終了後は確認リンクを利用できない", () => {
  const error = assertThrows(
    () => assertManageLinkActive(range, new Date("2026-10-09T02:30:00.001Z")),
    ApiError,
  );
  assertEquals(error.code, "LINK_EXPIRED");
});

Deno.test("予約時間帯を解析できない場合は期限判定を通さない", () => {
  const error = assertThrows(() => assertManageLinkActive("invalid", new Date()), ApiError);
  assertEquals(error.code, "INTERNAL_ERROR");
});

const token = "00000000-0000-4000-8000-000000000001";
function mockClient(reservation: Record<string, unknown> | null) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({
          data: table === "reservation_policy" ? { cancel_cutoff_hours: 0 } : reservation,
          error: null,
        }) }),
      }),
    }),
  } as unknown as Parameters<typeof getReservationByToken>[1];
}

Deno.test("有効な予約とキャンセル済み予約は終了前に照会できる", async () => {
  const time_range = '["2099-01-01 10:00:00+09","2099-01-01 11:30:00+09")';
  for (const status of ["confirmed", "cancelled_by_customer"]) {
    const response = await getReservationByToken(
      new URL(`https://example.com/reservations/manage?token=${token}`),
      mockClient({ status, time_range }),
      {},
    );
    assertEquals(response.status, 200);
    assertEquals((await response.json()).reservation.status, status);
  }
});

Deno.test("終了した予約の照会は予約情報を返さない", async () => {
  const error = await assertRejects(
    () => getReservationByToken(
      new URL(`https://example.com/reservations/manage?token=${token}`),
      mockClient({ status: "confirmed", time_range: '["2020-01-01 10:00:00+09","2020-01-01 11:30:00+09")' }),
      {},
    ),
    ApiError,
  );
  assertEquals(error.code, "LINK_EXPIRED");
});

Deno.test("無効なトークンの照会は従来どおりNOT_FOUND", async () => {
  const error = await assertRejects(
    () => getReservationByToken(
      new URL("https://example.com/reservations/manage?token=invalid"),
      mockClient(null),
      {},
    ),
    ApiError,
  );
  assertEquals(error.code, "NOT_FOUND");
});
