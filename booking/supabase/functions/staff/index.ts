// GET /staff — 顧客が指名予約時に選べる、稼働中スタッフの一覧を返す。認証不要。
//
// 「指名可能」の基準は role が assistant / maintainer でないこと(アシスタントはシフトを持たず
// 単独で指名予約を受け付けない運用のため。maintainerは保守用アカウントで店舗スタッフではない)。将来スタッフが増えた場合も、
// staffテーブルに行を追加するだけでここに自動的に反映される(コード変更不要)。
//
// クエリで menu_ids(カンマ区切り、または旧形式 menu_id)を渡すと、選択されたメニュー全部に
// 対応できるスタッフだけに絞り込む(migrations/0015・_shared/staffMenuCapability.ts)。
// 省略時は今までどおり絞り込みなし(全稼働スタッフ)。最終防御(実際に予約する時の判定)は
// GET /availability・POST /reservations側で必ず行うため、ここでの絞り込みはあくまで
// 画面上の選択肢を親切にする目的であり、これ単体を信用してはいけない。

import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { errorResponse, jsonResponse, ApiError } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { NON_BOOKABLE_ROLES } from "../_shared/staffRoles.ts";
import { parseMenuIds } from "../_shared/menuSelection.ts";
import { fetchStaffMenuExclusions, groupExclusionsByStaff, staffCanPerformMenus } from "../_shared/staffMenuCapability.ts";

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const headers = corsHeaders(req.headers.get("origin"));

  try {
    if (req.method !== "GET") {
      throw new ApiError("VALIDATION_ERROR", "GETのみ対応しています。");
    }

    const url = new URL(req.url);
    const menuIds = parseMenuIds({
      menu_ids: url.searchParams.get("menu_ids") ?? undefined,
      menu_id: url.searchParams.get("menu_id") ?? undefined,
    });

    const client = serviceClient();
    const { data, error } = await client
      .from("staff")
      .select("id, name, role")
      .eq("is_active", true)
      .eq("is_management_only", false)
      .not("role", "in", NON_BOOKABLE_ROLES)
      .order("display_order", { ascending: true });

    if (error) throw new ApiError("INTERNAL_ERROR", "スタッフ情報の取得に失敗しました。");

    let staff = data ?? [];
    if (menuIds.length > 0 && staff.length > 0) {
      const exclusions = await fetchStaffMenuExclusions(client, staff.map((s) => s.id));
      const excludedByStaff = groupExclusionsByStaff(exclusions);
      staff = staff.filter((s) => staffCanPerformMenus(excludedByStaff.get(s.id) ?? new Set(), menuIds));
    }

    return jsonResponse({ staff }, { headers });
  } catch (err) {
    return errorResponse(err, headers);
  }
});
