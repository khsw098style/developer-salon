// GET /site-content — LPの「CONCEPT」「SHOP & STYLE」「STAFF」セクション表示用データをまとめて返す。認証不要。
// MENU & PRICEは既存の GET /menus をそのまま使うため、ここには含めない(api-design.md参照)。

import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { errorResponse, jsonResponse, ApiError } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { MAINTAINER_ROLE } from "../_shared/staffRoles.ts";

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const headers = corsHeaders(req.headers.get("origin"));

  try {
    if (req.method !== "GET") {
      throw new ApiError("VALIDATION_ERROR", "GETのみ対応しています。");
    }

    const client = serviceClient();

    const [
      { data: features, error: featuresErr },
      { data: photos, error: photosErr },
      { data: staff, error: staffErr },
      { data: rating, error: ratingErr },
    ] = await Promise.all([
      client
        .from("site_features")
        .select("title, description, sort_order")
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      client
        .from("site_gallery_photos")
        .select("kind, image_url, caption, sort_order")
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      client
        .from("staff")
        .select("name, name_en, bio_role_label, bio_comment, avatar_image_url")
        .eq("is_active", true)
        .eq("is_management_only", false)
        .neq("role", MAINTAINER_ROLE)
        .order("display_order", { ascending: true }),
      client.from("site_rating").select("rating, review_count").eq("id", 1).maybeSingle(),
    ]);

    if (featuresErr) throw new ApiError("INTERNAL_ERROR", "特徴カードの取得に失敗しました。");
    if (photosErr) throw new ApiError("INTERNAL_ERROR", "写真の取得に失敗しました。");
    if (staffErr) throw new ApiError("INTERNAL_ERROR", "スタッフ情報の取得に失敗しました。");
    if (ratingErr) throw new ApiError("INTERNAL_ERROR", "評価情報の取得に失敗しました。");

    // kind='interior'が運用ミスで複数登録されても、LP表示は1件に絞る(sort_order最小の1件)。
    const interior = (photos ?? []).find((p) => p.kind === "interior") ?? null;
    const styles = (photos ?? []).filter((p) => p.kind === "style");

    return jsonResponse(
      {
        features: features ?? [],
        gallery: {
          interior: interior ? { image_url: interior.image_url, caption: interior.caption } : null,
          styles: styles.map((s) => ({ image_url: s.image_url, caption: s.caption })),
        },
        staff: staff ?? [],
        rating: rating ? { score: rating.rating, review_count: rating.review_count } : null,
      },
      { headers },
    );
  } catch (err) {
    return errorResponse(err, headers);
  }
});
