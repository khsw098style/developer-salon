// スタッフの表示・指名対象から外すロールの定義(PostgREST の .not("role", "in", ...) 用)。
// - assistant: シフトを持たず単独で予約を受けないため、指名リスト・空き枠・売上集計に出さない
// - maintainer: 納品後の保守用アカウント(閲覧専用)。店舗スタッフではないので、店舗側の
//   画面・LPには一切出さない(0014マイグレーション参照)
// - 管理専用ownerはrole=ownerのまま、staff.is_management_only=trueで各一覧から除外する。
export const NON_BOOKABLE_ROLES = "(assistant,maintainer)";
export const MAINTAINER_ROLE = "maintainer";
