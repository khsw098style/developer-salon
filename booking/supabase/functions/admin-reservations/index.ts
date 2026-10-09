// /admin/reservations 配下のルーティング(要ログイン)。
//   GET  /admin/reservations                 -> listReservations(検索・一覧)
//   GET  /admin/reservations/schedule        -> getSchedule(日付×スタッフのスケジュール)
//   GET  /admin/reservations/revenue-summary -> getRevenueSummary(月次売上・見込み/実績)
//   POST /admin/reservations                 -> createAdminReservation(電話予約の代理登録)
//   PATCH /admin/reservations/:id            -> updateReservation(ステータス変更・リスケジュール)
//
// 実際のデプロイ先は Supabase Edge Functions の仕様上 `admin-reservations`
// という1つの関数名になる(スラッシュを含む関数名は作れないため)。
// "admin-reservations" より後ろのパスを自前でパースしてサブルーティングする。

import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { errorResponse, ApiError } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { requireStaff } from "../_shared/auth.ts";
import { getSchedule } from "./schedule.ts";
import { listReservations } from "./list.ts";
import { createAdminReservation } from "./create.ts";
import { updateReservation } from "./update.ts";
import { getRevenueSummary } from "./revenueSummary.ts";
import { getCancelPolicy, updateCancelPolicy } from "./cancelPolicy.ts";

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const headers = corsHeaders(req.headers.get("origin"));

  try {
    const client = serviceClient();
    const staff = await requireStaff(req, client);

    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const anchor = segments.indexOf("admin-reservations");
    const subPath = anchor === -1 ? [] : segments.slice(anchor + 1);

    if (subPath.length === 1 && subPath[0] === "cancel-policy") {
      if (req.method === "GET") return await getCancelPolicy(client, staff, headers);
      if (req.method === "PUT") return await updateCancelPolicy(req, client, staff, headers);
    }

    if (req.method === "GET" && subPath.length === 1 && subPath[0] === "schedule") {
      return await getSchedule(url, client, headers);
    }

    if (req.method === "GET" && subPath.length === 1 && subPath[0] === "revenue-summary") {
      return await getRevenueSummary(url, client, headers);
    }

    if (req.method === "GET" && subPath.length === 0) {
      return await listReservations(url, client, headers);
    }

    if (req.method === "POST" && subPath.length === 0) {
      return await createAdminReservation(req, client, headers);
    }

    if (req.method === "PATCH" && subPath.length === 1) {
      return await updateReservation(decodeURIComponent(subPath[0]), req, client, headers);
    }

    throw new ApiError("NOT_FOUND", "対応していないエンドポイントです。");
  } catch (err) {
    return errorResponse(err, headers);
  }
});
