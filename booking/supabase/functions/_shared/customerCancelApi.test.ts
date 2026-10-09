import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ApiError } from "./http.ts";
import { cancelReservationByToken } from "../reservations/manage.ts";
import { updateCancelPolicy } from "../admin-reservations/cancelPolicy.ts";

const token = "00000000-0000-4000-8000-000000000001";
const request = () => new Request("https://example.com/reservations/manage/cancel", {
  method: "POST", body: JSON.stringify({ token }),
});

Deno.test("キャンセルAPI: DBの原子的判定が拒否した場合は更新成功を返さない", async () => {
  for (const [result, code] of [
    ["link_expired", "LINK_EXPIRED"],
    ["deadline_passed", "CANCELLATION_CLOSED"],
    ["disabled", "CANCELLATION_CLOSED"],
    ["invalid_status", "INVALID_STATUS_TRANSITION"],
    ["not_found", "NOT_FOUND"],
    ["policy_missing", "INTERNAL_ERROR"],
  ]) {
    const client = { rpc: () => Promise.resolve({ data: result, error: null }) } as unknown as Parameters<typeof cancelReservationByToken>[1];
    const error = await assertRejects(() => cancelReservationByToken(request(), client, {}), ApiError);
    assertEquals(error.code, code);
  }
});

Deno.test("キャンセルAPI: DBの成功結果だけを成功として返す", async () => {
  const client = { rpc: () => Promise.resolve({ data: "cancelled", error: null }) } as unknown as Parameters<typeof cancelReservationByToken>[1];
  const response = await cancelReservationByToken(request(), client, {});
  assertEquals(response.status, 200);
  assertEquals((await response.json()).status, "cancelled_by_customer");
});

Deno.test("設定API: オーナー以外の更新はDBへ到達する前に拒否", async () => {
  const client = { from: () => { throw new Error("DB must not be called"); } } as unknown as Parameters<typeof updateCancelPolicy>[1];
  for (const role of ["stylist", "assistant", "maintainer"] as const) {
    const req = new Request("https://example.com/admin-reservations/cancel-policy", {
      method: "PUT", body: JSON.stringify({ cancel_cutoff_hours: 0 }),
    });
    const error = await assertRejects(() => updateCancelPolicy(req, client, { role, staffId: "id", name: "test" }, {}), ApiError);
    assertEquals(error.code, "FORBIDDEN");
  }
});

Deno.test("設定API: オーナーは0時間と受付停止を保存でき、不正値は拒否", async () => {
  const saved: Array<number | null> = [];
  const client = {
    from: () => ({
      update: ({ cancel_cutoff_hours }: { cancel_cutoff_hours: number | null }) => {
        saved.push(cancel_cutoff_hours);
        return { eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({
          data: { cancel_cutoff_hours }, error: null,
        }) }) }) };
      },
    }),
  } as unknown as Parameters<typeof updateCancelPolicy>[1];
  const owner = { role: "owner" as const, staffId: "id", name: "test" };
  for (const hours of [0, null]) {
    const req = new Request("https://example.com/admin-reservations/cancel-policy", {
      method: "PUT", body: JSON.stringify({ cancel_cutoff_hours: hours }),
    });
    const response = await updateCancelPolicy(req, client, owner, {});
    assertEquals((await response.json()).policy.cancel_cutoff_hours, hours);
  }
  assertEquals(saved, [0, null]);
  for (const hours of [-1, 1.5, 8761, "0"]) {
    const req = new Request("https://example.com/admin-reservations/cancel-policy", {
      method: "PUT", body: JSON.stringify({ cancel_cutoff_hours: hours }),
    });
    const error = await assertRejects(() => updateCancelPolicy(req, client, owner, {}), ApiError);
    assertEquals(error.code, "VALIDATION_ERROR");
  }
  assertEquals(saved, [0, null]);
});
